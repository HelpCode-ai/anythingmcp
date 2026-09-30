import type { LicenseInfo } from './license.service';
import type { AttributionClickId } from '../audit/signup-attribution';

/**
 * Checkout links for AnythingMCP Cloud (DEPLOYMENT_MODE=cloud only).
 *
 * The licence site (anythingmcp.com) owns Stripe. This server asks it for a
 * checkout intent on behalf of the signed-in admin, server to server, and
 * hands the browser the one-time URL it answers with. The browser goes through
 * Stripe Checkout and comes back to /settings/license/activate#key=…, which
 * the existing activation page handles.
 */

export const CHECKOUT_PLANS = ['starter', 'team', 'business'] as const;

/** A card trial needs at least this much of the free trial left (Stripe: 48 h). */
export const CARD_TRIAL_MIN_LEAD_MS = 48 * 60 * 60 * 1000;
export type CheckoutPlan = (typeof CHECKOUT_PLANS)[number];

export const CHECKOUT_BILLING_PERIODS = ['monthly', 'yearly'] as const;
export type CheckoutBillingPeriod = (typeof CHECKOUT_BILLING_PERIODS)[number];

/** Body of POST {licence site}/api/stripe/checkout-intent (the agreed contract). */
export interface CheckoutIntentPayload {
  email: string;
  plan: `cloud_${CheckoutPlan}`;
  billingPeriod: CheckoutBillingPeriod;
  /** Present: a card trial ending then (the site clamps it). Absent: pay now. */
  trialEnd?: string;
  returnUrl: string;
  organizationId?: string;
  adMetadata?: {
    ad_consent: 'granted';
    gclid?: string;
    gbraid?: string;
    wbraid?: string;
  };
}

/**
 * When a card trial should end: exactly when the workspace's free trial would
 * have, so adding a card never shortens or lengthens the seven days the user
 * was promised. Only a live 'trial' licence qualifies; anything else (trial
 * over, a paid plan, no licence) answers null, which means "pay now".
 */
export function cardTrialEnd(license: LicenseInfo | null, now: Date = new Date()): Date | null {
  if (!license || license.plan !== 'trial' || license.status !== 'active') return null;
  if (!license.expiresAt) return null;
  const end = new Date(license.expiresAt);
  // Stripe needs a trial end at least 48 hours out; the licence site sells
  // without a trial when it is nearer, rather than lengthening the trial.
  if (Number.isNaN(end.getTime()) || end.getTime() < now.getTime() + CARD_TRIAL_MIN_LEAD_MS) return null;
  return end;
}

/**
 * The ad metadata the licence site may attach to the checkout, so a purchase
 * can be reported to Google Ads. Only a click id stored with ad consent
 * granted (clickIdForUser already guarantees that; checked again here), and
 * only the id fields, never the capture timestamp.
 */
export function checkoutAdMetadata(
  click: AttributionClickId | null | undefined,
): CheckoutIntentPayload['adMetadata'] | undefined {
  if (!click || click.ad_consent !== 'granted') return undefined;
  const out: NonNullable<CheckoutIntentPayload['adMetadata']> = { ad_consent: 'granted' };
  for (const key of ['gclid', 'gbraid', 'wbraid'] as const) {
    const value = click[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out.gclid || out.gbraid || out.wbraid ? out : undefined;
}

/** The cloud frontend origin the licence site sends the buyer back to. */
export function cloudFrontendOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FRONTEND_URL || env.CLOUD_PUBLIC_URL || 'https://cloud.anythingmcp.com';
  return configured.replace(/\/+$/, '');
}

/** Raised when the licence site cannot give us a checkout URL. */
export class CheckoutUnavailableError extends Error {
  constructor(
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'CheckoutUnavailableError';
  }
}
