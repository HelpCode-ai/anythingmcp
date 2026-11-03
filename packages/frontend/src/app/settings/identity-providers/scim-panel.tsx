'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { identityProviders, type IdentityProvider, type ScimStatus } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/toast';

// True when the identity provider has not called in for over two hours.
function isStale(lastRequestAt: string): boolean {
  return Date.now() - new Date(lastRequestAt).getTime() > 2 * 3600_000;
}

/**
 * Provisioning (SCIM) for one provider.
 *
 * Modelled on the recovery-codes card: the token is shown exactly once, at
 * issue, and the rest of the time the panel shows status only. Entra pulls
 * nothing from us — it pushes — so the only proof it is connected is the
 * timestamp of its last authenticated request.
 */
export function ScimPanel({
  provider,
  token,
  onChanged,
}: {
  provider: IdentityProvider;
  token: string;
  onChanged?: () => void;
}) {
  const t = useTranslations('settingsSso.scim');
  const locale = useLocale();
  const toast = useToast();
  const [status, setStatus] = useState<ScimStatus | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'url' | 'token' | null>(null);
  const [showSteps, setShowSteps] = useState(false);

  const load = async () => {
    try {
      setStatus(await identityProviders.scimStatus(provider.id, token));
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.loadFailed'), description: err.message });
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, token]);

  // Same origin-derived rule as the sign-in link: a self-hosted instance has
  // no reliable configured public URL, and Entra must reach exactly this host.
  const tenantUrl =
    status?.tenantUrl ??
    `${typeof window === 'undefined' ? '' : window.location.origin}/api/scim/v2`;

  const copy = async (text: string, what: 'url' | 'token') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.show({ tone: 'error', title: t('toast.copyFailed'), description: t('toast.copyManually') });
    }
  };

  const run = async (fn: () => Promise<{ bearerToken?: string } | void>, success: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && r.bearerToken) {
        setIssued(r.bearerToken);
        setRevealed(false);
        setShowSteps(true);
      }
      await load();
      onChanged?.();
      toast.show({ tone: 'success', title: success });
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.changeFailed'), description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleEnable = () =>
    run(() => identityProviders.setScim(provider.id, true, token), t('toast.enabled'));

  const handleRotate = () => {
    if (
      !confirm(
        t('confirmRotate'),
      )
    )
      return;
    return run(() => identityProviders.rotateScimToken(provider.id, token), t('toast.rotated'));
  };

  const handleResync = async () => {
    setBusy(true);
    try {
      const r = await identityProviders.resyncRoles(provider.id, token);
      toast.show({
        tone: 'success',
        title: t('resync.title', { count: r.total }),
        description: `${[
          t('resync.changed', { count: r.applied }),
          t('resync.unchanged', { count: r.unchanged }),
          ...(r.failed ? [t('resync.failed', { count: r.failed })] : []),
          ...(r.lastAdminProtected ? [t('resync.lastAdmin', { count: r.lastAdminProtected })] : []),
        ].join(', ')}.`,
      });
      await load();
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.resyncFailed'), description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = () => {
    if (
      !confirm(
        t('confirmDisable'),
      )
    )
      return;
    return run(async () => {
      await identityProviders.disableScim(provider.id, token);
    }, t('toast.disabled'));
  };

  const labelClass = 'block text-[11.5px] font-medium text-[var(--text-3)] mb-1';
  const richTags = {
    strong: (chunks: ReactNode) => <strong>{chunks}</strong>,
    em: (chunks: ReactNode) => <em>{chunks}</em>,
    code: (chunks: ReactNode) => <code>{chunks}</code>,
  };
  const codeClass =
    'text-[11.5px] text-[var(--text-2)] bg-[var(--surface-2)] rounded px-1.5 py-0.5 break-all';
  const stale = status?.enabled && status.lastRequestAt ? isStale(status.lastRequestAt) : false;

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-3">
      <div>
        <h4 className="text-[13px] font-semibold text-[var(--text)]">{t('title')}</h4>
        <p className="text-[11.5px] text-[var(--text-3)] mt-1 max-w-2xl">
          {t('intro')}
        </p>
      </div>

      {status && !status.supported && (
        <p className="text-[12px] text-[var(--text-3)]">
          {t('entraOnly')}
        </p>
      )}

      {issued && (
        <div className="p-3 rounded-[9px] bg-[var(--surface-2)] space-y-3">
          <p className="text-[12px] text-[var(--text)] font-medium">
            {t('saveNow')}
          </p>
          <div>
            <label className={labelClass}>{t('tenantUrl')}</label>
            <div className="flex items-center gap-2">
              <code className={codeClass}>{tenantUrl}</code>
              <button type="button" className="text-[11.5px] text-[var(--brand)] hover:underline shrink-0" onClick={() => copy(tenantUrl, 'url')}>
                {copied === 'url' ? t('copied') : t('copy')}
              </button>
            </div>
          </div>
          <div>
            <label className={labelClass}>{t('secretToken')}</label>
            <div className="flex items-center gap-2">
              <code className={codeClass}>{revealed ? issued : '•'.repeat(24)}</code>
              <button type="button" className="text-[11.5px] text-[var(--brand)] hover:underline shrink-0" onClick={() => setRevealed((v) => !v)}>
                {revealed ? t('hide') : t('reveal')}
              </button>
              <button type="button" className="text-[11.5px] text-[var(--brand)] hover:underline shrink-0" onClick={() => copy(issued, 'token')}>
                {copied === 'token' ? t('copied') : t('copy')}
              </button>
            </div>
          </div>
          <Button size="sm" onClick={() => setIssued(null)}>
            {t('savedIt')}
          </Button>
        </div>
      )}

      {status && status.supported && !status.enabled && !issued && (
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={handleEnable} disabled={busy}>
            {busy ? t('enabling') : t('enable')}
          </Button>
          {status.unlinkedMemberCount > 0 && (
            <span className="text-[11.5px] text-[var(--text-3)]">
              {t('unlinked', { count: status.unlinkedMemberCount })}
            </span>
          )}
        </div>
      )}

      {status && status.enabled && !issued && (
        <div className="space-y-2">
          <div>
            <label className={labelClass}>{t('tenantUrl')}</label>
            <div className="flex items-center gap-2">
              <code className={codeClass}>{tenantUrl}</code>
              <button type="button" className="text-[11.5px] text-[var(--brand)] hover:underline shrink-0" onClick={() => copy(tenantUrl, 'url')}>
                {copied === 'url' ? t('copied') : t('copy')}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-[var(--text-3)]">
            <span>{t('issued', { date: status.issuedAt ? new Date(status.issuedAt).toLocaleDateString(locale) : '—' })}</span>
            <span>
              {t('lastRequest', { date: status.lastRequestAt ? new Date(status.lastRequestAt).toLocaleString(locale) : t('never') })}
              {stale && <Badge tone="warn" className="ml-1">{t('stale')}</Badge>}
            </span>
            <span>{t('users', { count: status.userCount })}</span>
            <span>{t('groups', { count: status.groupCount })}</span>
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="secondary" onClick={handleRotate} disabled={busy}>
              {t('rotate')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleResync}
              disabled={busy || !provider.roleSyncEnabled || provider.roleSyncSource !== 'GROUPS'}
              title={
                !provider.roleSyncEnabled
                  ? t('resyncNeedsSync')
                  : provider.roleSyncSource !== 'GROUPS'
                    ? t('resyncNeedsGroups')
                    : undefined
              }
            >
              {t('resync.button')}
            </Button>
            <Button size="sm" variant="danger" onClick={handleDisable} disabled={busy}>
              {t('disable')}
            </Button>
          </div>
        </div>
      )}

      {status && status.supported && (
        <div>
          <button
            type="button"
            className="text-[11.5px] text-[var(--brand)] hover:underline"
            onClick={() => setShowSteps((v) => !v)}
          >
            {showSteps ? t('hide') : t('steps.show')}
          </button>
          {showSteps && (
            <ol className="mt-2 space-y-1 text-[11.5px] text-[var(--text-2)] list-decimal pl-5 max-w-2xl">
              <li>
                {t.rich('steps.s1', richTags)}
                <br />
                {t.rich('steps.s1b', richTags)}
              </li>
              {(['s2', 's3', 's4', 's5', 's6', 's7', 's8'] as const).map((step) => (
                <li key={step}>{t.rich(`steps.${step}`, richTags)}</li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
