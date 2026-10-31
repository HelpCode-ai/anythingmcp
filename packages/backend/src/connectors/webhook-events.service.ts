import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/** Default retention window and per-connector row cap, both configurable. */
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_EVENTS_PER_CONNECTOR = 500;

const RETENTION_SWEEP_FIRST_MS = 60 * 1000;
const RETENTION_SWEEP_MS = 60 * 60 * 1000;

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export interface RecordWebhookEventInput {
  connectorId: string;
  organizationId: string;
  provider: string;
  eventType?: string;
  externalId?: string;
  payload: unknown;
}

export interface RecentWebhookEvent {
  id: string;
  provider: string;
  eventType: string | null;
  externalId: string | null;
  payload: unknown;
  receivedAt: Date;
}

/**
 * Stores verified inbound webhook deliveries and keeps storage bounded two
 * ways: a cap enforced on every insert (so a burst never grows a connector's
 * row count past it even between sweeps), and a periodic sweep that deletes
 * rows older than the retention window, shaped like
 * ConnectorAuthStatusService's (setTimeout first run, then setInterval, both
 * unref()'d so they never keep the process alive).
 *
 * WEBHOOK_EVENT_RETENTION_DAYS and WEBHOOK_EVENT_MAX_PER_CONNECTOR are env-
 * configurable; see docs/operations/observability.md.
 */
@Injectable()
export class WebhookEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookEventsService.name);
  private sweepTimer?: ReturnType<typeof setInterval>;
  private firstSweep?: ReturnType<typeof setTimeout>;

  private readonly retentionDays = intEnv('WEBHOOK_EVENT_RETENTION_DAYS', DEFAULT_RETENTION_DAYS);
  private readonly maxPerConnector = intEnv(
    'WEBHOOK_EVENT_MAX_PER_CONNECTOR',
    DEFAULT_MAX_EVENTS_PER_CONNECTOR,
  );

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    const sweep = () => void this.sweepExpired();
    this.firstSweep = setTimeout(sweep, RETENTION_SWEEP_FIRST_MS);
    this.firstSweep.unref?.();
    this.sweepTimer = setInterval(sweep, RETENTION_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.firstSweep) clearTimeout(this.firstSweep);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /**
   * Stores a verified event and enforces the per-connector cap. Returns
   * false instead of throwing on a duplicate `externalId` for the same
   * connector (at-least-once redelivery), so callers can still answer the
   * provider with 200.
   */
  async recordEvent(input: RecordWebhookEventInput): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          connectorId: input.connectorId,
          organizationId: input.organizationId,
          provider: input.provider,
          eventType: input.eventType,
          externalId: input.externalId,
          payload: input.payload as any,
        },
      });
    } catch (err: any) {
      if (err.code === 'P2002') return false; // duplicate externalId: already recorded
      throw err;
    }
    await this.enforceCap(input.connectorId);
    return true;
  }

  private async enforceCap(connectorId: string): Promise<void> {
    const count = await this.prisma.webhookEvent.count({ where: { connectorId } });
    const overflow = count - this.maxPerConnector;
    if (overflow <= 0) return;
    const oldest = await this.prisma.webhookEvent.findMany({
      where: { connectorId },
      orderBy: { receivedAt: 'asc' },
      take: overflow,
      select: { id: true },
    });
    await this.prisma.webhookEvent.deleteMany({
      where: { id: { in: oldest.map((r) => r.id) } },
    });
  }

  /** Org-scoped: every caller of this must already have verified connectorId belongs to organizationId. */
  async recentEvents(
    connectorId: string,
    organizationId: string,
    opts: { limit?: number; since?: string } = {},
  ): Promise<RecentWebhookEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const since = opts.since ? new Date(opts.since) : undefined;
    const rows = await this.prisma.webhookEvent.findMany({
      where: {
        connectorId,
        organizationId,
        ...(since && !Number.isNaN(since.getTime()) ? { receivedAt: { gte: since } } : {}),
      },
      orderBy: { receivedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        provider: true,
        eventType: true,
        externalId: true,
        payload: true,
        receivedAt: true,
      },
    });
    return rows;
  }

  async sweepExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000);
    try {
      const { count } = await this.prisma.webhookEvent.deleteMany({
        where: { receivedAt: { lt: cutoff } },
      });
      if (count > 0) this.logger.log(`Retention sweep deleted ${count} webhook event(s) older than ${this.retentionDays}d`);
      return count;
    } catch (err) {
      this.logger.error(`Webhook event retention sweep failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
