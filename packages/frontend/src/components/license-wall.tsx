'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { license } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { LogoIcon } from '@/components/nav-bar';

export function LicenseWall() {
  const { token } = useAuth();
  const [blocked, setBlocked] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    if (!token) return;

    license.getStatus(token || undefined).then((status) => {
      if (!status.plan) return;
      // Block when trial is expired
      if (status.plan === 'trial' && status.trialDaysLeft !== undefined && status.trialDaysLeft <= 0) {
        setBlocked(true);
      }
      // Block when any license is expired/revoked
      if (status.status === 'expired' || status.status === 'revoked') {
        setBlocked(true);
      }
    }).catch(() => {});
  }, [token]);

  // Don't block the license settings page so users can enter a license key
  if (!blocked || pathname === '/settings/license') return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-8 max-w-md w-full mx-4 text-center shadow-2xl">
        <div className="flex justify-center mb-4">
          <LogoIcon size={48} />
        </div>

        <h1 className="text-2xl font-bold mb-2">Your Trial Has Expired</h1>

        <p className="text-[var(--muted-foreground)] text-sm mb-6">
          Your 7-day trial period has ended. Purchase a license to continue using
          AnythingMCP Cloud. Your connectors and configurations are preserved.
        </p>

        <div className="space-y-3">
          <a
            href="https://anythingmcp.com/pricing"
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full bg-[var(--brand)] text-white px-4 py-2.5 rounded-md text-sm font-medium hover:brightness-90 text-center"
          >
            View Plans &amp; Purchase License
          </a>

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
