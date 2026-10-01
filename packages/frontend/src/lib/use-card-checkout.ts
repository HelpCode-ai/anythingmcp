'use client';

import { useCallback, useState } from 'react';
import { ApiError, license } from './api';
import { useAuth } from './auth-context';
import { readPromoCode, type PlanSelection } from './card-trial';

const GENERIC_ERROR = 'We could not open the checkout. Please try again in a moment.';

/**
 * Opens Stripe Checkout for a Cloud plan (POST /api/license/checkout-link),
 * then leaves the page for it. `trial: true` is the card trial that ends with
 * the free trial; `false` is a plain purchase. Resolves false on failure so a
 * caller can fall back (e.g. to the pricing page); `error` holds a message
 * fit to show.
 */
export function useCardCheckout() {
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (selection: PlanSelection, trial: boolean): Promise<boolean> => {
      if (!token) return false;
      setLoading(true);
      setError(null);
      try {
        const promo = readPromoCode();
        const { url } = await license.checkoutLink(token, {
          plan: selection.plan,
          billingPeriod: selection.period,
          trial,
          ...(promo && { promo }),
        });
        // Stays "loading" on purpose: the page is being left.
        window.location.assign(url);
        return true;
      } catch (err) {
        // A 409 says why (the workspace already pays); anything else is ours.
        setError(err instanceof ApiError && err.status === 409 ? err.message : GENERIC_ERROR);
        setLoading(false);
        return false;
      }
    },
    [token],
  );

  return { start, loading, error };
}
