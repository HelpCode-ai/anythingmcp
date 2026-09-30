'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { connectors, license, users } from '@/lib/api';
import { cardTrialEligible, readCardTrialPrompt, writeCardTrialPrompt } from '@/lib/card-trial';

// Routes where we MUST NOT redirect, even if the wizard hasn't been
// completed yet. Login + token-bound flows handle their own redirects,
// the license/setup pages must stay reachable so admins can fix gating
// problems without being bounced back to /welcome, and /welcome itself
// is the destination so we shouldn't loop.
const EXCLUDED_ROUTES = [
  '/login',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/accept-invite',
  '/settings/license',
  '/welcome',
  '/start-trial',
];

function isExcluded(pathname: string | null): boolean {
  if (!pathname) return true;
  return EXCLUDED_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + '/'),
  );
}

/**
 * Decides whether to show the new welcome wizard for the current user.
 * Lives at provider scope so it runs on every route change.
 *
 * Gate precedence (matches LicenseWall + login multi-step flows):
 *  1. Email must be verified — unverified users see verify prompts.
 *  2. Cloud: the license must be active. LicenseWall reads the same
 *     source. Self-hosted is never blocked here.
 *  3. Wizard not yet completed/skipped (onboardingCompletedAt === null).
 *  4. User has zero connectors — once they own at least one, the wizard
 *     is moot and we auto-stamp completion (so they don't re-see it).
 *
 * If all 4 hold and we're on the dashboard, redirect to /welcome.
 * If 1-3 hold but they already have a connector, fire-and-forget the
 * PATCH so we don't pester them again.
 *
 * Cloud only, ahead of the wizard: an admin on a running free trial who has
 * not yet been offered the card trial is sent to /start-trial, once per user
 * (remembered in localStorage). Self-hosted never gets there.
 */
export function OnboardingRedirect() {
  const { token, user, isLoading, deploymentMode, deploymentModeLoaded } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  // Avoid duplicate evaluations on rapid route changes / re-renders.
  const lastRun = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading || !token || !user) return;
    // Both gates below depend on the deployment mode, which is only a guess
    // ('self-hosted') until /health/server-info answers. Evaluating on the
    // guess recorded the path as done and never looked again with the real
    // mode, so a cloud admin could miss the card-trial offer.
    if (!deploymentModeLoaded) return;
    if (isExcluded(pathname)) return;

    // Dedupe per (path, userId) to avoid hammering the API on every render.
    // The key is recorded only once an evaluation has run to the end. It
    // used to be recorded up front, and `deploymentMode` or a refreshed
    // `user` arriving a moment later re-ran this effect: the cleanup
    // cancelled the evaluation in flight, the re-run saw the key and
    // stopped, and nobody was ever sent to /welcome.
    const key = `${user.id}:${pathname}`;
    if (lastRun.current === key) return;

    let cancelled = false;
    const run = async () => {
      try {
        // Four lightweight calls; can race in parallel. We fetch the full
        // /me ourselves because the auth-context User type doesn't expose
        // emailVerified (an unverified user shouldn't reach this code path
        // — the signup flow keeps them on /verify-email — but we guard
        // anyway so a malformed session doesn't slip past the gate).
        const [onboarding, lic, connList, me] = await Promise.all([
          users.onboardingState(token),
          license.getStatus(token),
          connectors.list(token),
          users.me(token),
        ]);
        if (cancelled) return;
        lastRun.current = key;
        if (me?.emailVerified === false) return;

        // License gate — mirror LicenseWall's logic exactly so the two
        // never disagree. It walls Cloud only; self-hosted runs Community.
        const isCloud = deploymentMode === 'cloud';
        const noPlan = !lic.plan;
        const trialEnded =
          lic.plan === 'trial' &&
          typeof lic.trialDaysLeft === 'number' &&
          lic.trialDaysLeft <= 0;
        const expired = lic.status === 'expired' || lic.status === 'revoked';
        const licenseBlocking = isCloud && (noPlan || trialEnded || expired);
        if (licenseBlocking) return;

        // The card-trial offer, once, before the wizard. Marked as shown
        // before navigating so a failure on that page can never loop back.
        if (
          isCloud &&
          pathname === '/' &&
          cardTrialEligible({ isCloud, role: me?.role ?? user.role, license: lic }) &&
          readCardTrialPrompt(user.id) === null
        ) {
          writeCardTrialPrompt(user.id, 'shown');
          // Coming back to the dashboard must be evaluated afresh (for the
          // wizard), not skipped as already seen.
          lastRun.current = null;
          router.replace('/start-trial');
          return;
        }

        const hasConnector = (connList?.length ?? 0) > 0;
        const wizardDone = onboarding.onboardingCompletedAt !== null;

        // User finished onboarding implicitly by creating a connector
        // elsewhere — stamp it so the wizard never opens again.
        if (!wizardDone && hasConnector) {
          users
            .updateOnboardingState({ completed: true }, token)
            .catch(() => {});
          return;
        }

        if (!wizardDone && !hasConnector && pathname === '/') {
          router.replace('/welcome');
        }
      } catch {
        // Network blip — don't surface to the user; we'll re-evaluate
        // on the next navigation.
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [isLoading, token, user, pathname, deploymentMode, deploymentModeLoaded, router]);

  return null;
}
