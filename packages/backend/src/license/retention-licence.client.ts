import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { DeploymentService } from '../common/deployment.service';
import { LICENSE_API_URL, licenseServiceHeaders } from './license.service';

/**
 * The licence site's two win-back endpoints, for the Cloud (service token):
 *
 * - `POST /api/license/winback-code`: a single-use Stripe promotion code for
 *   one workspace and offer, valid 14 days, idempotent per workspace and
 *   offer while it is unredeemed.
 * - `POST /api/license/trial/extend`: one 7-day extension of a trial
 *   licence, within 7 days of its end.
 *
 * Both answer null when the site cannot give an answer (no service token,
 * not Cloud, network error, 429, 5xx, or a reply that is not what the
 * contract says). The caller then sends nothing and tries again later, as
 * with LicenseService.subscriptionHistory. Self-hosted never calls them.
 */

/** The segments the site accepts (winback-segment.ts on the Cloud). */
export type WinbackCodeSegment = 'business' | 'consumer' | 'telegram' | 'unused';
/** Each offer is one Stripe coupon on the site, restricted to Cloud Starter. */
export type WinbackCodeOffer = 'locked-monthly' | 'locked-yearly' | 'personal-monthly';

export interface WinbackCode {
  code: string;
  expiresAt: Date;
}

/** Why the site refused an extension (its lib/trial-extension.ts), plus a malformed key. */
export const TRIAL_EXTENSION_REFUSALS = [
  'not_found',
  'not_trial',
  'already_extended',
  'too_late',
  'revoked',
  'invalid_key',
] as const;
export type TrialExtensionRefusal = (typeof TRIAL_EXTENSION_REFUSALS)[number];

export type TrialExtensionAnswer =
  | { ok: true; expiresAt: Date }
  | { ok: false; reason: TrialExtensionRefusal };

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,49}$/;

@Injectable()
export class RetentionLicenceClient {
  private readonly logger = new Logger(RetentionLicenceClient.name);
  private readonly apiBase = LICENSE_API_URL;

  constructor(private readonly deployment: DeploymentService) {}

  private headers(): Record<string, string> | null {
    if (!this.deployment.isCloud()) return null;
    const headers = licenseServiceHeaders();
    if (!headers['x-amcp-service-token']) {
      this.logger.warn('Cannot reach the licence site for win-back: LICENSE_SERVICE_TOKEN is not set.');
      return null;
    }
    return headers;
  }

  /** The workspace's code for this offer, or null when the site cannot give one now. */
  async winbackCode(
    organizationId: string,
    segment: WinbackCodeSegment,
    offer: WinbackCodeOffer,
  ): Promise<WinbackCode | null> {
    const headers = this.headers();
    if (!headers) return null;
    try {
      const { data } = await axios.post(
        `${this.apiBase}/api/license/winback-code`,
        { organizationId, segment, offer },
        { timeout: 15000, headers },
      );
      const code = typeof data?.code === 'string' ? data.code.trim().toUpperCase() : '';
      const expiresAt = typeof data?.expiresAt === 'string' ? new Date(data.expiresAt) : null;
      if (!CODE_RE.test(code) || !expiresAt || Number.isNaN(expiresAt.getTime())) {
        this.logger.warn(`Win-back code (${offer}) for workspace ${organizationId}: the licence site sent no usable code.`);
        return null;
      }
      return { code, expiresAt };
    } catch (err: any) {
      this.logger.warn(
        `Win-back code (${offer}) for workspace ${organizationId} unavailable (${err?.response?.status ?? 'no response'}).`,
      );
      return null;
    }
  }

  /**
   * Extends the trial licence `key` by 7 days. A refusal carries the site's
   * reason; null means no answer (try again later). The key is never logged.
   */
  async extendTrial(key: string): Promise<TrialExtensionAnswer | null> {
    const headers = this.headers();
    if (!headers) return null;
    try {
      const { data } = await axios.post(`${this.apiBase}/api/license/trial/extend`, { key }, { timeout: 15000, headers });
      const expiresAt = typeof data?.expiresAt === 'string' ? new Date(data.expiresAt) : null;
      if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
        this.logger.warn('Trial extension: the licence site sent no end date.');
        return null;
      }
      return { ok: true, expiresAt };
    } catch (err: any) {
      const status: number | undefined = err?.response?.status;
      const reason = err?.response?.data?.reason;
      if (
        (status === 400 || status === 404 || status === 409) &&
        (TRIAL_EXTENSION_REFUSALS as readonly string[]).includes(reason)
      ) {
        return { ok: false, reason };
      }
      this.logger.warn(`Trial extension unavailable (${status ?? 'no response'}).`);
      return null;
    }
  }
}
