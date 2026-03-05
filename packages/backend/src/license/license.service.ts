import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';
import { PrismaService } from '../common/prisma.service';
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

  // ── Community License Registration ─────────────────────────────────────────

  async registerCommunityLicense(
    email: string,
    name: string,
  ): Promise<LicenseInfo> {
    const instanceId = await this.getInstanceId();

    try {
      const { data } = await axios.post(
        `${this.apiBase}/api/license/register`,
        { email, name, instanceId },
        { timeout: 10000 },
      );

      const license = await this.prisma.license.create({
        data: {
          licenseKey: data.licenseKey,
          plan: data.plan || 'community',
          status: 'active',
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
          instanceId,
        },
      });

      await this.siteSettings.set('license_key', data.licenseKey);

      // Activate in background
      this.activateLicense(data.licenseKey).catch((err) =>
        this.logger.warn(`License activation failed: ${err.message}`),
      );

      return this.toLicenseInfo(license);
    } catch (err: any) {
      // If remote is unreachable, create a pending license locally
      if (err.response?.status === 409) {
        // Community license already exists for this email — try to use it
        throw new Error('A community license already exists for this email');
      }

      this.logger.warn(
        `Remote license registration failed: ${err.message}. Creating pending license.`,
      );

      const pendingKey = `AMCP-PEND-${crypto.randomBytes(6).toString('hex').toUpperCase().slice(0, 12).replace(/(.{4})/g, '$1-').slice(0, -1)}`;
      const license = await this.prisma.license.create({
        data: {
          licenseKey: pendingKey,
          plan: 'community',
          status: 'pending',
          instanceId,
        },
      });

      await this.siteSettings.set('license_key', pendingKey);
      return this.toLicenseInfo(license);
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

  async verifyLicense(key?: string): Promise<RemoteVerifyResponse> {
    const licenseKey =
      key || (await this.siteSettings.get('license_key'));

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

  async setLicenseKey(licenseKey: string): Promise<LicenseInfo> {
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
      },
    });

    await this.siteSettings.set('license_key', licenseKey);

    // Activate in background
    this.activateLicense(licenseKey).catch((err) =>
      this.logger.warn(`License activation failed: ${err.message}`),
    );

    return this.toLicenseInfo(license);
  }

  // ── Get Current License ────────────────────────────────────────────────────

  async getCurrentLicense(): Promise<LicenseInfo | null> {
    const licenseKey = await this.siteSettings.get('license_key');
    if (!licenseKey) return null;

    const license = await this.prisma.license.findUnique({
      where: { licenseKey },
    });

    return license ? this.toLicenseInfo(license) : null;
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
