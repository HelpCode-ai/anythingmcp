'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { license, productEvents } from '@/lib/api';
import { LogoIcon } from '@/components/logo-icon';
import { PlanPicker } from '@/components/plan-picker';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DEFAULT_SELECTION,
  cardTrialDisplayEnd,
  cardTrialEligible,
  formatEur,
  formatTrialEnd,
  planById,
  readAuthorizationReturn,
  readPlanIntent,
  readPromoCode,
  takeAuthorizationReturn,
  trialRunning,
  writeCardTrialPrompt,
  type PlanSelection,
} from '@/lib/card-trial';
import { useCardCheckout } from '@/lib/use-card-checkout';
import { formatLocal, useLocalPricing } from '@/lib/local-currency';
import { fetchCardTrialKind } from '@/lib/use-card-trial-eligibility';
import { parseCheckoutSource, type CheckoutSource } from '@/lib/checkout-source';

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
 * With under 48 hours of the free trial left, Stripe cannot take a trial
 * ending then: the page sells the plan billed today instead, and says so
 * (someone who clicked "Buy" on the pricing page in their trial's last day
 * lands here). The same wording as for a returning subscriber, with its own
 * reason.
 *
 * Anyone it does not apply to (self-hosted, non-admins, no running trial) is
 * sent to the dashboard.
 *
 * `?source=` names the entry point that led here (lib/checkout-source.ts). It
 * goes with the checkout into Stripe metadata, and with the page's two
 * product events: start_trial_viewed (once per load) and
 * start_trial_checkout_started (the button), so each entry point's clicks,
 * emails included, can be read against the checkouts it produced.
 */
/**
 * 'mobile' on a touch screen, otherwise 'desktop': all start_trial_viewed
 * records of the device, so the card-trial page can be read per device.
 */
function deviceKind(): 'mobile' | 'desktop' {
  try {
    return window.matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop';
  } catch {
    return 'desktop';
  }
}

export default function StartTrialPage() {
  const { token, user, isLoading, deploymentMode, deploymentModeLoaded } = useAuth();
  const localPricing = useLocalPricing(deploymentMode === 'cloud');
  const router = useRouter();
  const t = useTranslations('startTrial');
  // Dates in the UI language; English keeps the British "7 October 2026".
  const locale = useLocale();
  const dateLocale = locale === 'en' ? 'en-GB' : locale;
  const checkout = useCardCheckout();
  const [trialEnd, setTrialEnd] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState<PlanSelection>(DEFAULT_SELECTION);
  const [promo, setPromo] = useState<string | null>(null);
  // 'pay': this address had a subscription, so the plan starts and is billed today.
  // 'ending': under 48 hours of the free trial left, too late for a card trial;
  // billed today as well.
  const [kind, setKind] = useState<'trial' | 'pay' | 'ending'>('trial');
  // When the free trial ends, also when it is too near for a card trial.
  const [freeTrialEnd, setFreeTrialEnd] = useState<string | null>(null);
  // Which entry point sent the user here (?source=…), for Stripe and the events.
  const [source, setSource] = useState<CheckoutSource>('start_trial');
  const viewReported = useRef(false);
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
        if (!trialRunning(lic)) {
          leave('/');
          return;
        }
        // The card trial needs 48 hours of the free trial left; with less,
        // the plan is sold billed today.
        const cardTrial = cardTrialEligible({ isCloud: true, role: user.role, license: lic });
        const pageKind = cardTrial && trialKind !== 'none' ? trialKind : 'ending';
        setKind(pageKind);
        setFreeTrialEnd(lic.expiresAt ?? null);
        setAuthorizationReturn(readAuthorizationReturn());
        setTrialEnd(cardTrialDisplayEnd(lic.expiresAt));
        setSelection(readPlanIntent() ?? DEFAULT_SELECTION);
        setPromo(readPromoCode());
        const from = parseCheckoutSource(new URLSearchParams(window.location.search).get('source')) ?? 'start_trial';
        setSource(from);
        setReady(true);
        if (!viewReported.current) {
          viewReported.current = true;
          productEvents.track('start_trial_viewed', token, { source: from, kind: pageKind, device: deviceKind() });
        }
      })
      .catch(() => {
        if (live) leave('/');
      });
    return () => {
      live = false;
    };
  }, [isLoading, deploymentModeLoaded, deploymentMode, token, user, router, leave]);

  // The licence site refused the trial at checkout: say so before sending anyone on.
  const paysToday = kind !== 'trial' || !!checkout.chargesTodayUrl;

  const handleStart = async () => {
    if (!user) return;
    if (checkout.chargesTodayUrl) {
      writeCardTrialPrompt(user.id, 'checkout');
      window.location.assign(checkout.chargesTodayUrl);
      return;
    }
    if (token) productEvents.track('start_trial_checkout_started', token, { source, kind: paysToday ? 'pay' : 'trial' });
    const outcome = await checkout.start(selection, !paysToday, source);
    if (outcome === 'redirected') writeCardTrialPrompt(user.id, 'checkout');
  };

  const handleSkip = () => {
    if (user) writeCardTrialPrompt(user.id, 'skipped');
    if (token) productEvents.track('start_trial_skipped', token, { source, kind: paysToday ? 'pay' : 'trial' });
    // Back to the AI client's authorization if one is waiting; otherwise the
    // dashboard decides what comes next (usually the /welcome wizard).
    leave('/');
  };

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
        <div className="text-sm text-[var(--text-2)]">{t('loading')}</div>
      </div>
    );
  }

  const endLong = formatTrialEnd(trialEnd, 'long', undefined, dateLocale);
  const freeTrialEndLong = formatTrialEnd(freeTrialEnd, 'long', undefined, dateLocale);
  const plan = planById(selection.plan);
  // Outside the euro area Stripe charges in the visitor's currency: say
  // roughly how much, next to the exact euro price.
  const euros = selection.period === 'yearly' ? plan.yearly : plan.monthly;
  const local = formatLocal(euros, localPricing);
  const exactPrice = t('price', { amount: formatEur(euros), period: selection.period });
  const price = local ? t('priceLocal', { local, period: selection.period, exact: exactPrice }) : exactPrice;
  const dueToday = local ? `≈ ${local} (${formatEur(euros)})` : formatEur(euros);
  const strong = (chunks: React.ReactNode) => <strong className="text-[var(--text)]">{chunks}</strong>;
  const startLabel = checkout.loading
    ? t('start.opening')
    : checkout.error
      ? t('start.tryAgain')
      : paysToday
        ? t('start.checkout')
        : t('start.withCard');

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
          {t('skipCorner')}
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 sm:py-14">
        <div className="text-center mb-8">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--brand)] font-mono mb-3">
            {paysToday ? t('eyebrow.choosePlan') : endLong ? t('eyebrow.freeUntil', { date: endLong }) : t('eyebrow.freeTrial')}
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
            {paysToday ? t('title.paysToday') : t('title.trial')}
          </h1>
          {kind === 'ending' ? (
            <p className="text-[var(--text-2)] max-w-xl mx-auto">
              {freeTrialEndLong
                ? t.rich('ending', { date: freeTrialEndLong, strong })
                : t.rich('endingSoon', { strong })}
            </p>
          ) : paysToday ? (
            <p className="text-[var(--text-2)] max-w-xl mx-auto">
              {endLong ? t.rich('returning', { date: endLong, strong }) : t.rich('returningNoDate', { strong })}
            </p>
          ) : (
            <p className="text-[var(--text-2)] max-w-xl mx-auto">
              {endLong ? t.rich('trial', { date: endLong, strong }) : t.rich('trialNoDate', { strong })}
            </p>
          )}
          {authorizationReturn && (
            <p className="mt-3 text-sm text-[var(--text-2)] max-w-xl mx-auto">
              {t('authorizationReturn')}
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
                {t('chargesToday', { amount: dueToday })}
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
                {t('promo', { code: promo })}
              </p>
            )}
            {checkout.error && (
              <p role="alert" className="text-sm text-[var(--danger)] text-center">
                {checkout.error}
              </p>
            )}
            <p className="text-xs text-[var(--text-3)] text-center max-w-md">
              {paysToday
                ? t('finePrintPaysToday', { plan: plan.name, price, period: selection.period })
                : endLong
                  ? t('finePrintTrial', { plan: plan.name, period: selection.period, date: endLong })
                  : t('finePrintTrialNoDate', { plan: plan.name, period: selection.period })}
            </p>
            <p className="text-xs text-[var(--text-2)] text-center">
              {paysToday ? t('notReady') : t('notReadyCard')}{' '}
              <button
                type="button"
                onClick={handleSkip}
                className="font-medium text-[var(--brand)] underline-offset-2 hover:underline"
              >
                {paysToday ? t('keepFree') : t('tryFree')}
              </button>
            </p>
          </div>
        </Card>
      </main>
    </div>
  );
}
