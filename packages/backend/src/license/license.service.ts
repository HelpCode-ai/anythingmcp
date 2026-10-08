import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { SiteSettingsService } from '../settings/site-settings.service';
import { CheckoutIntentPayload, CheckoutUnavailableError } from './license-checkout';
import { Prisma } from '../generated/prisma/client';

// Production always talks to anythingmcp.com. The licence site decides
// which plan an installation runs; a URL taken from the environment would let
// any self-hosted operator point verification at a server of their own and
// unlock paid features. LICENSE_API_URL applies outside production only (local
// end-to-end runs against a local licence site).
export const LICENSE_API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://anythingmcp.com'
    : process.env.LICENSE_API_URL?.replace(/\/+$/, '') || 'http://localhost:3100';

/**
 * Headers that mark a call to the licence site as coming from this server
 * (LICENSE_SERVICE_TOKEN). Empty when the token is unset.
 */
export function licenseServiceHeaders(): Record<string, string> {
  const token = process.env.LICENSE_SERVICE_TOKEN;
  return token ? { 'x-amcp-service-token': token } : {};
}

/**
 * How hard we chase a trial licence before giving up. The licence API is a
 * different machine behind its own rate limits, and a trial lost to one bad
 * second is a customer who lands on the licence wall instead of onboarding —
 * so a transient failure is retried rather than logged.
 */
const TRIAL_RETRY_ATTEMPTS = 3;
/** Read at call time so a test (or an operator) can shrink the wait. */
const trialRetryBaseMs = () => Number(process.env.TRIAL_RETRY_BASE_MS ?? 600);
/** A checkout link is asked for by someone waiting on a spinner: one retry, no more. */
const CHECKOUT_RETRY_ATTEMPTS = 2;
/** Most addresses the licence site's subscription-history route takes per call. */
const SUBSCRIPTION_HISTORY_BATCH = 20;

/**
 * A paid Cloud licence's Stripe subscription as the licence site reports it
 * (GET /api/license/verify?billing=1 with the service token). Dates are ISO
 * strings, amount is in the currency's smallest unit.
 */
export interface LicenseBilling {
  status: string;
  /** Set to end at the period end (or a cancel_at date) instead of renewing. */
  cancelling: boolean;
  endsAt: string | null;
  currentPeriodEnd: string | null;
  /** End of a card trial, while trialing. */
  trialEnd: string | null;
  amount: number | null;
  currency: string | null;
  interval: 'day' | 'week' | 'month' | 'year' | null;
}

export interface LicenseInfo {
  licenseKey: string;
  plan: string;
  status: string;
  features: Record<string, any> | null;
  expiresAt: Date | null;
  lastVerifiedAt: Date | null;
  instanceId: string | null;
  billing?: LicenseBilling | null;
}

/** Shape check on what the licence site sent, so a bad payload stores nothing. */
export function parseLicenseBilling(raw: unknown): LicenseBilling | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 64 ? v : null);
  const date = (v: unknown) => {
    const s = str(v);
    return s && Number.isFinite(Date.parse(s)) ? s : null;
  };
  const status = str(b.status);
  if (!status) return null;
  const interval = ['day', 'week', 'month', 'year'].includes(b.interval as string)
    ? (b.interval as LicenseBilling['interval'])
    : null;
  return {
    status,
    cancelling: b.cancelling === true,
    endsAt: date(b.endsAt),
    currentPeriodEnd: date(b.currentPeriodEnd),
    trialEnd: date(b.trialEnd),
    amount: typeof b.amount === 'number' && Number.isFinite(b.amount) ? b.amount : null,
    currency: str(b.currency),
    interval,
  };
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
  /** The subscription's state (Cloud, service token, paid licences only). */
  billing?: unknown;
}

@Injectable()
export class LicenseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LicenseService.name);
  private readonly apiBase = LICENSE_API_URL;
  private reverifyTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly siteSettings: SiteSettingsService,
    private readonly deployment: DeploymentService,
  ) {}

  async onModuleInit() {
    await this.ensureInstanceId();
    await this.verifyOnStartup();
    // A self-hosted instance can run for months without a restart; without
    // this, a cancelled or renewed licence would only be noticed at the next
    // one. verifyOnStartup skips keys verified in the last 24 hours.
    if (!this.deployment.isCloud()) {
      this.reverifyTimer = setInterval(() => void this.verifyOnStartup(), 6 * 60 * 60 * 1000);
      this.reverifyTimer.unref();
    }
  }

  onModuleDestroy() {
    if (this.reverifyTimer) clearInterval(this.reverifyTimer);
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
    /** 'cancel' opens Stripe's cancellation page directly. */
    flow?: 'cancel',
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
        { licenseKey: license.licenseKey, returnUrl, ...(flow && { flow }) },
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

  // ── Stripe Checkout (Cloud) ────────────────────────────────────────────────

  /**
   * Ask the licence site for a one-time Stripe Checkout URL (Cloud only; the
   * caller checks the deployment mode). The licence site owns Stripe; it
   * accepts this call only with our service token, so the email and workspace
   * in the payload are the ones this server vouches for.
   *
   * A user is waiting on the other end, so the retry is short: one more try
   * on throttling, an upstream fault or no answer at all. A duplicate intent
   * is harmless (it simply expires unused). Every failure comes out as a
   * CheckoutUnavailableError; the upstream detail stays in our log.
   */
  async createCheckoutIntent(payload: CheckoutIntentPayload): Promise<{ url: string }> {
    const headers = this.serviceHeaders();
    if (!headers['x-amcp-service-token']) {
      this.logger.error('Checkout link requested but LICENSE_SERVICE_TOKEN is not set.');
      throw new CheckoutUnavailableError('Licence service token is not configured');
    }

    let lastErr: any;
    for (let attempt = 1; attempt <= CHECKOUT_RETRY_ATTEMPTS; attempt++) {
      try {
        const { data } = await axios.post(`${this.apiBase}/api/stripe/checkout-intent`, payload, {
          timeout: 10000,
          headers,
        });
        const url = typeof data?.url === 'string' ? data.url : '';
        if (!/^https?:\/\//i.test(url)) {
          throw new CheckoutUnavailableError('Checkout intent answered without a URL');
        }
        return { url };
      } catch (err: any) {
        lastErr = err;
        if (
          err instanceof CheckoutUnavailableError ||
          attempt === CHECKOUT_RETRY_ATTEMPTS ||
          !this.isRetriableLicenseError(err)
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, trialRetryBaseMs()));
      }
    }

    if (lastErr instanceof CheckoutUnavailableError) {
      this.logger.warn(`Checkout intent failed: ${lastErr.message}`);
      throw lastErr;
    }
    const status: number | undefined = lastErr?.response?.status;
    const detail = lastErr?.response?.data?.error || lastErr?.message || 'no response';
    this.logger.warn(
      `Checkout intent failed (${status ?? lastErr?.code ?? 'no response'}) for org ${payload.organizationId}: ${detail}`,
    );
    throw new CheckoutUnavailableError(`Checkout intent failed: ${detail}`, status);
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
    return licenseServiceHeaders();
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
      if (!data?.licenseKey) {
        // The licence API hands the key back only to this server, by its
        // service token; anyone else is told it went by email. Without a key
        // there is nothing to activate here.
        this.logger.error(
          'Trial request answered without a licence key: LICENSE_SERVICE_TOKEN is missing or not accepted by the licence API.',
        );
        throw new Error('Trial licence API did not return a key');
      }

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

  async activateLicense(licenseKey: string, organizationId?: string): Promise<boolean> {
    const instanceId = await this.getInstanceId();

    try {
      // On Cloud the licence API is told which workspace the key now belongs
      // to, so it can report the binding and refuse the key elsewhere. It
      // records that only from this server (service token). Self-hosted sends
      // no workspace: there, one admin owns every workspace.
      const cloudOrg = this.deployment.isCloud() ? organizationId : undefined;
      await axios.post(
        `${this.apiBase}/api/license/activate`,
        { licenseKey, instanceId, ...(cloudOrg && { organizationId: cloudOrg }) },
        { timeout: 10000, headers: this.serviceHeaders() },
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
        {
          // Cloud also asks for the subscription's state (trial end, set to
          // cancel, renewal date) so the app can tell the customer.
          params: { key: licenseKey, ...(this.deployment.isCloud() && { billing: '1' }) },
          timeout: 10000,
          headers: this.serviceHeaders(),
        },
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
        const billing = parseLicenseBilling(data.billing);
        updateData.billing = billing ?? Prisma.DbNull;
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
        // The licence site alerts us and emails the licence's owner.
        this.reportRebindAttempt(licenseKey, organizationId, bound.organizationId).catch(() => {});
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
    this.activateLicense(licenseKey, organizationId).catch((err) =>
      this.logger.warn(`License activation failed: ${err.message}`),
    );

    return this.toLicenseInfo(license);
  }

  /**
   * Tell the licence site that a key bound to one workspace was just entered
   * in another and refused. It holds the owner's address and our alert
   * channel; the binding itself stays here. Best effort: the refusal stands
   * whether or not the report arrives.
   */
  async reportRebindAttempt(
    licenseKey: string,
    organizationId: string,
    boundOrganizationId: string,
  ): Promise<void> {
    const headers = this.serviceHeaders();
    if (!headers['x-amcp-service-token']) return;
    try {
      await axios.post(
        `${this.apiBase}/api/license/rebind-attempt`,
        { licenseKey, organizationId, boundOrganizationId },
        { timeout: 10000, headers },
      );
    } catch (err: any) {
      this.logger.warn(
        `Could not report the refused move of licence …${licenseKey.slice(-4)}: ${err?.response?.status ?? err?.message}`,
      );
    }
  }

  /**
   * Whether each address ever had an AnythingMCP Stripe subscription, in any
   * state (card trials and cancelled ones included). The licence site holds the
   * Stripe customers; the Cloud trial win-back asks it so a discount never goes
   * to a current or former customer.
   *
   * Returns the answer per lower-cased address, or null when the site cannot
   * give a complete one (no service token, network or HTTP error, an address
   * missing from the reply, a value that is not a boolean). The caller must
   * then send nothing. Addresses go out in batches of 20, the site's limit;
   * none of them is ever logged.
   */
  async subscriptionHistory(emails: string[]): Promise<Map<string, boolean> | null> {
    const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const out = new Map<string, boolean>();
    if (unique.length === 0) return out;

    const headers = this.serviceHeaders();
    if (!headers['x-amcp-service-token']) {
      this.logger.warn('Cannot check subscription history: LICENSE_SERVICE_TOKEN is not set.');
      return null;
    }

    for (let i = 0; i < unique.length; i += SUBSCRIPTION_HISTORY_BATCH) {
      const batch = unique.slice(i, i + SUBSCRIPTION_HISTORY_BATCH);
      try {
        const { data } = await axios.post(
          `${this.apiBase}/api/license/subscription-history`,
          { emails: batch },
          { timeout: 10000, headers },
        );
        const results: unknown = data?.results;
        if (!results || typeof results !== 'object' || Array.isArray(results)) {
          this.logger.warn('Subscription history check: the licence site sent no results.');
          return null;
        }
        for (const email of batch) {
          const had = Object.prototype.hasOwnProperty.call(results, email)
            ? (results as Record<string, unknown>)[email]
            : undefined;
          if (typeof had !== 'boolean') {
            this.logger.warn('Subscription history check: the licence site left an address unanswered.');
            return null;
          }
          out.set(email, had);
        }
      } catch (err: any) {
        this.logger.warn(
          `Subscription history check failed (${err?.response?.status ?? 'no response'}): ${err?.message ?? err}`,
        );
        return null;
      }
    }
    return out;
  }

  // ── Get Current License ────────────────────────────────────────────────────

  /**
   * The workspace's most recent licence that is no longer active (expired,
   * revoked, invalid), for status reporting only — never for gating. Null
   * when the workspace has none.
   */
  async getLatestInactiveLicense(
    organizationId: string,
  ): Promise<{ plan: string; status: string; expiresAt: Date | null } | null> {
    const license = await this.prisma.license.findFirst({
      where: { organizationId, status: { not: 'active' } },
      orderBy: { createdAt: 'desc' },
      select: { plan: true, status: true, expiresAt: true },
    });
    return license ?? null;
  }

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
      billing: parseLicenseBilling(license.billing),
    };
  }

  /** Last refresh per workspace, so the licence page cannot hammer the site. */
  private readonly lastRefresh = new Map<string, number>();

  /**
   * Re-verify a workspace's licence now (Cloud, from the licence page), so a
   * plan change, cancellation or card trial made in Stripe shows up right away
   * instead of at the next daily re-verification. At most once a minute per
   * workspace; a call inside that window does nothing.
   */
  async refreshLicense(organizationId: string): Promise<boolean> {
    if (!this.deployment.isCloud()) return false;
    const last = this.lastRefresh.get(organizationId) ?? 0;
    if (Date.now() - last < 60_000) return false;
    this.lastRefresh.set(organizationId, Date.now());
    if (this.lastRefresh.size > 5000) {
      // Bounded: drop the oldest half rather than grow forever.
      for (const k of [...this.lastRefresh.keys()].slice(0, 2500)) this.lastRefresh.delete(k);
    }
    const license = await this.prisma.license.findFirst({
      where: { organizationId, status: 'active', plan: { not: 'trial' } },
      orderBy: { createdAt: 'desc' },
      select: { licenseKey: true },
    });
    if (!license) return false;
    await this.verifyLicense(license.licenseKey);
    return true;
  }
}
