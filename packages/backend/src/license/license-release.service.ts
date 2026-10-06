import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { SiteSettingsService } from '../settings/site-settings.service';
import { LICENSE_API_URL, licenseServiceHeaders } from './license.service';

/**
 * Tells the licence site that a Cloud workspace was deleted, so the licence it
 * held stops for good: the site cancels its Stripe subscription and revokes it.
 *
 * Deleting a workspace removes it from this database only. Its licence row
 * survives with organization_id NULL (ON DELETE SET NULL), and the site, which
 * never heard of the deletion, kept the licence active: the trial went on
 * getting reminder and win-back emails, and a card trial went on to its first
 * charge. In Cloud every licence is created for a workspace, so a row without
 * one is a deleted workspace's.
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
      if (status === 404) return 'unknown';
      const detail = err?.response?.data?.error || err?.message || 'no response';
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
