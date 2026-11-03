import { Logger } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import { ProductEvents, type ProductEventService } from '../audit/product-event.service';
import { trialReactivationUrl } from '../license/license-checkout';

/**
 * A tool call refused because the workspace's Cloud trial ended
 * (TrialEndedException): what the AI client is told, and the
 * `trial_expired_call_blocked` event that records it.
 *
 * Self-hosted never gets here: the licence guard returns before any check
 * outside Cloud.
 */

/** At most one event per workspace and tool in this window. */
export const BLOCKED_CALL_WINDOW_MS = 60 * 60 * 1000;

/** "28 October 2026": the day a trial ended, in UTC like the emails. */
function endedOn(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The tool result's text: what happened, that nothing was lost, and the link
 * an administrator reactivates the workspace with, which the AI is asked to
 * show. The link carries no email token, since this text reaches the AI
 * provider.
 */
export function trialEndedToolResult(
  trialEndedAt: Date | null,
  url: string = trialReactivationUrl(),
): { error: string; reactivateUrl: string } {
  const ended = trialEndedAt ? `ended on ${endedOn(trialEndedAt)}` : 'has ended';
  return {
    error:
      `This workspace's AnythingMCP trial ${ended}. Its connectors and settings are kept. ` +
      'To keep using this tool, an administrator can reactivate the workspace. ' +
      // The link comes last, so no punctuation sticks to it when it is shown.
      `Show this link to the user: ${url}`,
    reactivateUrl: url,
  };
}

/**
 * In-memory half of the throttle: one slot per workspace and tool per window.
 * The slot is taken before the database is asked, so calls arriving together
 * on this process are counted once. Bounded: past `maxEntries`, expired
 * entries are dropped, then the oldest.
 */
export class BlockedCallThrottle {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly windowMs = BLOCKED_CALL_WINDOW_MS,
    private readonly maxEntries = 10_000,
  ) {}

  /** True, and the slot taken, when this pair has no slot in the window. */
  take(organizationId: string, toolName: string, now = Date.now()): boolean {
    const key = `${organizationId}\u0000${toolName}`;
    const at = this.last.get(key);
    if (at !== undefined && now - at < this.windowMs) return false;
    if (this.last.size >= this.maxEntries) this.prune(now);
    // Re-inserting moves the key to the end, so insertion order stays oldest first.
    this.last.delete(key);
    this.last.set(key, now);
    return true;
  }

  get size(): number {
    return this.last.size;
  }

  private prune(now: number): void {
    for (const [key, at] of this.last) {
      if (now - at >= this.windowMs) this.last.delete(key);
    }
    for (const key of this.last.keys()) {
      if (this.last.size < this.maxEntries) break;
      this.last.delete(key);
    }
  }
}

export interface BlockedCallInput {
  organizationId: string;
  userId?: string;
  toolName: string;
  /** The catalog adapter of the tool's connector; absent for custom ones. */
  adapterSlug?: string;
  /** The OAuth client the access token was issued to, when there is one. */
  oauthClientId?: string;
}

/**
 * Writes `trial_expired_call_blocked`, throttled per workspace and tool: the
 * in-memory map first, then a look at the table for a row in the last hour
 * (another process, or one from before a restart). Never throws and is not
 * awaited by the tool call: a lost event must not slow or break the answer.
 */
export class TrialBlockedCallRecorder {
  private readonly logger = new Logger(TrialBlockedCallRecorder.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly productEvents: ProductEventService | undefined,
    private readonly throttle = new BlockedCallThrottle(),
  ) {}

  async record(input: BlockedCallInput, now = Date.now()): Promise<void> {
    if (!this.productEvents) return;
    try {
      if (!this.throttle.take(input.organizationId, input.toolName, now)) return;
      const recent = await this.prisma.productEvent.findFirst({
        where: {
          event: ProductEvents.TRIAL_EXPIRED_CALL_BLOCKED,
          organizationId: input.organizationId,
          createdAt: { gte: new Date(now - BLOCKED_CALL_WINDOW_MS) },
          metadata: { path: ['toolName'], equals: input.toolName },
        },
        select: { id: true },
      });
      if (recent) return;
      const client = input.oauthClientId
        ? (
            await this.prisma.oAuthClient.findUnique({
              where: { clientId: input.oauthClientId },
              select: { clientName: true },
            })
          )?.clientName
        : undefined;
      await this.productEvents.log({
        event: ProductEvents.TRIAL_EXPIRED_CALL_BLOCKED,
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        metadata: {
          toolName: input.toolName,
          ...(input.adapterSlug ? { adapterSlug: input.adapterSlug } : {}),
          ...(client ? { client } : {}),
        },
      });
    } catch (err: any) {
      this.logger.warn(`Blocked trial call not recorded: ${err?.message ?? err}`);
    }
  }
}
