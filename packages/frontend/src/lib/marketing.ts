import { CLICK_ID_KEYS, cleanClickId, type ClickIds } from './attribution';
import type { PricingLinkSource } from './checkout-source';

const DEFAULT_MARKETING_URL = 'https://anythingmcp.com';

/**
 * AnythingMCP's listing in Claude's connector directory. Connecting from there
 * reaches AnythingMCP Cloud's shared /mcp endpoint, so it is only offered on
 * Cloud: a self-hosted instance is never what that listing connects to.
 */
export const CLAUDE_DIRECTORY_URL = 'https://claude.ai/directory/anythingmcp';

export function getMarketingUrl(): string {
  if (typeof process !== 'undefined') {
    const env = (process as { env?: Record<string, string | undefined> }).env;
    const fromEnv = env?.NEXT_PUBLIC_MARKETING_URL;
    if (fromEnv) return fromEnv.replace(/\/$/, '');
  }
  return DEFAULT_MARKETING_URL;
}

/** What the pricing page accepts as an address token. */
const EMAIL_TOKEN_RE = /^[A-Za-z0-9_-]{20,1024}$/;

/**
 * The pricing page, with `return_url` back to this app. On AnythingMCP Cloud
 * the caller may pass the user's own ad click ids (a Google Ads one and a
 * ChatGPT Ads `oppref`, see usePricingUrl), which the pricing page puts into
 * the checkout so the purchase can be reported to the ad platform; anything
 * that is not a well-formed id is left out.
 * A self-hosted instance opens the page on its own plans (`hosting=self-hosted`).
 *
 * `emailToken` is the signed-in user's address token (from the Cloud server),
 * put in the fragment (`#t=`): the pricing page then knows who is buying and
 * refuses a second subscription beside a card trial or plan the address
 * already has. The address itself never appears in the URL.
 *
 * `source` names the place in the app the link sits in; the pricing page's
 * checkout stores it in Stripe as `metadata.checkout_source`.
 */
export function buildPricingUrl(
  returnPath = '/settings/license/activate',
  clickIds?: ClickIds | null,
  selfHosted = false,
  emailToken?: string | null,
  source?: PricingLinkSource | null,
): string {
  const base = `${getMarketingUrl()}/pricing`;
  if (typeof window === 'undefined') return selfHosted ? `${base}?hosting=self-hosted` : base;
  const returnUrl = `${window.location.origin}${returnPath}`;
  let url = `${base}?return_url=${encodeURIComponent(returnUrl)}`;
  if (selfHosted) url += '&hosting=self-hosted';
  if (source) url += `&source=${source}`;
  for (const key of CLICK_ID_KEYS) {
    const id = cleanClickId(clickIds?.[key], key);
    if (id) url += `&${key}=${encodeURIComponent(id)}`;
  }
  if (emailToken && EMAIL_TOKEN_RE.test(emailToken)) url += `#t=${emailToken}`;
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

/**
 * Enterprise has no checkout: the contact form on the marketing site, with
 * Enterprise preselected (`?plan=enterprise`). Single sign-on, SCIM and
 * anything beyond Team's limits are sold this way.
 */
export function buildEnterpriseContactUrl(params?: Record<string, string>): string {
  const url = new URL(`${getMarketingUrl()}/contact`);
  url.searchParams.set('plan', 'enterprise');
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url.toString();
}
