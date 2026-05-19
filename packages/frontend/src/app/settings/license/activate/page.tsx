'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { license } from '@/lib/api';
import { LogoIcon } from '@/components/nav-bar';

const KEY_RE = /^AMCP-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/;

type Phase = 'loading' | 'activating' | 'success' | 'error' | 'invalid';

function LicenseActivateInner() {
  const { token, user, isLoading } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawKey = searchParams.get('key') || '';
  const key = rawKey.toUpperCase();
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (isLoading || ran.current) return;

    if (!key) {
      setPhase('invalid');
      setMessage('No license key was provided in the URL.');
      ran.current = true;
      return;
    }

    if (!KEY_RE.test(key)) {
      setPhase('invalid');
      setMessage('The license key in the URL is malformed.');
      ran.current = true;
      return;
    }

    if (!token || !user) {
      const next = `/settings/license/activate?key=${encodeURIComponent(key)}`;
      router.replace(`/login?redirect=${encodeURIComponent(next)}`);
      ran.current = true;
      return;
    }

    if (user.role !== 'ADMIN') {
      setPhase('error');
      setMessage('Only administrators can activate a license key. Ask your admin to sign in.');
      ran.current = true;
      return;
    }

    ran.current = true;
    setPhase('activating');
    license.setKey(key, token)
      .then((res) => {
        setPhase('success');
        setMessage(res.message || 'License activated successfully.');
        setTimeout(() => router.replace('/settings/license'), 1500);
      })
      .catch((err: any) => {
        setPhase('error');
        setMessage(err?.message || 'Failed to activate license.');
      });
  }, [key, token, user, isLoading, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="flex justify-center mb-3">
            <LogoIcon size={48} />
          </div>
          <h1 className="text-xl font-bold">License Activation</h1>
        </div>

        <div className="border border-[var(--border)] rounded-lg p-6 bg-[var(--card)] text-sm">
          {phase === 'loading' || phase === 'activating' ? (
            <p className="text-center text-[var(--muted-foreground)]">
              {phase === 'loading' ? 'Preparing…' : 'Activating your license…'}
            </p>
          ) : null}

          {phase === 'success' && (
            <div className="text-center">
              <p className="text-emerald-600 font-medium mb-2">{message}</p>
              <p className="text-[var(--muted-foreground)] text-xs">Redirecting to settings…</p>
            </div>
          )}

          {(phase === 'error' || phase === 'invalid') && (
            <div className="space-y-3">
              <p className="text-[var(--destructive-text)]">{message}</p>
              {key && phase === 'error' && (
                <p className="text-xs text-[var(--muted-foreground)] break-all">
                  Key: <span className="font-mono">{key}</span>
                </p>
              )}
              <Link
                href="/settings/license"
                className="inline-block bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90"
              >
                Go to License Settings
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LicenseActivatePage() {
  return (
    <Suspense>
      <LicenseActivateInner />
    </Suspense>
  );
}
