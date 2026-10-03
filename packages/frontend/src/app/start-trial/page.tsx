'use client';

import { useCallback, useEffect, useState } from 'react';
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
  readAuthorizationReturn,
  readPlanIntent,
  readPromoCode,
  takeAuthorizationReturn,
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
  const [promo, setPromo] = useState<string | null>(null);
  // Set when the user came from "Connect" in an AI client: every way out of
  // this page goes back to that authorization.
  const [authorizationReturn, setAuthorizationReturn] = useState<string | null>(null);

  /** Leave for the waiting authorization (a backend page) or for `fallback`. */
  const leave = useCallback(
    (fallback: string) => {
      const target = takeAuthorizationReturn(fallback);
      if (target.startsWith('/auth/')) window.location.assign(target);
      else router.replace(target);
    },
    [router],
  );

  useEffect(() => {
    if (isLoading || !deploymentModeLoaded) return;
    if (!token || !user) {
      router.replace('/login?redirect=/start-trial');
      return;
    }
    if (deploymentMode !== 'cloud' || user.role !== 'ADMIN') {
      leave('/');
      return;
    }
    let live = true;
    license
      .getStatus(token)
      .then((lic) => {
        if (!live) return;
        if (!cardTrialEligible({ isCloud: true, role: user.role, license: lic })) {
          leave('/');
          return;
        }
        setAuthorizationReturn(readAuthorizationReturn());
        setTrialEnd(cardTrialDisplayEnd(lic.expiresAt));
        setSelection(readPlanIntent() ?? DEFAULT_SELECTION);
        setPromo(readPromoCode());
        setReady(true);
      })
      .catch(() => {
        if (live) leave('/');
      });
    return () => {
      live = false;
    };
  }, [isLoading, deploymentModeLoaded, deploymentMode, token, user, router, leave]);

  const handleStart = async () => {
    if (!user) return;
    const ok = await checkout.start(selection, true);
    if (ok) writeCardTrialPrompt(user.id, 'checkout');
  };

  const handleSkip = () => {
    if (user) writeCardTrialPrompt(user.id, 'skipped');
    // Back to the AI client's authorization if one is waiting; otherwise the
    // dashboard decides what comes next (usually the /welcome wizard).
    leave('/');
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
            Your 7-day free trial
          </h1>
          <p className="text-[var(--text-2)] max-w-xl mx-auto">
            Every feature, free for 7 days. Add a card now and your plan simply carries on after the
            trial, with nothing charged before{' '}
            {endLong ? <strong className="text-[var(--text)]">{endLong}</strong> : 'the trial ends'}. Or
            try it without payment details — the no-card trial has a{' '}
            <strong className="text-[var(--text)]">lower connector limit</strong>, and you can add a card
            any time to unlock your full plan.
          </p>
          {authorizationReturn && (
            <p className="mt-3 text-sm text-[var(--text-2)] max-w-xl mx-auto">
              Either way, you go straight back to finish connecting your AI client.
            </p>
          )}
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
              {checkout.loading ? 'Opening checkout…' : checkout.error ? 'Try again' : 'Start free trial with card'}
            </Button>
            {promo && (
              <p className="text-xs font-medium text-[var(--ok)] text-center">
                Code {promo} will be applied at checkout.
              </p>
            )}
            {checkout.error && (
              <p role="alert" className="text-sm text-[var(--danger)] text-center">
                {checkout.error}
              </p>
            )}
            <p className="text-xs text-[var(--text-3)] text-center max-w-md">
              €0 today. {plan.name}, billed {selection.period === 'yearly' ? 'yearly' : 'monthly'} from{' '}
              {endLong ?? 'the end of your trial'}. Secure checkout by Stripe. Cancel before then and
              you pay nothing.
            </p>
            <p className="text-xs text-[var(--text-2)] text-center">
              Not ready to add a card?{' '}
              <button
                type="button"
                onClick={handleSkip}
                className="font-medium text-[var(--brand)] underline-offset-2 hover:underline"
              >
                Try free without payment details
              </button>
            </p>
          </div>
        </Card>
      </main>
    </div>
  );
}
