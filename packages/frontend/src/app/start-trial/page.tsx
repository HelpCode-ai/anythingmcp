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
  formatEur,
  formatPlanPrice,
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
import { fetchCardTrialKind } from '@/lib/use-card-trial-eligibility';
import { parseCheckoutSource, type CheckoutSource } from '@/lib/first-success-offer';

/**
 * Cloud only: the card-trial offer shown once after sign-up (see
 * OnboardingRedirect). "Start free trial" opens Stripe Checkout with a trial
 * that ends when the free trial would have; nothing is charged today. The
 * no-card trial the user already has stays one small link away, in the
 * corner, on purpose.
 *
 * An address that had a subscription before gets no trial from the licence
 * site: Checkout charges it today. The page asks first
 * (/api/license/card-trial-eligibility) and then says so plainly, with the
 * plan's price, instead of "€0 today". If the site still refuses the trial at
 * checkout, the page switches to the same wording before sending anyone on.
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
  // 'pay': this address had a subscription, so the plan starts and is billed today.
  const [kind, setKind] = useState<'trial' | 'pay'>('trial');
  // Which in-app offer sent the user here (?source=first_success), for Stripe.
  const [source, setSource] = useState<CheckoutSource | null>(null);
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
      // Keep ?source= through the sign-in (the offer email links here).
      router.replace(`/login?redirect=${encodeURIComponent(`/start-trial${window.location.search}`)}`);
      return;
    }
    if (deploymentMode !== 'cloud' || user.role !== 'ADMIN') {
      leave('/');
      return;
    }
    let live = true;
    Promise.all([license.getStatus(token), fetchCardTrialKind(token)])
      .then(([lic, trialKind]) => {
        if (!live) return;
        if (!cardTrialEligible({ isCloud: true, role: user.role, license: lic }) || trialKind === 'none') {
          leave('/');
          return;
        }
        setKind(trialKind);
        setAuthorizationReturn(readAuthorizationReturn());
        setTrialEnd(cardTrialDisplayEnd(lic.expiresAt));
        setSelection(readPlanIntent() ?? DEFAULT_SELECTION);
        setPromo(readPromoCode());
        setSource(parseCheckoutSource(new URLSearchParams(window.location.search).get('source')));
        setReady(true);
      })
      .catch(() => {
        if (live) leave('/');
      });
    return () => {
      live = false;
    };
  }, [isLoading, deploymentModeLoaded, deploymentMode, token, user, router, leave]);

  // The licence site refused the trial at checkout: say so before sending anyone on.
  const paysToday = kind === 'pay' || !!checkout.chargesTodayUrl;

  const handleStart = async () => {
    if (!user) return;
    if (checkout.chargesTodayUrl) {
      writeCardTrialPrompt(user.id, 'checkout');
      window.location.assign(checkout.chargesTodayUrl);
      return;
    }
    const outcome = await checkout.start(selection, !paysToday, source);
    if (outcome === 'redirected') writeCardTrialPrompt(user.id, 'checkout');
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
  const price = formatPlanPrice(plan, selection.period);
  const dueToday = formatEur(selection.period === 'yearly' ? plan.yearly : plan.monthly);
  const startLabel = checkout.loading
    ? 'Opening checkout…'
    : checkout.error
      ? 'Try again'
      : paysToday
        ? 'Continue to checkout'
        : 'Start free trial with card';

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
            {paysToday ? 'Choose your plan' : endLong ? `Free until ${endLong}` : 'Free trial'}
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
            {paysToday ? 'Keep your workspace running' : 'Your free trial'}
          </h1>
          {paysToday ? (
            <p className="text-[var(--text-2)] max-w-xl mx-auto">
              This email address has had an AnythingMCP subscription before, so a new free trial is
              not available with a card. <strong className="text-[var(--text)]">Your plan starts today
              and is billed today.</strong> Your workspace, connectors and settings stay exactly as they
              are{endLong ? <>, and your current trial keeps running until{' '}
              <strong className="text-[var(--text)]">{endLong}</strong> if you decide later</> : ''}.
            </p>
          ) : (
            <p className="text-[var(--text-2)] max-w-xl mx-auto">
              Every feature, free until{' '}
              {endLong ? <strong className="text-[var(--text)]">{endLong}</strong> : 'your trial ends'}. Add
              a card now and your plan simply carries on after the trial, with nothing charged before
              then. Or keep trying without payment details: the no-card trial has a{' '}
              <strong className="text-[var(--text)]">lower connector limit</strong>, and you can add a card
              any time to unlock your full plan.
            </p>
          )}
          {authorizationReturn && (
            <p className="mt-3 text-sm text-[var(--text-2)] max-w-xl mx-auto">
              Either way, you go straight back to finish connecting your AI client.
            </p>
          )}
        </div>

        <Card className="p-5 sm:p-6">
          <PlanPicker
            value={selection}
            onChange={setSelection}
            disabled={checkout.loading || !!checkout.chargesTodayUrl}
          />

          <div className="mt-6 flex flex-col items-center gap-3">
            {checkout.chargesTodayUrl && (
              <p role="status" className="text-sm text-[var(--text)] text-center max-w-md">
                This address already had a subscription, so the checkout will charge {dueToday} today.
              </p>
            )}
            <Button
              size="lg"
              className="w-full sm:w-auto sm:min-w-[260px]"
              onClick={handleStart}
              disabled={checkout.loading}
            >
              {startLabel}
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
              {paysToday ? (
                <>
                  {plan.name}, {price}, billed today and then {selection.period === 'yearly' ? 'every year' : 'every month'}.
                  Secure checkout by Stripe. Cancel anytime from the billing portal.
                </>
              ) : (
                <>
                  €0 today. {plan.name}, billed {selection.period === 'yearly' ? 'yearly' : 'monthly'} from{' '}
                  {endLong ?? 'the end of your trial'}. Secure checkout by Stripe. Cancel before then and
                  you pay nothing.
                </>
              )}
            </p>
            <p className="text-xs text-[var(--text-2)] text-center">
              {paysToday ? 'Not ready yet?' : 'Not ready to add a card?'}{' '}
              <button
                type="button"
                onClick={handleSkip}
                className="font-medium text-[var(--brand)] underline-offset-2 hover:underline"
              >
                {paysToday ? 'Keep using the free trial' : 'Try free without payment details'}
              </button>
            </p>
          </div>
        </Card>
      </main>
    </div>
  );
}
