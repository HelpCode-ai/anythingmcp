'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { license } from '@/lib/api';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

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
    <div className="mx-auto w-full max-w-md">
      <div className="mb-6">
        <h1 className="text-base font-semibold text-[var(--text)]">License Activation</h1>
      </div>

      <Card className="p-6 text-sm">
        {phase === 'loading' || phase === 'activating' ? (
          <p className="text-center text-[var(--text-3)]">
            {phase === 'loading' ? 'Preparing…' : 'Activating your license…'}
          </p>
        ) : null}

        {phase === 'success' && (
          <div className="text-center">
            <p className="text-[var(--ok)] font-medium mb-2">{message}</p>
            <p className="text-[var(--text-3)] text-xs">Redirecting to settings…</p>
          </div>
        )}

        {(phase === 'error' || phase === 'invalid') && (
          <div className="space-y-3">
            <p className="text-[var(--danger)]">{message}</p>
            {key && phase === 'error' && (
              <p className="text-xs text-[var(--text-3)] break-all">
                Key: <span className="font-mono">{key}</span>
              </p>
            )}
            <Link
              href="/settings/license"
              className={cn(buttonVariants({ variant: 'primary' }))}
            >
              Go to License Settings
            </Link>
          </div>
        )}
      </Card>
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
