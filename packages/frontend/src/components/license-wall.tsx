'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { license } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { buildPricingUrl } from '@/lib/marketing';
import { LogoIcon } from '@/components/logo-icon';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type BlockReason = 'no-license' | 'trial-ended' | 'expired';

export function LicenseWall() {
  const { token, deploymentMode } = useAuth();
  const [reason, setReason] = useState<BlockReason | null>(null);
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);
  const pathname = usePathname();
  const isCloud = deploymentMode === 'cloud';

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

  useEffect(() => {
    // Logged out (or logging out) — clear any stale block so the wall
    // doesn't keep covering the login page. Without this reset the modal
    // stays mounted after Logout because we'd only ever *set* `reason`,
    // never unset it.
    if (!token) {
      setReason(null);
      return;
    }

    license.getStatus(token).then((status) => {
      // Cloud: no license at all means the org is not allowed to use the
      // product. Self-hosted: a missing license means "running on the
      // community tier", which is permitted.
      if (!status.plan) {
        if (isCloud) setReason('no-license');
        else setReason(null);
        return;
      }
      // Block when trial is expired
      if (status.plan === 'trial' && status.trialDaysLeft !== undefined && status.trialDaysLeft <= 0) {
        setReason('trial-ended');
        return;
      }
      // Block when any license is expired/revoked
      if (status.status === 'expired' || status.status === 'revoked') {
        setReason('expired');
        return;
      }
      // Active/valid license — make sure no stale block lingers.
      setReason(null);
    }).catch(() => {});
  }, [token, isCloud]);

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
    reason === 'no-license'
      ? 'License Required'
      : reason === 'trial-ended'
        ? 'Your Trial Has Expired'
        : 'Your License Has Expired';

  const body =
    reason === 'no-license'
      ? 'This workspace doesn’t have an active license. Start a trial or purchase a plan to continue.'
      : reason === 'trial-ended'
        ? 'Your 7-day trial period has ended. Purchase a license to continue using AnythingMCP Cloud. Your connectors and configurations are preserved.'
        : 'Your license is no longer active. Purchase or renew a license to continue using AnythingMCP. Your connectors and configurations are preserved.';

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[14px] p-8 max-w-md w-full mx-4 text-center shadow-[var(--shadow)]">
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
                href={buildPricingUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'w-full')}
              >
                View Plans &amp; Purchase License
              </a>
            </>
          ) : (
            <a
              href={buildPricingUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full')}
            >
              View Plans &amp; Purchase License
            </a>
          )}

          <p className="text-xs text-[var(--text-3)]">
            Already purchased?{' '}
            <Link
              href="/settings/license"
              className="text-[var(--brand)] hover:underline"
            >
              Enter your license key
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
