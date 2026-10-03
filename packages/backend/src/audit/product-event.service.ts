import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AttributionClickId, clickIdFromAttribution, sanitizeSignupAttribution } from './signup-attribution';

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
} as const;

export type ProductEventName = (typeof ProductEvents)[keyof typeof ProductEvents];

/**
 * Events only the server writes. A signed-in user could otherwise post a
 * `signup_attributed` of their own and skew the channel report.
 */
const SERVER_ONLY = new Set<string>([
  ProductEvents.SIGNUP_ATTRIBUTED,
  ProductEvents.AI_CLIENT_CONNECTED,
  ProductEvents.EMPTY_WORKSPACE_PROMPT,
]);
const CLIENT_REPORTABLE = new Set<string>(
  Object.values(ProductEvents).filter((e) => !SERVER_ONLY.has(e)),
);
const MAX_METADATA_BYTES = 1024;
/** Two touches of up to fifteen capped fields each, three of them click ids of up to 150 chars. */
const MAX_ATTRIBUTION_BYTES = 5120;

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
   * The Google Ads click id this user signed up through, if they granted ad
   * consent: read from their own `signup_attributed` event only, keyed by the
   * user id alone. Null when there is none.
   */
  async clickIdForUser(userId: string | null | undefined): Promise<AttributionClickId | null> {
    if (!userId) return null;
    const rows = await this.prisma.productEvent.findMany({
      where: { userId, event: ProductEvents.SIGNUP_ATTRIBUTED },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { metadata: true },
    });
    for (const row of rows) {
      const found = clickIdFromAttribution(row.metadata);
      if (found) return found;
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
const METADATA_KEYS = ['client', 'serverId', 'connectorId', 'adapterSlug', 'kind', 'via'] as const;

function boundMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean> | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const entries: Array<[string, string | number | boolean]> = [];
  for (const key of METADATA_KEYS) {
    const v = metadata[key];
    if (typeof v === 'string') entries.push([key, v.slice(0, 200)]);
    else if (typeof v === 'number' || typeof v === 'boolean') entries.push([key, v]);
  }
  if (entries.length === 0) return null;
  const out = Object.fromEntries(entries);
  return JSON.stringify(out).length > MAX_METADATA_BYTES ? null : out;
}

/** The attribution pair, re-sanitized here so no caller can store anything else. */
function boundAttribution(metadata: unknown): Record<string, unknown> | null {
  const out = sanitizeSignupAttribution(metadata);
  if (!out) return null;
  return JSON.stringify(out).length > MAX_ATTRIBUTION_BYTES ? null : out;
}
