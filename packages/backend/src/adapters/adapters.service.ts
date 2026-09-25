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
import { normalizeBaseUrlVariables } from '../common/base-url-variable.util';
import { ConnectorsService } from '../connectors/connectors.service';
import { classifyToolExecutionError } from '../connectors/connector-error.util';
import { applyResponseTransform } from '../connectors/response-transform.util';

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
      .map((a) => ({
        ...a,
        requiredEnvVars: withoutOperatorProvided(a.requiredEnvVars) ?? [],
      }));
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
   * Adapters that only work from a residential IP (upstreams behind Cloudflare
   * or Akamai bot walls, session-token scrapers) are marked `selfHostOnly` in
   * the catalog. From the cloud's datacenter address they fail every call, so
   * the cloud does not list them at all. Self-host shows them as usual.
   */
  private isInstallableHere(adapter: { selfHostOnly?: boolean }): boolean {
    if (!adapter.selfHostOnly) return true;
    return this.configService.get<string>('DEPLOYMENT_MODE') !== 'cloud';
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

    // Values the operator provides for everyone (e.g. the cloud's own MOTIS
    // URL) go in here, and override anything the request carried.
    credentials = withOperatorProvided(credentials);

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
      credentials = normalizeBaseUrlVariables(
        adapter.connector.baseUrl,
        credentials,
        adapter.connector.type,
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
      slug,
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

    for (const tool of adapter.tools) {
      try {
        await this.prisma.mcpTool.create({
          data: {
            connectorId: connector.id,
            name: tool.name,
            description: tool.description,
            isEnabled: true,
            // Seed the proxy preference from the adapter spec (default off).
            useProxy: tool.useProxy === true,
            parameters: tool.parameters as any,
            endpointMapping: tool.endpointMapping as any,
            responseMapping: tool.responseMapping as any,
            outputSchema: ((tool as any).outputSchema ?? null) as any,
            annotations: (tool.annotations ?? undefined) as any,
          },
        });
        toolsCreated++;
      } catch (err: any) {
        if (err.code !== 'P2002') {
          this.logger.warn(`Failed to create tool ${tool.name}: ${err.message}`);
        }
      }
    }

    await this.mcpServer.reloadConnectorTools(connector.id);

    this.logger.log(
      `Imported adapter "${slug}" as connector ${connector.id} with ${toolsCreated} tools`,
    );

    const probe = await this.runImportProbe(adapter, connector.id);

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
  ): Promise<ImportProbeResult | null> {
    // An OAuth2 connector authorised in the browser (authorizationUrl, no
    // refresh token of its own) holds no token until the user completes that
    // step on the connector page. Probing it now can only return a 401 that
    // the form would present as a wrong credential.
    const auth = adapter.connector.authConfig as Record<string, unknown> | undefined;
    if (
      adapter.connector.authType === 'OAUTH2' &&
      auth?.authorizationUrl &&
      !auth.refreshToken
    ) {
      return null;
    }
    const call = pickProbe(adapter);
    if (!call) return null;
    const started = Date.now();
    try {
      const connector = await this.prisma.connector.findUnique({
        where: { id: connectorId },
        include: { tools: { where: { name: call.toolName } } },
      });
      const tool = connector?.tools[0];
      if (!connector || !tool) return null;
      const raw = await this.connectors.executeConnectorCall(
        connector,
        tool.endpointMapping as any,
        call.params,
        call.toolName,
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
      return {
        ok: false,
        toolName: call.toolName,
        durationMs: Date.now() - started,
        status: status ?? null,
        message: `${upstream} ${hint}`.trim(),
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

export type ImportProbeResult =
  | { ok: true; toolName: string; durationMs: number; sample: string }
  | {
      ok: false;
      toolName: string;
      durationMs: number;
      status: number | null;
      message: string;
    };

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
