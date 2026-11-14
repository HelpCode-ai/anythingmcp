import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AdaptersService } from './adapters.service';
import { describeAdapterEnvVars, describeEnvVarOptions, needsBrowserAuthorization } from './env-var-meta';
import { normalizeAdapterEnvValue } from './env-var-checks';
import { addressFix, describeAddressFix } from './address-fix';
import { LicenseGuardService } from '../license/license-guard.service';
import { SecurityEvents, SecurityEventService } from '../audit/security-event.service';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import {
  SetupCallOptions,
  SetupCallResult,
  SetupContext,
  SharedSetupProvider,
  SharedSetupRegistry,
} from '../mcp-server/shared-setup';
import {
  ReturnAssistant,
  isExcludedAdapterSlug,
  sharedEndpointAccess,
  withheldGenerationTools,
} from '../mcp-server/shared-toolset';
import { computeSetupState } from '../connectors/connector-setup-status.util';
import { decrypt } from '../common/crypto/encryption.util';
import { findSecretLiterals } from '../common/secret-literals.util';
import { searchCatalog } from './catalog-search';
import { fileSearchSetupPath } from './file-search-setup';
import { CHAT_SETUP_SOURCE } from '../license/license-checkout';
import { inspectOdooAddress } from './odoo-database-hint';
import { WOOCOMMERCE_SLUG, WOOCOMMERCE_URL_VAR } from './woocommerce-setup';

/** Assistants a setup link can name (see assistantForRedirectUris). */
const RETURN_ASSISTANTS: readonly ReturnAssistant[] = ['claude', 'chatgpt', 'muse'];

/** How long a setup link handed to the user stays valid. */
export const SETUP_LINK_TTL_MS = 30 * 60 * 1000;
/** How long expired setup links stay in the table, for measurement only. */
export const SETUP_LINK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Installs through a chat, per user and hour. A model does not need more. */
const INSTALLS_PER_HOUR = 10;

/** The Odoo connectors: JSON-2 needs Odoo 19 or later, JSON-RPC covers 14-18. */
const JSON2_SLUG = 'odoo';
const JSONRPC_SLUG = 'odoo-jsonrpc';
const ODOO_SLUGS = new Set([JSON2_SLUG, JSONRPC_SLUG]);

/** setup_get_status checks a ready connector never used if it was saved this recently. */
const READY_CHECK_WINDOW_MS = 24 * 60 * 60 * 1000;
/** At most this many setup checks per setup_get_status call (each is a call to the provider). */
const READY_CHECKS_PER_STATUS = 3;
/** setup_get_status points out a catalog connector still waiting for its values after this long. */
const UNFINISHED_AFTER_MS = 24 * 60 * 60 * 1000;

/** Installed from the catalog (not hand-built). */
function isCatalogConnector(config: unknown): boolean {
  const slug = (config as { adapterSlug?: unknown } | null | undefined)?.adapterSlug;
  return typeof slug === 'string' && slug !== '';
}

/**
 * Where providers send the browser back after sign-in: the URL a user must
 * register in their own app (Etsy, Google, ...). Same value as the dashboard
 * shows (ConnectorsController.oauthCallbackUrl).
 */
function oauthCallbackUrl(): string {
  const base = (process.env.SERVER_URL || 'http://localhost:4000').replace(/\/+$/, '');
  return `${base}/api/mcp-oauth/callback`;
}

/**
 * For connectors that sign in through the user's own app (Etsy, Google, ...):
 * where to create that app, and the callback URL to register in it. Written
 * so the model shows both in a form the user can act on from a phone: a link
 * to tap, and the URL alone in a code block to copy. Paraphrased as plain
 * text ("etsy.com/developers → Your apps" and the URL inline), neither was.
 */
/**
 * A bridge whose server registers the client itself (dynamic client
 * registration: Notion, Helium 10) signs in without an app of the user's, so
 * there is no app to create and no callback URL to register.
 */
function registersItsOwnClient(definition: { connector: { config?: unknown } }): boolean {
  const config = (definition.connector.config ?? {}) as { mcpOAuth?: { registration?: string } };
  return config.mcpOAuth?.registration === 'dcr';
}

function providerApp(definition: {
  appRegistrationUrl?: string;
  envVars?: Array<{ link?: string; advanced?: boolean }>;
}): Record<string, string> {
  const createAt =
    definition.appRegistrationUrl ?? definition.envVars?.find((v) => !v.advanced && v.link)?.link;
  return {
    ...(createAt ? { createTheAppAt: createAt } : {}),
    callbackUrlToRegisterInTheProviderApp: oauthCallbackUrl(),
    showToTheUser:
      (createAt
        ? 'Give createTheAppAt as a clickable Markdown link with the full https address, e.g. [Create the app](' +
          createAt +
          '). '
        : '') +
      'Put the callback URL alone in a fenced code block, so it can be copied in one tap. Never shorten or reword either address.',
  };
}

/**
 * Setting up connectors from an AI client, through the shared `/mcp`
 * endpoint (see shared-setup.ts), and the one-time links that finish what a
 * chat must not handle: secrets and the provider's sign-in.
 *
 * Rules, all enforced here rather than trusted to the model:
 * - catalog adapters only: no URL a prompt injection could point at a server
 *   of its own;
 * - only values that are not secret are accepted from the chat; a secret is
 *   refused with the link to enter it in the dashboard instead;
 * - ADMIN or EDITOR of the workspace, the same rule as the dashboard;
 * - the trial's connector limit, and INSTALLS_PER_HOUR per user;
 * - every install is recorded as a security event.
 */
@Injectable()
export class ConnectorSetupService implements SharedSetupProvider, OnModuleInit {
  private readonly logger = new Logger(ConnectorSetupService.name);
  private readonly installs = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdaptersService,
    private readonly licenseGuard: LicenseGuardService,
    private readonly registry: SharedSetupRegistry,
    private readonly securityEvents: SecurityEventService,
    private readonly productEvents: ProductEventService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ── Who may ───────────────────────────────────────────────────────────

  async canSetUp(ctx: SetupContext): Promise<boolean> {
    if (!ctx.organizationId) return false;
    const member = await this.prisma.organizationMember.findFirst({
      where: { userId: ctx.userId, organizationId: ctx.organizationId, deactivatedAt: null },
      select: { role: true },
    });
    return member?.role === 'ADMIN' || member?.role === 'EDITOR';
  }

  // ── Find ──────────────────────────────────────────────────────────────

  async find(
    ctx: SetupContext,
    args: { query?: string; limit?: number },
    opts: SetupCallOptions = {},
  ): Promise<SetupCallResult> {
    const query = String(args.query ?? '');
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    const installed = new Set(
      (
        await this.prisma.connector.findMany({
          where: { organizationId: ctx.organizationId },
          select: { config: true },
        })
      )
        .map((c) => (c.config as { adapterSlug?: string } | null)?.adapterSlug)
        .filter((s): s is string => !!s),
    );

    // The same search as the store and /welcome (catalog-search.ts), over the
    // adapters this deployment offers: listAll() already leaves out unlisted
    // ones and, on the cloud, self-host-only ones.
    const offered = this.adapters
      .listAll()
      .filter((a) => !isExcludedAdapterSlug(a.slug, ctx.profile ?? 'chatgpt'))
      .map((a) => ({ ...a, text: [a.description, a.category] }));
    const search = searchCatalog(offered, query);
    const scored = search.terms.length
      ? search.hits.slice(0, limit).map((h) => ({ a: h.entry }))
      : [...offered]
          .sort((x, y) => (y.priority ?? 0) - (x.priority ?? 0))
          .slice(0, limit)
          .map((a) => ({ a }));

    if (search.terms.length) {
      // `results` alone overstates coverage: "printify shop" returns every
      // connector whose description says "shop". `missing` keeps the words no
      // connector matches at all, here "printify"; `match` says whether the
      // results matched the query as typed or only with a typo forgiven
      // ('fuzzy') or some of its words left out ('partial').
      void this.productEvents.log({
        event: ProductEvents.CATALOG_SEARCH,
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        metadata: {
          query,
          results: scored.length,
          via: opts.via ?? 'mcp',
          ...(search.missing.length ? { missing: search.missing.join(' ') } : {}),
          ...(scored.length ? { match: search.match, adapterSlug: scored.map(({ a }) => a.slug).join(',') } : {}),
        },
      });
    }

    const usage = await this.licenseGuard.getUsage(ctx.userId, ctx.organizationId).catch(() => null);
    const wizardUrl = (slug: string): string | null => {
      const path = fileSearchSetupPath(this.adapters.describe(slug), 'chat');
      return path ? `${ctx.dashboardBase}${path}` : null;
    };
    // A storage query ("synology", "nas", "Dateiserver"): File Search reads
    // the documents on that system, which its API connector does not. The
    // suggestion travels with the results so the model can offer both.
    const shown = new Set(scored.map(({ a }) => a.slug));
    const fileSearchShown = search.terms.length ? search.fileSearch.filter((e) => shown.has(e.slug)) : [];
    const setupUrls = new Map(scored.map(({ a }) => [a.slug, wizardUrl(a.slug)]));
    const anyFileSearch = [...setupUrls.values()].some(Boolean);
    return {
      body: {
        results: scored.map(({ a }) => {
          const setupUrl = setupUrls.get(a.slug);
          if (setupUrl) {
            return {
              adapter: a.slug,
              name: a.name,
              description: a.description,
              alreadyInstalled: installed.has(a.slug),
              fileSearch: true,
              setup:
                'Set up in the File Search wizard on the dashboard, not from the chat: it tests the connection, scans the folder and checks it against the plan, then indexes the documents so the AI can search inside them.',
              setupUrl,
              showToTheUser: 'Give setupUrl as a clickable Markdown link with the full https address. Never shorten or reword it.',
            };
          }
          const full = this.adapters.describe(a.slug);
          const vars = full.envVars.filter((v) => !v.advanced);
          return {
            adapter: a.slug,
            name: a.name,
            description: a.description,
            alreadyInstalled: installed.has(a.slug),
            ...(sharedEndpointAccess(a.slug, ctx.profile ?? 'chatgpt') === 'read'
              ? { servedHere: 'Read tools only. Tools that move money or change payment data run on the server\'s own URL.' }
              : withheldGenerationTools(a.slug, ctx.profile ?? 'chatgpt').length
                ? { servedHere: 'All tools except image, video and audio generation, which run on the server\'s own URL.' }
                : {}),
            setup:
              full.setupKind === 'none'
                ? 'Nothing to enter: installs and works right away.'
                : full.setupKind === 'oauth_browser' && registersItsOwnClient(full)
                  ? 'Needs only a sign-in at the provider, done on a page AnythingMCP links to. No app to create.'
                  : full.setupKind === 'oauth_browser'
                  ? 'Needs the user\'s own app keys and a sign-in at the provider, done on a page AnythingMCP links to.'
                  : 'Needs credentials the user enters on a page AnythingMCP links to.',
            // The provider refuses the sign-in, without ever coming back here,
            // when the app does not list this URL. Users creating the app from
            // a chat never saw the setup page that shows it.
            ...(full.setupKind === 'oauth_browser' && !registersItsOwnClient(full) ? providerApp(full) : {}),
            settingsYouMayPass: vars
              .filter((v) => !v.secret)
              .map((v) => ({
                name: v.name,
                label: v.label,
                required: v.required,
                help: v.help,
                example: v.example,
                // A fixed list of choices (one API host per country): the
                // user picks, the model passes that choice's value.
                ...(v.options?.length
                  ? {
                      options: v.options,
                      howToPass: 'Takes one of the options and nothing else. Ask the user which one applies (name the labels), then pass the value of the one they pick, exactly as listed.',
                    }
                  : {}),
              })),
            enteredByTheUserOnTheLinkedPage: vars.filter((v) => v.secret).map((v) => v.label),
          };
        }),
        ...(fileSearchShown.length
          ? {
              fileSearch: {
                adapters: fileSearchShown.map((e) => e.slug),
                whatItAdds:
                  'File Search lets the AI search inside the documents stored there, which an API connector does not: it indexes the PDF, Word, Excel and Outlook files on the NAS, server or storage and keeps the index in sync. Offer it alongside the other results.',
              },
            }
          : {}),
        ...(usage?.connectors?.max != null
          ? { connectorsLeftOnThisPlan: Math.max(0, usage.connectors.max - usage.connectors.current) }
          : {}),
        next:
          'Confirm the choice with the user, then call setup_install_connector with the adapter id (and any settings listed above). Never ask for passwords, API keys or tokens in the chat.' +
          (anyFileSearch ? ' For a File Search result, give the user its setupUrl instead: it cannot be installed from the chat.' : ''),
      },
    };
  }

  // ── Install ───────────────────────────────────────────────────────────

  async install(
    ctx: SetupContext,
    args: { adapter?: string; settings?: Record<string, unknown> },
    opts: SetupCallOptions = {},
  ): Promise<SetupCallResult> {
    let slug = String(args.adapter ?? '').trim();
    let definition: ReturnType<AdaptersService['describe']>;
    try {
      if (!slug || isExcludedAdapterSlug(slug, ctx.profile ?? 'chatgpt')) throw new Error('unknown');
      definition = this.adapters.describe(slug);
    } catch {
      return { isError: true, body: { error: `No catalog connector '${slug}'. Use setup_find_connectors to get its id.` } };
    }

    // File Search needs the wizard (connection test, folder scan, plan check);
    // importAdapter would refuse it with a bare error.
    const wizardPath = fileSearchSetupPath(definition, 'chat');
    if (wizardPath) {
      return {
        isError: true,
        body: {
          error: `${definition.name} is a File Search connector and is set up in the File Search wizard, not from the chat.`,
          setupUrl: `${ctx.dashboardBase}${wizardPath}`,
          whatTheUserDoes: 'Open the link, enter the server address and a read-only account, and follow the wizard: it tests the connection, scans the folder and activates the index.',
        },
      };
    }

    const descriptors = new Map(describeAdapterEnvVars(definition).map((d) => [d.name, d]));
    const settings: Record<string, string> = {};
    for (const [name, value] of Object.entries(args.settings ?? {})) {
      const d = descriptors.get(name);
      if (!d) {
        return { isError: true, body: { error: `'${name}' is not a setting of ${definition.name}. Settings: ${[...descriptors.keys()].join(', ') || 'none'}.` } };
      }
      if (d.secret) {
        return {
          isError: true,
          body: {
            error: `'${d.label}' is a secret and is never taken from the chat. Install without it; the user enters it on the page linked in the answer.`,
          },
        };
      }
      // An address typed without https:// (`acme.odoo.com`) gets it when the
      // field's pattern wants it, as on the setup page (address-fix.ts).
      const typed = value !== undefined && value !== null ? String(value).trim() : '';
      const text = typed ? normalizeAdapterEnvValue(d, typed, slug) : '';
      // A shop URL with `?access_token=…`, a tenant field holding a key: the
      // chat is the wrong place for it, whatever the setting is called.
      if (text && findSecretLiterals(text).length > 0) {
        return {
          isError: true,
          body: {
            error: `'${d.label}' contains what looks like a password, API key or token. Secrets are never taken from the chat.`,
            hint: 'Install without it, or with only the non-secret part (the address without the key). The user enters the secret on the page linked in the answer, where it is stored encrypted.',
          },
        };
      }
      // A variable with a fixed list of choices takes one of their values.
      if (text && d.options?.length && !d.options.some((o) => o.value === text)) {
        return {
          isError: true,
          body: {
            error: `'${d.label}' must be one of: ${describeEnvVarOptions(d.options)}.`,
            hint: 'Ask the user which one applies and pass its value exactly as listed (the value, not the label), or install without it: they can choose it on the page linked in the answer.',
          },
        };
      }
      if (text && !d.options?.length && d.pattern && !matchesPattern(d.pattern, text)) {
        // Secrets never get here, so the fixed address can be named.
        const fix = d.kind !== 'credential' ? addressFix(d.pattern, text) : undefined;
        return {
          isError: true,
          body: {
            error: `'${d.label}' does not look right. ${fix ? describeAddressFix(fix) : (d.patternMessage ?? d.help ?? '')}`.trim(),
            hint: 'Ask the user to check the value, or install without it: they can enter it on the page linked in the answer.',
          },
        };
      }
      if (text) settings[name] = text;
    }

    // Odoo: the address is asked, without a key, before anything is
    // installed. 315 Odoo connectors came from a chat in two weeks of Oct-Nov
    // 2026, often with the subdomain as the database name and the JSON-2
    // connector on an Odoo below 19; both were only found on the setup page.
    let addressNotes: string[] = [];
    if (ODOO_SLUGS.has(slug) && settings.ODOO_URL) {
      const checked = await this.checkOdooAddress(ctx, slug, settings);
      if ('error' in checked) return { isError: true, body: checked.error };
      if (checked.slug !== slug) {
        slug = checked.slug;
        definition = this.adapters.describe(slug);
        // Labels for what the user still enters (the JSON-RPC one adds the user id).
        for (const d of describeAdapterEnvVars(definition)) descriptors.set(d.name, d);
      }
      addressNotes = checked.notes;
    }
    // WooCommerce: the shop is asked, without a key, the same way as on the
    // setup page: its own address is used, a name that does not exist is
    // refused so the assistant asks again, and anything the user must change
    // in WordPress first (Plain permalinks, WooCommerce inactive, a firewall)
    // is said before they create the key.
    if (slug === WOOCOMMERCE_SLUG && settings[WOOCOMMERCE_URL_VAR]) {
      const checked = await this.checkWooCommerceAddress(settings);
      if ('error' in checked) return { isError: true, body: checked.error };
      addressNotes = checked.notes;
    }

    if (!this.takeInstallSlot(ctx.userId)) {
      return { isError: true, body: { error: `At most ${INSTALLS_PER_HOUR} connectors an hour can be installed from a chat. Try again later or use the dashboard.` } };
    }
    try {
      await this.licenseGuard.checkCanCreateConnector(ctx.userId, ctx.organizationId);
    } catch (err: any) {
      return { isError: true, body: await this.planLimitAnswer(ctx, String(err?.message ?? err)) };
    }

    let imported: Awaited<ReturnType<AdaptersService['importAdapter']>>;
    try {
      // A value that forms part of the API address may still be missing (a
      // bot token is never taken here): the setup link asks for it.
      imported = await this.adapters.importAdapter(slug, ctx.userId, ctx.organizationId, settings, {
        addressMayWait: true,
      });
    } catch (err: any) {
      return { isError: true, body: { error: String(err?.message ?? err) } };
    }
    await this.attachToGrantedServers(ctx, imported.connectorId);
    await this.securityEvents.log({
      event: SecurityEvents.CONNECTOR_INSTALLED_VIA_MCP,
      actorType: 'USER',
      actorUserId: ctx.userId,
      organizationId: ctx.organizationId,
      metadata: { adapter: slug, connectorId: imported.connectorId, settings: Object.keys(settings) },
    });
    await this.productEvents.log({
      event: ProductEvents.SETUP_COMPLETED,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      // A chat install checks nothing but the import probe; `verified` keeps
      // these apart from setups that made a successful call.
      metadata: { adapterSlug: slug, via: opts.via ?? 'mcp', verified: imported.probe?.ok === true },
    });

    const state = await this.connectorState(imported.connectorId);
    if (state.status === 'ready') {
      return {
        body: {
          installed: definition.name,
          status: 'ready',
          tools: definition.tools.length,
          ...(addressNotes.length ? { checkedTheAddress: addressNotes.join(' ') } : {}),
          ...(imported.probe ? { firstCall: imported.probe.ok ? 'worked' : imported.probe.message } : {}),
          next: 'Its tools are available now: find them with anythingmcp_search_tools.',
        },
      };
    }
    const link = await this.createLink(ctx, imported.connectorId);
    return {
      body: {
        installed: definition.name,
        status: state.status,
        ...(addressNotes.length ? { checkedTheAddress: addressNotes.join(' ') } : {}),
        ...(needsBrowserAuthorization(definition) && !registersItsOwnClient(definition)
          ? providerApp(definition)
          : {}),
        whatTheUserDoes:
          state.status === 'needs_authorization'
            ? `Open the link, then sign in to ${definition.name} and approve. It takes a minute.`
            : `Open the link and enter ${state.missing.map((m) => descriptors.get(m)?.label ?? m).join(', ')}${
                needsBrowserAuthorization(definition)
                  ? `, then sign in to ${definition.name} and approve`
                  : ''
              }.`,
        finishSetupUrl: link,
        linkValidFor: '30 minutes, for this user only',
        next: 'Give the user the link. When they say they are done, call setup_get_status.',
      },
    };
  }

  /**
   * The plan's connector limit stopped an install. Billing is mentioned here
   * and only here: the answer is the reason the request failed, with the one
   * page that lifts the limit. An admin on the free trial gets the card-trial
   * offer (nothing charged before the trial ends); other admins the licence
   * page; members are told who can do it.
   */
  private async planLimitAnswer(ctx: SetupContext, reason: string): Promise<Record<string, unknown>> {
    const member = await this.prisma.organizationMember
      .findFirst({
        where: { userId: ctx.userId, organizationId: ctx.organizationId, deactivatedAt: null },
        select: { role: true },
      })
      .catch(() => null);
    const usage = await this.licenseGuard.getUsage(ctx.userId, ctx.organizationId).catch(() => null);
    // No licence at all (an ended trial, a lapsed plan): a bigger plan or one
    // connector fewer would not help, so say what would.
    const noLicence = usage != null && usage.plan == null;
    if (member?.role !== 'ADMIN') {
      return {
        error: reason,
        whatTheUserCanDo: noLicence
          ? 'Ask a workspace administrator to activate a licence for this workspace.'
          : 'Ask a workspace administrator to upgrade the plan, or remove a connector they no longer need.',
      };
    }
    if (noLicence) {
      return {
        error: reason,
        whatTheUserCanDo: 'This workspace has no active licence, so no app can be added yet. Choose a plan on the licence page, then try again.',
        upgradeUrl: `${ctx.dashboardBase}/settings/license?source=${CHAT_SETUP_SOURCE}`,
      };
    }
    const onTrial = usage?.plan === 'trial';
    return {
      error: reason,
      whatTheUserCanDo: onTrial
        ? 'Add a card to continue the trial on the full plan (nothing is charged before the trial ends), or remove a connector.'
        : 'Choose a plan with more connectors, or remove a connector.',
      upgradeUrl: `${ctx.dashboardBase}${onTrial ? '/start-trial' : '/settings/license'}?source=${CHAT_SETUP_SOURCE}`,
    };
  }

  /**
   * What the Odoo address says about itself, applied to a chat install:
   * - no database at the address (Odoo Online's typo page): refused, so the
   *   assistant asks for the right address before anything is created;
   * - below 19 on the JSON-2 connector: the JSON-RPC connector instead;
   * - one database: its name, whatever the assistant passed;
   * - several, and the one passed is not among them: none is passed, and the
   *   note names them so the assistant can ask.
   * Nothing changes when the address says nothing.
   */
  private async checkOdooAddress(
    ctx: SetupContext,
    slug: string,
    settings: Record<string, string>,
  ): Promise<{ slug: string; notes: string[] } | { error: Record<string, unknown> }> {
    const facts = await inspectOdooAddress(settings.ODOO_URL);
    if (!facts) return { slug, notes: [] };
    if (facts.noDatabase) {
      return {
        error: {
          error: `There is no Odoo database at ${settings.ODOO_URL}: Odoo answered with its "database not found" page.`,
          hint: 'Ask the user for the address they open Odoo at (copy it from the browser after signing in, up to the host, e.g. https://mycompany.odoo.com), then install again.',
        },
      };
    }
    const notes: string[] = [];
    let target = slug;
    if (
      slug === JSON2_SLUG &&
      facts.major !== undefined &&
      facts.major < 19 &&
      !isExcludedAdapterSlug(JSONRPC_SLUG, ctx.profile ?? 'chatgpt')
    ) {
      target = JSONRPC_SLUG;
      notes.push(
        `This Odoo is version ${facts.version}, older than 19, which has no JSON-2 API: the Odoo 14-18 (JSON-RPC) connector was installed instead.`,
      );
    }
    const databases = facts.databases ?? [];
    if (databases.length === 1 && settings.ODOO_DB !== databases[0]) {
      notes.push(
        settings.ODOO_DB
          ? `The database is called "${databases[0]}", not "${settings.ODOO_DB}": that name was used.`
          : `The database is called "${databases[0]}": that name was used.`,
      );
      settings.ODOO_DB = databases[0];
    } else if (databases.length > 1 && settings.ODOO_DB && !databases.includes(settings.ODOO_DB)) {
      notes.push(
        `This Odoo has no database "${settings.ODOO_DB}"; it serves ${databases
          .slice(0, 5)
          .map((d) => `"${d}"`)
          .join(', ')}. The user picks the right one on the linked page.`,
      );
      delete settings.ODOO_DB;
    }
    return { slug: target, notes };
  }

  /**
   * What a WooCommerce address says about itself, applied to a chat install
   * (woocommerce-setup.ts): WordPress's own address replaces the one passed;
   * no such host is refused; a problem the user fixes in WordPress (Plain
   * permalinks, WooCommerce inactive or too old, a firewall, no https) goes
   * into the notes, so the assistant tells it with the link. Nothing changes
   * when the address says nothing.
   */
  private async checkWooCommerceAddress(
    settings: Record<string, string>,
  ): Promise<{ notes: string[] } | { error: Record<string, unknown> }> {
    const typed = settings[WOOCOMMERCE_URL_VAR];
    const found = await this.adapters.inspectWooCommerceAddress(typed);
    if (!found) return { notes: [] };
    if (found.problem === 'dns') {
      return {
        error: {
          error: found.message,
          hint: 'Ask the user for the address their shop opens at in the browser (e.g. https://myshop.com), then install again.',
        },
      };
    }
    const notes: string[] = [];
    if (found.corrected && found.corrected !== typed) {
      settings[WOOCOMMERCE_URL_VAR] = found.corrected;
      notes.push(`WooCommerce answers at ${found.corrected}: that address was used instead of ${typed}.`);
    } else if (found.woocommerce) {
      notes.push(`WooCommerce found at ${found.home ?? typed}.`);
    }
    if (found.problem && found.message) {
      notes.push(
        `${found.message} Tell the user this before they create the key${found.fixUrl ? `, with the link ${found.fixUrl}` : ''}.`,
      );
    }
    return { notes };
  }

  // ── Status ────────────────────────────────────────────────────────────

  async status(ctx: SetupContext): Promise<SetupCallResult> {
    const rows = await this.prisma.connector.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        name: true,
        authType: true,
        authConfig: true,
        baseUrl: true,
        headers: true,
        envVars: true,
        config: true,
        createdAt: true,
        updatedAt: true,
        authStatus: true,
        authStatusMessage: true,
        authStatusAt: true,
        tools: { where: { isEnabled: true }, select: { endpointMapping: true } },
      },
    });
    // "ready" only means every value is filled in: a connector saved with a
    // wrong value ("Save anyway") is ready too. So each ready one also says
    // how its last call went, and one finished in the last day but never
    // used gets the setup check, with its stored values.
    const states = rows.map((r) => ({ row: r, state: this.stateOf(r) }));
    const checks = await this.readyChecks(
      ctx,
      states.filter(({ state }) => state.status === 'ready').map(({ row }) => row),
    );
    const now = Date.now();
    const out = [];
    let unfinished = 0;
    let refused = 0;
    for (const { row: r, state } of states) {
      const check = checks.get(r.id);
      // A catalog connector added (mostly from a chat) whose values were never
      // entered: 28 of the 41 WooCommerce connectors never called in Oct-Nov
      // 2026 still held {{WOOCOMMERCE_URL}}, their link long expired. After a
      // day the answer says so, so the assistant offers the new link.
      const waiting =
        state.status === 'needs_input' &&
        isCatalogConnector(r.config) &&
        r.createdAt instanceof Date &&
        now - r.createdAt.getTime() >= UNFINISHED_AFTER_MS;
      if (waiting) unfinished++;
      // The provider kept refusing the stored credential (connector-auth-status).
      const credentialRefused = state.status === 'ready' && r.authStatus === 'needs_reauth';
      if (credentialRefused) refused++;
      out.push({
        name: r.name,
        status: state.status,
        ...(state.status !== 'ready' ? { finishSetupUrl: await this.createLink(ctx, r.id) } : {}),
        ...(waiting ? { unfinishedSince: r.createdAt.toISOString() } : {}),
        ...(credentialRefused
          ? {
              credential: {
                ok: false,
                ...(r.authStatusAt ? { since: r.authStatusAt.toISOString() } : {}),
                message: String(r.authStatusMessage ?? 'The provider refuses the stored credential.').slice(0, 600),
              },
            }
          : {}),
        ...(check?.lastCall ? { lastCall: check.lastCall } : {}),
        ...(check?.check ? { check: check.check } : {}),
        ...(check?.check?.ok === false || credentialRefused ? { fixUrl: await this.createLink(ctx, r.id) } : {}),
      });
    }
    const trial = await this.trialAnswer(ctx);
    return {
      body: {
        connectors: out,
        ...(out.length === 0 ? { hint: 'No connectors yet: use setup_find_connectors.' } : {}),
        ...([...checks.values()].some((c) => c.check?.ok === false)
          ? { checkHint: 'check.ok false: the values saved on that connector do not work. Tell the user what check.message says and give them its fixUrl.' }
          : {}),
        ...(unfinished
          ? {
              unfinishedHint:
                'unfinishedSince: that connector was added but its setup was never finished, and the link given then has expired. ' +
                'Offer the user its finishSetupUrl (a new link, valid 30 minutes) as a clickable link, or ask whether to remove it.',
            }
          : {}),
        ...(refused
          ? {
              credentialHint:
                'credential.ok false: the provider has been refusing that connector\'s saved credentials. Tell the user what credential.message says and give them its fixUrl to enter new ones.',
            }
          : {}),
        ...(trial ? { trial } : {}),
      },
    };
  }

  /**
   * For ready connectors: the last call (worked or not, with the error), and
   * for at most three catalog connectors finished in the last 24 hours with no
   * call yet, the setup check run on their stored values.
   */
  private async readyChecks(
    ctx: SetupContext,
    ready: Array<{ id: string; config: unknown; updatedAt?: Date | null }>,
  ): Promise<Map<string, { lastCall?: Record<string, unknown>; check?: { ok: boolean; message?: string } }>> {
    const out = new Map<string, { lastCall?: Record<string, unknown>; check?: { ok: boolean; message?: string } }>();
    const lastCalls = await Promise.all(
      ready.map((r) =>
        this.prisma.toolInvocation
          .findFirst({
            where: { connectorId: r.id, organizationId: ctx.organizationId },
            orderBy: { createdAt: 'desc' },
            select: { status: true, error: true, createdAt: true },
          })
          .catch(() => null),
      ),
    );
    const unused: typeof ready = [];
    ready.forEach((r, i) => {
      const call = lastCalls[i];
      if (call) {
        out.set(r.id, {
          lastCall:
            call.status === 'SUCCESS'
              ? { ok: true, at: call.createdAt.toISOString() }
              : { ok: false, at: call.createdAt.toISOString(), error: String(call.error ?? call.status).slice(0, 240) },
        });
      } else if (r.updatedAt && Date.now() - r.updatedAt.getTime() < READY_CHECK_WINDOW_MS) {
        unused.push(r);
      }
    });
    const toCheck = unused
      .filter((r) => typeof (r.config as { adapterSlug?: unknown } | null)?.adapterSlug === 'string')
      .slice(0, READY_CHECKS_PER_STATUS);
    await Promise.all(
      toCheck.map(async (r) => {
        const slug = (r.config as { adapterSlug: string }).adapterSlug;
        const result = await Promise.resolve()
          .then(() => this.adapters.verifyCredentials(slug, ctx.organizationId, {}, r.id))
          .catch(() => null);
        if (!result || result.ok === null) return;
        out.set(r.id, { check: result.ok ? { ok: true } : { ok: false, message: result.message } });
      }),
    );
    return out;
  }

  /**
   * The workspace's free trial, as part of its status: days left and, for an
   * admin, the page where a plan is chosen. Facts only, in this one answer:
   * no other tool carries it, and nothing here tells the model what to say.
   * The card trial while 48 hours remain (the same end date, nothing charged
   * before it), the licence page after that. Members get no billing link.
   */
  private async trialAnswer(ctx: SetupContext): Promise<Record<string, unknown> | null> {
    const state = await this.licenseGuard.getTrialState(ctx.organizationId).catch(() => null);
    if (!state) return null;
    const member = await this.prisma.organizationMember
      .findFirst({
        where: { userId: ctx.userId, organizationId: ctx.organizationId, deactivatedAt: null },
        select: { role: true },
      })
      .catch(() => null);
    const admin = member?.role === 'ADMIN';
    const endsAt = state.endsAt.toISOString();

    if (!state.active) {
      return {
        ended: true,
        endedAt: endsAt,
        ...(admin
          ? { choosePlanUrl: `${ctx.dashboardBase}/settings/license?source=${CHAT_SETUP_SOURCE}`, afterTheTrial: 'The trial has ended. Choosing a plan turns the connectors back on.' }
          : { afterTheTrial: 'The trial has ended. A workspace administrator can choose a plan.' }),
      };
    }
    const daysLeft = Math.max(1, Math.ceil((state.endsAt.getTime() - Date.now()) / 86_400_000));
    if (!admin) {
      return { daysLeft, endsAt, afterTheTrial: 'A workspace administrator can choose a plan.' };
    }
    return state.cardTrialAvailable
      ? {
          daysLeft,
          endsAt,
          choosePlanUrl: `${ctx.dashboardBase}/start-trial?source=${CHAT_SETUP_SOURCE}`,
          afterTheTrial: 'Adding a card keeps the workspace running when the trial ends. Nothing is charged before then.',
        }
      : {
          daysLeft,
          endsAt,
          choosePlanUrl: `${ctx.dashboardBase}/settings/license?source=${CHAT_SETUP_SOURCE}`,
          afterTheTrial: 'Choosing a plan keeps the workspace running when the trial ends.',
        };
  }

  // ── Links ─────────────────────────────────────────────────────────────

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * A fresh one-time link to finish this connector, for this user. It names
   * the assistant the chat runs in, when known, so the setup page can send the
   * user back there; it is no secret and changes nothing else.
   */
  async createLink(
    ctx: Pick<SetupContext, 'userId' | 'organizationId' | 'dashboardBase' | 'assistant'>,
    connectorId: string,
  ): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    // Expired links stop working at once (resolveLink checks expiresAt); the
    // rows are kept a week so the share of links that get opened can be read.
    await this.prisma.connectorSetupLink
      .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - SETUP_LINK_RETENTION_MS) } } })
      .catch(() => undefined);
    await this.prisma.connectorSetupLink.create({
      data: {
        tokenHash: this.hash(token),
        connectorId,
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        expiresAt: new Date(Date.now() + SETUP_LINK_TTL_MS),
      },
    });
    const from = ctx.assistant && RETURN_ASSISTANTS.includes(ctx.assistant) ? `?from=${ctx.assistant}` : '';
    return `${ctx.dashboardBase}/s/${token}${from}`;
  }

  /**
   * Open a link: valid, unused, not expired, and opened by the user it was
   * made for. Marks it used and returns where the dashboard should go.
   */
  async resolveLink(
    token: string,
    userId: string,
    from?: unknown,
  ): Promise<{ redirect: string; organizationId: string } | { error: string }> {
    const row = await this.prisma.connectorSetupLink.findUnique({ where: { tokenHash: this.hash(String(token || '')) } });
    if (!row || row.expiresAt.getTime() < Date.now()) {
      return { error: 'This link has expired. Ask your AI client for a new one, or open the connector in the dashboard.' };
    }
    if (row.userId !== userId) {
      return { error: 'This link was made for another account. Sign in as that account.' };
    }
    // Opened again by the same user (a second click, a reload, a link
    // preview) it still works until it expires: it is bound to that user and
    // needs their session, so a second opening gives nobody else anything.
    // usedAt records the first opening.
    if (!row.usedAt) {
      await this.prisma.connectorSetupLink.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    }
    const connector = await this.prisma.connector.findFirst({
      where: { id: row.connectorId, organizationId: row.organizationId },
      select: { id: true, config: true },
    });
    if (!connector) return { error: 'This connector no longer exists.' };
    const slug = (connector.config as { adapterSlug?: string } | null)?.adapterSlug;
    // A setup link always comes from a chat. The assistant named on the link
    // when it was made, or a neutral "your AI assistant" (links made before
    // they named one, and clients that are not recognised).
    const back = RETURN_ASSISTANTS.find((a) => a === from) ?? 'assistant';
    return {
      redirect: slug
        ? `/connectors/setup/${encodeURIComponent(slug)}?connector=${encodeURIComponent(connector.id)}&from=${back}`
        : `/connectors/${encodeURIComponent(connector.id)}`,
      // The workspace the connector is in: the dashboard switches to it when
      // its session is on another one, or every save would be refused.
      organizationId: row.organizationId,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private takeInstallSlot(userId: string, now = Date.now()): boolean {
    const recent = (this.installs.get(userId) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= INSTALLS_PER_HOUR) {
      this.installs.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.installs.set(userId, recent);
    return true;
  }

  /**
   * importAdapter put the connector on the user's own server. The connection
   * may be granted a different one (a teammate's, a picked one): put it there
   * too, or the chat that installed it would not see it.
   */
  private async attachToGrantedServers(ctx: SetupContext, connectorId: string): Promise<void> {
    if (ctx.serverIds.length === 0) return;
    const servers = await this.prisma.mcpServerConfig.findMany({
      where: { id: { in: ctx.serverIds }, organizationId: ctx.organizationId, isActive: true },
      select: { id: true },
    });
    for (const s of servers) {
      await this.prisma.mcpServerConnector
        .create({ data: { mcpServerId: s.id, connectorId } })
        .catch(() => undefined); // already there
    }
  }

  /** Where a connector stands: ready, needs_input (with the missing variables) or needs_authorization. */
  connectorStatus(connectorId: string): Promise<{ status: string; missing: string[] }> {
    return this.connectorState(connectorId) as Promise<{ status: string; missing: string[] }>;
  }

  private async connectorState(connectorId: string) {
    const row = await this.prisma.connector.findUnique({
      where: { id: connectorId },
      select: {
        authType: true,
        authConfig: true,
        baseUrl: true,
        headers: true,
        envVars: true,
        config: true,
        tools: { where: { isEnabled: true }, select: { endpointMapping: true } },
      },
    });
    return row ? this.stateOf(row) : { status: 'needs_input' as const, missing: [] as string[] };
  }

  private stateOf(row: {
    authType: string;
    authConfig: string | null;
    baseUrl: string;
    headers: unknown;
    envVars: unknown;
    config: unknown;
    tools?: Array<{ endpointMapping: unknown }>;
  }) {
    let authConfig: unknown;
    try {
      authConfig = row.authConfig ? JSON.parse(decrypt(row.authConfig, process.env.ENCRYPTION_KEY || '')) : undefined;
    } catch {
      authConfig = undefined;
    }
    return computeSetupState({
      authType: row.authType,
      authConfig,
      baseUrl: row.baseUrl,
      headers: row.headers,
      envVars: row.envVars,
      config: row.config,
      toolMappings: row.tools?.map((t) => t.endpointMapping),
    });
  }
}

/** A broken pattern in an adapter never blocks an install. */
function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

