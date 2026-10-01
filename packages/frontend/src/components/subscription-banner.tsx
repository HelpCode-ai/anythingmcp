'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { license, type LicenseBilling } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { describeBilling } from '@/lib/billing-summary';

const DAY = 24 * 60 * 60 * 1000;
const DISMISS_KEY = 'amcp_subscription_banner_dismissed';

/**
 * When a paid Cloud subscription needs the admin's attention, say so above the
 * app — not only in an email they may not read:
 *  - a failed payment, always;
 *  - a plan cancelled at period end, in its last 7 days ("keep my plan");
 *  - a card trial, in its last 3 days ("first charge on X").
 * The free (no-card) trial has its own countdown in TrialBanner.
 */
export function shouldShowSubscriptionBanner(billing: LicenseBilling | undefined, now = Date.now()): boolean {
  if (!billing) return false;
  if (billing.status === 'past_due' || billing.status === 'unpaid') return true;
  const within = (iso: string | null, days: number) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) && t > now && t - now <= days * DAY;
  };
  if (billing.cancelling) return within(billing.endsAt ?? billing.currentPeriodEnd, 7);
  if (billing.status === 'trialing') return within(billing.trialEnd, 3);
  return false;
}

export function SubscriptionBanner() {
  const { token, user, deploymentMode } = useAuth();
  const [billing, setBilling] = useState<LicenseBilling | undefined>();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!token || deploymentMode !== 'cloud' || user?.role !== 'ADMIN') return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (sessionStorage.getItem(DISMISS_KEY) === '1') setDismissed(true);
    } catch {
      /* storage blocked: show it */
    }
    license
      .getStatus(token)
      .then((s) => setBilling(s.billing))
      .catch(() => {});
  }, [token, deploymentMode, user?.role]);

  if (dismissed || !shouldShowSubscriptionBanner(billing)) return null;
  const summary = describeBilling(billing);
  if (!summary) return null;
  const tone = summary.tone === 'neutral' ? 'info' : summary.tone;

  return (
    <div
      className="text-sm py-2 px-4 text-center"
      style={{ backgroundColor: `var(--t-${tone}-bg)`, color: `var(--t-${tone}-fg)` }}
    >
      <span>{summary.text}</span>{' '}
      <Link href="/settings/license" className="underline font-medium hover:no-underline">
        {summary.paymentIssue
          ? 'Update payment method'
          : summary.cancelling
            ? 'Keep my plan'
            : 'Manage billing'}
      </Link>
      {!summary.paymentIssue && (
        <button
          type="button"
          onClick={() => {
            setDismissed(true);
            try {
              sessionStorage.setItem(DISMISS_KEY, '1');
            } catch {
              /* ignore */
            }
          }}
          aria-label="Dismiss"
          className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded hover:bg-black/10"
        >
          ×
        </button>
      )}
    </div>
  );
}
