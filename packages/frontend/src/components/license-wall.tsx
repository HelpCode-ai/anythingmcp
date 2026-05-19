'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { license } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { buildPricingUrl } from '@/lib/marketing';
import { LogoIcon } from '@/components/nav-bar';

type BlockReason = 'no-license' | 'trial-ended' | 'expired';

export function LicenseWall() {
  const { token, deploymentMode } = useAuth();
  const [reason, setReason] = useState<BlockReason | null>(null);
  const pathname = usePathname();
  const isCloud = deploymentMode === 'cloud';

  useEffect(() => {
    if (!token) return;

    license.getStatus(token).then((status) => {
      // Cloud: no license at all means the org is not allowed to use the
      // product. Self-hosted: a missing license means "running on the
      // community tier", which is permitted.
      if (!status.plan) {
        if (isCloud) setReason('no-license');
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
      }
    }).catch(() => {});
  }, [token, isCloud]);

  // Don't block the license settings page so users can enter a license key
  if (!reason || pathname === '/settings/license' || pathname?.startsWith('/settings/license/')) return null;

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
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-8 max-w-md w-full mx-4 text-center shadow-2xl">
        <div className="flex justify-center mb-4">
          <LogoIcon size={48} />
        </div>

        <h1 className="text-2xl font-bold mb-2">{title}</h1>

        <p className="text-[var(--muted-foreground)] text-sm mb-6">{body}</p>

        <div className="space-y-3">
          <a
            href={buildPricingUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full bg-[var(--brand)] text-white px-4 py-2.5 rounded-md text-sm font-medium hover:brightness-90 text-center"
          >
            View Plans &amp; Purchase License
          </a>

          {reason === 'no-license' && isCloud && (
            <Link
              href="/settings/license"
              className="block w-full border border-[var(--border)] px-4 py-2.5 rounded-md text-sm font-medium hover:bg-[var(--accent)] text-center"
            >
              Start 7-Day Free Trial
            </Link>
          )}

          <p className="text-xs text-[var(--muted-foreground)]">
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
