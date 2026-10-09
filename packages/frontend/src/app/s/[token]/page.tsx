'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { setupLinks } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { returnAssistant } from '@/lib/return-assistant';

/**
 * A one-time link from an AI client ("open this to finish connecting Etsy").
 * It only opens for the user it was made for, signed in, once; then it leads
 * to the guided setup of that connector.
 */
export default function SetupLinkPage() {
  const { token } = useParams<{ token: string }>();
  const { token: authToken, isLoading } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (isLoading || started.current) return;
    // The assistant the link was made in, for the setup page's way back; only
    // a name from the fixed list is passed on.
    const from = returnAssistant(new URLSearchParams(window.location.search).get('from'))?.id;
    if (!authToken) {
      const self = `/s/${token}${from ? `?from=${from}` : ''}`;
      router.replace(`/login?redirect=${encodeURIComponent(self)}`);
      return;
    }
    started.current = true;
    setupLinks
      .resolve(token, authToken, from)
      .then((out) => router.replace(out.redirect))
      .catch((e: Error) => setError(e.message || 'This link cannot be opened.'));
  }, [isLoading, authToken, token, router]);

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
