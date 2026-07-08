'use client';

import { useState, useEffect } from 'react';
import { license } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { buildPricingUrl } from '@/lib/marketing';

export function TrialBanner() {
  const { token } = useAuth();
  const [daysLeft, setDaysLeft] = useState<number | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<number | null>(null);

  useEffect(() => {
    if (!token) return;
    license.getStatus(token).then((status) => {
      setPlan(status.plan);
      if (status.trialDaysLeft !== undefined) {
        setDaysLeft(status.trialDaysLeft);
      }
    }).catch(() => {});
    // Value framing: how much the user has already built (so the upgrade
    // protects something concrete, not just "your trial ends").
    license.getUsage(token)
      .then((u) => setConnectors(u?.connectors?.current ?? null))
      .catch(() => {});
  }, [token]);

  if (plan !== 'trial' || daysLeft === null) return null;

  const isUrgent = daysLeft <= 1;
  const isWarning = daysLeft <= 3;

  const tone = isUrgent ? 'danger' : isWarning ? 'warn' : 'info';

  const countdown =
    daysLeft === 0
      ? 'Your trial expires today.'
      : daysLeft === 1
        ? 'Your trial expires tomorrow.'
        : `Trial: ${daysLeft} days left.`;

  // Only show the value clause once they've actually built something.
  const value =
    connectors && connectors > 0
      ? ` Keep your ${connectors} connector${connectors === 1 ? '' : 's'} running —`
      : '';

  return (
    <div
      className="text-sm py-2 px-4 text-center"
      style={{
        backgroundColor: `var(--t-${tone}-bg)`,
        color: `var(--t-${tone}-fg)`,
      }}
    >
      <span>{countdown}{value}</span>
      {' '}
      <a
        href={buildPricingUrl()}
        target="_blank"
        rel="noopener noreferrer"
        className="underline font-medium hover:no-underline"
      >
        Upgrade now
      </a>
    </div>
  );
}
