/**
 * Where in the app a checkout was started. Every Cloud checkout carries one:
 * as `source` on POST /api/license/checkout-link (the in-app checkouts) or as
 * `?source=` on links to the public pricing page. The licence site stores it
 * on the Stripe Checkout Session and the subscription as
 * `metadata.checkout_source` (and `metadata.trial_source` on card trials), so
 * purchases can be counted per entry point.
 *
 * Mirrors CHECKOUT_SOURCES in packages/backend/src/license/license-checkout.ts:
 * the backend refuses any other value, because it ends up in Stripe.
 */
export const CHECKOUT_SOURCES = [
  /** The card-trial offer after the first successful tool call: the in-app card. */
  'first_success_banner',
  /** The same offer's email. */
  'first_success_email',
  /** The offer before banner and email were told apart (old emails, open tabs). */
  'first_success',
  /** The countdown banner at the top of every page. */
  'trial_banner',
  /** Settings → License. */
  'license_page',
  /** The wall shown once the free trial is over. */
  'trial_ended_wall',
  /** "Add a card" on the page after approving an AI client. */
  'post_approve',
  /** The card-trial page shown once after sign-up. */
  'signup_prompt',
  /** "Add a payment method" next to the connector limit. */
  'trial_limit',
  /** "Add a card for more" in the starter pack on /welcome. */
  'starter_pack',
  /** The plan link the setup tools give the AI in a chat. */
  'chat_setup',
  /** /start-trial opened without a known source. */
  'start_trial',
  /** Any checkout the page did not name (the backend's default). */
  'app',
] as const;
export type CheckoutSource = (typeof CHECKOUT_SOURCES)[number];

/** A `?source=` value the app knows, or null. Anything else is dropped. */
export function parseCheckoutSource(raw: string | null | undefined): CheckoutSource | null {
  const value = (raw ?? '').trim();
  return (CHECKOUT_SOURCES as readonly string[]).includes(value) ? (value as CheckoutSource) : null;
}

/** The card-trial page, marked with where the user came from. */
export function startTrialPath(source: CheckoutSource): string {
  return `/start-trial?source=${source}`;
}

/**
 * `?source=` on links to the public pricing page. Its checkout records it as
 * `metadata.checkout_source`; a value the site does not know is recorded as
 * `pricing_page`, like a visitor who came on their own. Kept in step with
 * PRICING_CHECKOUT_SOURCES on the site (lib/stripe.ts).
 */
export type PricingLinkSource = 'app_pricing' | 'trial_banner' | 'license_page' | 'trial_ended_wall' | 'first_success_email' | 'chat_setup';

/**
 * The source Settings → License passes on (to /start-trial and the pricing
 * link). The offer email and the chat's setup tools link here when the card
 * trial is no longer available, with their own `?source=`; the offer email
 * said `first_success` before the split. Everyone else is the page's own.
 */
export function licensePageSource(raw: string | null | undefined): 'first_success_email' | 'chat_setup' | 'license_page' {
  const value = parseCheckoutSource(raw);
  if (value === 'first_success_email' || value === 'first_success') return 'first_success_email';
  if (value === 'chat_setup') return 'chat_setup';
  return 'license_page';
}
