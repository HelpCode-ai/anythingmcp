'use client';

import { useCallback, useState } from 'react';
import { ApiError, license } from './api';
import { useAuth } from './auth-context';
import { readPromoCode, type PlanSelection } from './card-trial';
import type { CheckoutSource } from './first-success-offer';

const GENERIC_ERROR = 'We could not open the checkout. Please try again in a moment.';

/**
 * What became of a checkout request:
 * - 'redirected': the page is leaving for Stripe Checkout;
 * - 'charges_today': a card trial was asked for, but the licence site will
 *   charge today (the address had a subscription before). Nothing was opened:
 *   `chargesTodayUrl` holds the checkout, for the page to say so first;
 * - 'failed': `error` says why.
 */
export type CheckoutOutcome = 'redirected' | 'charges_today' | 'failed';

/**
 * Opens Stripe Checkout for a Cloud plan (POST /api/license/checkout-link),
 * then leaves the page for it. `trial: true` is the card trial that ends with
 * the free trial; `false` is a plain purchase. `source` marks the in-app offer
 * that led here, for Stripe metadata.
 */
export function useCardCheckout() {
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chargesTodayUrl, setChargesTodayUrl] = useState<string | null>(null);

  const start = useCallback(
    async (selection: PlanSelection, trial: boolean, source?: CheckoutSource | null): Promise<CheckoutOutcome> => {
      if (!token) return 'failed';
      setLoading(true);
      setError(null);
      try {
        const promo = readPromoCode();
        const res = await license.checkoutLink(token, {
          plan: selection.plan,
          billingPeriod: selection.period,
          trial,
          ...(promo && { promo }),
          ...(source && { source }),
        });
        // A trial was asked for and the licence site did not grant it: never
        // send someone to a charge the page did not announce.
        if (trial && res.trial === false) {
          setChargesTodayUrl(res.url);
          setLoading(false);
          return 'charges_today';
        }
        // Stays "loading" on purpose: the page is being left.
        window.location.assign(res.url);
        return 'redirected';
      } catch (err) {
        // A 409 says why (the workspace already pays); anything else is ours.
        setError(err instanceof ApiError && err.status === 409 ? err.message : GENERIC_ERROR);
        setLoading(false);
        return 'failed';
      }
    },
    [token],
  );

  return { start, loading, error, chargesTodayUrl };
}
