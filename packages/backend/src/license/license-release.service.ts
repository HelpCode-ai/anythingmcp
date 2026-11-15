import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { SiteSettingsService } from '../settings/site-settings.service';
import { LICENSE_API_URL, licenseServiceHeaders, parseLicenseBilling } from './license.service';

/** Subscription states Stripe will charge again (unless set to cancel). */
const LIVE_SUBSCRIPTION = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

/**
 * Tells the licence site that a Cloud workspace was deleted, so the licence it
 * held stops for good: the site revokes it, and the trial reminder and
 * win-back emails stop.
 *
 * Deleting a workspace removes it from this database only. Its licence row
 * survives with organization_id NULL (ON DELETE SET NULL), and the site, which
 * never heard of the deletion, kept the licence active. In Cloud every licence
 * is created for a workspace, so a row without one is a deleted workspace's.
 *
 * Subscriptions are cancelled by their customer in the Stripe billing portal
 * and nowhere else: a workspace whose subscription is still live cannot be
 * deleted (assertNoLiveSubscription), and the site refuses to release such a
 * licence.
 *
 * releaseOrphanedLicenses runs right after a deletion and again from the
 * onboarding cron, which retries what the site did not confirm and covers the
 * workspaces deleted before this existed. A row is deleted once the site has
 * confirmed (or does not know the key); a refusal is logged and left alone.
 */
@Injectable()
export class LicenseReleaseService {
  private readonly logger = new Logger(LicenseReleaseService.name);
  private running: Promise<ReleaseSummary> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly siteSettings: SiteSettingsService,
  ) {}

  /**
   * Refuse to delete a workspace whose subscription Stripe would go on
   * charging. The customer cancels it in the billing portal first; one that
   * is already set to cancel, ended, or a trial without a card does not block.
   * Asks the licence site for the subscription's current state, and refuses
   * when it cannot tell rather than risk a charge for a deleted workspace.
   *
   * Every paid licence of the workspace counts, not only the one in use. A
   * card trial whose first charge was declined is no longer valid here (the
   * site answers "revoked" and the row is marked so), while Stripe goes on
   * retrying the charge for days. Such a workspace was deleted on 10 Nov 2026
   * and the retry went through four days later. The site sends the
   * subscription's state with an invalid answer too, so that state decides.
   *
   * The refusal carries `code: 'active_subscription'` and the workspaces
   * concerned, so the app can offer to cancel right there.
   */
  async assertNoLiveSubscription(organizationIds: string[]): Promise<void> {
    if (!this.deployment.isCloud() || organizationIds.length === 0) return;
    const paid = await this.prisma.license.findMany({
      where: { organizationId: { in: organizationIds }, plan: { not: 'trial' } },
      select: { licenseKey: true, billing: true, organizationId: true, status: true },
    });

    const blocked = new Set<string>();
    for (const licence of paid) {
      if (licence.organizationId && blocked.has(licence.organizationId)) continue;
      let billing = parseLicenseBilling(licence.billing);
      try {
        const { data } = await axios.get(`${LICENSE_API_URL}/api/license/verify`, {
          params: {
            key: licence.licenseKey,
            billing: '1',
            ...(licence.organizationId && { organizationId: licence.organizationId }),
          },
          timeout: 10000,
          headers: licenseServiceHeaders(),
        });
        billing = parseLicenseBilling(data?.billing);
      } catch (err: any) {
        this.logger.warn(
          `Could not check the subscription of licence …${licence.licenseKey.slice(-4)} before a deletion: ${err?.message ?? err}`,
        );
        // A licence in use whose state is unknown refuses the deletion. One
        // that already stopped here and left no state behind decides nothing,
        // as before this looked at stopped licences at all.
        if (!billing && licence.status === 'active') {
          throw new ServiceUnavailableException(
            'We could not check the subscription of this workspace. Please try again in a few minutes.',
          );
        }
      }
      if (billing && LIVE_SUBSCRIPTION.has(billing.status) && !billing.cancelling) {
        if (licence.organizationId) blocked.add(licence.organizationId);
      }
    }

    if (blocked.size === 0) return;
    const organizations = await this.prisma.organization.findMany({
      where: { id: { in: [...blocked] } },
      select: { id: true, name: true },
    });
    throw new ConflictException({
      statusCode: 409,
      code: 'active_subscription',
      message:
        'This workspace has an active subscription. Cancel it first under Settings → License → ' +
        'Manage subscription & billing; the workspace can be deleted once it is cancelled.',
      organizations,
    });
  }

  /** Fire and forget, for the deletion paths: the user is not kept waiting. */
  releaseInBackground(): void {
    if (!this.deployment.isCloud()) return;
    this.releaseOrphanedLicenses().catch((err) =>
      this.logger.warn(`Licence release after deletion failed: ${err?.message ?? err}`),
    );
  }

  /** One pass at a time; a call during a pass waits for it. */
  releaseOrphanedLicenses(limit = 50): Promise<ReleaseSummary> {
    if (!this.running) {
      this.running = this.runPass(limit).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runPass(limit: number): Promise<ReleaseSummary> {
    const out: ReleaseSummary = { examined: 0, released: 0, refused: 0, failed: 0 };
    if (!this.deployment.isCloud()) return out;

    const headers = licenseServiceHeaders();
    if (!headers['x-amcp-service-token']) {
      this.logger.error('Cannot release licences of deleted workspaces: LICENSE_SERVICE_TOKEN is not set.');
      return out;
    }

    // Revoked or invalid rows are already dead on the site; only those it may
    // still treat as live (trial reminders go to expired trials too) matter.
    const orphans = await this.prisma.license.findMany({
      where: { organizationId: null, status: { in: ['active', 'expired'] } },
      select: { id: true, licenseKey: true, plan: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    if (orphans.length === 0) return out;

    const instanceId = (await this.siteSettings.get('instance_id')) || undefined;

    for (const row of orphans) {
      out.examined++;
      const outcome = await this.releaseOne(row.licenseKey, instanceId, headers);
      if (outcome === 'released' || outcome === 'unknown') {
        await this.prisma.license.deleteMany({ where: { id: row.id, organizationId: null } });
        out.released++;
      } else if (outcome === 'refused') {
        // Nothing the Cloud may end: keep the row out of the next pass.
        await this.prisma.license.updateMany({
          where: { id: row.id, organizationId: null },
          data: { status: 'invalid' },
        });
        out.refused++;
      } else {
        out.failed++;
      }
    }

    this.logger.log(
      `Licence release: examined=${out.examined} released=${out.released} ` +
        `refused=${out.refused} failed=${out.failed}`,
    );
    return out;
  }

  private async releaseOne(
    licenseKey: string,
    instanceId: string | undefined,
    headers: Record<string, string>,
  ): Promise<'released' | 'unknown' | 'refused' | 'failed'> {
    const tail = licenseKey.slice(-4);
    try {
      const { data } = await axios.post(
        `${LICENSE_API_URL}/api/license/release`,
        { licenseKey, ...(instanceId && { instanceId }) },
        { timeout: 15000, headers },
      );
      this.logger.log(`Released licence …${tail} of a deleted workspace (subscription ${data?.subscription}).`);
      return 'released';
    } catch (err: any) {
      const status: number | undefined = err?.response?.status;
      const detail = err?.response?.data?.error || err?.message || 'no response';
      // Only the route's own answer means the key is unknown. A bare 404 (a
      // licence site without the route yet) must not drop the row unreleased.
      if (status === 404 && detail === 'License not found') return 'unknown';
      if (status === 409) {
        this.logger.warn(`Licence site refused to release licence …${tail}: ${detail}`);
        return 'refused';
      }
      this.logger.warn(`Releasing licence …${tail} failed (${status ?? 'no response'}): ${detail}`);
      return 'failed';
    }
  }
}

export interface ReleaseSummary {
  examined: number;
  released: number;
  refused: number;
  failed: number;
}
