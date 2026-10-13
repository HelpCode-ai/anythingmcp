'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { license, productEvents } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { storage } from '@/lib/storage';
import { formatTrialEnd } from '@/lib/card-trial';
import { Button } from '@/components/ui/button';
import {
  OFFER_START_PATH,
  isOfferDismissed,
  offerDay,
  offerDetail,
  offerDismissKey,
  offerHeadline,
  offerShownKey,
  shouldReportShown,
  type OfferVia,
} from '@/lib/first-success-offer';

type Offer = { connectorName: string | null; trialEndsAt: string };

/**
 * Cloud only: the card-trial offer right after the workspace's first
 * successful tool call, on the dashboard and the connector and connect pages.
 *
 * Shown to admins only (the only role that can start a subscription), only
 * while the backend says the workspace is eligible (no-card trial, at least
 * 48 hours left). Non-blocking and dismissible: "Not now" hides it for three
 * days on every page. The button opens the existing card-trial page with
 * ?source=first_success, which follows the checkout into Stripe metadata.
 *
 * `refreshKey` asks again, e.g. when the connect page sees the first request
 * arrive.
 */
export function FirstSuccessOffer({ via, refreshKey = 0 }: { via: OfferVia; refreshKey?: number }) {
  const { token, user, deploymentMode } = useAuth();
  const router = useRouter();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const userId = user?.id;
  const applies = !!token && !!userId && deploymentMode === 'cloud' && user?.role === 'ADMIN';

  useEffect(() => {
    if (!applies || !token || !userId) return;
    if (isOfferDismissed(storage.get(offerDismissKey(userId)))) return;
    let live = true;
    license
      .cardTrialOffer(token)
      .then((res) => {
        if (live) setOffer(res?.offer ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [applies, token, userId, refreshKey]);

  // Reported once a day per user and browser, not on every render or page.
  useEffect(() => {
    if (!offer || !userId || !token) return;
    const key = offerShownKey(userId);
    if (!shouldReportShown(storage.get(key))) return;
    storage.set(key, offerDay());
    productEvents.track('card_trial_offer_shown', token, { via });
  }, [offer, userId, token, via]);

  if (!applies || !offer || dismissed) return null;

  const trialEnd = formatTrialEnd(offer.trialEndsAt, 'long');

  const start = () => {
    if (token) productEvents.track('card_trial_offer_clicked', token, { via });
    router.push(OFFER_START_PATH);
  };

  const dismiss = () => {
    if (userId) storage.set(offerDismissKey(userId), String(Date.now()));
    if (token) productEvents.track('card_trial_offer_dismissed', token, { via });
    setDismissed(true);
  };

  return (
    <div
      role="region"
      aria-label="Start your trial"
      data-testid="first-success-offer"
      className="flex flex-col gap-3 rounded-[14px] border border-[var(--brand)]/30 bg-[var(--brand-tint)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold"
          style={{ background: 'var(--t-emerald-bg)', color: 'var(--t-emerald-fg)' }}
          aria-hidden
        >
          ✓
        </span>
        <div>
          <div className="text-sm font-semibold">{offerHeadline(offer.connectorName)}</div>
          <div className="mt-0.5 text-xs text-[var(--text-2)]">{offerDetail(offer.connectorName, trialEnd)}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 sm:ml-4">
        <button
          type="button"
          onClick={dismiss}
          className="text-xs text-[var(--text-3)] underline-offset-2 hover:text-[var(--text-2)] hover:underline"
        >
          Not now
        </button>
        <Button onClick={start}>Start your 7-day trial</Button>
      </div>
    </div>
  );
}
