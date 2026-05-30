'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { connectors, license, users } from '@/lib/api';

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
 *  2. License must be active (cloud has a plan, or self-host community
 *     personal-use already chosen). LicenseWall reads the same source.
 *  3. Wizard not yet completed/skipped (onboardingCompletedAt === null).
 *  4. User has zero connectors — once they own at least one, the wizard
 *     is moot and we auto-stamp completion (so they don't re-see it).
 *
 * If all 4 hold and we're on the dashboard, redirect to /welcome.
 * If 1-3 hold but they already have a connector, fire-and-forget the
 * PATCH so we don't pester them again.
 */
export function OnboardingRedirect() {
  const { token, user, isLoading, deploymentMode } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  // Avoid duplicate evaluations on rapid route changes / re-renders.
  const lastRun = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading || !token || !user) return;
    if (isExcluded(pathname)) return;

    // Dedupe per (path, userId) to avoid hammering the API on every render.
    const key = `${user.id}:${pathname}`;
    if (lastRun.current === key) return;
    lastRun.current = key;

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
        if (me?.emailVerified === false) return;

        // License gate — mirror LicenseWall's logic exactly so the two
        // never disagree. Self-host with no plan = community tier OK.
        const isCloud = deploymentMode === 'cloud';
        const noPlan = !lic.plan;
        const trialEnded =
          lic.plan === 'trial' &&
          typeof lic.trialDaysLeft === 'number' &&
          lic.trialDaysLeft <= 0;
        const expired = lic.status === 'expired' || lic.status === 'revoked';
        const licenseBlocking = (isCloud && noPlan) || trialEnded || expired;
        if (licenseBlocking) return;

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
  }, [isLoading, token, user, pathname, deploymentMode, router]);

  return null;
}
