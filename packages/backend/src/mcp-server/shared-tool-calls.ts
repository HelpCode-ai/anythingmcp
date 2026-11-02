import { Logger } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import { ProductEvents, type ProductEventService } from '../audit/product-event.service';
import type { SetupToolName, SharedToolsetProfile } from './shared-toolset';

/**
 * The `shared_tool_called` event: which tools of the shared `/mcp` set a
 * workspace calls at all (connector tool calls have their own log and table;
 * these meta tools and the setup tools behind them had none).
 *
 * At most one row per workspace, tool (and setup tool) and UTC day, so the
 * table answers "did this workspace ever call list_connectors / search /
 * setup_find_connectors, and on which days" without a write per call. The
 * in-process map is checked first, so a busy connection costs one database
 * read per key and day at most; the read catches a row written by another
 * process or before a restart. Two processes can still both write the first
 * row of a day: rare, and harmless for a "did it happen" count.
 */
export interface SharedToolCall {
  organizationId: string;
  userId?: string | null;
  /** The listed tool that was called. */
  tool: string;
  /** For run_read_tool / run_write_tool on AnythingMCP Setup: which setup tool. */
  setupTool?: SetupToolName;
  profile: SharedToolsetProfile;
  /** The OAuth client the access token was issued to, when there is one. */
  oauthClientId?: string;
}

/** "2026-11-02": the UTC day a call falls on. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function startOfUtcDay(now: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Keys already recorded, oldest first. Bounded: past `maxEntries` the oldest
 * key is dropped, which at worst costs one more database read for it.
 */
export class DailyKeySet {
  private readonly keys = new Set<string>();

  constructor(private readonly maxEntries = 20_000) {}

  /** True, and the key remembered, when it was not there yet. */
  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    if (this.keys.size >= this.maxEntries) {
      const oldest = this.keys.values().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
    this.keys.add(key);
    return true;
  }

  get size(): number {
    return this.keys.size;
  }
}

export class SharedToolCallRecorder {
  private readonly logger = new Logger(SharedToolCallRecorder.name);

  constructor(
    private readonly prisma: Pick<PrismaService, 'productEvent' | 'oAuthClient'>,
    private readonly productEvents: Pick<ProductEventService, 'log'>,
    private readonly seen = new DailyKeySet(),
  ) {}

  /** Never throws; callers do not await it, so a call is never slowed by it. */
  async record(call: SharedToolCall, now = Date.now()): Promise<void> {
    try {
      const key = [utcDay(now), call.organizationId, call.tool, call.setupTool ?? ''].join('\u0000');
      if (!this.seen.add(key)) return;
      const today = await this.prisma.productEvent.findMany({
        where: {
          event: ProductEvents.SHARED_TOOL_CALLED,
          organizationId: call.organizationId,
          createdAt: { gte: startOfUtcDay(now) },
          metadata: { path: ['tool'], equals: call.tool },
        },
        select: { metadata: true },
        take: 10,
      });
      const same = today.some(
        (row) => ((row.metadata as { setupTool?: unknown } | null)?.setupTool ?? undefined) === call.setupTool,
      );
      if (same) return;
      const client = call.oauthClientId
        ? (
            await this.prisma.oAuthClient.findUnique({
              where: { clientId: call.oauthClientId },
              select: { clientName: true },
            })
          )?.clientName
        : undefined;
      await this.productEvents.log({
        event: ProductEvents.SHARED_TOOL_CALLED,
        organizationId: call.organizationId,
        userId: call.userId ?? null,
        metadata: {
          tool: call.tool,
          profile: call.profile,
          ...(call.setupTool ? { setupTool: call.setupTool } : {}),
          ...(client ? { client } : {}),
        },
      });
    } catch (err: any) {
      this.logger.warn(`Shared tool call not recorded: ${err?.message ?? err}`);
    }
  }
}
