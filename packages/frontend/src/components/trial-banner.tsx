'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { license } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { usePricingUrl } from '@/lib/use-pricing-url';
import { useCardCheckout } from '@/lib/use-card-checkout';
import {
  cardTrialDisplayEnd,
  cardTrialEligible,
  formatTrialEnd,
  readPlanIntent,
} from '@/lib/card-trial';

export function TrialBanner() {
  const { token, user, deploymentMode } = useAuth();
  const router = useRouter();
  const pricingUrl = usePricingUrl();
  const checkout = useCardCheckout();
  const [daysLeft, setDaysLeft] = useState<number | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<number | null>(null);

  useEffect(() => {
    if (!token) return;
    license.getStatus(token).then((status) => {
      setPlan(status.plan);
      setStatus(status.status);
      setExpiresAt(status.expiresAt);
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

  // Cloud admins on a running trial add a card instead (the card trial ends
  // with the free trial, nothing is charged before). Everyone else, and
  // self-hosted, keeps the pricing link.
  const offerCard = cardTrialEligible({
    isCloud: deploymentMode === 'cloud',
    role: user?.role,
    license: { plan, status: status ?? '', expiresAt, trialDaysLeft: daysLeft },
  });
  const chargeDate = formatTrialEnd(cardTrialDisplayEnd(expiresAt), 'short');

  const addPaymentMethod = async () => {
    // With a plan picked on the pricing page, straight to Checkout;
    // otherwise to the plan picker first.
    const intent = readPlanIntent();
    if (!intent) {
      router.push('/start-trial');
      return;
    }
    const ok = await checkout.start(intent, true);
    if (!ok) window.location.assign(pricingUrl);
  };

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
      {offerCard ? (
        <button
          type="button"
          onClick={addPaymentMethod}
          disabled={checkout.loading}
          className="underline font-medium hover:no-underline disabled:opacity-60"
        >
          {checkout.loading
            ? 'Opening checkout…'
            : chargeDate
              ? `Add a payment method — no charge before ${chargeDate}`
              : 'Add a payment method'}
        </button>
      ) : (
        <a
          href={pricingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium hover:no-underline"
        >
          Upgrade now
        </a>
      )}
    </div>
  );
}
