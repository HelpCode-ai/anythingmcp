'use client';

import { useState, useEffect } from 'react';
import { license } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

export function TrialBanner() {
  const { token } = useAuth();
  const [daysLeft, setDaysLeft] = useState<number | null>(null);
  const [plan, setPlan] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    license.getStatus(token).then((status) => {
      setPlan(status.plan);
      if (status.trialDaysLeft !== undefined) {
        setDaysLeft(status.trialDaysLeft);
      }
    }).catch(() => {});
  }, [token]);

  if (plan !== 'trial' || daysLeft === null) return null;

  const isUrgent = daysLeft <= 1;
  const isWarning = daysLeft <= 3;

  const bgColor = isUrgent
    ? 'bg-red-600'
    : isWarning
      ? 'bg-amber-500'
      : 'bg-blue-600';

  return (
    <div className={`${bgColor} text-white text-sm py-2 px-4 text-center`}>
      <span>
        {daysLeft === 0
          ? 'Your trial expires today.'
          : daysLeft === 1
            ? 'Your trial expires tomorrow.'
            : `Trial: ${daysLeft} days left.`}
      </span>
      {' '}
      <a
        href="https://anythingmcp.com/pricing"
        target="_blank"
        rel="noopener noreferrer"
        className="underline font-medium hover:no-underline"
      >
        Upgrade now
      </a>
    </div>
  );
}
