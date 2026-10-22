import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AttributionClickId, clickIdFromAttribution, sanitizeSignupAttribution } from './signup-attribution';
import { CHECKOUT_SOURCES } from '../license/license-checkout';

/**
 * Product-usage events the UI reports so the activation funnel can be read
 * step by step instead of from its two ends.
 *
 * The allow-list is the contract: a client cannot invent event names, and a
 * name that is not here is dropped rather than stored. Add to it when a page
 * gains a step worth measuring, and say in the comment what question the
 * event answers.
 */
export const ProductEvents = {
  /** Landed on the post-attach page (the one that shows the MCP endpoint). */
  POST_ATTACH_VIEWED: 'post_attach_viewed',
  /** Copied the MCP endpoint URL. */
  MCP_URL_COPIED: 'mcp_url_copied',
  /** Opened a client's Quick Connect instructions. metadata.client = which. */
  CLIENT_TAB_OPENED: 'client_tab_opened',
  /** Copied a ready-made client config or command. metadata.client = which. */
  CLIENT_CONFIG_COPIED: 'client_config_copied',
  /** Generated an MCP API key on the page. */
  API_KEY_GENERATED: 'api_key_generated',
  /** Left the post-attach page having copied nothing at all. */
  LEFT_WITHOUT_COPY: 'left_page_without_copy',
  /**
   * Watched the first MCP request arrive live on the connect page (the
   * connection check turned green). Answers: does the live check help people
   * finish connecting, read against post_attach_viewed.
   */
  FIRST_CALL_SEEN: 'first_call_seen',
  /** Saw the starter pack on /welcome. Read against the next one: how many take it. */
  STARTER_PACK_VIEWED: 'starter_pack_viewed',
  /** Installed connectors from the starter pack. metadata.adapterSlug = comma list. */
  STARTER_PACK_INSTALLED: 'starter_pack_installed',
  /**
   * The guided connector setup (/connectors/setup/<slug>). metadata.adapterSlug
   * on all of them; read in order they answer where a setup is abandoned:
   * opened, credentials refused (metadata.kind = auth_failed, invalid_input…),
   * sent to the provider's sign-in, finished, or kept as a draft / unverified.
   */
  SETUP_STARTED: 'setup_started',
  SETUP_VERIFY_FAILED: 'setup_verify_failed',
  OAUTH_STARTED: 'oauth_started',
  SETUP_COMPLETED: 'setup_completed',
  SETUP_SAVED_DRAFT: 'setup_saved_draft',
  /**
   * The provider sign-in of a guided setup failed: refused at the provider
   * (metadata.kind = 'provider_refused', metadata.error = its error code) or
   * the code could not be exchanged ('token_exchange'). Server-only. Answers
   * why setups that reach oauth_started never complete.
   */
  OAUTH_FAILED: 'oauth_failed',
  SETUP_SAVED_UNVERIFIED: 'setup_saved_unverified',
  /**
   * A new cloud account was created; metadata = the first and last touch the
   * visitor arrived through (see signup-attribution.ts). Written by the
   * server on sign-up, never accepted from a client. Answers: which channel
   * brings sign-ups, verified sign-ups and paying customers.
   */
  SIGNUP_ATTRIBUTED: 'signup_attributed',
  /**
   * A user connected an AI client (Claude, ChatGPT…) through the OAuth flow
   * for the first time; metadata.client = the client's name. Server-only.
   * Answers: how many sign-ups reach the client, and how many of those then
   * add a connector (read against the connectors table).
   */
  AI_CLIENT_CONNECTED: 'ai_client_connected',
  /**
   * Cloud: after approving an AI client, the user was told their workspace
   * is empty and shown how to add an app (chat or dashboard). Server-only.
   * Read against setup_completed: does the prompt lead to a first connector.
   */
  EMPTY_WORKSPACE_PROMPT: 'empty_workspace_prompt',
  /**
   * A search of the connector catalog: metadata.query, metadata.results (how
   * many connectors matched), metadata.via (where: 'store', 'welcome', or
   * 'mcp' when the model searched from a chat), metadata.missing (the words no
   * connector matches) and, when there are results, metadata.match: 'direct',
   * or 'fuzzy' (found only with a typo forgiven, "telgram") or 'partial'
   * (only some of the words matched). Answers: which apps people look for that
   * we have no connector for (results = 0, or missing set), and which we have
   * but they did not take (read against catalog_search_picked).
   */
  CATALOG_SEARCH: 'catalog_search',
  /** A result was picked after a search. metadata.query, adapterSlug, via. */
  CATALOG_SEARCH_PICKED: 'catalog_search_picked',
  /**
   * Cloud: the workspace's first successful tool call was handed to the
   * licence site, to be uploaded to Google Ads as an activation conversion
   * against the sign-up's click id (see ads-activation.service.ts), and to
   * ChatGPT Ads when the sign-up carried an `oppref`. Once per workspace;
   * metadata.kind = which click id (gclid, gbraid, wbraid, oppref; two
   * joined by "+" when the sign-up carried both),
   * metadata.status = the site's HTTP answer (2xx queued, 4xx refused for
   * good). Server-only. Its presence is what stops a second report.
   */
  ADS_ACTIVATION_REPORTED: 'ads_activation_reported',
  /**
   * Cloud: a user who signed up from a ChatGPT Ads click (an `oppref` stored
   * with ad consent) verified their email address, and the licence site was
   * told, to report the verified sign-up to ChatGPT Ads (see
   * ads-signup.service.ts). Once per user; metadata.kind = 'oppref',
   * metadata.status = the site's HTTP answer. Server-only.
   */
  ADS_SIGNUP_REPORTED: 'ads_signup_reported',
  /**
   * Cloud: a workspace on the no-card trial made its first successful tool
   * call and is offered the card trial in the app and by email (see
   * card-trial-offer.ts). Once per workspace; metadata.connectorId,
   * adapterSlug and toolName = the call that did it. Server-only.
   */
  CARD_TRIAL_OFFER_ELIGIBLE: 'card_trial_offer_eligible',
  /**
   * The in-app offer, as an admin saw it (at most once a day per user and
   * browser), clicked its button, or dismissed it. metadata.via = the page:
   * 'dashboard', 'connectors' or 'connect'. Read against the eligible event.
   */
  CARD_TRIAL_OFFER_SHOWN: 'card_trial_offer_shown',
  CARD_TRIAL_OFFER_CLICKED: 'card_trial_offer_clicked',
  CARD_TRIAL_OFFER_DISMISSED: 'card_trial_offer_dismissed',
  /**
   * The offer email went out to the workspace's admins. metadata.connectorId,
   * metadata.kind = 'trial' (linked to the card trial) or 'plan' (under 48 h
   * of trial left, linked to the plans). Server-only.
   */
  CARD_TRIAL_OFFER_EMAILED: 'card_trial_offer_emailed',
  /**
   * The card-trial page (/start-trial) was opened, once per page load.
   * metadata.source = the entry point that led there (CHECKOUT_SOURCES in
   * license-checkout.ts, e.g. 'first_success_banner', 'first_success_email',
   * 'trial_banner'), metadata.kind = 'trial' (card trial on offer), 'pay'
   * (the address had a subscription, the plan is billed today) or 'ending'
   * (under 48 hours of the free trial left, billed today too). Answers how
   * many clicks on each entry point, emails included, reach the page.
   */
  START_TRIAL_VIEWED: 'start_trial_viewed',
  /**
   * Its checkout button was pressed: metadata.source and metadata.kind as
   * above. Read against start_trial_viewed (who leaves without trying) and
   * checkout_link_created (who reaches Stripe).
   */
  START_TRIAL_CHECKOUT_STARTED: 'start_trial_checkout_started',
  /**
   * "Continue without payment details" (or "Try free without payment
   * details") was pressed: metadata.source and metadata.kind as above. Tells
   * "chose the no-card trial" apart from "closed the tab", which records
   * nothing.
   */
  START_TRIAL_SKIPPED: 'start_trial_skipped',
  /**
   * The app minted a Stripe Checkout link (POST /api/license/checkout-link).
   * metadata.via = the entry point it came from (CHECKOUT_SOURCES, 'app' when
   * the page did not say), metadata.kind = 'trial' (card trial) or 'pay'.
   * Server-only. Answers how many clicks reach Checkout; Stripe says how many
   * finish (metadata.checkout_source, the same value).
   */
  CHECKOUT_LINK_CREATED: 'checkout_link_created',
} as const;

export type ProductEventName = (typeof ProductEvents)[keyof typeof ProductEvents];

/**
 * Events only the server writes. A signed-in user could otherwise post a
 * `signup_attributed` of their own and skew the channel report.
 */
const SERVER_ONLY = new Set<string>([
  ProductEvents.SIGNUP_ATTRIBUTED,
  ProductEvents.OAUTH_FAILED,
  ProductEvents.AI_CLIENT_CONNECTED,
  ProductEvents.EMPTY_WORKSPACE_PROMPT,
  ProductEvents.ADS_ACTIVATION_REPORTED,
  ProductEvents.ADS_SIGNUP_REPORTED,
  ProductEvents.CARD_TRIAL_OFFER_ELIGIBLE,
  ProductEvents.CARD_TRIAL_OFFER_EMAILED,
  ProductEvents.CHECKOUT_LINK_CREATED,
]);
const CLIENT_REPORTABLE = new Set<string>(
  Object.values(ProductEvents).filter((e) => !SERVER_ONLY.has(e)),
);
const MAX_METADATA_BYTES = 1024;
/**
 * Two touches of up to sixteen capped fields each: three Google click ids of
 * up to 150 chars and an `oppref` of up to 500.
 */
const MAX_ATTRIBUTION_BYTES = 6144;

@Injectable()
export class ProductEventService {
  private readonly logger = new Logger(ProductEventService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Whether a client may report this event. Server-only events are not. */
  isKnown(event: unknown): event is ProductEventName {
    return typeof event === 'string' && CLIENT_REPORTABLE.has(event);
  }

  /** Best-effort and never throws: a lost event must not break the page. */
  async log(input: {
    event: ProductEventName;
    userId?: string | null;
    organizationId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      const metadata =
        input.event === ProductEvents.SIGNUP_ATTRIBUTED
          ? boundAttribution(input.metadata)
          : boundMetadata(input.metadata);
      await this.prisma.productEvent.create({
        data: {
          event: input.event,
          userId: input.userId ?? null,
          organizationId: input.organizationId ?? null,
          metadata: metadata as any,
        },
      });
    } catch (err: any) {
      this.logger.warn(`product event ${input.event} not recorded: ${err?.message ?? err}`);
    }
  }

  /**
   * The ad click ids this user signed up through (one Google id, an
   * `oppref`, or both), if they granted ad consent: read from their own `signup_attributed` event only, keyed by the
   * user id alone. Null when there is none.
   */
  async clickIdForUser(userId: string | null | undefined): Promise<AttributionClickId | null> {
    if (!userId) return null;
    return (await this.signupClickId({ userId }))?.clickId ?? null;
  }

  /**
   * The same for a workspace: the click id of the sign-up that created it,
   * with the user who signed up (null if that account is gone). Null when
   * the sign-up carried no click id with ad consent granted.
   */
  async clickIdForOrganization(
    organizationId: string | null | undefined,
  ): Promise<{ clickId: AttributionClickId; userId: string | null } | null> {
    if (!organizationId) return null;
    return this.signupClickId({ organizationId });
  }

  /** Newest `signup_attributed` rows first; the first that yields an id wins. */
  private async signupClickId(
    where: { userId: string } | { organizationId: string },
  ): Promise<{ clickId: AttributionClickId; userId: string | null } | null> {
    const rows = await this.prisma.productEvent.findMany({
      where: { ...where, event: ProductEvents.SIGNUP_ATTRIBUTED },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { metadata: true, userId: true },
    });
    for (const row of rows) {
      const clickId = clickIdFromAttribution(row.metadata);
      if (clickId) return { clickId, userId: row.userId ?? null };
    }
    return null;
  }
}

/**
 * Metadata keys a page may send. Anything else is dropped: the events carry
 * a client name or a server id, nothing that should ever be a secret, and a
 * fixed key set is what keeps an untrusted body from choosing property names.
 */
// `kind`: what a setup involved or why its check failed ('credentials',
// 'auth'); `via`: where a connector was set up ('mcp' when from the chat).
// `query`, `results`, `missing`, `match`: a catalog search (see
// sanitizeSearchQuery); `missing` = the query's words no connector matches,
// `match` = how the results matched (see CATALOG_SEARCH).
// `status`, `toolName`, `error`: why a setup check or sign-in failed (the
// provider's message, passed through scrubProviderMessage by the server);
// `verified`: whether a completed setup made a successful call.
// `source`: the entry point that led to /start-trial (start_trial_viewed,
// start_trial_checkout_started); only the CHECKOUT_SOURCES values are kept.
// `device`: 'mobile' (a touch screen) or 'desktop', on start_trial_viewed;
// nothing finer, and any other value is dropped.
const METADATA_KEYS = [
  'client', 'serverId', 'connectorId', 'adapterSlug', 'kind', 'via', 'query', 'results', 'missing', 'match',
  'status', 'toolName', 'error', 'verified', 'cardTrialOffered', 'source', 'device',
] as const;
const DEVICE_KINDS = new Set(['mobile', 'desktop']);
const KNOWN_CHECKOUT_SOURCES = new Set<string>(CHECKOUT_SOURCES);
const MAX_QUERY_LENGTH = 100;
/** The values of `match` (see catalog-search.ts). */
const SEARCH_MATCH_KINDS = new Set(['direct', 'fuzzy', 'partial']);

function boundMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean> | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const entries: Array<[string, string | number | boolean]> = [];
  for (const key of METADATA_KEYS) {
    const v =
      key === 'query' || key === 'missing'
        ? sanitizeSearchQuery(metadata[key])
        : key === 'match'
          ? (SEARCH_MATCH_KINDS.has(metadata[key] as string) ? metadata[key] : null)
          : key === 'source'
            ? (KNOWN_CHECKOUT_SOURCES.has(metadata[key] as string) ? metadata[key] : null)
            : key === 'device'
              ? (DEVICE_KINDS.has(metadata[key] as string) ? metadata[key] : null)
              : metadata[key];
    if (typeof v === 'string') entries.push([key, v.slice(0, 200)]);
    else if (typeof v === 'number' || typeof v === 'boolean') entries.push([key, v]);
  }
  if (entries.length === 0) return null;
  const out = Object.fromEntries(entries);
  return JSON.stringify(out).length > MAX_METADATA_BYTES ? null : out;
}

/**
 * A search box's text, kept only when it reads like the name of an app.
 *
 * What people type is free text, so it can hold what should not be stored:
 * an email address, or a key pasted into the wrong field. Those are dropped
 * whole rather than masked; a search for an app name never looks like either.
 */
export function sanitizeSearchQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const q = value.replace(/\s+/g, ' ').trim();
  if (!q || q.length > MAX_QUERY_LENGTH) return null;
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(q)) return null;
  // One unbroken run of 24+ letters, digits and key punctuation: a token, not a name.
  if (/[A-Za-z0-9_\-.:/+=]{24,}/.test(q) && /\d/.test(q)) return null;
  return q;
}

/**
 * A provider's error message, made safe to keep: query strings dropped from
 * URLs (keys travel there), any of the given secret values masked, long
 * token-like runs masked, and the whole capped at 160 characters.
 *
 * The message comes from a vendor or an OAuth callback, so it can be long and
 * crafted. Secrets are masked on the whole text (a plain split, no regex), then
 * only the first SCRUB_INPUT_LIMIT characters reach the regexes, and those are
 * linear: the URL one used to rescan the rest of the input from every
 * `http://` of `http://http://…` (CodeQL js/polynomial-redos).
 */
const SCRUB_INPUT_LIMIT = 2000;

export function scrubProviderMessage(message: unknown, secrets: unknown[] = []): string | null {
  if (typeof message !== 'string' || !message.trim()) return null;
  let out = message;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('***');
  }
  out = out.slice(0, SCRUB_INPUT_LIMIT);
  // Each URL is matched once (the match always succeeds and the scan moves on
  // past it), then cut at its first ? or #.
  out = out.replace(/https?:\/\/[^\s"']*/g, (url) => {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  });
  out = out.replace(/[A-Za-z0-9_\-.+/=]{32,}/g, '***');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 160 ? `${out.slice(0, 159)}…` : out;
}

/** The attribution pair, re-sanitized here so no caller can store anything else. */
function boundAttribution(metadata: unknown): Record<string, unknown> | null {
  const out = sanitizeSignupAttribution(metadata);
  if (!out) return null;
  return JSON.stringify(out).length > MAX_ATTRIBUTION_BYTES ? null : out;
}
