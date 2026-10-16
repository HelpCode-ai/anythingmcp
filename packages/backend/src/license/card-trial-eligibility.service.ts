import { Injectable } from '@nestjs/common';
import { DeploymentService } from '../common/deployment.service';
import { LicenseService } from './license.service';
import { cardTrialEnd } from './license-checkout';

/** How long an answer of the licence site is reused for one address. */
const HISTORY_TTL_MS = 10 * 60 * 1000;
const HISTORY_CACHE_MAX = 10_000;

/**
 * Whether the signed-in admin can start a card trial, before they reach
 * Checkout (Cloud only).
 *
 * The licence site grants a card trial only to an address that never held an
 * AnythingMCP subscription (`hasHadSubscription` in its checkout-intent); any
 * other address is charged today. The app used to find that out only at
 * Checkout, after a page that said "€0 today". The same lookup is exposed
 * to this server as POST /api/license/subscription-history (service token,
 * LicenseService.subscriptionHistory), so the app can say the truth first.
 *
 * - `trial`: a running free trial with 48 h left, and an address that never
 *   had a subscription, or one the site could not answer for (the site checks
 *   again at checkout, and the app follows its answer: see checkoutLink).
 * - `pay`: the address had a subscription. The plan starts and is billed
 *   today.
 * - `none`: no card trial applies (no running trial, under 48 h left, a paid
 *   plan); the app keeps its existing pay-now paths.
 */
export type CardTrialEligibility =
  | { kind: 'trial'; trialEndsAt: Date }
  | { kind: 'pay'; reason: 'had_subscription' }
  | { kind: 'none' };

@Injectable()
export class CardTrialEligibilityService {
  /** Address (lowercased) → had a subscription, and when the site said so. */
  private readonly history = new Map<string, { had: boolean; at: number }>();

  constructor(
    private readonly licenseService: LicenseService,
    private readonly deployment: DeploymentService,
  ) {}

  /**
   * Whether each address ever held a subscription, from the licence site,
   * cached for 10 minutes. Null when the site could not answer for all of
   * them; unknown answers are not cached.
   */
  async hadSubscriptions(emails: string[], now: number = Date.now()): Promise<Map<string, boolean> | null> {
    const keys = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const out = new Map<string, boolean>();
    const missing: string[] = [];
    for (const key of keys) {
      const hit = this.history.get(key);
      if (hit && now - hit.at < HISTORY_TTL_MS) out.set(key, hit.had);
      else missing.push(key);
    }
    if (missing.length === 0) return out;
    const fresh = await this.licenseService.subscriptionHistory(missing).catch(() => null);
    if (!fresh) return null;
    for (const [key, had] of fresh) {
      out.set(key, had);
      this.history.delete(key);
      this.history.set(key, { had, at: now });
    }
    while (this.history.size > HISTORY_CACHE_MAX) this.history.delete(this.history.keys().next().value!);
    return out;
  }

  /** One address: true / false, or null when unknown. */
  async hadSubscription(email: string): Promise<boolean | null> {
    const key = email.trim().toLowerCase();
    if (!key) return null;
    const answer = await this.hadSubscriptions([key]);
    return answer?.get(key) ?? null;
  }

  /** What the app may offer this admin of this workspace. */
  async forAdmin(organizationId: string | null | undefined, email: string | null | undefined): Promise<CardTrialEligibility> {
    if (!this.deployment.isCloud() || !organizationId || !email) return { kind: 'none' };
    const current = await this.licenseService.getCurrentLicense(organizationId);
    // A workspace with a live paid plan changes plan in the billing portal.
    if (current && current.plan !== 'trial' && current.status === 'active') return { kind: 'none' };
    // Nor one whose card was declined: that subscription resumes with a new card.
    if (await this.licenseService.getPaymentFailedLicense(organizationId)) return { kind: 'none' };
    // Only where a card trial would otherwise be offered is the site asked.
    const trialEndsAt = cardTrialEnd(current);
    if (!trialEndsAt) return { kind: 'none' };
    const had = await this.hadSubscription(email);
    return had === true ? { kind: 'pay', reason: 'had_subscription' } : { kind: 'trial', trialEndsAt };
  }
}
