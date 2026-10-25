'use client';

import { useEffect, useState } from 'react';
import { getMarketingUrl } from './marketing';

/**
 * What a visitor outside the euro area will roughly pay in their own currency.
 *
 * Plan prices are in euros, and so are invoices. Stripe Checkout charges a
 * visitor from the US in dollars, one from the UK in pounds (Adaptive
 * Pricing), and only buyers in the EU pay VAT. The marketing site's
 * /api/price-estimate knows the visitor's country (Cloudflare) and the rate,
 * so the app asks it from the browser, as the pricing page does. Cloud only.
 */
export interface LocalPricing {
  /** ISO code of the checkout currency, or null when the visitor pays in euros. */
  currency: string | null;
  /** Approximate units of `currency` per euro, Stripe's fee included. */
  rate: number | null;
  /** Whether the visitor pays VAT: false outside the EU, null when unknown. */
  vat: boolean | null;
}

/** Shape check on the site's answer; anything else counts as no answer. */
export function parseLocalPricing(raw: unknown): LocalPricing | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const currency = typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency) ? b.currency : null;
  const rate = typeof b.rate === 'number' && Number.isFinite(b.rate) && b.rate > 0 ? b.rate : null;
  const vat = typeof b.vat === 'boolean' ? b.vat : null;
  return { currency: currency && rate ? currency : null, rate: currency && rate ? rate : null, vat };
}

/** "≈ $22.15" for 19 € at 1.1656, or null when the visitor pays in euros. */
export function formatLocal(euros: number, pricing: LocalPricing | null): string | null {
  if (!pricing?.currency || !pricing.rate) return null;
  const amount = euros * pricing.rate;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: pricing.currency,
      currencyDisplay: 'narrowSymbol',
    }).format(amount);
  } catch {
    return null;
  }
}

let request: Promise<LocalPricing | null> | null = null;

function fetchLocalPricing(): Promise<LocalPricing | null> {
  request ??= fetch(`${getMarketingUrl()}/api/price-estimate`, { credentials: 'omit' })
    .then((res) => (res.ok ? res.json() : null))
    .then(parseLocalPricing)
    .catch(() => null);
  return request;
}

/**
 * The visitor's checkout currency and VAT status, asked once per page load.
 * Null until it arrives, and for good when `enabled` is false (self-hosted)
 * or the site cannot be reached: then everything stays in euros.
 */
export function useLocalPricing(enabled: boolean): LocalPricing | null {
  const [pricing, setPricing] = useState<LocalPricing | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchLocalPricing().then((p) => {
      if (!cancelled) setPricing(p);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? pricing : null;
}
