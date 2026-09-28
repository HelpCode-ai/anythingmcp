'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { useEdition, daysUntil, formatDay } from '@/lib/use-edition';

/**
 * Self-hosted, administrators only: a one-line notice when the edition is
 * about to change or the instance has used every user Community includes.
 * Never blocks anything; dismissible for the session.
 */
export function EditionBanner() {
  const { user } = useAuth();
  const { edition } = useEdition();
  const [dismissed, setDismissed] = useState(false);

  if (!edition || user?.role !== 'ADMIN' || dismissed) return null;

  let text: string | null = null;
  let tone: 'info' | 'warn' = 'info';

  if (edition.source === 'trial' && edition.trialEndsAt) {
    const left = daysUntil(edition.trialEndsAt) ?? 0;
    // The whole trial would be noisy; the last week is when it matters.
    if (left <= 7) {
      text =
        left === 0
          ? 'Your Business trial ends today.'
          : `Business trial: ${left} day${left === 1 ? '' : 's'} left.`;
      tone = left <= 2 ? 'warn' : 'info';
    }
  } else if (edition.source === 'transition' && edition.transitionUntil) {
    text = `Single sign-on, SCIM and more than ${edition.communitySeatLimit} users remain available on this instance until ${formatDay(edition.transitionUntil)}.`;
  } else if (
    !edition.business &&
    edition.seatLimit !== null &&
    edition.seatsUsed >= edition.seatLimit
  ) {
    text = `This instance has ${edition.seatsUsed} active users; Community includes ${edition.seatLimit}.`;
  }

  if (!text) return null;

  return (
    <div
      className="text-sm py-2 px-4 text-center"
      style={{ backgroundColor: `var(--t-${tone}-bg)`, color: `var(--t-${tone}-fg)` }}
    >
      <span>{text}</span>{' '}
      <Link href="/settings/license" className="underline font-medium hover:no-underline">
        {edition.trialAvailable ? 'Try Business' : 'See options'}
      </Link>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded hover:bg-black/10"
      >
        ×
      </button>
    </div>
  );
}
