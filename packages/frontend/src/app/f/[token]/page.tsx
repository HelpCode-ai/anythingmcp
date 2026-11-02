'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { ApiError, fileShare } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatBytes, formatDate } from '@/components/file-search/shared';

/**
 * A File Share link (#1387). The interstitial names the file, its size, the
 * workspace that shared it and when the link expires, then hands out a
 * 60-second download URL. Internal links ask for a sign-in first.
 */
export default function FileShareLinkPage() {
  const t = useTranslations('fileShare.link');
  const locale = useLocale();
  const { token } = useParams<{ token: string }>();
  const { token: authToken, isLoading } = useAuth();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof fileShare.describe>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fileShare
      .describe(token)
      .then(setInfo)
      .catch((e) => setError(e instanceof ApiError ? e.message : t('notFound')));
  }, [token, t]);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fileShare.download(token, info?.access === 'internal' ? authToken : null);
      window.location.href = r.url;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const needsSignIn = info?.access === 'internal' && !authToken && !isLoading;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 py-8">
      <Card className="w-full max-w-md p-6">
        {!info && !error && <p className="text-sm text-[var(--text-2)]">{t('loading')}</p>}
        {error && !info && (
          <>
            <h1 className="text-lg font-semibold text-[var(--text)]">{t('unavailable')}</h1>
            <p role="alert" className="mt-2 text-sm text-[var(--text-2)]">{error}</p>
          </>
        )}
        {info && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[var(--brand-tint)] text-[var(--brand)]">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /></svg>
              </span>
              <div className="min-w-0">
                <h1 className="break-words text-[16px] font-semibold text-[var(--text)]">{info.filename}</h1>
                <p className="mt-0.5 text-[13px] text-[var(--text-2)]">{formatBytes(info.bytes)}</p>
              </div>
            </div>
            <dl className="space-y-1.5 text-[13px]">
              <div className="flex justify-between gap-3"><dt className="text-[var(--text-3)]">{t('sharedBy')}</dt><dd className="text-right text-[var(--text)]">{info.workspace}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--text-3)]">{t('access')}</dt><dd className="text-right text-[var(--text)]">{info.access === 'internal' ? t('internal') : t('public')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--text-3)]">{t('expires')}</dt><dd className="text-right text-[var(--text)]">{info.expiresAt ? formatDate(info.expiresAt, locale) : t('never')}</dd></div>
            </dl>
            {info.state !== 'active' ? (
              <p role="alert" className="rounded-[10px] bg-[var(--t-danger-bg)] p-3 text-[13px] text-[var(--text)]">{t(`state.${info.state}`)}</p>
            ) : needsSignIn ? (
              <Link href={`/login?redirect=${encodeURIComponent(`/f/${token}`)}`} className="inline-flex h-10 w-full items-center justify-center rounded-[9px] bg-[var(--brand)] text-[13.5px] font-semibold text-[var(--primary-foreground)]">
                {t('signIn')}
              </Link>
            ) : (
              <Button size="lg" className="w-full" onClick={download} disabled={busy}>{busy ? t('preparing') : t('download')}</Button>
            )}
            {error && <p role="alert" className="text-[13px] text-[var(--danger)]">{error}</p>}
            <p className="text-[12px] leading-[1.5] text-[var(--text-3)]">{t('warning')}</p>
          </div>
        )}
      </Card>
    </main>
  );
}
