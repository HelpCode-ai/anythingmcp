'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { ApiError, fileUploads } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { formatBytes, formatDate } from '@/components/file-search/shared';

type Status = Awaited<ReturnType<typeof fileUploads.status>>;

/**
 * One-time upload link from an AI client (file_upload_link). Used when the AI's
 * code sandbox cannot reach AnythingMCP (Claude Free, Pro and Max, ChatGPT) and
 * the app does not show the upload box in the chat: the user saves the file the
 * AI created and picks it here. No sign-in: the token in the URL is the
 * credential, and it works once, for 15 minutes.
 */
export default function UploadLinkPage() {
  const t = useTranslations('fileUpload.page');
  const locale = useLocale();
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadedBytes, setUploadedBytes] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fileUploads
      .status(token)
      .then(setInfo)
      .catch((e) => setLoadError(e instanceof ApiError && e.status !== 404 ? e.message : t('notFound')));
  }, [token, t]);

  const upload = async (file: File | undefined) => {
    if (!file || !info) return;
    setError(null);
    if (file.size > info.max_bytes) {
      setError(t('tooBig', { size: formatBytes(file.size), limit: formatBytes(info.max_bytes) }));
      return;
    }
    setProgress(0);
    try {
      const r = await fileUploads.upload(token, file, setProgress);
      setUploadedBytes(r.bytes);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 409 || status === 410) setInfo({ ...info, state: 'expired' });
      else setError(status === 0 ? t('network') : t('failed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setProgress(null);
    }
  };

  const state = uploadedBytes != null ? 'done' : info?.state;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 py-8">
      <Card className="w-full max-w-md p-6">
        {!info && !loadError && <p className="text-sm text-[var(--text-2)]">{t('loading')}</p>}
        {loadError && !info && (
          <>
            <h1 className="text-lg font-semibold text-[var(--text)]">{t('unavailable')}</h1>
            <p role="alert" className="mt-2 text-sm text-[var(--text-2)]">{loadError}</p>
          </>
        )}
        {info && (
          <div className="space-y-4">
            <div>
              <h1 className="text-[16px] font-semibold text-[var(--text)]">{t('title')}</h1>
              <p className="mt-1 text-[13px] text-[var(--text-2)]">{t('intro')}</p>
            </div>
            <div className="flex items-start gap-3">
              <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[var(--brand-tint)] text-[var(--brand)]">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /></svg>
              </span>
              <div className="min-w-0">
                <p className="break-words text-[15px] font-semibold text-[var(--text)]" data-testid="upload-filename">{info.filename}</p>
                <p className="mt-0.5 text-[12.5px] text-[var(--text-2)]">
                  {t('limit', { size: formatBytes(info.max_bytes), time: formatDate(info.link_expires_at, locale) })}
                </p>
              </div>
            </div>

            {state === 'done' && (
              <p role="status" className="rounded-[10px] bg-[var(--t-success-bg,var(--brand-tint))] p-3 text-[13px] text-[var(--text)]">
                ✓ {t('done')} {uploadedBytes ? `(${formatBytes(uploadedBytes)})` : ''}
              </p>
            )}
            {state === 'uploaded' && (
              <p role="status" className="rounded-[10px] bg-[var(--brand-tint)] p-3 text-[13px] text-[var(--text)]">✓ {t('already')}</p>
            )}
            {(state === 'expired' || state === 'uploading') && (
              <p role="alert" className="rounded-[10px] bg-[var(--t-danger-bg)] p-3 text-[13px] text-[var(--text)]">{t('expired')}</p>
            )}

            {state === 'waiting' && progress == null && (
              <div
                className={`rounded-[12px] border-2 border-dashed p-5 text-center ${over ? 'border-[var(--brand)]' : 'border-[var(--border)]'}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(false);
                  void upload(e.dataTransfer.files?.[0]);
                }}
              >
                <button
                  type="button"
                  onClick={() => input.current?.click()}
                  className="inline-flex h-10 items-center justify-center rounded-[9px] bg-[var(--brand)] px-5 text-[13.5px] font-semibold text-[var(--primary-foreground)]"
                >
                  {t('choose')}
                </button>
                <p className="mt-2 text-[12.5px] text-[var(--text-3)]">{t('drop')}</p>
                <input
                  ref={input}
                  type="file"
                  className="hidden"
                  data-testid="upload-input"
                  onChange={(e) => void upload(e.target.files?.[0])}
                />
              </div>
            )}

            {progress != null && (
              <div>
                <p className="text-[13px] text-[var(--text-2)]">{t('uploading', { name: info.filename })}</p>
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-[var(--border)]">
                  <div className="h-full bg-[var(--brand)] transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}

            {error && <p role="alert" className="text-[13px] text-[var(--danger)]">{error}</p>}
            <p className="text-[12px] leading-[1.5] text-[var(--text-3)]">{t('note')}</p>
          </div>
        )}
      </Card>
    </main>
  );
}
