import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { encrypt } from '../common/crypto/encryption.util';
import { ConfigService } from '@nestjs/config';
import { listAdapters, getAdapter, AdapterMeta, AdapterDefinition } from './catalog';
import { hashInstructions } from './catalog-fingerprint';
import { getRequiredSecret } from '../common/secrets.util';
import {
  withOperatorProvided,
  withoutOperatorProvided,
} from './cloud-managed-env';
import { pickProbe } from './probe.util';
import { odooDatabaseHint } from './odoo-database-hint';
import { outboundRequest } from '../common/outbound-http';
import { interpolateString } from '../common/env-interpolation.util';
import { normalizeAddressVariables } from '../common/base-url-variable.util';
import { STARTER_PACK } from './starter-pack';
import {
  POPULAR_CACHE_MS,
  POPULAR_FALLBACK,
  POPULAR_MAX,
  POPULAR_MIN_WORKSPACES,
  POPULAR_WINDOW_DAYS,
} from './popular-connectors';
import { ConnectorsService } from '../connectors/connectors.service';
import { classifyToolExecutionError } from '../connectors/connector-error.util';
import { applyResponseTransform } from '../connectors/response-transform.util';
import {
  describeAdapterEnvVars,
  EnvVarDescriptor,
  needsBrowserAuthorization,
  setupKind,
  SetupKind,
} from './env-var-meta';
import { computeSetupState } from '../connectors/connector-setup-status.util';
import { describeDiscoveredTools, mergeDiscoveredMcpTools } from './mcp-adapter.util';
import { deriveToolAnnotations } from '../mcp-server/tool-annotations';
import { mcpToolPrefixOf } from '../connectors/mcp-connector-config.util';

@Injectable()
export class AdaptersService {
  private readonly logger = new Logger(AdaptersService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
    private readonly connectors: ConnectorsService,
  ) {
    this.encryptionKey = getRequiredSecret(
      'ENCRYPTION_KEY',
      this.configService.get<string>('ENCRYPTION_KEY'),
    );
  }

  listAll(): AdapterMeta[] {
    return listAdapters()
      .filter((a) => this.isInstallableHere(a))
      .map((a) => {
        const requiredEnvVars = withoutOperatorProvided(a.requiredEnvVars) ?? [];
        const full = getAdapter(a.slug);
        return {
          ...a,
          requiredEnvVars,
          setupKind: full ? setupKind({ ...full, requiredEnvVars }) : undefined,
        };
      });
  }

  /**
   * The adapter as the setup form needs it: the definition, each variable
   * described (label, address / credential / setting, secret, help), and what
   * setting it up involves.
   */
  describe(slug: string): AdapterDefinition & {
    envVars: EnvVarDescriptor[];
    setupKind: SetupKind;
  } {
    const adapter = this.getBySlug(slug);
    return {
      ...adapter,
      envVars: describeAdapterEnvVars(adapter),
      setupKind: setupKind(adapter),
    };
  }

  getBySlug(slug: string): AdapterDefinition {
    const adapter = getAdapter(slug);
    if (!adapter || !this.isInstallableHere(adapter)) {
      throw new NotFoundException(`Adapter "${slug}" not found`);
    }
    return {
      ...adapter,
      requiredEnvVars: withoutOperatorProvided(adapter.requiredEnvVars) ?? [],
    };
  }

  /**
   * The starter pack as this deployment can serve it, for this workspace.
   * An entry drops out when its adapter is missing, hidden here, or would
   * need a value from the user (the pack promises one click and no keys);
   * `installed` marks the ones the workspace already has, so the page can
   * show them as done instead of offering a duplicate.
   */
  async starterPack(organizationId: string): Promise<StarterPackItem[]> {
    const installed = await this.installedAdapterSlugs(organizationId);
    const items: StarterPackItem[] = [];
    for (const entry of STARTER_PACK) {
      const adapter = getAdapter(entry.slug);
      if (!adapter || !this.isInstallableHere(adapter)) continue;
      if ((withoutOperatorProvided(adapter.requiredEnvVars) ?? []).length > 0) continue;
      items.push({
        slug: entry.slug,
        name: adapter.name,
        pitch: entry.pitch,
        icon: adapter.icon,
        category: adapter.category,
        toolCount: adapter.tools.length,
        preselected: entry.preselected,
        installed: installed.has(entry.slug),
      });
    }
    return items;
  }

  private popularCache: { at: number; slugs: string[] } | null = null;

  /**
   * The apps /welcome offers first, most-working first (see
   * ./popular-connectors.ts), each with what its setup asks for and whether
   * this workspace already has it.
   */
  async popularConnectors(organizationId: string): Promise<PopularConnectorItem[]> {
    const [ranked, installed] = await Promise.all([
      this.rankedPopularSlugs(),
      this.installedAdapterSlugs(organizationId),
    ]);
    const items: PopularConnectorItem[] = [];
    for (const slug of [...ranked, ...POPULAR_FALLBACK]) {
      if (items.length >= POPULAR_MAX) break;
      if (items.some((i) => i.slug === slug)) continue;
      const adapter = getAdapter(slug);
      if (!adapter || !this.isInstallableHere(adapter)) continue;
      const requiredEnvVars = withoutOperatorProvided(adapter.requiredEnvVars) ?? [];
      const kind = setupKind({ ...adapter, requiredEnvVars });
      if (kind === 'none') continue;
      const needs = describeAdapterEnvVars({ ...adapter, requiredEnvVars })
        .filter((v) => v.required && !v.advanced)
        .map((v) => v.label);
      items.push({
        slug,
        name: adapter.name,
        icon: adapter.icon,
        category: adapter.category,
        setupKind: kind,
        needs,
        installed: installed.has(slug),
      });
    }
    return items;
  }

  /** Adapter slugs by successful workspaces over the window, cached for an hour. */
  private async rankedPopularSlugs(): Promise<string[]> {
    const now = Date.now();
    if (this.popularCache && now - this.popularCache.at < POPULAR_CACHE_MS) {
      return this.popularCache.slugs;
    }
    let slugs: string[] = [];
    try {
      // tool_invocations is large; the EXISTS goes through its
      // (connector_id, created_at) index, one recent connector at a time.
      const rows = await this.prisma.$queryRaw<Array<{ slug: string; workspaces: bigint }>>`
        SELECT c.config->>'adapterSlug' AS slug,
               COUNT(DISTINCT c.organization_id) AS workspaces
        FROM connectors c
        WHERE c.created_at > now() - make_interval(days => ${POPULAR_WINDOW_DAYS})
          AND c.config ? 'adapterSlug'
          AND EXISTS (
            SELECT 1 FROM tool_invocations ti
            WHERE ti.connector_id = c.id AND ti.status = 'SUCCESS'
          )
        GROUP BY 1
        HAVING COUNT(DISTINCT c.organization_id) >= ${POPULAR_MIN_WORKSPACES}
        ORDER BY 2 DESC, 1
        LIMIT 40`;
      slugs = rows.map((r) => r.slug).filter((s): s is string => typeof s === 'string');
    } catch (err: any) {
      // The page still has the fallback list; a ranking that fails is not
      // worth an error on a new user's first screen.
      this.logger.warn(`Could not rank popular connectors: ${err?.message ?? err}`);
    }
    this.popularCache = { at: now, slugs };
    return slugs;
  }

  /** Catalog slugs this workspace already has a connector for. */
  async installedAdapterSlugs(organizationId: string): Promise<Set<string>> {
    const rows = await this.prisma.connector.findMany({
      where: { organizationId },
      select: { config: true },
    });
    const slugs = new Set<string>();
    for (const r of rows) {
      const slug = (r.config as { adapterSlug?: unknown } | null)?.adapterSlug;
      if (typeof slug === 'string') slugs.add(slug);
    }
    return slugs;
  }

  /**
   * Adapters that only work from a residential IP (upstreams behind Cloudflare
   * or Akamai bot walls, session-token scrapers) are marked `selfHostOnly` in
   * the catalog. From the cloud's datacenter address they fail every call, so
   * the cloud does not list them at all. Self-host shows them as usual.
   */
  private isInstallableHere(adapter: { selfHostOnly?: boolean; unlisted?: boolean }): boolean {
    // Unlisted adapters do not match the vendor's API; nowhere offers them.
    if (adapter.unlisted) return false;
    if (!adapter.selfHostOnly) return true;
    return this.configService.get<string>('DEPLOYMENT_MODE') !== 'cloud';
  }

  /**
   * The connector an adapter becomes with these credentials, before anything
   * is written: credentials trimmed and operator values applied, base-URL
   * variables normalised, {{VAR}} resolved in auth, address and headers.
   * Shared by the import and by the pre-save verification, so both judge
   * exactly the same configuration.
   */
  private prepareConnector(
    adapter: AdapterDefinition,
    input?: Record<string, string>,
  ) {
    let credentials = input;
    // Values the operator provides for everyone (e.g. the cloud's own MOTIS
    // URL) go in here, and override anything the request carried. Only the
    // adapters that declare the variable get it.
    credentials = withOperatorProvided(credentials, [
      ...adapter.requiredEnvVars,
      ...(adapter.optionalEnvVars ?? []),
    ]);

    // Credentials arrive from the UI verbatim — a stray leading/trailing
    // space (easy to pick up when pasting) would otherwise be encrypted into
    // authConfig and break auth downstream (e.g. Basic Auth 401s that are
    // invisible in the UI because the displayed env var looks correct).
    if (credentials) {
      // Rebuild via Object.fromEntries (no dynamic user-keyed property write)
      // so a pasted leading/trailing space in a credential can't survive into
      // the encrypted authConfig and break auth.
      credentials = Object.fromEntries(
        Object.entries(credentials).map(([k, v]) => [
          k,
          typeof v === 'string' ? v.trim() : v,
        ]),
      ) as Record<string, string>;

      // A base URL built from a variable (Substack, Magento, WordPress, …)
      // needs that variable to be a whole URL. `yourname.substack.com` gets
      // its https:// here; a value that is not a web address at all is
      // refused while the user is still on the form, naming the variable.
      // The normalised value is what gets stored, so the environment-variable
      // editor shows what is actually used.
      // A tenant field (`{{WECLAPP_TENANT}}.weclapp.com`) given as the whole
      // address the browser shows keeps the label it stands for; an address
      // on another domain is refused, naming the variable.
      credentials = normalizeAddressVariables(
        adapter.connector.baseUrl,
        credentials,
        adapter.connector.type,
        { singleLabel: true },
      );
    }

    // Resolve {{VAR}} placeholders in authConfig with provided credentials
    const resolvedAuthConfig = adapter.connector.authConfig
      ? this.resolveTemplate(adapter.connector.authConfig, credentials)
      : null;

    const encryptedAuth = resolvedAuthConfig
      ? encrypt(JSON.stringify(resolvedAuthConfig), this.encryptionKey)
      : null;

    // Resolve {{VAR}} placeholders in baseUrl (e.g. weclapp tenant)
    const resolvedBaseUrl = this.resolveString(adapter.connector.baseUrl, credentials);
    this.assertBaseUrlFullyResolved(
      adapter.slug,
      adapter.connector.baseUrl,
      resolvedBaseUrl,
    );

    // Resolve {{VAR}} placeholders in static connector headers (e.g. Harvest
    // requires a per-tenant Harvest-Account-Id header on every call).
    const adapterHeaders = (adapter.connector as { headers?: Record<string, string> }).headers;
    const resolvedHeaders = adapterHeaders
      ? (this.resolveTemplate(adapterHeaders, credentials) as Record<string, string>)
      : null;

    // Persist the import credentials as envVars so the engine can use them
    // for runtime $varname substitution inside tool bodies/queries/paths.
    // (authConfig has its own {{VAR}} substitution; envVars covers everything
    // outside auth/baseUrl.)
    const envVarsToPersist = credentials && Object.keys(credentials).length > 0
      ? (credentials as Record<string, unknown>)
      : null;

    return {
      credentials,
      resolvedAuthConfig,
      encryptedAuth,
      resolvedBaseUrl,
      resolvedHeaders,
      envVarsToPersist,
    };
  }

  /**
   * Try the adapter with these credentials before anything is saved: the same
   * preparation as the import, then its probe call against a connector that
   * exists only in memory (no row, no token cache written).
   *
   * - `ok: true`: the API answered; `sample` shows what came back.
   * - `ok: false`: a value is missing or malformed (`kind: 'invalid_input'`),
   *   or the API refused the call (`kind` from the shared classifier, e.g.
   *   `auth_failed`).
   * - `ok: null`: nothing to try yet: the connector needs a sign-in at the
   *   provider first, or the adapter has no safe read call.
   */
  async verifyCredentials(
    slug: string,
    organizationId: string,
    credentials?: Record<string, string>,
    /** Finishing an existing connector: a field left empty uses what it stores (masked secrets come back empty). */
    existingConnectorId?: string,
  ): Promise<VerifyResult> {
    const adapter = this.getBySlug(slug);
    if (existingConnectorId) {
      const stored = await this.prisma.connector.findFirst({
        where: { id: existingConnectorId, organizationId },
        select: { envVars: true },
      });
      const env = (stored?.envVars ?? {}) as Record<string, unknown>;
      // Only names the adapter declares come from the request.
      const declared = new Set([...adapter.requiredEnvVars, ...(adapter.optionalEnvVars ?? [])]);
      const merged = new Map<string, string>();
      for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && v) merged.set(k, v);
      for (const [k, v] of Object.entries(credentials ?? {})) {
        if (declared.has(k) && typeof v === 'string' && v.trim()) merged.set(k, v);
      }
      credentials = Object.fromEntries(merged);
    }
    // Required fields left empty: say which, before anything else complains
    // about the address they would have formed.
    const empty = adapter.requiredEnvVars.filter((name) => !credentials?.[name]?.trim());
    const browserTokens = needsBrowserAuthorization(adapter)
      ? new Set(describeAdapterEnvVars(adapter).filter((d) => d.advanced).map((d) => d.name))
      : new Set<string>();
    const missingRequired = empty.filter((name) => !browserTokens.has(name));
    if (missingRequired.length > 0) {
      return {
        ok: false,
        kind: 'invalid_input',
        missing: missingRequired,
        message: `Still empty: ${missingRequired.join(', ')}.`,
      };
    }
    let prepared: ReturnType<AdaptersService['prepareConnector']>;
    try {
      prepared = this.prepareConnector(adapter, credentials);
    } catch (err: any) {
      return { ok: false, kind: 'invalid_input', message: String(err?.message ?? err) };
    }
    const state = computeSetupState({
      authType: adapter.connector.authType,
      authConfig: prepared.resolvedAuthConfig,
      baseUrl: prepared.resolvedBaseUrl,
      headers: prepared.resolvedHeaders,
      envVars: prepared.envVarsToPersist,
      config: { adapterSlug: slug },
      toolMappings: adapter.tools.map((t) => t.endpointMapping),
    });
    if (state.status === 'needs_input') {
      return {
        ok: false,
        kind: 'invalid_input',
        missing: state.missing,
        message: `Still empty: ${state.missing.join(', ')}.`,
      };
    }
    if (state.status === 'needs_authorization') {
      return (
        (await this.checkAppKeys(adapter, prepared.resolvedBaseUrl, credentials)) ?? {
          ok: null,
          skipped: 'authorization',
        }
      );
    }

    const call = pickProbe(adapter);
    const tool = call ? adapter.tools.find((t) => t.name === call.toolName) : undefined;
    if (!call || !tool) return { ok: null, skipped: 'no_probe' };

    const transient = this.transientConnector(adapter, prepared, organizationId);

    const started = Date.now();
    try {
      const raw = await this.connectors.executeConnectorCall(
        transient,
        tool.endpointMapping as any,
        call.params,
        call.toolName,
        tool.parameters,
      );
      const shaped = applyResponseTransform(raw, tool.responseMapping as any).value;
      return {
        ok: true,
        toolName: call.toolName,
        durationMs: Date.now() - started,
        sample: truncateSample(shaped),
      };
    } catch (err: any) {
      const status: number | undefined =
        typeof err?.status === 'number'
          ? err.status
          : typeof err?.response?.status === 'number'
            ? err.response.status
            : undefined;
      const upstream = String(err?.message ?? err ?? 'unknown error').slice(0, 400);
      const classified = classifyToolExecutionError({
        status,
        authType: adapter.connector.authType,
        message: upstream,
      });
      // The adapter knows its own failures better than the shared classifier:
      // an Odoo 404 means "older than 19", not "check the tool path".
      const own = adapter.verifyHints?.[String(status)] ?? adapter.verifyHints?.[classified.kind];
      const hint = typeof own === 'string' ? own : own?.hint ?? classified.hint;
      const message = hint ? `${hint} (${upstream.replace(/[.\s]+$/, '')})` : upstream;
      // A wrong Odoo database name: look up the right one rather than send
      // the user looking for a value Odoo shows nowhere.
      const database = await odooDatabaseHint(
        adapter.slug,
        message,
        prepared.resolvedBaseUrl,
        credentials?.ODOO_DB,
      );
      // ...in which case the JSON-RPC adapter is not the better choice either.
      const suggest =
        !database && typeof own === 'object' && own?.suggest ? own.suggest : undefined;
      return {
        ok: false,
        kind: classified.kind,
        toolName: call.toolName,
        status: status ?? null,
        // The hint is what the user acts on; the provider's own words follow.
        message: database ? `${database} ${message}` : message,
        ...(suggest ? { suggest, suggestName: getAdapter(suggest)?.name ?? suggest } : {}),
      };
    }
  }

  /**
   * The adapter's checkBeforeAuthorization, when it has one: a refusal of the
   * app keys (401/403) as a failed check, anything else (keys accepted, the
   * provider down, a timeout) as nothing, so the sign-in goes ahead as before.
   * On 7 Oct 2026 every Etsy user who started the sign-in and never came back
   * had keys Etsy refused: an app still Pending, or the wrong shared secret.
   */
  private async checkAppKeys(
    adapter: AdapterDefinition,
    baseUrl: string,
    credentials?: Record<string, string>,
  ): Promise<VerifyResult | undefined> {
    const check = adapter.checkBeforeAuthorization;
    if (!check) return undefined;
    const headers = Object.fromEntries(
      Object.entries(check.headers ?? {}).map(([k, v]) => [k, this.resolveString(v, credentials)]),
    );
    if (Object.values(headers).some((v) => /\{\{\w+\}\}/.test(v))) return undefined;
    let status: number;
    let body = '';
    try {
      const response = await outboundRequest({
        method: 'GET',
        url: `${baseUrl.replace(/\/+$/, '')}/${check.path.replace(/^\/+/, '')}`,
        headers,
        timeout: 10000,
        validateStatus: () => true,
        responseType: 'text',
      });
      status = response.status;
      body = String(response.data ?? '').slice(0, 200);
    } catch {
      return undefined;
    }
    if (status !== 401 && status !== 403) return undefined;
    const own = adapter.verifyHints?.[String(status)] ?? adapter.verifyHints?.auth_failed;
    const hint = typeof own === 'string' ? own : own?.hint;
    const upstream = `${status}${body ? `: ${body.replace(/\s+/g, ' ').trim()}` : ''}`;
    return {
      ok: false,
      kind: 'auth_failed',
      status,
      message: hint ? `${hint} (${upstream})` : `The provider refused the app keys (${upstream}).`,
    };
  }

  /**
   * Run every read-only tool of an adapter definition with these credentials,
   * against a connector that exists only in memory, and report what each
   * returned without the data itself: status, duration and the shape of the
   * answer (type, item count, top-level keys).
   *
   * For checking a new adapter against a working account before it ships
   * (scripts/ops/verify-adapter-with-connector.mjs). The definition is passed
   * in, not looked up, so an adapter that is not in the catalog yet can be
   * checked. A tool runs only when its annotations say read-only, the same
   * conservative derivation the MCP surface uses: a GET, a GraphQL query, or
   * an explicit `readOnlyHint` in the adapter JSON. Everything else is
   * reported as skipped and never sent.
   */
  async exerciseReadTools(
    adapter: AdapterDefinition,
    organizationId: string,
    credentials: Record<string, string>,
    opts: {
      /** Arguments per tool, for tools with required parameters. */
      params?: Record<string, Record<string, unknown>>;
      /** Only these tools. */
      only?: string[];
    } = {},
  ): Promise<ExerciseResult[]> {
    const prepared = this.prepareConnector(adapter, credentials);
    const transient = this.transientConnector(adapter, prepared, organizationId);
    const results: ExerciseResult[] = [];
    for (const tool of adapter.tools) {
      if (opts.only && !opts.only.includes(tool.name)) continue;
      const annotations = deriveToolAnnotations({
        name: tool.name,
        connectorType: adapter.connector.type,
        endpointMapping: tool.endpointMapping as { method?: string; path?: string },
        annotations: (tool as { annotations?: unknown }).annotations,
      });
      if (annotations.readOnlyHint !== true) {
        results.push({ tool: tool.name, outcome: 'skipped', reason: 'not read-only' });
        continue;
      }
      const required = ((tool.parameters as { required?: string[] })?.required ?? []) as string[];
      const params = { ...(opts.params?.[tool.name] ?? {}) };
      const missing = required.filter((name) => params[name] === undefined && credentials[name] === undefined);
      if (missing.length > 0) {
        results.push({ tool: tool.name, outcome: 'skipped', reason: `needs ${missing.join(', ')}` });
        continue;
      }
      const started = Date.now();
      try {
        const raw = await this.connectors.executeConnectorCall(
          transient,
          tool.endpointMapping as any,
          params,
          tool.name,
          tool.parameters,
        );
        const shaped = applyResponseTransform(raw, tool.responseMapping as any).value;
        results.push({ tool: tool.name, outcome: 'ok', durationMs: Date.now() - started, shape: describeShape(shaped) });
      } catch (err: any) {
        const status: number | null =
          typeof err?.status === 'number'
            ? err.status
            : typeof err?.response?.status === 'number'
              ? err.response.status
              : null;
        results.push({
          tool: tool.name,
          outcome: 'error',
          durationMs: Date.now() - started,
          status,
          message: String(err?.message ?? err ?? 'unknown error').slice(0, 200),
        });
      }
    }
    return results;
  }

  /** The in-memory connector a verification runs against: no id, no row. */
  private transientConnector(
    adapter: AdapterDefinition,
    prepared: ReturnType<AdaptersService['prepareConnector']>,
    organizationId: string,
  ) {
    return {
      // No id: token services then keep what they fetch in memory only.
      id: '',
      name: adapter.connector.name,
      type: adapter.connector.type,
      baseUrl: prepared.resolvedBaseUrl,
      authType: adapter.connector.authType || 'NONE',
      authConfig: prepared.encryptedAuth,
      headers: prepared.resolvedHeaders,
      envVars: prepared.envVarsToPersist,
      config: { ...(adapter.connector.config ?? {}), adapterSlug: adapter.slug },
      organizationId,
      specUrl: null,
    } as unknown as Parameters<ConnectorsService['executeConnectorCall']>[0];
  }

  async importAdapter(
    slug: string,
    userId: string,
    organizationId: string,
    credentials?: Record<string, string>,
  ): Promise<{
    connectorId: string;
    toolsCreated: number;
    probe: ImportProbeResult | null;
  }> {
    const adapter = this.getBySlug(slug);
    const {
      resolvedAuthConfig,
      encryptedAuth,
      resolvedBaseUrl,
      resolvedHeaders,
      envVarsToPersist,
    } = this.prepareConnector(adapter, credentials);

    const connector = await this.prisma.connector.create({
      data: {
        userId,
        organizationId,
        name: adapter.connector.name,
        type: adapter.connector.type as any,
        baseUrl: resolvedBaseUrl,
        isActive: true,
        authType: (adapter.connector.authType as any) || 'NONE',
        authConfig: encryptedAuth,
        headers: resolvedHeaders as any,
        // Without this the "Test connection" probe GETs `/`, which plenty of
        // APIs answer with 404 and the UI reports as a broken connector.
        healthcheckPath:
          (adapter.connector as { healthcheckPath?: string }).healthcheckPath ||
          null,
        envVars: envVarsToPersist as any,
        instructions: adapter.instructions || null,
        // Persist the source adapter slug (brand-logo resolution survives a
        // rename) plus the catalog version + instructions baseline at install
        // time, so the catalog re-sync feature can later detect that the
        // catalog has moved on and whether the user has edited instructions.
        config: {
          ...((adapter.connector as { config?: Record<string, unknown> }).config ?? {}),
          adapterSlug: slug,
          adapterVersion: adapter.version,
          instructionsBaseline: hashInstructions(adapter.instructions),
          // What the catalog's baseUrl resolved to at install. Later, when the
          // catalog moves, this is the only way to tell "we fixed a wrong
          // hostname" from "the operator deliberately pointed this at their
          // own region or sandbox" — the two look identical without it.
          baseUrlBaseline: resolvedBaseUrl,
        },
      },
    });

    let toolsCreated = 0;

    // An adapter for a vendor's own MCP server installs the tools that server
    // lists now; the catalog's copy is the fallback. Listing them is also the
    // proof that the address and token work, so it stands in for the probe.
    let toolsToCreate = adapter.tools;
    let mcpProbe: ImportProbeResult | null = null;
    // A bridge that needs a sign-in at the provider has no token yet: listing
    // could only return a 401. It installs the snapshot, and the tools are
    // listed again, through the same policy, once the authorization completes.
    if (adapter.connector.type === 'MCP' && !needsBrowserAuthorization(adapter)) {
      const started = Date.now();
      try {
        const discovered = await this.connectors.discoverRemoteMcpTools(connector);
        toolsToCreate = mergeDiscoveredMcpTools(
          adapter.tools,
          discovered,
          mcpToolPrefixOf(adapter.connector.config),
        );
        mcpProbe = {
          ok: true,
          toolName: 'tools/list',
          durationMs: Date.now() - started,
          sample: describeDiscoveredTools(discovered),
        };
      } catch (err: any) {
        // The MCP SDK reports the HTTP status of a failed request as `code`.
        const status: number | undefined =
          typeof err?.status === 'number'
            ? err.status
            : typeof err?.code === 'number' && err.code >= 400
              ? err.code
              : undefined;
        const upstream = String(err?.message ?? err ?? 'unknown error').slice(0, 400);
        const { hint } = classifyToolExecutionError({
          status,
          authType: adapter.connector.authType,
          message: upstream,
        });
        this.logger.warn(
          `Could not list the tools of "${slug}" at install (${upstream}); installed the catalog's list`,
        );
        mcpProbe = {
          ok: false,
          toolName: 'tools/list',
          durationMs: Date.now() - started,
          status: status ?? null,
          message: `${upstream} ${hint}`.trim(),
        };
      }
    }

    const toolRows = toolsToCreate.map((tool) => ({
      connectorId: connector.id,
      name: tool.name,
      description: tool.description,
      isEnabled: tool.enabled !== false,
      // Seed the proxy preference from the adapter spec (default off).
      useProxy: tool.useProxy === true,
      parameters: tool.parameters as any,
      endpointMapping: tool.endpointMapping as any,
      responseMapping: tool.responseMapping as any,
      outputSchema: ((tool as any).outputSchema ?? null) as any,
      annotations: (tool.annotations ?? undefined) as any,
      // A catalog tool: catalog updates may change or retire it.
      origin: 'catalog',
    }));

    try {
      // One insert for the whole adapter instead of one per tool
      // (ANYTHINGMCP-CLOUD-BACKEND-5: 40-odd inserts for Telegram Bot). A
      // name the connector already has is skipped, as before.
      toolsCreated = (
        await this.prisma.mcpTool.createMany({ data: toolRows, skipDuplicates: true })
      ).count;
    } catch (err: any) {
      // A row the batch cannot take would otherwise lose every tool: insert
      // one by one so only that tool is left out, as the import always did.
      this.logger.warn(`Batch insert of the "${slug}" tools failed (${err.message}); inserting one by one`);
      for (const data of toolRows) {
        try {
          await this.prisma.mcpTool.create({ data });
          toolsCreated++;
        } catch (e: any) {
          if (e.code !== 'P2002') {
            this.logger.warn(`Failed to create tool ${data.name}: ${e.message}`);
          }
        }
      }
    }

    await this.mcpServer.reloadConnectorTools(connector.id);

    this.logger.log(
      `Imported adapter "${slug}" as connector ${connector.id} with ${toolsCreated} tools`,
    );

    const probe =
      adapter.connector.type === 'MCP'
        ? mcpProbe
        : await this.runImportProbe(
            adapter,
            connector.id,
            resolvedAuthConfig as Record<string, unknown> | null,
          );

    return { connectorId: connector.id, toolsCreated, probe };
  }

  /**
   * Call one read-only tool of the connector just created, with the
   * credentials just entered, and report the outcome to the install form.
   *
   * Never blocks or undoes the import: a slow or unreachable upstream is
   * reported, not treated as a failed install (the connector may need an
   * allow-listed IP, or the user may fix a value in the editor). The result is
   * whatever the agent would have got, run through the same engine and the
   * same response mapping, so "green" here means the first real call will
   * work and "red" carries the upstream's own words.
   */
  private async runImportProbe(
    adapter: AdapterDefinition,
    connectorId: string,
    resolvedAuthConfig?: Record<string, unknown> | null,
  ): Promise<ImportProbeResult | null> {
    // An OAuth2 connector authorised in the browser (authorizationUrl, no
    // refresh token of its own) holds no token until the user completes that
    // step on the connector page. Probing it now can only return a 401 that
    // the form would present as a wrong credential.
    //
    // Judged on the config as installed, not the catalog template: Etsy and
    // Pinterest take either a pasted refresh token or the browser flow, so
    // the template always says `{{ETSY_REFRESH_TOKEN}}` and only the resolved
    // value says whether one was given. One that was is probed, as before.
    const auth = (resolvedAuthConfig ?? adapter.connector.authConfig) as
      | Record<string, unknown>
      | undefined;
    if (
      adapter.connector.authType === 'OAUTH2' &&
      auth?.authorizationUrl &&
      !hasUsableValue(auth.refreshToken)
    ) {
      return null;
    }
    const call = pickProbe(adapter);
    if (!call) return null;
    const started = Date.now();
    let envVars: Record<string, string> = {};
    let baseUrl: string | undefined;
    try {
      const connector = await this.prisma.connector.findUnique({
        where: { id: connectorId },
        include: { tools: { where: { name: call.toolName } } },
      });
      envVars = (connector?.envVars as Record<string, string> | null) ?? {};
      baseUrl = connector ? interpolateString(connector.baseUrl, envVars) : undefined;
      const tool = connector?.tools[0];
      if (!connector || !tool) return null;
      const raw = await this.connectors.executeConnectorCall(
        connector,
        tool.endpointMapping as any,
        call.params,
        call.toolName,
        tool.parameters,
      );
      const shaped = applyResponseTransform(raw, tool.responseMapping as any).value;
      return {
        ok: true,
        toolName: call.toolName,
        durationMs: Date.now() - started,
        sample: truncateSample(shaped),
      };
    } catch (err: any) {
      const status: number | undefined =
        typeof err?.status === 'number'
          ? err.status
          : typeof err?.response?.status === 'number'
            ? err.response.status
            : undefined;
      const upstream = String(err?.message ?? err ?? 'unknown error').slice(0, 400);
      const { hint } = classifyToolExecutionError({
        status,
        authType: adapter.connector.authType,
        message: upstream,
      });
      const message = hint ? `${hint} (${upstream.replace(/[.\s]+$/, '')})` : upstream;
      const database = await odooDatabaseHint(adapter.slug, message, baseUrl, envVars.ODOO_DB);
      return {
        ok: false,
        toolName: call.toolName,
        durationMs: Date.now() - started,
        status: status ?? null,
        // The hint is what the user acts on; the provider's own words follow.
        message: database ? `${database} ${message}` : message,
      };
    }
  }

  /** Replace {{VAR}} placeholders in a string with credential values */
  /**
   * An unresolved placeholder in `baseUrl` produces a connector that cannot
   * ever work. `resolveString` deliberately keeps the placeholder when a key
   * is absent — right for `authConfig`, where an operator may fill a secret in
   * later, but fatal here: every request then goes to a URL like
   * `{{SPAPI_ENDPOINT}}/sellers/v1/...` and dies in the SSRF guard with a
   * message that names neither the adapter nor the missing variable.
   *
   * Eleven live connectors were in exactly this state when the check was
   * added — bitrix24, substack, amazon-seller, magento, wordpress,
   * woocommerce, xentral, ghost, agilecrm, sap-concur and telegram-bot —
   * and bitrix24 had already spent 97 tool calls on it. None of them could
   * have succeeded once. Failing the import is the kinder outcome: the user
   * is still on the form with the value in front of them.
   */
  private assertBaseUrlFullyResolved(
    slug: string,
    template: string,
    resolved: string,
  ): void {
    const names = [
      ...new Set([...resolved.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])),
    ];

    // A whole URL pasted into a variable that wanted one fragment. Insightly
    // asks for a pod name to go in `https://api.{{INSIGHTLY_POD}}.insightly.com`;
    // someone gave it `https://api.na1.insightly.com/v3.1`, which resolved to a
    // host of `api.https` and failed every call with "cannot resolve
    // 'api.https'". The URL is syntactically fine, so validateBaseUrl lets it
    // through — only the template tells you the value was meant to be a part,
    // not a whole.
    if (names.length === 0) {
      const placeholders = [
        ...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])),
      ];
      if (placeholders.length > 0 && resolved.split('://').length > 2) {
        throw new BadRequestException(
          `The value given for ${placeholders.join(' or ')} looks like a full ` +
            `URL. "${slug}" builds the address as ` +
            `${template.replace(/^https?:\/\//, '')}, so it needs just that ` +
            `part — not another https:// inside it.`,
        );
      }
      return;
    }
    const plural = names.length > 1;
    // The hint shows the adapter's own template, never `resolved`. They differ
    // precisely in the parts the user supplied, and those can be secrets —
    // telegram-bot templates the bot token straight into the path, so echoing
    // the resolved URL would put it in an error message and a server log.
    throw new BadRequestException(
      `${names.join(' and ')} ${plural ? 'are' : 'is'} required to install ` +
        `"${slug}" — ${plural ? 'they form' : 'it forms'} part of the API ` +
        `address (${template.replace(/^https?:\/\//, '')}), so the connector ` +
        `cannot be created without ${plural ? 'them' : 'it'}.`,
    );
  }

  private resolveString(
    str: string,
    credentials?: Record<string, string>,
  ): string {
    if (!credentials) return str;
    // An explicitly-supplied empty value must resolve to empty, not fall back
    // to the literal placeholder — some APIs require a credential header to be
    // present but blank (e.g. Destatis GENESIS wants `password: ""` when
    // identifying via API token). A `||` fallback here would send the string
    // "{{DESTATIS_PASSWORD}}" as the password. Only an *absent* key keeps its
    // placeholder, so the operator can still fill it in later.
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) =>
      key in credentials ? credentials[key] : `{{${key}}}`,
    );
  }

  /** Deep-replace {{VAR}} placeholders in an object/value */
  private resolveTemplate(
    obj: unknown,
    credentials?: Record<string, string>,
  ): unknown {
    if (!credentials) return obj;
    if (typeof obj === 'string') return this.resolveString(obj, credentials);
    if (Array.isArray(obj)) return obj.map((v) => this.resolveTemplate(v, credentials));
    if (obj && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = this.resolveTemplate(v, credentials);
      }
      return result;
    }
    return obj;
  }
}

export interface PopularConnectorItem {
  slug: string;
  name: string;
  icon: string;
  category: string;
  setupKind: SetupKind;
  /** Labels of the values the setup asks for, e.g. ["Keystring", "Shared secret"]. */
  needs: string[];
  installed: boolean;
}

export interface StarterPackItem {
  slug: string;
  name: string;
  pitch: string;
  icon: string;
  category: string;
  toolCount: number;
  preselected: boolean;
  installed: boolean;
}

export type VerifyResult =
  | { ok: true; toolName: string; durationMs: number; sample: string }
  | {
      ok: false;
      kind: string;
      message: string;
      missing?: string[];
      toolName?: string;
      status?: number | null;
      /** Another adapter to offer instead, from the adapter's verifyHints. */
      suggest?: string;
      suggestName?: string;
    }
  | { ok: null; skipped: 'authorization' | 'no_probe' };

export type ExerciseResult =
  | { tool: string; outcome: 'ok'; durationMs: number; shape: string }
  | { tool: string; outcome: 'error'; durationMs: number; status: number | null; message: string }
  | { tool: string; outcome: 'skipped'; reason: string };

export type ImportProbeResult =
  | { ok: true; toolName: string; durationMs: number; sample: string }
  | {
      ok: false;
      toolName: string;
      durationMs: number;
      status: number | null;
      message: string;
    };

/** Set, and not a `{{VAR}}` placeholder left over from the template. */
function hasUsableValue(value: unknown): boolean {
  // [^{}] rather than [^}]: linear on a run of '{' (#788).
  return typeof value === 'string' && value.trim() !== '' && !/\{\{[^{}]+\}\}/.test(value);
}

/**
 * What came back, without the data: `array(25) of {id,title,…}`,
 * `object {data,meta}`, `string(120)`. Keys only, never values.
 */
function describeShape(value: unknown): string {
  const keys = (v: unknown) => {
    const k = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object) : [];
    return `{${k.slice(0, 12).join(',')}${k.length > 12 ? ',…' : ''}}`;
  };
  if (Array.isArray(value)) return `array(${value.length})${value.length ? ` of ${keys(value[0])}` : ''}`;
  if (value && typeof value === 'object') return `object ${keys(value)}`;
  if (typeof value === 'string') return `string(${value.length})`;
  return typeof value;
}

/** A short, printable slice of the probe's response for the install form. */
function truncateSample(value: unknown, max = 600): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
