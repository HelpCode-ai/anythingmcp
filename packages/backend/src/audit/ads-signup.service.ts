import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { licenseServiceHeaders } from '../license/license.service';
import { ProductEvents, ProductEventService } from './product-event.service';
import { postAdReport } from './ads-report';

/**
 * Cloud: a user who signed up through a ChatGPT Ads click (an `oppref`
 * stored with ad consent) verified their email address → the licence site is
 * told, and reports the verified sign-up to ChatGPT Ads through OpenAI's
 * Conversions API.
 *
 * Google Ads learns the same moment in the browser (the `sign_up_verified`
 * GTM event, lib/conversion.ts in the frontend); OpenAI gets no browser tag
 * from us, so this is the server-side equivalent, sent only when there is an
 * `oppref` to match on.
 *
 * The verify-email endpoints call onEmailVerified after marking the address
 * verified. The work happens in the background: verification never waits for
 * it and nothing here throws into it. The `ads_signup_reported` event makes it
 * once per user.
 *
 * Contract: POST {LICENSE_API_URL}/api/ads/signup with the service token,
 * body { userId, organizationId, verifiedAt, oppref, adConsent, email }. The
 * site is idempotent per userId. 2xx = done; 401, 429, 5xx and network errors
 * are retried a few times (see postAdReport); any other 4xx is a refusal for
 * good. A report that fails every attempt is not tried again: verification
 * happens once.
 *
 * Inert on self-hosted, and when LICENSE_SERVICE_TOKEN is unset. Never logs
 * the email or the click reference.
 */
@Injectable()
export class AdsSignupService {
  private readonly logger = new Logger(AdsSignupService.name);
  /** A check or report running now. */
  private readonly inFlight = new Set<string>();
  private warnedNoToken = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly productEvents: ProductEventService,
  ) {}

  /**
   * The user's email address was just verified. Returns at once; the
   * returned promise is for tests and never rejects.
   */
  onEmailVerified(userId: string | null | undefined, verifiedAt: Date = new Date()): Promise<void> | undefined {
    if (!userId || !this.deployment.isCloud()) return undefined;
    if (this.inFlight.has(userId)) return undefined;
    if (!licenseServiceHeaders()['x-amcp-service-token']) {
      if (!this.warnedNoToken) {
        this.warnedNoToken = true;
        this.logger.warn('Ad sign-ups are not reported: LICENSE_SERVICE_TOKEN is not set.');
      }
      return undefined;
    }

    this.inFlight.add(userId);
    return this.report(userId, verifiedAt)
      .catch((err) => this.logger.warn(`Ads sign-up check failed for ${userId}: ${err?.message ?? err}`))
      .finally(() => this.inFlight.delete(userId));
  }

  private async report(userId: string, verifiedAt: Date): Promise<void> {
    const reported = await this.prisma.productEvent.findFirst({
      where: { userId, event: ProductEvents.ADS_SIGNUP_REPORTED },
      select: { id: true },
    });
    if (reported) return;

    // clickIdForUser only yields ids stored with ad consent granted.
    const click = await this.productEvents.clickIdForUser(userId);
    if (!click?.oppref || click.ad_consent !== 'granted') return;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, organizationId: true },
    });
    if (!user) return;

    const body = {
      userId,
      ...(user.organizationId && { organizationId: user.organizationId }),
      verifiedAt: verifiedAt.toISOString(),
      oppref: click.oppref,
      adConsent: click.ad_consent,
      ...(user.email && { email: user.email }),
    };

    const status = await postAdReport(this.logger, '/api/ads/signup', body, 'ChatGPT Ads sign-up', userId);
    if (status === null) return;
    await this.productEvents.log({
      event: ProductEvents.ADS_SIGNUP_REPORTED,
      userId,
      organizationId: user.organizationId ?? null,
      metadata: { kind: 'oppref', status },
    });
  }
}
