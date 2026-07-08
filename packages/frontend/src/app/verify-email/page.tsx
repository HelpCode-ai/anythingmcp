'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { LogoIcon } from '@/components/logo-icon';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const API_BASE = '';

/** Small AnythingMCP brand mark for the top of pre-auth cards. */
function BrandMark() {
  return (
    <div className="flex items-center justify-center gap-2">
      <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] bg-[var(--brand-tint)] text-[var(--brand)]">
        <LogoIcon size={20} />
      </span>
      <span className="text-base font-semibold text-[var(--text)]">
        Anything<span className="text-[var(--brand)]">MCP</span>
      </span>
    </div>
  );
}

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setErrorMessage('No verification token provided');
      return;
    }

    // The verify-email-link endpoint redirects on success,
    // but if accessed directly via API we handle the response
    fetch(`${API_BASE}/api/auth/verify-email-link?token=${token}`, {
      redirect: 'manual',
    })
      .then((res) => {
        if (res.type === 'opaqueredirect' || res.status === 302 || res.status === 301) {
          // Redirect means success
          setStatus('success');
        } else if (res.ok) {
          setStatus('success');
        } else {
          return res.json().then((data) => {
            setStatus('error');
            setErrorMessage(data.message || 'Verification failed');
          });
        }
      })
      .catch(() => {
        // A redirect will cause a fetch error in manual mode — that's success
        setStatus('success');
      });
  }, [token]);

  return (
    <div className="w-full max-w-sm">
      <Card className="p-6">
        <div className="text-center mb-6">
          <div className="flex justify-center mb-4">
            <BrandMark />
          </div>
          <h1 className="text-xl font-semibold text-[var(--text)]">Email Verification</h1>
        </div>

        {status === 'loading' && (
          <p className="text-center text-[var(--text-2)]">
            Verifying your email...
          </p>
        )}

        {status === 'success' && (
          <div className="text-center space-y-4">
            <div className="inline-flex items-center justify-center w-12 h-12 mx-auto rounded-full bg-[var(--t-success-bg)] text-[var(--t-success-fg)] text-2xl">
              &#10003;
            </div>
            <p className="text-sm font-medium text-[var(--text)]">Your email has been verified successfully!</p>
            <Link
              href="/login?emailVerified=true"
              className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full')}
            >
              Go to Sign In
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="text-center space-y-4">
            <div className="rounded-[9px] px-3 py-2.5 text-sm bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]">
              {errorMessage}
            </div>
            <Link
              href="/login"
              className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full')}
            >
              Back to Sign In
            </Link>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] px-4">
      <Suspense>
        <VerifyEmailContent />
      </Suspense>
    </div>
  );
}
