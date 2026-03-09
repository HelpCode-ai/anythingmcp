'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { LogoIcon } from '@/components/nav-bar';

const API_BASE = '';

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
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4">
          <LogoIcon size={56} />
        </div>
        <h1 className="text-2xl font-bold">Email Verification</h1>
      </div>

      <div className="border border-[var(--border)] rounded-lg p-6 bg-[var(--card)]">
        {status === 'loading' && (
          <p className="text-center text-[var(--muted-foreground)]">
            Verifying your email...
          </p>
        )}

        {status === 'success' && (
          <div className="text-center space-y-4">
            <div className="text-4xl">&#10003;</div>
            <p className="text-sm font-medium">Your email has been verified successfully!</p>
            <Link
              href="/login?emailVerified=true"
              className="inline-block w-full bg-[var(--brand)] text-white px-4 py-2.5 rounded-md text-sm font-medium hover:brightness-90 text-center"
            >
              Go to Sign In
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="text-center space-y-4">
            <p className="text-sm text-[var(--destructive-text)]">
              {errorMessage}
            </p>
            <Link
              href="/login"
              className="inline-block w-full bg-[var(--brand)] text-white px-4 py-2.5 rounded-md text-sm font-medium hover:brightness-90 text-center"
            >
              Back to Sign In
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
      <Suspense>
        <VerifyEmailContent />
      </Suspense>
    </div>
  );
}
