'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { license } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { usePricingUrl } from '@/lib/use-pricing-url';
import { useManagePlan } from '@/lib/use-manage-plan';
import { useCardCheckout } from '@/lib/use-card-checkout';
import { DEFAULT_SELECTION, planById, readPlanIntent, type PlanSelection } from '@/lib/card-trial';
import { PlanPicker } from '@/components/plan-picker';
import { LogoIcon } from '@/components/logo-icon';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// 'lapsed' is a paid subscription that stopped being active without being
// cancelled — the website marks a licence expired on any non-active status,
// which in practice means a renewal the card did not cover.
// 'payment-failed' is the same with Stripe still retrying the subscription
// (a card trial whose first charge was declined, or a first SEPA debit the
// bank returned, is revoked straight away): a new payment method resumes it,
// a new purchase would bill a second subscription.
type BlockReason = 'no-license' | 'trial-ended' | 'expired' | 'lapsed' | 'payment-failed';

export function LicenseWall() {
  const { token, user, deploymentMode } = useAuth();
  const managePlan = useManagePlan();
  const [reason, setReason] = useState<BlockReason | null>(null);
  // The pricing links name the wall when it is the ended trial's.
  const pricingUrl = usePricingUrl(undefined, reason === 'trial-ended' ? 'trial_ended_wall' : 'app_pricing');
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);
  const pathname = usePathname();
  const isCloud = deploymentMode === 'cloud';
  const checkout = useCardCheckout();
  const [selection, setSelection] = useState<PlanSelection>(DEFAULT_SELECTION);
  // Cloud admins whose trial ended pick a plan and pay right here (Stripe
  // Checkout, no trial left). Other roles cannot subscribe the workspace and
  // keep the pricing link.
  const buyInPlace = isCloud && reason === 'trial-ended' && user?.role === 'ADMIN';
  const isAdmin = user?.role === 'ADMIN';
  const [updatingCard, setUpdatingCard] = useState(false);
  const [cardErr, setCardErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);

  useEffect(() => {
    if (buyInPlace) setSelection(readPlanIntent() ?? DEFAULT_SELECTION);
  }, [buyInPlace]);

  // Start the trial in place (no navigation) so a failed auto-activation on
  // signup doesn't strand the user on this wall. On success the block clears.
  const startTrial = async () => {
    if (!token) return;
    setStarting(true);
    setStartErr(null);
    try {
      await license.activateTrial(token);
      setReason(null);
    } catch (e: any) {
      setStartErr(e?.message || 'Could not start the trial. Please try again or contact support.');
    } finally {
      setStarting(false);
    }
  };

  // Stripe's page for adding a payment method (card or bank account): it
  // becomes the subscription's and the open invoice is paid on the spot. It returns here, where the licence is
  // checked again.
  const updateCard = async () => {
    if (!token) return;
    setUpdatingCard(true);
    setCardErr(null);
    try {
      const { url } = await license.billingPortal(token, window.location.href, 'payment_method_update');
      window.location.href = url;
    } catch (e: any) {
      setCardErr(e?.message || 'Could not open the payment page. Please try again or contact support.');
      setUpdatingCard(false);
    }
  };

  const reasonFor = (status: Awaited<ReturnType<typeof license.getStatus>>): BlockReason | null => {
    // A failed payment the subscription can still be saved from. Before the
    // trial rule: a card trial is charged the moment the free trial ends.
    if (status.paymentFailed) return 'payment-failed';
    // No license at all means the org is not allowed to use the product.
    if (!status.plan) return 'no-license';
    // Block when trial is expired
    if (status.plan === 'trial' && status.trialDaysLeft !== undefined && status.trialDaysLeft <= 0) {
      return 'trial-ended';
    }
    // A paid licence that lapsed is fixed in the billing portal. Sending it
    // to the pricing page, as this used to, starts a second subscription
    // while Stripe keeps retrying the first — double billing the day the
    // old card goes through.
    if (status.status === 'expired' && status.plan !== 'trial') return 'lapsed';
    // Block when any license is expired/revoked
    if (status.status === 'expired' || status.status === 'revoked') return 'expired';
    // Active/valid license — make sure no stale block lingers.
    return null;
  };

  // "I've updated my payment method": verify the licence now (the payment reaches the
  // licence a few seconds after Stripe takes it) and lift the wall if it is back.
  const checkAgain = async () => {
    if (!token) return;
    setChecking(true);
    setCheckNote(null);
    try {
      await license.refresh(token).catch(() => undefined);
      const next = reasonFor(await license.getStatus(token));
      setReason(next);
      if (next === 'payment-failed') {
        setCheckNote('The payment has not come through yet. If you just updated your payment method, try again in a minute.');
      }
    } catch {
      setCheckNote('Could not check right now. Please try again in a minute.');
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    // Logged out (or logging out) — clear any stale block so the wall
    // doesn't keep covering the login page. Without this reset the modal
    // stays mounted after Logout because we'd only ever *set* `reason`,
    // never unset it.
    // Self-hosted is never walled: without a valid licence it simply runs
    // Community (see useEdition), including when a key expires or is revoked.
    if (!token || !isCloud) {
      setReason(null);
      return;
    }

    let cancelled = false;
    license
      .getStatus(token)
      .then(async (status) => {
        let next = reasonFor(status);
        // Back from Stripe's payment-method page (or a retry went through since the last
        // daily check): ask for a fresh verification before walling an admin.
        if (next === 'payment-failed' && isAdmin) {
          const { refreshed } = await license.refresh(token).catch(() => ({ refreshed: false }));
          if (refreshed) next = reasonFor(await license.getStatus(token));
        }
        if (!cancelled) setReason(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token, isCloud, isAdmin]);

  // Routes where the wall must never appear: unauthenticated/auth flows
  // (you can't fix a license problem while logged out) and the license
  // settings page itself (so users can enter a key / start a trial).
  const isExemptRoute =
    !pathname ||
    pathname === '/login' ||
    pathname === '/verify-email' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password' ||
    pathname.startsWith('/accept-invite') ||
    pathname === '/settings/license' ||
    pathname.startsWith('/settings/license/');

  // Don't block when logged out, when there's no active block, or on an
  // exempt route.
  if (!token || !reason || isExemptRoute) return null;

  const title =
    reason === 'payment-failed'
      ? 'Your payment didn’t go through'
      : reason === 'no-license'
      ? 'License Required'
      : reason === 'trial-ended'
        ? 'Your Trial Has Expired'
        : reason === 'lapsed'
          ? 'Your Subscription Is Not Active'
          : 'Your License Has Expired';

  const body =
    reason === 'payment-failed'
      ? isAdmin
        ? 'Your last payment didn’t go through, so your subscription is on hold. Update your payment method and it resumes right away: the open payment is taken as soon as the new one is saved. Your connectors and configurations are preserved.'
        : 'The last payment for this workspace’s subscription didn’t go through, so the subscription is on hold. Ask a workspace admin to update the payment method. Your connectors and configurations are preserved.'
      : reason === 'no-license'
      ? 'This workspace doesn’t have an active license. Start a trial or purchase a plan to continue.'
      : reason === 'trial-ended'
        ? 'Your 7-day trial period has ended. Purchase a license to continue using AnythingMCP Cloud. Your connectors and configurations are preserved.'
        : reason === 'lapsed'
          ? 'Your subscription is not active — usually a renewal payment that did not go through. Update your payment method in the billing portal and it resumes; buying a new plan would start a second subscription beside this one. Your connectors and configurations are preserved.'
          : 'Your license is no longer active. Purchase or renew a license to continue using AnythingMCP. Your connectors and configurations are preserved.';

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[14px] p-8 max-w-md w-full mx-4 max-h-[calc(100dvh-2rem)] overflow-y-auto text-center shadow-[var(--shadow)]">
        <div className="flex justify-center mb-4">
          <LogoIcon size={48} />
        </div>

        <h1 className="text-2xl font-bold mb-2 text-[var(--text)]">{title}</h1>

        <p className="text-[var(--text-2)] text-sm mb-6">{body}</p>

        <div className="space-y-3">
          {reason === 'no-license' && isCloud ? (
            <>
              {/* Fresh workspace with no trial yet → starting it is the intended
                  path (and the in-place retry for a failed auto-activation). */}
              <button
                onClick={startTrial}
                disabled={starting}
                className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full')}
              >
                {starting ? 'Starting…' : 'Start 7-Day Free Trial'}
              </button>
              {startErr && <p className="text-xs text-[var(--danger)]">{startErr}</p>}
              <a
                href={pricingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'w-full')}
              >
                View Plans &amp; Purchase License
              </a>
            </>
          ) : buyInPlace ? (
            <>
              <div className="text-left">
                <PlanPicker value={selection} onChange={setSelection} compact disabled={checkout.loading} />
              </div>
              <button
                onClick={() => checkout.start(selection, false, 'trial_ended_wall')}
                disabled={checkout.loading}
                className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full')}
              >
                {checkout.loading ? 'Opening checkout…' : `Subscribe to ${planById(selection.plan).name}`}
              </button>
              {checkout.error && <p role="alert" className="text-xs text-[var(--danger)]">{checkout.error}</p>}
              <a
                href={pricingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-xs text-[var(--brand)] hover:underline"
              >
                Compare plans
              </a>
            </>
          ) : reason === 'payment-failed' ? (
            isAdmin ? (
              <>
                <button
                  onClick={updateCard}
                  disabled={updatingCard}
                  className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full')}
                >
                  {updatingCard ? 'Opening…' : 'Update payment method'}
                </button>
                {cardErr && <p role="alert" className="text-xs text-[var(--danger)]">{cardErr}</p>}
                <button
                  onClick={checkAgain}
                  disabled={checking}
                  className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'w-full')}
                >
                  {checking ? 'Checking…' : 'I’ve updated my payment method'}
                </button>
                {checkNote && <p className="text-xs text-[var(--text-2)]">{checkNote}</p>}
              </>
            ) : null
          ) : reason === 'lapsed' ? (
            <a
              href={managePlan.href}
              onClick={managePlan.onClick}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full')}
            >
              Update Billing
            </a>
          ) : (
            <a
              href={pricingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full')}
            >
              View Plans &amp; Purchase License
            </a>
          )}

          {reason !== 'payment-failed' && (
            <p className="text-xs text-[var(--text-3)]">
              Already purchased?{' '}
              <Link
                href="/settings/license"
                className="text-[var(--brand)] hover:underline"
              >
                Enter your license key
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
