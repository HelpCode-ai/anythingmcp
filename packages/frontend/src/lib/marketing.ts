const DEFAULT_MARKETING_URL = 'https://anythingmcp.com';

export function getMarketingUrl(): string {
  if (typeof process !== 'undefined') {
    const env = (process as { env?: Record<string, string | undefined> }).env;
    const fromEnv = env?.NEXT_PUBLIC_MARKETING_URL;
    if (fromEnv) return fromEnv.replace(/\/$/, '');
  }
  return DEFAULT_MARKETING_URL;
}

export function buildPricingUrl(returnPath = '/settings/license/activate'): string {
  const base = `${getMarketingUrl()}/pricing`;
  if (typeof window === 'undefined') return base;
  const returnUrl = `${window.location.origin}${returnPath}`;
  return `${base}?return_url=${encodeURIComponent(returnUrl)}`;
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
