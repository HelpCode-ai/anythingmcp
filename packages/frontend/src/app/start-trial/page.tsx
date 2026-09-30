'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { license } from '@/lib/api';
import { LogoIcon } from '@/components/logo-icon';
import { PlanPicker } from '@/components/plan-picker';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DEFAULT_SELECTION,
  cardTrialDisplayEnd,
  cardTrialEligible,
  formatTrialEnd,
  planById,
  readPlanIntent,
  writeCardTrialPrompt,
  type PlanSelection,
} from '@/lib/card-trial';
import { useCardCheckout } from '@/lib/use-card-checkout';

/**
 * Cloud only: the card-trial offer shown once after sign-up (see
 * OnboardingRedirect). "Start free trial" opens Stripe Checkout with a trial
 * that ends when the free trial would have; nothing is charged today. The
 * no-card trial the user already has stays one small link away, in the
 * corner, on purpose.
 *
 * Anyone it does not apply to (self-hosted, non-admins, no live trial) is
 * sent to the dashboard.
 */
export default function StartTrialPage() {
  const { token, user, isLoading, deploymentMode, deploymentModeLoaded } = useAuth();
  const router = useRouter();
  const checkout = useCardCheckout();
  const [trialEnd, setTrialEnd] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState<PlanSelection>(DEFAULT_SELECTION);

  useEffect(() => {
    if (isLoading || !deploymentModeLoaded) return;
    if (!token || !user) {
      router.replace('/login?redirect=/start-trial');
      return;
    }
    if (deploymentMode !== 'cloud' || user.role !== 'ADMIN') {
      router.replace('/');
      return;
    }
    let live = true;
    license
      .getStatus(token)
      .then((lic) => {
        if (!live) return;
        if (!cardTrialEligible({ isCloud: true, role: user.role, license: lic })) {
          router.replace('/');
          return;
        }
        setTrialEnd(cardTrialDisplayEnd(lic.expiresAt));
        setSelection(readPlanIntent() ?? DEFAULT_SELECTION);
        setReady(true);
      })
      .catch(() => {
        if (live) router.replace('/');
      });
    return () => {
      live = false;
    };
  }, [isLoading, deploymentModeLoaded, deploymentMode, token, user, router]);

  const handleStart = async () => {
    if (!user) return;
    const ok = await checkout.start(selection, true);
    if (ok) writeCardTrialPrompt(user.id, 'checkout');
  };

  const handleSkip = () => {
    if (user) writeCardTrialPrompt(user.id, 'skipped');
    // The dashboard decides what comes next (usually the /welcome wizard).
    router.replace('/');
  };

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
        <div className="text-sm text-[var(--text-2)]">Loading…</div>
      </div>
    );
  }

  const endLong = formatTrialEnd(trialEnd, 'long');
  const plan = planById(selection.plan);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="max-w-3xl mx-auto px-6 pt-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] bg-[var(--brand-tint)] text-[var(--brand)]">
            <LogoIcon size={20} />
          </span>
          <span className="font-semibold">
            Anything<span className="text-[var(--brand)]">MCP</span>
          </span>
        </div>
        {/* Deliberately quiet: a plain text link in the corner, not a button. */}
        <button
          type="button"
          onClick={handleSkip}
          className="text-xs text-[var(--text-3)] underline-offset-2 hover:text-[var(--text-2)] hover:underline"
        >
          Continue without payment details
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 sm:py-14">
        <div className="text-center mb-8">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--brand)] font-mono mb-3">
            7-day free trial
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
            Start your 7-day free trial
          </h1>
          <p className="text-[var(--text-2)] max-w-xl mx-auto">
            €0 today.{' '}
            {endLong ? (
              <>
                Your plan starts on <strong className="text-[var(--text)]">{endLong}</strong> unless you cancel.
              </>
            ) : (
              'Your plan starts when the trial ends unless you cancel.'
            )}{' '}
            Cancel anytime.
          </p>
        </div>

        <Card className="p-5 sm:p-6">
          <PlanPicker value={selection} onChange={setSelection} disabled={checkout.loading} />

          <div className="mt-6 flex flex-col items-center gap-3">
            <Button
              size="lg"
              className="w-full sm:w-auto sm:min-w-[260px]"
              onClick={handleStart}
              disabled={checkout.loading}
            >
              {checkout.loading ? 'Opening checkout…' : checkout.error ? 'Try again' : 'Start free trial'}
            </Button>
            {checkout.error && (
              <p role="alert" className="text-sm text-[var(--danger)] text-center">
                {checkout.error}
              </p>
            )}
            <p className="text-xs text-[var(--text-3)] text-center max-w-md">
              {plan.name}, billed {selection.period === 'yearly' ? 'yearly' : 'monthly'} from{' '}
              {endLong ?? 'the end of your trial'}. Secure checkout by Stripe. Cancel before then and
              you pay nothing.
            </p>
          </div>
        </Card>
      </main>
    </div>
  );
}
