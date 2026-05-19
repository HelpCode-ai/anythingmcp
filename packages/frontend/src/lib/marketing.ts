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
