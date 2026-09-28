import { CLICK_ID_KEYS, cleanClickId, type ClickIds } from './attribution';

const DEFAULT_MARKETING_URL = 'https://anythingmcp.com';

export function getMarketingUrl(): string {
  if (typeof process !== 'undefined') {
    const env = (process as { env?: Record<string, string | undefined> }).env;
    const fromEnv = env?.NEXT_PUBLIC_MARKETING_URL;
    if (fromEnv) return fromEnv.replace(/\/$/, '');
  }
  return DEFAULT_MARKETING_URL;
}

/**
 * The pricing page, with `return_url` back to this app. On AnythingMCP Cloud
 * the caller may pass the user's own Google Ads click id (see usePricingUrl),
 * which the pricing page puts into the checkout so the purchase can be
 * reported to Google Ads; anything that is not a well-formed id is left out.
 * A self-hosted instance opens the page on its own plans (`hosting=self-hosted`).
 */
export function buildPricingUrl(
  returnPath = '/settings/license/activate',
  clickIds?: ClickIds | null,
  selfHosted = false,
): string {
  const base = `${getMarketingUrl()}/pricing`;
  if (typeof window === 'undefined') return selfHosted ? `${base}?hosting=self-hosted` : base;
  const returnUrl = `${window.location.origin}${returnPath}`;
  let url = `${base}?return_url=${encodeURIComponent(returnUrl)}`;
  if (selfHosted) url += '&hosting=self-hosted';
  for (const key of CLICK_ID_KEYS) {
    const id = cleanClickId(clickIds?.[key]);
    if (id) url += `&${key}=${id}`;
  }
  return url;
}

/**
 * Where a customer who already pays changes plan: the billing portal on the
 * marketing site, reached through /account, which mails the portal link to the
 * address that owns the subscription.
 *
 * Not the pricing page. A checkout does not change a plan, it adds one, and
 * until 23 Sep every upgrade nudge in this app sent paying customers to a
 * fresh checkout — two of them moved Starter to Team that way and were billed
 * for both. The portal's plan switch replaces the subscription and prorates.
 *
 * The address is not put in the URL (it used to be, as `?email=`, to prefill
 * the form): URLs end up in analytics, Referer headers and browser history.
 * On Cloud, admins skip /account altogether — see useManagePlan.
 */
export function buildManagePlanUrl(params?: Record<string, string>): string {
  const url = new URL(`${getMarketingUrl()}/account`);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url.toString();
}
