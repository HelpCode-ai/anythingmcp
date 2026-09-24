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

/**
 * How hard we chase a trial licence before giving up. The licence API is a
 * different machine behind its own rate limits, and a trial lost to one bad
 * second is a customer who lands on the licence wall instead of onboarding —
 * so a transient failure is retried rather than logged.
 */
const TRIAL_RETRY_ATTEMPTS = 3;
/** Read at call time so a test (or an operator) can shrink the wait. */
const trialRetryBaseMs = () => Number(process.env.TRIAL_RETRY_BASE_MS ?? 600);

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
  /** Set while a paid licence's renewal payment is failing. */
  paymentIssue?: boolean;
  /** End of the payment grace period (also returned as expiresAt). */
  graceUntil?: string;
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
      // The licence API opens a portal only for this server, by its service
      // token: a licence key alone is not a billing credential. What makes it
      // safe to hand back a URL here is that the key is the one bound to the
      // signed-in admin's own workspace.
      const { data } = await axios.post(
        `${this.apiBase}/api/billing/portal`,
        { licenseKey: license.licenseKey, returnUrl },
        { timeout: 15000, headers: this.serviceHeaders() },
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

  /**
   * Headers that mark a call as coming from this server rather than from a
   * browser. The licence API rate-limits anonymous callers per IP, and every
   * cloud trial request leaves from the same IP, so without this header the
   * whole cloud shares one small bucket and signups silently lose their trial.
   * Unset in self-hosted installs, where the public limit is the right one.
   */
  private serviceHeaders(): Record<string, string> {
    const token = process.env.LICENSE_SERVICE_TOKEN;
    return token ? { 'x-amcp-service-token': token } : {};
  }

  /** Retry only what can succeed on a second try: throttling, upstream faults, no answer at all. */
  private isRetriableLicenseError(err: any): boolean {
    const status = err?.response?.status;
    if (status === undefined) return true; // timeout, DNS, connection reset
    return status === 429 || status >= 500;
  }

  private async postTrialWithRetry(payload: {
    email: string;
    name: string;
    instanceId: string;
  }): Promise<any> {
    let lastErr: any;
    for (let attempt = 1; attempt <= TRIAL_RETRY_ATTEMPTS; attempt++) {
      try {
        const { data } = await axios.post(`${this.apiBase}/api/license/trial`, payload, {
          timeout: 10000,
          headers: this.serviceHeaders(),
        });
        if (attempt > 1) {
          this.logger.log(`Trial licence obtained for ${payload.email} on attempt ${attempt}.`);
        }
        return data;
      } catch (err: any) {
        lastErr = err;
        if (attempt === TRIAL_RETRY_ATTEMPTS || !this.isRetriableLicenseError(err)) break;
        // Exponential with jitter: several verifications can land together and
        // retrying them in lockstep just rebuilds the burst that failed.
        const base = trialRetryBaseMs();
        const delay = base * 2 ** (attempt - 1) + Math.floor(Math.random() * (base / 2));
        this.logger.warn(
          `Trial licence attempt ${attempt} for ${payload.email} failed (${err?.response?.status ?? err.code ?? 'no response'}), retrying in ${delay}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastErr;
  }

  async requestTrialLicense(
    email: string,
    name: string,
    organizationId?: string,
  ): Promise<{ licenseKey: string; plan: string; expiresAt: string; trialDaysLeft: number }> {
    const instanceId = await this.getInstanceId();

    try {
      const data = await this.postTrialWithRetry({ email, name, instanceId });

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

  /**
   * Cloud self-heal: hand a trial to every verified user whose workspace ended
   * up with no licence at all.
   *
   * Activation on email verification is best-effort by design (verification
   * must succeed even if the licence API is down), and the licence wall's
   * "Start trial" button only helps a user who notices it. Between the two,
   * 131 verified users had been left with no licence by 2026-09-16, most of
   * them because the licence API rate-limited the whole cloud to three trials
   * an hour. This pass closes that gap for good: whatever the reason a trial
   * went missing, the next cron run picks it up.
   *
   * Bounded per run and paced, because it talks to a remote API and a
   * thundering herd is what created the backlog in the first place.
   */
  async repairMissingTrials(
    limit = 25,
  ): Promise<{ examined: number; repaired: number; failed: number }> {
    const out = { examined: 0, repaired: 0, failed: 0 };
    if (!this.deployment.isCloud()) return out;

    const candidates = await this.prisma.user.findMany({
      where: {
        emailVerified: true,
        organizationId: { not: null },
        organization: { licenses: { none: {} } },
      },
      select: { id: true, email: true, name: true, organizationId: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    for (const user of candidates) {
      out.examined++;
      try {
        await this.requestTrialLicense(
          user.email,
          user.name || user.email,
          user.organizationId ?? undefined,
        );
        out.repaired++;
        this.logger.log(`Repaired missing trial for org ${user.organizationId} (${user.email}).`);
      } catch (err: any) {
        out.failed++;
        this.logger.warn(`Trial repair failed for ${user.email}: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (out.examined > 0) {
      this.logger.log(
        `Trial repair: examined=${out.examined} repaired=${out.repaired} failed=${out.failed}`,
      );
    }
    return out;
  }

  /**
   * Re-verify the cloud's paid licences against the licence server.
   *
   * Until now a paid licence was verified once, when it was activated, and
   * never again: a subscription that was cancelled or stopped being paid on
   * Stripe stayed `active` here for good. Runs from the onboarding cron (every
   * six hours) and picks the licences not verified in the last 20 hours, so
   * each one is checked about once a day.
   *
   * verifyLicense writes the outcome: a revoked or expired licence stops being
   * `active`; one whose renewal is failing stays active with expiresAt set to
   * the end of its grace period, which the licence guard enforces. A licence
   * server that cannot be reached changes nothing, and the licence is retried
   * on the next run.
   */
  async reverifyPaidLicenses(
    limit = 50,
  ): Promise<{ checked: number; deactivated: number; inGrace: number; unreachable: number }> {
    const out = { checked: 0, deactivated: 0, inGrace: 0, unreachable: 0 };
    if (!this.deployment.isCloud()) return out;

    const due = await this.prisma.license.findMany({
      where: {
        status: 'active',
        plan: { not: 'trial' },
        OR: [
          { lastVerifiedAt: null },
          { lastVerifiedAt: { lt: new Date(Date.now() - 20 * 60 * 60 * 1000) } },
        ],
      },
      select: { licenseKey: true, organizationId: true },
      orderBy: { lastVerifiedAt: { sort: 'asc', nulls: 'first' } },
      take: limit,
    });

    for (const { licenseKey, organizationId } of due) {
      out.checked++;
      const result = await this.verifyLicense(licenseKey);
      if (result.valid) {
        if (result.paymentIssue) {
          out.inGrace++;
          this.logger.warn(
            `Licence ${licenseKey.slice(0, 9)}… (org ${organizationId}) has a failing payment; allowed until ${result.graceUntil}.`,
          );
        }
      } else if (result.error === 'Verification service unreachable') {
        out.unreachable++;
      } else {
        out.deactivated++;
        this.logger.warn(
          `Licence ${licenseKey.slice(0, 9)}… (org ${organizationId}) deactivated: ${result.error}.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (out.checked > 0) {
      this.logger.log(
        `Licence re-verification: checked=${out.checked} deactivated=${out.deactivated} ` +
          `inGrace=${out.inGrace} unreachable=${out.unreachable}`,
      );
    }
    return out;
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
        { params: { key: licenseKey }, timeout: 10000, headers: this.serviceHeaders() },
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
        updateData.status = data.error?.includes('revoked')
          ? 'revoked'
          : data.error?.includes('expired')
            ? 'expired'
            : 'invalid';
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
    // A key already bound to one workspace is not moved to another. The upsert
    // below is keyed on the licence key and used to overwrite organizationId,
    // so pasting a paying customer's key into any free workspace took their
    // licence away from them — the licence wall locked them out — and gave the
    // new workspace their plan, and with it their billing portal. Holding a
    // key proves nothing: keys travel in URLs, emails and screenshots.
    // Self-hosted is one tenant, where the admin owns every workspace.
    if (this.deployment.isCloud() && organizationId) {
      const bound = await this.prisma.license.findUnique({
        where: { licenseKey },
        select: { organizationId: true },
      });
      if (bound?.organizationId && bound.organizationId !== organizationId) {
        this.logger.warn(
          `Refused to move licence …${licenseKey.slice(-4)} from workspace ${bound.organizationId} to ${organizationId}`,
        );
        throw new Error(
          'This license key is already active in another workspace. If it is yours, contact support@anythingmcp.com to move it.',
        );
      }
    }

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
