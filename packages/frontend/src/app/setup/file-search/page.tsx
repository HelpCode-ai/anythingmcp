'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { fileSearchSetup } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The hand-off from the File Search plugin's authorization page (the folder
 * setup offered after "Approve") to the File Search wizard.
 *
 * The browser has just signed in there, usually without a dashboard session.
 * The backend checks that sign-in, the paused authorization and the page's
 * token, then returns a dashboard session on the workspace the AI client was
 * granted and the wizard path for the chosen protocol. Nothing in the URL
 * decides where the browser goes next: `option` is looked up in a fixed list.
 */
export default function FileSearchSetupHandoffPage() {
  return (
    <Suspense fallback={null}>
      <Handoff />
    </Suspense>
  );
}

function Handoff() {
  const t = useTranslations('fileSearch.authorize');
  const params = useSearchParams();
  const router = useRouter();
  const { isLoading, login } = useAuth();
  const [failure, setError] = useState<string | null>(null);
  const started = useRef(false);
  const option = params.get('option') ?? '';
  const csrf = params.get('t') ?? '';
  const error = !option || !csrf ? t('openFailed') : failure;

  useEffect(() => {
    if (isLoading || started.current || !option || !csrf) return;
    started.current = true;
    fileSearchSetup
      .openFromAuthorize(csrf, option)
      .then((out) => {
        login(out.session.accessToken, out.session.user);
        router.replace(out.redirect);
      })
      .catch((e: Error) => setError(e.message || t('openFailed')));
  }, [isLoading, option, csrf, login, router, t]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] p-6">
      <Card className="w-full max-w-md space-y-4 p-6">
        {error ? (
          <>
            <h1 className="text-lg font-semibold text-[var(--text)]">{t('openFailedTitle')}</h1>
            <p role="alert" className="text-sm text-[var(--text-2)]">{error}</p>
            <p className="text-sm text-[var(--text-2)]">{t('openFailedHint')}</p>
            <Link href="/connectors/new/file-search" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}>
              {t('openWizard')}
            </Link>
          </>
        ) : (
          <p className="text-sm text-[var(--text-2)]">{t('opening')}</p>
        )}
      </Card>
    </div>
  );
}
