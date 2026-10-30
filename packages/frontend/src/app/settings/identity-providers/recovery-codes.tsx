'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { recoveryCodes as api, type RecoveryCodeStatus } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toast';
import { copyText } from '@/lib/clipboard';

/**
 * Break-glass credentials for the signed-in admin.
 *
 * Lives beside the SSO settings rather than under Profile because it exists
 * for one reason: `enforceSso` cannot be switched on without it, and an admin
 * reading about enforcement should find the prerequisite in the same place.
 */
export function RecoveryCodesCard({
  token,
  onChanged,
}: {
  token: string;
  onChanged?: () => void;
}) {
  const t = useTranslations('settingsSso.recovery');
  const toast = useToast();
  const [status, setStatus] = useState<RecoveryCodeStatus | null>(null);
  const [issued, setIssued] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      setStatus(await api.status(token));
    } catch {
      // Non-fatal: the card degrades to "generate" rather than blocking the
      // whole SSO page on a count.
      setStatus(null);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleGenerate = async () => {
    setBusy(true);
    try {
      const { codes } = await api.generate(token);
      setIssued(codes);
      setCopied(false);
      await load();
      onChanged?.();
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('generateFailed'), description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!issued) return;
    if (!(await copyText(issued.join('\n')))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!issued) return;
    // The file keeps its English text, like the other downloads.
    const body = [
      'AnythingMCP recovery codes',
      `Generated ${new Date().toISOString()}`,
      '',
      'Each code works once. Keep them somewhere you can reach WITHOUT',
      'single sign-on — that is the situation they exist for.',
      '',
      ...issued,
      '',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'anythingmcp-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const none = !status || status.unused === 0;

  return (
    <div className="mt-5 pt-4 border-t border-[var(--border)]">
      <h4 className="text-[13px] font-semibold text-[var(--text)]">{t('title')}</h4>
      <p className="text-[11.5px] text-[var(--text-3)] mt-1 max-w-2xl">
        {t('intro')}
      </p>

      {issued ? (
        <div className="mt-3 p-3 rounded-[9px] bg-[var(--surface-2)] space-y-3">
          {/*
            Shown once and never again: the server stores bcrypt hashes, so
            there is nothing to display on a later visit. Saying so here is the
            difference between an admin saving them and an admin closing the
            page.
          */}
          <p className="text-[12px] text-[var(--text)] font-medium">
            {t('saveNow')}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-1.5">
            {issued.map((c) => (
              <code
                key={c}
                className="text-[12px] tracking-wide text-[var(--text)] bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-center"
              >
                {c}
              </code>
            ))}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={handleCopy}>
              {copied ? t('copied') : t('copy')}
            </Button>
            <Button size="sm" variant="secondary" onClick={handleDownload}>
              {t('download')}
            </Button>
            <Button size="sm" onClick={() => setIssued(null)}>
              {t('savedThem')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <Button size="sm" variant={none ? undefined : 'secondary'} onClick={handleGenerate} disabled={busy}>
            {busy ? t('generating') : none ? t('generate') : t('regenerate')}
          </Button>
          <span className="text-[12px] text-[var(--text-3)]">
            {status === null
              ? ''
              : status.total === 0
                ? t('noneYet')
                : t('unused', { unused: status.unused, total: status.total })}
            {status && status.total > 0 && ` ${t('regenerateWarning')}`}
          </span>
        </div>
      )}
    </div>
  );
}
