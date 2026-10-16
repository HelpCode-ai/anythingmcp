import type { LicenseInfo } from './license.service';
import { CLICK_ID_KEYS, type AttributionClickId } from '../audit/signup-attribution';

/**
 * Checkout links for AnythingMCP Cloud (DEPLOYMENT_MODE=cloud only).
 *
 * The licence site (anythingmcp.com) owns Stripe. This server asks it for a
 * checkout intent on behalf of the signed-in admin, server to server, and
 * hands the browser the one-time URL it answers with. The browser goes through
 * Stripe Checkout and comes back to /settings/license/activate#key=…, which
 * the existing activation page handles.
 */

/**
 * Plans this app opens a checkout for. Business was retired on 8 Oct 2026:
 * beyond Team, Enterprise is quoted through the contact form. The licence site
 * keeps the Business prices for subscriptions that already exist.
 */
export const CHECKOUT_PLANS = ['starter', 'team'] as const;

/** A card trial needs at least this much of the free trial left (Stripe: 48 h). */
export const CARD_TRIAL_MIN_LEAD_MS = 48 * 60 * 60 * 1000;
export type CheckoutPlan = (typeof CHECKOUT_PLANS)[number];

export const CHECKOUT_BILLING_PERIODS = ['monthly', 'yearly'] as const;

/**
 * Where in the app a checkout was started. Sent to the licence site as
 * `source` with every checkout intent; the site stores it on the Stripe
 * Checkout Session and the subscription as `metadata.checkout_source` (and as
 * `metadata.trial_source` on card trials). Allow-listed: the value ends up in
 * Stripe. The frontend mirrors this list in src/lib/checkout-source.ts.
 *
 * - first_success_banner / first_success_email: the card-trial offer after a
 *   workspace's first successful tool call, from the in-app card or the email.
 * - first_success: the same offer before banner and email were told apart
 *   (links in emails already sent, tabs already open). Still accepted.
 * - trial_banner: the countdown banner at the top of every page.
 * - license_page: Settings → License.
 * - trial_ended_wall: the wall shown when the free trial is over.
 * - post_approve: "add a card" on the page after approving an AI client.
 * - signup_prompt: the card-trial page shown once after sign-up.
 * - trial_limit / starter_pack: "add a card" next to the connector limit.
 * - chat_setup: the plan link the setup tools give the AI in a chat.
 * - start_trial: /start-trial opened without a known source.
 * - app: a caller that did not say (DEFAULT_CHECKOUT_SOURCE).
 */
export const CHECKOUT_SOURCES = [
  'first_success_banner',
  'first_success_email',
  'first_success',
  'trial_banner',
  'license_page',
  'trial_ended_wall',
  'post_approve',
  'signup_prompt',
  'trial_limit',
  'starter_pack',
  'chat_setup',
  'start_trial',
  'app',
] as const;
export type CheckoutSource = (typeof CHECKOUT_SOURCES)[number];
/** The setup tools' plan links (`?source=` on /start-trial and /settings/license). */
export const CHAT_SETUP_SOURCE: CheckoutSource = 'chat_setup';
/** "Add a card" on the page after approving an AI client (login.controller). */
export const POST_APPROVE_SOURCE: CheckoutSource = 'post_approve';
/** Sent when the app did not name an entry point, so no checkout goes without one. */
export const DEFAULT_CHECKOUT_SOURCE: CheckoutSource = 'app';

/**
 * Where a link to the public pricing page came from, as `?source=` on it. The
 * pricing page passes it to its checkout, which stores it as
 * `metadata.checkout_source` (anything it does not know becomes
 * `pricing_page`). Kept in step with PRICING_CHECKOUT_SOURCES on the site.
 */
export type PricingLinkSource =
  | 'email_trial_warn3'
  | 'email_trial_warn1'
  | 'email_trial_expired'
  | 'email_winback';

/** `url` with `source=<source>` added to its query (before any fragment). */
export function withSourceParam(url: string, source: CheckoutSource | PricingLinkSource): string {
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  return `${base}${base.includes('?') ? '&' : '?'}source=${encodeURIComponent(source)}${hash}`;
}
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
  /** A Stripe promotion code the user arrived with; the site pre-applies it. */
  promoCode?: string;
  /** The app entry point (CHECKOUT_SOURCES); Stripe metadata `checkout_source`. */
  source?: CheckoutSource;
  adMetadata?: {
    ad_consent: 'granted';
    gclid?: string;
    gbraid?: string;
    wbraid?: string;
    /** ChatGPT Ads click reference. */
    oppref?: string;
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
 * can be reported to Google Ads or ChatGPT Ads. Only a click id stored with ad consent
 * granted (clickIdForUser already guarantees that; checked again here), and
 * only the id fields, never the capture timestamp.
 */
export function checkoutAdMetadata(
  click: AttributionClickId | null | undefined,
): CheckoutIntentPayload['adMetadata'] | undefined {
  if (!click || click.ad_consent !== 'granted') return undefined;
  const out: NonNullable<CheckoutIntentPayload['adMetadata']> = { ad_consent: 'granted' };
  for (const key of CLICK_ID_KEYS) {
    const value = click[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return CLICK_ID_KEYS.some((key) => out[key]) ? out : undefined;
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
