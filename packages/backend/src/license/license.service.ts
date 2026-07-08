import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { SiteSettingsService } from '../settings/site-settings.service';

const LICENSE_API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://anythingmcp.com'
    : 'http://localhost:3100';

export interface LicenseInfo {
  licenseKey: string;
  plan: string;
  status: string;
  features: Record<string, any> | null;
  expiresAt: Date | null;
  lastVerifiedAt: Date | null;
  instanceId: string | null;
}

export interface RemoteVerifyResponse {
  valid: boolean;
  plan?: string;
  features?: Record<string, any>;
  expiresAt?: string;
  error?: string;
}

@Injectable()
export class LicenseService implements OnModuleInit {
  private readonly logger = new Logger(LicenseService.name);
  private readonly apiBase = LICENSE_API_URL;

  constructor(
    private readonly prisma: PrismaService,
    private readonly siteSettings: SiteSettingsService,
    private readonly deployment: DeploymentService,
  ) {}

  async onModuleInit() {
    await this.ensureInstanceId();
    await this.verifyOnStartup();
  }

  // ── Instance ID ────────────────────────────────────────────────────────────

  async ensureInstanceId(): Promise<string> {
    let instanceId = await this.siteSettings.get('instance_id');
    if (!instanceId) {
      instanceId = crypto.randomUUID();
      await this.siteSettings.set('instance_id', instanceId);
      this.logger.log(`Generated instance ID: ${instanceId}`);
    }
    return instanceId;
  }

  async getInstanceId(): Promise<string> {
    return (await this.siteSettings.get('instance_id')) || (await this.ensureInstanceId());
  }

  // ── Stripe Billing Portal ──────────────────────────────────────────────────

  /**
   * Create a Stripe Billing Portal session for the org's active license so the
   * user can manage payment method, invoices, or cancel their subscription.
   * We hold only the license key locally; the licensing site (which owns the
   * Stripe customer/subscription mapping) mints the actual portal URL.
   */
  async createBillingPortalSession(
    organizationId: string,
    returnUrl?: string,
  ): Promise<{ url: string }> {
    const license = await this.getCurrentLicense(organizationId);
    if (!license?.licenseKey) {
      throw new Error('No active license for this organization.');
    }
    try {
      const { data } = await axios.post(
        `${this.apiBase}/api/billing/portal`,
        { licenseKey: license.licenseKey, returnUrl },
        { timeout: 15000 },
      );
      if (!data?.url) throw new Error('No portal URL returned.');
      return { url: data.url as string };
    } catch (err: any) {
      const msg =
        err?.response?.data?.error ||
        err?.message ||
        'Failed to open the billing portal.';
      this.logger.warn(`Billing portal request failed: ${msg}`);
      throw new Error(msg);
    }
  }

  // ── Community License Request (sends key via email) ───────────────────────

  async requestCommunityLicense(
    email: string,
    name: string,
  ): Promise<{ success: boolean; message: string }> {
    const instanceId = await this.getInstanceId();

    try {
      await axios.post(
        `${this.apiBase}/api/license/register`,
        { email, name, instanceId },
        { timeout: 10000 },
      );

      return {
        success: true,
        message: `License key sent to ${email}`,
      };
    } catch (err: any) {
      if (err.response?.status === 409) {
        throw new Error('A community license already exists for this email. Check your inbox.');
      }
      if (err.response?.status === 429) {
        throw new Error('Too many requests. Please try again later.');
      }
      this.logger.warn(`Remote license registration failed: ${err.message}`);
      throw new Error('Failed to register license. Please try again later.');
    }
  }

  // ── Cloud Trial License ──────────────────────────────────────────────────

  async requestTrialLicense(
    email: string,
    name: string,
    organizationId?: string,
  ): Promise<{ licenseKey: string; plan: string; expiresAt: string; trialDaysLeft: number }> {
    const instanceId = await this.getInstanceId();

    try {
      const { data } = await axios.post(
        `${this.apiBase}/api/license/trial`,
        { email, name, instanceId },
        { timeout: 10000 },
      );

      // Auto-activate the trial key locally
      await this.prisma.license.upsert({
        where: { licenseKey: data.licenseKey },
        update: {
          plan: 'trial',
          status: 'active',
          features: data.features || undefined,
          expiresAt: new Date(data.expiresAt),
          lastVerifiedAt: new Date(),
          instanceId,
          organizationId: organizationId || undefined,
        },
        create: {
          licenseKey: data.licenseKey,
          plan: 'trial',
          status: 'active',
          features: data.features || undefined,
          expiresAt: new Date(data.expiresAt),
          lastVerifiedAt: new Date(),
          instanceId,
          organizationId: organizationId || undefined,
        },
      });

      // Self-hosted = single tenant, the instance-wide pointer is meaningful.
      // Cloud = multi tenant, a global pointer would let one org's verify
      // resolve to another org's key, so we skip the write.
      if (!this.deployment.isCloud()) {
        await this.siteSettings.set('license_key', data.licenseKey);
      }

      return {
        licenseKey: data.licenseKey,
        plan: data.plan,
        expiresAt: data.expiresAt,
        trialDaysLeft: data.trialDaysLeft,
      };
    } catch (err: any) {
      if (err.response?.status === 409) {
        throw new Error('A trial license already exists for this email.');
      }
      if (err.response?.status === 429) {
        throw new Error('Too many requests. Please try again later.');
      }
      this.logger.warn(`Trial license request failed: ${err.message}`);
      throw new Error('Failed to start trial. Please try again later.');
    }
  }

  // ── License Activation ─────────────────────────────────────────────────────

  async activateLicense(licenseKey: string): Promise<boolean> {
    const instanceId = await this.getInstanceId();

    try {
      await axios.post(
        `${this.apiBase}/api/license/activate`,
        { licenseKey, instanceId },
        { timeout: 10000 },
      );

      await this.prisma.license.update({
        where: { licenseKey },
        data: { activatedAt: new Date(), instanceId },
      });

      return true;
    } catch (err: any) {
      this.logger.warn(`License activation failed: ${err.message}`);
      return false;
    }
  }

  // ── License Verification ───────────────────────────────────────────────────

  async verifyLicense(
    key?: string,
    organizationId?: string,
  ): Promise<RemoteVerifyResponse> {
    let licenseKey = key;

    if (!licenseKey) {
      if (this.deployment.isCloud()) {
        // Multi-tenant: only verify the key that actually belongs to the
        // requesting organization. No fallback to a global pointer.
        if (organizationId) {
          const existing = await this.prisma.license.findFirst({
            where: { organizationId },
            orderBy: { createdAt: 'desc' },
          });
          licenseKey = existing?.licenseKey;
        }
      } else {
        licenseKey = await this.siteSettings.get('license_key') || undefined;
      }
    }

    if (!licenseKey) {
      return { valid: false, error: 'No license key configured' };
    }

    try {
      const { data } = await axios.get<RemoteVerifyResponse>(
        `${this.apiBase}/api/license/verify`,
        { params: { key: licenseKey }, timeout: 10000 },
      );

      // Update local record
      const updateData: any = {
        lastVerifiedAt: new Date(),
      };

      if (data.valid) {
        updateData.plan = data.plan;
        updateData.features = data.features || undefined;
        updateData.expiresAt = data.expiresAt
          ? new Date(data.expiresAt)
          : null;
        updateData.status = 'active';
      } else {
        updateData.status =
          data.error?.includes('expired') ? 'expired' : 'invalid';
      }

      await this.prisma.license
        .update({ where: { licenseKey }, data: updateData })
        .catch(() => {
          // License may not exist locally yet
        });

      return data;
    } catch (err: any) {
      this.logger.warn(`License verification failed: ${err.message}`);
      return { valid: false, error: 'Verification service unreachable' };
    }
  }

  async verifyOnStartup(): Promise<void> {
    // In cloud mode "the" instance-wide license key is meaningless — each
    // org has its own. Per-org background verification (if needed) belongs
    // elsewhere; here we only handle the self-hosted single-tenant case.
    if (this.deployment.isCloud()) return;

    try {
      const licenseKey = await this.siteSettings.get('license_key');
      if (!licenseKey) return;

      const license = await this.prisma.license.findUnique({
        where: { licenseKey },
      });

      if (!license) return;

      // Only verify if last check was >24h ago
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      if (license.lastVerifiedAt && license.lastVerifiedAt > dayAgo) {
        return;
      }

      await this.verifyLicense(licenseKey);
      this.logger.log('Startup license verification completed');
    } catch (err: any) {
      this.logger.warn(
        `Startup license verification failed: ${err.message}`,
      );
    }
  }

  // ── Admin: Set License Key ─────────────────────────────────────────────────

  async setLicenseKey(licenseKey: string, organizationId?: string): Promise<LicenseInfo> {
    // Verify remotely first
    const verification = await this.verifyLicense(licenseKey);

    if (!verification.valid) {
      throw new Error(verification.error || 'Invalid license key');
    }

    const instanceId = await this.getInstanceId();

    // Upsert local license
    const license = await this.prisma.license.upsert({
      where: { licenseKey },
      update: {
        plan: verification.plan || 'community',
        status: 'active',
        features: verification.features || undefined,
        expiresAt: verification.expiresAt
          ? new Date(verification.expiresAt)
          : null,
        lastVerifiedAt: new Date(),
        instanceId,
        organizationId: organizationId || undefined,
      },
      create: {
        licenseKey,
        plan: verification.plan || 'community',
        status: 'active',
        features: verification.features || undefined,
        expiresAt: verification.expiresAt
          ? new Date(verification.expiresAt)
          : null,
        lastVerifiedAt: new Date(),
        instanceId,
        organizationId: organizationId || undefined,
      },
    });

    // Self-hosted: this is "the" instance license, so we point site_settings
    // at it. In cloud the same write would leak the key across tenants on the
    // next unscoped lookup.
    if (!this.deployment.isCloud()) {
      await this.siteSettings.set('license_key', licenseKey);
    }

    // Activate in background
    this.activateLicense(licenseKey).catch((err) =>
      this.logger.warn(`License activation failed: ${err.message}`),
    );

    return this.toLicenseInfo(license);
  }

  // ── Get Current License ────────────────────────────────────────────────────

  async getCurrentLicense(organizationId?: string): Promise<LicenseInfo | null> {
    // 1. Per-org: find license directly assigned to this organization
    if (organizationId) {
      const license = await this.prisma.license.findFirst({
        where: { organizationId, status: 'active' },
        orderBy: { createdAt: 'desc' },
      });
      if (license) return this.toLicenseInfo(license);
    }

    // Cloud: stop here. Falling back to a global key or to any unassigned
    // license would let one org see another org's entitlement (or auto-bind
    // someone else's license to the calling org).
    if (this.deployment.isCloud()) {
      return null;
    }

    // 2. Self-hosted fallback: global license via site_settings key
    const licenseKey = await this.siteSettings.get('license_key');
    if (licenseKey) {
      const license = await this.prisma.license.findUnique({
        where: { licenseKey },
      });
      if (license) {
        // Auto-assign unassigned license to the requesting org
        if (organizationId && !license.organizationId) {
          await this.prisma.license.update({
            where: { id: license.id },
            data: { organizationId },
          }).catch(() => {});
        }
        return this.toLicenseInfo(license);
      }
    }

    // 3. Self-hosted fallback: any active license without an org (migrated but unassigned)
    const unassigned = await this.prisma.license.findFirst({
      where: { status: 'active', organizationId: null },
      orderBy: { createdAt: 'desc' },
    });
    if (unassigned) {
      if (organizationId) {
        await this.prisma.license.update({
          where: { id: unassigned.id },
          data: { organizationId },
        }).catch(() => {});
      }
      return this.toLicenseInfo(unassigned);
    }

    return null;
  }

  // ── Commercial Use Flag ────────────────────────────────────────────────────

  async setCommercialUse(isCommercial: boolean): Promise<void> {
    await this.siteSettings.set(
      'commercial_use',
      isCommercial ? 'true' : 'false',
    );
  }

  async isCommercialUse(): Promise<boolean | null> {
    const value = await this.siteSettings.get('commercial_use');
    if (value === null) return null;
    return value === 'true';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private toLicenseInfo(license: any): LicenseInfo {
    return {
      licenseKey: license.licenseKey,
      plan: license.plan,
      status: license.status,
      features: license.features as Record<string, any> | null,
      expiresAt: license.expiresAt,
      lastVerifiedAt: license.lastVerifiedAt,
      instanceId: license.instanceId,
    };
  }
}
