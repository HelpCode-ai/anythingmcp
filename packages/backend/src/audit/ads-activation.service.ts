import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { LICENSE_API_URL, licenseServiceHeaders } from '../license/license.service';
import { ProductEvents, ProductEventService } from './product-event.service';
import { CLICK_ID_KEYS } from './signup-attribution';

/** Attempts per report before giving up until a later call (or a restart). */
const REPORT_ATTEMPTS = 3;
/** Read at call time so a test can shrink the wait; doubles per attempt. */
const retryBaseMs = () => Number(process.env.ADS_ACTIVATION_RETRY_BASE_MS ?? 1000);
/** After a report that failed every attempt, this process leaves the workspace alone this long. */
const FAILED_COOLDOWN_MS = 10 * 60_000;
/**
 * Workspaces remembered as settled. Forgetting one only costs a repeat of
 * the database check, which the stored event keeps from reporting twice.
 */
const SETTLED_MAX = 50_000;

/**
 * Cloud: a workspace that signed up through a Google Ads click (with ad
 * consent) makes its first successful tool call → the licence site is told,
 * and uploads it to Google Ads as an "activation" offline conversion. A
 * sign-up that never connects anything is worth little to the bidding; one
 * that runs a tool is the signal the campaigns should buy.
 *
 * AuditService calls onSuccessfulInvocation after it stored a SUCCESS row.
 * The work happens in the background: the tool call never waits for it and
 * nothing here throws into it. Per workspace and process the database is
 * read once; the `ads_activation_reported` event is what makes it once ever.
 *
 * Contract: POST {LICENSE_API_URL}/api/ads/activation with the service token,
 * body { organizationId, activatedAt, one of gclid/gbraid/wbraid, adConsent,
 * email }. The site is idempotent per organizationId. 2xx = done; 401, 429,
 * 5xx and network errors are retried; any other 4xx is a refusal for good.
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
        this.logger.warn('Google Ads activations are not reported: LICENSE_SERVICE_TOKEN is not set.');
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
    const kind = CLICK_ID_KEYS.find((k) => clickId[k]);
    if (!kind) return this.settle(organizationId);
    const consented = clickId.ad_consent === 'granted';
    const email =
      consented && userId
        ? (await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email
        : undefined;

    const body = {
      organizationId,
      activatedAt: first.createdAt.toISOString(),
      [kind]: clickId[kind],
      adConsent: clickId.ad_consent,
      ...(consented && email && { email }),
    };

    const status = await this.post(organizationId, body);
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
      metadata: { kind, status },
    });
    this.settle(organizationId);
  }

  /**
   * The site's HTTP status once it answered for good (2xx, or a 4xx it will
   * not change its mind about), or null when every attempt failed.
   */
  private async post(organizationId: string, body: Record<string, unknown>): Promise<number | null> {
    for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt++) {
      try {
        const res = await axios.post(`${LICENSE_API_URL}/api/ads/activation`, body, {
          timeout: 10000,
          headers: licenseServiceHeaders(),
        });
        this.logger.log(`Reported the Google Ads activation of ${organizationId} (${res.status}).`);
        return res.status;
      } catch (err: any) {
        const status: number | undefined = err?.response?.status;
        if (status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 429) {
          this.logger.warn(`Licence site refused the Google Ads activation of ${organizationId} (${status}).`);
          return status;
        }
        this.logger.warn(
          `Reporting the Google Ads activation of ${organizationId} failed ` +
            `(${status ?? err?.code ?? 'no response'}), attempt ${attempt}/${REPORT_ATTEMPTS}.`,
        );
        if (attempt < REPORT_ATTEMPTS) await sleep(retryBaseMs() * 2 ** (attempt - 1));
      }
    }
    return null;
  }

  private settle(organizationId: string): void {
    this.failedAt.delete(organizationId);
    this.settled.add(organizationId);
    // A Set iterates in insertion order: drop the oldest when it is full.
    if (this.settled.size > SETTLED_MAX) this.settled.delete(this.settled.values().next().value!);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
