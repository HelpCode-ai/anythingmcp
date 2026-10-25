import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { licenseServiceHeaders } from '../license/license.service';
import { ProductEvents, ProductEventService } from './product-event.service';
import { postAdReport } from './ads-report';
import { googleClickIdKey } from './signup-attribution';
/** After a report that failed every attempt, this process leaves the workspace alone this long. */
const FAILED_COOLDOWN_MS = 10 * 60_000;
/**
 * Workspaces remembered as settled. Forgetting one only costs a repeat of
 * the database check, which the stored event keeps from reporting twice.
 */
const SETTLED_MAX = 50_000;

/**
 * Cloud: a workspace that signed up through an ad click (with ad consent)
 * makes its first successful tool call → the licence site is told, and
 * reports it as an "activation" conversion: to Google Ads for a Google click
 * id, to ChatGPT Ads for an `oppref`. A sign-up that never connects anything
 * is worth little to the bidding; one that runs a tool is the signal the
 * campaigns should buy.
 *
 * AuditService calls onSuccessfulInvocation after it stored a SUCCESS row.
 * The work happens in the background: the tool call never waits for it and
 * nothing here throws into it. Per workspace and process the database is
 * read once; the `ads_activation_reported` event is what makes it once ever.
 *
 * Contract: POST {LICENSE_API_URL}/api/ads/activation with the service token,
 * body { organizationId, activatedAt, at most one of gclid/gbraid/wbraid,
 * oppref, adConsent, email }. The site is idempotent per organizationId.
 * 2xx = done; 401, 429, 5xx and network errors are retried; any other 4xx is
 * a refusal for good (see postAdReport).
 *
 * Inert on self-hosted, and when LICENSE_SERVICE_TOKEN is unset. Never logs
 * the email or the click id.
 */
@Injectable()
export class AdsActivationService {
  private readonly logger = new Logger(AdsActivationService.name);
  /** Reported, refused, or found not eligible: nothing more to do in this process. */
  private readonly settled = new Set<string>();
  /** A check or report running now. */
  private readonly inFlight = new Set<string>();
  /** Workspaces whose last report failed every attempt, by when. */
  private readonly failedAt = new Map<string, number>();
  private warnedNoToken = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly productEvents: ProductEventService,
  ) {}

  /**
   * A SUCCESS invocation of this workspace was stored. Returns at once;
   * the returned promise is for tests and never rejects.
   */
  onSuccessfulInvocation(organizationId: string | null | undefined): Promise<void> | undefined {
    if (!organizationId || !this.deployment.isCloud()) return undefined;
    if (this.settled.has(organizationId) || this.inFlight.has(organizationId)) return undefined;
    const failed = this.failedAt.get(organizationId);
    if (failed !== undefined && Date.now() - failed < FAILED_COOLDOWN_MS) return undefined;
    if (!licenseServiceHeaders()['x-amcp-service-token']) {
      if (!this.warnedNoToken) {
        this.warnedNoToken = true;
        this.logger.warn('Ad activations are not reported: LICENSE_SERVICE_TOKEN is not set.');
      }
      return undefined;
    }

    this.inFlight.add(organizationId);
    return this.check(organizationId)
      .catch((err) => this.logger.warn(`Ads activation check failed for ${organizationId}: ${err?.message ?? err}`))
      .finally(() => this.inFlight.delete(organizationId));
  }

  private async check(organizationId: string): Promise<void> {
    const reported = await this.prisma.productEvent.findFirst({
      where: { organizationId, event: ProductEvents.ADS_ACTIVATION_REPORTED },
      select: { id: true },
    });
    if (reported) return this.settle(organizationId);

    const signup = await this.productEvents.clickIdForOrganization(organizationId);
    if (!signup) return this.settle(organizationId);

    // The workspace's earliest success, whichever call brought us here: a
    // report retried after a failure, or a workspace active before this
    // existed, still carries the time it really activated.
    const first = await this.prisma.toolInvocation.findFirst({
      where: { organizationId, status: 'SUCCESS' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    if (!first) return;

    const { clickId, userId } = signup;
    const google = googleClickIdKey(clickId);
    const kinds = [google, clickId.oppref ? 'oppref' : undefined].filter((k): k is string => !!k);
    if (kinds.length === 0) return this.settle(organizationId);
    const consented = clickId.ad_consent === 'granted';
    const email =
      consented && userId
        ? (await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email
        : undefined;

    const body = {
      organizationId,
      activatedAt: first.createdAt.toISOString(),
      ...(google && { [google]: clickId[google] }),
      ...(clickId.oppref && { oppref: clickId.oppref }),
      adConsent: clickId.ad_consent,
      ...(consented && email && { email }),
    };

    const status = await postAdReport(this.logger, '/api/ads/activation', body, 'ad activation', organizationId);
    if (status === null) {
      // Retryable and out of attempts: no event, so a later call or a
      // restart tries again once the cooldown is over.
      this.failedAt.set(organizationId, Date.now());
      if (this.failedAt.size > SETTLED_MAX) this.failedAt.delete(this.failedAt.keys().next().value!);
      return;
    }
    await this.productEvents.log({
      event: ProductEvents.ADS_ACTIVATION_REPORTED,
      organizationId,
      userId,
      metadata: { kind: kinds.join('+'), status },
    });
    this.settle(organizationId);
  }

  private settle(organizationId: string): void {
    this.failedAt.delete(organizationId);
    this.settled.add(organizationId);
    // A Set iterates in insertion order: drop the oldest when it is full.
    if (this.settled.size > SETTLED_MAX) this.settled.delete(this.settled.values().next().value!);
  }
}
