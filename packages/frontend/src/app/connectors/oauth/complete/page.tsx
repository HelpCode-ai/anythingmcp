'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { connectors } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Where "Authorize with Provider" lands. The provider sends the browser to the
 * backend callback, which only checks the state and forwards the code here;
 * this page exchanges it in an authenticated request, so the server can check
 * that the person completing the authorization is the one who started it.
 */
function CompleteContent() {
  const params = useSearchParams();
  const router = useRouter();
  const { token, isLoading } = useAuth();
  const [error, setError] = useState<string | null>(params.get('error'));
  const started = useRef(false);

  const state = params.get('state');
  const code = params.get('code');
  const connectorId = params.get('connectorId');

  useEffect(() => {
    if (error || !state || !code || started.current || isLoading) return;
    if (!token) {
      // Sign in first, then come back here with the same code.
      const here = `${window.location.pathname}${window.location.search}`;
      router.replace(`/login?redirect=${encodeURIComponent(here)}`);
      return;
    }
    started.current = true;
    // The code is single-use and bound to a verifier the server keeps, but it
    // still has no business staying in the address bar or the history.
    window.history.replaceState({}, '', '/connectors/oauth/complete');
    connectors
      .oauthComplete(state, code, token)
      .then((out) => {
        const fallback = `/connectors/${out.connectorId}?oauth=success&tools=${out.toolsImported}`;
        router.replace(out.returnTo || fallback);
      })
      .catch((err: Error) => setError(err.message || 'The authorization could not be completed.'));
  }, [error, state, code, token, isLoading, router]);

  if (!error && !state) {
    return <p className="text-sm text-[var(--text-2)]">Nothing to complete here.</p>;
  }

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-[var(--text)]">Authorization not completed</h1>
        <p role="alert" className="text-sm text-[var(--text-2)]">{error}</p>
        <Link
          href={connectorId ? `/connectors/${connectorId}` : '/connectors'}
          className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
        >
          {connectorId ? 'Back to the connector' : 'Back to connectors'}
        </Link>
      </div>
    );
  }

  return <p className="text-sm text-[var(--text-2)]">Completing the authorization…</p>;
}

export default function OAuthCompletePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] p-6">
      <Card className="w-full max-w-md p-6">
        <Suspense fallback={<p className="text-sm text-[var(--text-2)]">Loading…</p>}>
          <CompleteContent />
        </Suspense>
      </Card>
    </div>
  );
}
