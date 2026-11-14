'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { useLocale, useTranslations } from 'next-intl';
import { license, productEvents } from '@/lib/api';
import { PlanFitNotice } from '@/components/plan-fit-notice';
import { buttonVariants } from '@/components/ui/button';
import { usePlanFit } from '@/lib/use-plan-fit';
import { deviceKind } from '@/lib/paywall-tracking';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth-context';
import { usePricingUrl } from '@/lib/use-pricing-url';
import { useCardCheckout } from '@/lib/use-card-checkout';
import { useCardTrialKind } from '@/lib/use-card-trial-eligibility';
import { useFirstSuccessOfferVisible } from '@/lib/first-success-offer-visibility';
import { startTrialPath } from '@/lib/checkout-source';
import {
  cardTrialDisplayEnd,
  cardTrialEligible,
  fitFor,
  formatTrialEnd,
  readPlanIntent,
} from '@/lib/card-trial';

export function TrialBanner() {
  const { token, user, deploymentMode } = useAuth();
  const router = useRouter();
  const t = useTranslations('trialBanner');
  // Dates in the UI language; English keeps the British "7 Oct".
  const locale = useLocale();
  const pricingUrl = usePricingUrl(undefined, 'trial_banner');
  const checkout = useCardCheckout();
  const [daysLeft, setDaysLeft] = useState<number | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);

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
  }, [token]);

  const isTrialAdmin = deploymentMode === 'cloud' && user?.role === 'ADMIN' && plan === 'trial' && status === 'active';
  const cardTrialKind = useCardTrialKind(token, isTrialAdmin);
  // The first-success offer on this page asks for the same thing: one call
  // to action at a time, so the banner keeps only its countdown then.
  const offerOnScreen = useFirstSuccessOfferVisible();
  // The trial has everything in Team. In its last 3 days, an admin whose
  // workspace is above Starter can see what Starter would change, before the
  // plan is chosen. Plan fit is only asked for then.
  const lastDays = isTrialAdmin && daysLeft !== null && daysLeft <= 3;
  const starterFit = fitFor(usePlanFit(lastDays, 'starter'), 'starter');
  const aboveStarter = lastDays && !!starterFit && !starterFit.fits;

  // An ended trial is reported too (status 'expired'); the licence wall
  // covers that case, so the countdown banner stays out of the way.
  if (plan !== 'trial' || daysLeft === null || status !== 'active') return null;

  const isUrgent = daysLeft <= 1;
  const isWarning = daysLeft <= 3;

  const tone = isUrgent ? 'danger' : isWarning ? 'warn' : 'info';

  const countdown =
    daysLeft === 0 ? t('today') : daysLeft === 1 ? t('tomorrow') : t('daysLeft', { days: daysLeft });

  const trackChange = (action: 'plan_fit_shown' | 'plan_fit_details_opened', plan: 'starter' | 'team') => {
    if (token) productEvents.track('paywall_action', token, { source: 'trial_banner', action, plan, device: deviceKind() });
  };

  // Cloud admins on a running trial add a card instead (the card trial ends
  // with the free trial, nothing is charged before). Everyone else, and
  // self-hosted, keeps the pricing link.
  const offerCard = cardTrialEligible({
    isCloud: deploymentMode === 'cloud',
    role: user?.role,
    license: { plan, status: status ?? '', expiresAt, trialDaysLeft: daysLeft },
  });
  const chargeDate = formatTrialEnd(
    cardTrialDisplayEnd(expiresAt),
    'short',
    undefined,
    locale === 'en' ? 'en-GB' : locale,
  );
  // An address that had a subscription before gets no card trial: its plan
  // starts and is billed today, which /start-trial says before checkout.
  const paysToday = cardTrialKind === 'pay';

  const addPaymentMethod = async () => {
    // With a plan picked on the pricing page, straight to Checkout;
    // otherwise (or when it would charge today) to the plan picker first.
    const intent = readPlanIntent();
    if (!intent || paysToday) {
      router.push(startTrialPath('trial_banner'));
      return;
    }
    const outcome = await checkout.start(intent, true, 'trial_banner');
    if (outcome === 'charges_today') router.push(startTrialPath('trial_banner'));
    else if (outcome === 'failed') window.location.assign(pricingUrl);
  };

  return (
    <div
      className="text-sm py-2 px-4 text-center text-balance"
      style={{
        backgroundColor: `var(--t-${tone}-bg)`,
        color: `var(--t-${tone}-fg)`,
      }}
    >
      <span>
        {countdown} {t('includesTeam')}
      </span>{' '}
      {aboveStarter && (
        <>
          <button
            type="button"
            onClick={() => setChangesOpen(true)}
            className="underline font-medium hover:no-underline"
          >
            {t('aboveStarter.link')}
          </button>
          {offerOnScreen ? ' ' : ' · '}
          <Dialog.Root open={changesOpen} onOpenChange={setChangesOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
              <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 text-left shadow-[var(--shadow)]">
                <Dialog.Title className="text-[16px] font-semibold text-[var(--text)]">
                  {t('aboveStarter.title')}
                </Dialog.Title>
                <Dialog.Description className="mt-1 mb-4 text-sm text-[var(--text-2)]">
                  {t('aboveStarter.body')}
                </Dialog.Description>
                {changesOpen && <PlanFitNotice fit={starterFit} onTrack={trackChange} />}
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                  <Dialog.Close className={cn(buttonVariants({ variant: 'secondary', size: 'md' }))}>
                    {t('aboveStarter.close')}
                  </Dialog.Close>
                  <Link
                    href={startTrialPath('trial_banner')}
                    onClick={() => setChangesOpen(false)}
                    className={cn(buttonVariants({ variant: 'primary', size: 'md' }))}
                  >
                    {t('choosePlan')}
                  </Link>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </>
      )}
      {offerOnScreen ? null : offerCard ? (
        <button
          type="button"
          onClick={addPaymentMethod}
          disabled={checkout.loading}
          className="underline font-medium hover:no-underline disabled:opacity-60"
        >
          {checkout.loading
            ? t('openingCheckout')
            : paysToday
              ? t('choosePlan')
              : chargeDate
                ? t('addPaymentBefore', { date: chargeDate })
                : t('addPayment')}
        </button>
      ) : (
        <a
          href={pricingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium hover:no-underline"
        >
          {t('upgrade')}
        </a>
      )}
    </div>
  );
}
