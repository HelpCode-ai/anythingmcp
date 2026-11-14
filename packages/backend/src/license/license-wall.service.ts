import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { ProductEventService, ProductEvents } from '../audit/product-event.service';

/**
 * Which wall a workspace sees: 'trust' (its own numbers and the trust line)
 * or 'control' (the earlier wall), fixed per workspace so a reload never
 * switches it.
 */
export type LicenseWallVariant = 'trust' | 'control';

/** What the workspace really did, shown only when it made successful calls. */
export interface LicenseWallRecap {
  /** Successful tool calls of the workspace, all time (repeats counted). */
  successfulCalls: number;
  /** Up to three connector names with the most successful calls, most first. */
  connectors: string[];
  /** The AI client it connected, when it is one we can name; null otherwise. */
  client: string | null;
  /** An AI client tried a tool after the trial ended (and was refused). */
  blockedSinceEnd: boolean;
}

export interface LicenseWallView {
  variant: LicenseWallVariant;
  recap: LicenseWallRecap | null;
}

/** Share of workspaces kept on the earlier wall, out of 100. */
export const CONTROL_PERCENT = 10;

/** 'control' for about CONTROL_PERCENT% of workspaces, always the same for one. */
export function wallVariant(organizationId: string): LicenseWallVariant {
  const bucket = createHash('sha256').update(`license-wall-v1:${organizationId}`).digest().readUInt16BE(0) % 100;
  return bucket < CONTROL_PERCENT ? 'control' : 'trust';
}

/**
 * The client's display name from the OAuth client name recorded at
 * connection, for the clients we know. Anything else (a custom name) is not
 * shown: the wall then says "your AI".
 */
export function knownClientName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const n = raw.toLowerCase();
  if (n.includes('claude')) return 'Claude';
  if (n.includes('chatgpt') || n.includes('openai')) return 'ChatGPT';
  if (n.includes('cursor')) return 'Cursor';
  if (n.includes('copilot')) return 'Copilot';
  if (n.includes('raycast')) return 'Raycast';
  return null;
}

/**
 * The licence wall of a Cloud workspace whose trial ended: the variant, the
 * workspace's own numbers, and one `license_wall_viewed` event a UTC day.
 * Every query is scoped to the workspace.
 */
@Injectable()
export class LicenseWallService {
  private readonly logger = new Logger(LicenseWallService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly productEvents: ProductEventService,
  ) {}

  async view(organizationId: string, userId: string | null): Promise<LicenseWallView> {
    const variant = wallVariant(organizationId);
    let recap: LicenseWallRecap | null = null;
    try {
      recap = await this.recap(organizationId);
    } catch (err: any) {
      this.logger.warn(`licence wall recap failed for ${organizationId}: ${err?.message ?? err}`);
    }
    await this.recordView(organizationId, userId, variant, recap?.successfulCalls ?? 0);
    return { variant, recap };
  }

  /** Null when the workspace never made a successful call: then no numbers are shown. */
  async recap(organizationId: string): Promise<LicenseWallRecap | null> {
    const success = { organizationId, status: 'SUCCESS' as const };
    const total = await this.prisma.toolInvocation.aggregate({ where: success, _sum: { repeatCount: true } });
    const successfulCalls = total._sum.repeatCount ?? 0;
    if (successfulCalls <= 0) return null;

    const [byConnector, client, blocked] = await Promise.all([
      this.prisma.toolInvocation.groupBy({
        by: ['connectorId'],
        where: { ...success, connectorId: { not: null } },
        _sum: { repeatCount: true },
        orderBy: { _sum: { repeatCount: 'desc' } },
        take: 10,
      }),
      this.connectedClient(organizationId),
      this.prisma.productEvent.findFirst({
        where: {
          organizationId,
          event: ProductEvents.TRIAL_EXPIRED_CALL_BLOCKED,
          createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        },
        select: { id: true },
      }),
    ]);

    const ids = byConnector.map((r) => r.connectorId).filter((id): id is string => !!id);
    // Connectors still in this workspace only: a deleted one is not named.
    const rows = ids.length
      ? await this.prisma.connector.findMany({ where: { id: { in: ids }, organizationId }, select: { id: true, name: true } })
      : [];
    const names = new Map(rows.map((c) => [c.id, c.name]));
    const connectors = ids.map((id) => names.get(id)).filter((n): n is string => !!n).slice(0, 3);

    return { successfulCalls, connectors, client, blockedSinceEnd: !!blocked };
  }

  /**
   * The first AI client the workspace connected that we can name
   * (knownClientName), from its `ai_client_connected` events; null otherwise.
   * Also used by the no-login reactivation page (reactivation.controller.ts).
   */
  async connectedClient(organizationId: string): Promise<string | null> {
    const connected = await this.prisma.productEvent.findMany({
      where: { organizationId, event: ProductEvents.AI_CLIENT_CONNECTED },
      select: { metadata: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    for (const e of connected) {
      const client = knownClientName((e.metadata as Record<string, unknown> | null)?.client);
      if (client) return client;
    }
    return null;
  }

  private async recordView(
    organizationId: string,
    userId: string | null,
    variant: LicenseWallVariant,
    calls: number,
  ): Promise<void> {
    try {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const seen = await this.prisma.productEvent.findFirst({
        where: { organizationId, event: ProductEvents.LICENSE_WALL_VIEWED, createdAt: { gte: startOfDay } },
        select: { id: true },
      });
      if (seen) return;
      await this.productEvents.log({
        event: ProductEvents.LICENSE_WALL_VIEWED,
        organizationId,
        userId,
        metadata: { variant, calls },
      });
    } catch (err: any) {
      this.logger.warn(`license_wall_viewed not recorded: ${err?.message ?? err}`);
    }
  }
}
