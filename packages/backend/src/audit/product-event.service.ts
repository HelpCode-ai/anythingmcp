import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

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
} as const;

export type ProductEventName = (typeof ProductEvents)[keyof typeof ProductEvents];

const ALLOWED = new Set<string>(Object.values(ProductEvents));
const MAX_METADATA_BYTES = 1024;

@Injectable()
export class ProductEventService {
  private readonly logger = new Logger(ProductEventService.name);

  constructor(private readonly prisma: PrismaService) {}

  isKnown(event: unknown): event is ProductEventName {
    return typeof event === 'string' && ALLOWED.has(event);
  }

  /** Best-effort and never throws: a lost event must not break the page. */
  async log(input: {
    event: ProductEventName;
    userId?: string | null;
    organizationId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      const metadata = boundMetadata(input.metadata);
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
}

/**
 * Metadata keys a page may send. Anything else is dropped: the events carry
 * a client name or a server id, nothing that should ever be a secret, and a
 * fixed key set is what keeps an untrusted body from choosing property names.
 */
const METADATA_KEYS = ['client', 'serverId', 'connectorId', 'adapterSlug'] as const;

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
