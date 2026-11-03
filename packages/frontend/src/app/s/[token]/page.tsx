'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { setupLinks, type SetupLinkSession } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { returnAssistant } from '@/lib/return-assistant';

/**
 * A setup link from an AI client ("open this to finish connecting Etsy").
 * It only opens for the user it was made for, until it expires, and leads to
 * the guided setup of that connector, in the connector's workspace.
 *
 * Without a dashboard session, the sign-in this browser just made to connect
 * the AI client opens one (the backend checks its signed cookie); otherwise,
 * the usual sign-in, then back here.
 */
export default function SetupLinkPage() {
  const { token } = useParams<{ token: string }>();
  const { token: authToken, isLoading, login } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (isLoading || started.current) return;
    started.current = true;
    // The assistant the link was made in, for the setup page's way back; only
    // a name from the fixed list is passed on.
    const from = returnAssistant(new URLSearchParams(window.location.search).get('from'))?.id;
    const self = `/s/${token}${from ? `?from=${from}` : ''}`;
    const go = (out: { redirect: string; session?: SetupLinkSession }) => {
      if (out.session) login(out.session.accessToken, out.session.user);
      router.replace(out.redirect);
    };
    const signIn = () => router.replace(`/login?redirect=${encodeURIComponent(self)}`);
    if (!authToken) {
      setupLinks
        .open(token, from)
        .then((out) => (typeof out?.redirect === 'string' && out.session ? go(out) : signIn()))
        .catch(signIn);
      return;
    }
    setupLinks
      .resolve(token, authToken, from)
      .then(go)
      .catch((e: Error) => setError(e.message || 'This link cannot be opened.'));
  }, [isLoading, authToken, token, router, login]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] p-6">
      <Card className="w-full max-w-md space-y-4 p-6">
        {error ? (
          <>
            <h1 className="text-lg font-semibold text-[var(--text)]">This link does not work any more</h1>
            <p role="alert" className="text-sm text-[var(--text-2)]">{error}</p>
            <Link href="/connectors" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}>
              Open your connectors
            </Link>
          </>
        ) : (
          <p className="text-sm text-[var(--text-2)]">Opening the setup…</p>
        )}
      </Card>
    </div>
  );
}
