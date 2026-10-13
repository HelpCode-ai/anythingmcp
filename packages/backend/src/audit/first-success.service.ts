import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { ProductEvents, ProductEventService } from './product-event.service';
import {
  FIRST_SUCCESS_FRESH_MS,
  FIRST_SUCCESS_KEY,
  OFFER_ELIGIBLE_KEY,
  offerLicenceState,
} from '../license/card-trial-offer';
import { CardTrialEligibilityService } from '../license/card-trial-eligibility.service';

/** Workspaces remembered as settled; forgetting one only costs one indexed read. */
const SETTLED_MAX = 50_000;

/**
 * Cloud: a workspace's first successful tool call.
 *
 * AuditService calls onSuccessfulInvocation after it stored a SUCCESS row,
 * like AdsActivationService. The first time a process sees a workspace it
 * reads two OrgSettings rows by their unique key; after that the workspace is
 * settled in memory and later calls cost nothing. The work runs in the
 * background: the tool call never waits for it and nothing here throws into
 * it.
 *
 * - Stores the workspace's first success time (OrgSettings
 *   `first_successful_call_at`) if it is not stored yet. A workspace active
 *   before this shipped gets its real first success, read from
 *   tool_invocations once.
 * - If that first success is fresh (FIRST_SUCCESS_FRESH_MS) and the workspace
 *   is on the no-card trial, marks it eligible for the card-trial offer
 *   (OrgSettings `card_trial_offer_eligible_at` + the
 *   `card_trial_offer_eligible` product event, once per workspace).
 *
 * Paying workspaces, card trials, former customers and ended trials are not
 * eligible and keep the existing licence wall and banners. Inert on
 * self-hosted. Nothing here touches the tool's response.
 */
@Injectable()
export class FirstSuccessService {
  private readonly logger = new Logger(FirstSuccessService.name);
  private readonly settled = new Set<string>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly productEvents: ProductEventService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** LicenseModule's service, resolved lazily (this one lives in the global AuditModule). */
  private cardTrialEligibility(): CardTrialEligibilityService | null {
    try {
      return this.moduleRef?.get(CardTrialEligibilityService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * False only when the licence site says every active admin's address had a
   * subscription: none of them could start a card trial (it would charge
   * today). Unknown counts as yes; the offer and /start-trial check again.
   */
  private async anyAdminCanTrial(organizationId: string): Promise<boolean> {
    const eligibility = this.cardTrialEligibility();
    if (!eligibility) return true;
    const admins = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: 'ADMIN', deactivatedAt: null },
      select: { user: { select: { email: true } } },
    });
    const emails = admins.map((a) => a.user.email);
    if (emails.length === 0) return true;
    const history = await eligibility.hadSubscriptions(emails).catch(() => null);
    if (!history) return true;
    return emails.some((e) => history.get(e.trim().toLowerCase()) !== true);
  }

  /**
   * A SUCCESS invocation of this workspace was stored. Returns at once; the
   * promise is for tests and never rejects.
   */
  onSuccessfulInvocation(
    organizationId: string | null | undefined,
    call: { connectorId?: string | null; toolId?: string | null } = {},
  ): Promise<void> | undefined {
    if (!organizationId || !this.deployment.isCloud()) return undefined;
    if (this.settled.has(organizationId) || this.inFlight.has(organizationId)) return undefined;
    this.inFlight.add(organizationId);
    return this.check(organizationId, call)
      .then(() => this.settle(organizationId))
      .catch((err) =>
        // Not settled: the next successful call of this workspace tries again.
        this.logger.warn(`First-success check failed for ${organizationId}: ${err?.message ?? err}`),
      )
      .finally(() => this.inFlight.delete(organizationId));
  }

  private async check(
    organizationId: string,
    call: { connectorId?: string | null; toolId?: string | null },
  ): Promise<void> {
    const stored = await this.prisma.orgSettings.findUnique({
      where: { organizationId_key: { organizationId, key: FIRST_SUCCESS_KEY } },
      select: { id: true },
    });
    if (stored) return;

    // The earliest success, not necessarily this one: a workspace that was
    // active before this shipped keeps the time it really activated.
    const first = await this.prisma.toolInvocation.findFirst({
      where: { organizationId, status: 'SUCCESS' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, connectorId: true, toolId: true },
    });
    const firstAt = first?.createdAt ?? new Date();
    await this.prisma.orgSettings.createMany({
      data: [{ organizationId, key: FIRST_SUCCESS_KEY, value: firstAt.toISOString() }],
      skipDuplicates: true,
    });

    const now = new Date();
    if (now.getTime() - firstAt.getTime() > FIRST_SUCCESS_FRESH_MS) return;

    const licences = await this.prisma.license.findMany({
      where: { organizationId },
      select: { plan: true, status: true, expiresAt: true, createdAt: true },
    });
    if (offerLicenceState(licences, now) !== 'eligible') return;
    if (!(await this.anyAdminCanTrial(organizationId))) return;

    // The unique (organizationId, key) row is the lock: of two processes
    // that get here together, only the one that creates it logs the event.
    const created = await this.prisma.orgSettings.createMany({
      data: [{ organizationId, key: OFFER_ELIGIBLE_KEY, value: now.toISOString() }],
      skipDuplicates: true,
    });
    if (created.count !== 1) return;

    const connectorId = first?.connectorId ?? call.connectorId ?? null;
    const toolId = first?.toolId ?? call.toolId ?? null;
    const [connector, tool] = await Promise.all([
      connectorId
        ? this.prisma.connector.findFirst({
            where: { id: connectorId, organizationId },
            select: { config: true },
          })
        : null,
      toolId ? this.prisma.mcpTool.findUnique({ where: { id: toolId }, select: { name: true } }) : null,
    ]);
    const adapterSlug = (connector?.config as { adapterSlug?: unknown } | null)?.adapterSlug;
    await this.productEvents.log({
      event: ProductEvents.CARD_TRIAL_OFFER_ELIGIBLE,
      organizationId,
      metadata: {
        ...(connectorId && { connectorId }),
        ...(typeof adapterSlug === 'string' && { adapterSlug }),
        ...(tool?.name && { toolName: tool.name }),
      },
    });
    this.logger.log(`Workspace ${organizationId} made its first successful call on the no-card trial.`);
  }

  private settle(organizationId: string): void {
    this.settled.add(organizationId);
    // A Set iterates in insertion order: drop the oldest when it is full.
    if (this.settled.size > SETTLED_MAX) this.settled.delete(this.settled.values().next().value!);
  }
}
