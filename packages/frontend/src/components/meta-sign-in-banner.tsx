'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { connectors, type MetaInstagramAccount } from '@/lib/api';
import { Button } from '@/components/ui/button';

/** What a Meta sign-in of an Instagram connector ended with (?meta=… on the connector page). */
export type MetaSignInStatus = 'connected' | 'choose' | 'no_account' | 'error';

const TONE: Record<MetaSignInStatus, string> = {
  connected: 'bg-[var(--t-success-bg)] text-[var(--t-success-fg)]',
  choose: 'bg-[var(--surface-2)] text-[var(--text-2)]',
  no_account: 'bg-[var(--t-warn-bg)] text-[var(--t-warn-fg)]',
  error: 'bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]',
};

/**
 * The outcome of "Authorize with Instagram or Facebook", shown on the
 * connector page with the next step, so a sign-in never ends on a page with
 * nothing to do: test the connection when it worked, pick the account when
 * several were shared, name it or sign in again when Meta returned none, or
 * sign in again after an error.
 */
export function MetaSignInBanner({
  connectorId,
  status,
  message,
  reason,
  token,
  authorizing,
  onAuthorize,
  onTest,
  onSaved,
  onDismiss,
}: {
  connectorId: string;
  status: MetaSignInStatus;
  message?: string | null;
  /** `no_assets`: Meta granted the permissions but no Instagram account. */
  reason?: string | null;
  token: string | null;
  authorizing: boolean;
  onAuthorize: () => void;
  onTest: () => void;
  onSaved: (account: MetaInstagramAccount) => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('connectorDetail.metaBanner');
  const [accounts, setAccounts] = useState<MetaInstagramAccount[] | null>(null);
  const [current, setCurrent] = useState<MetaInstagramAccount | null>(null);
  const [manualId, setManualId] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The accounts the stored sign-in reaches: to pick from, or to name the connected one.
  useEffect(() => {
    if (!token || status === 'error') return;
    connectors
      .metaAccounts(connectorId, token)
      .then((out) => {
        setAccounts(out.accounts);
        setCurrent(out.accounts.find((a) => a.id === out.current) ?? (out.current ? { id: out.current } : null));
      })
      .catch(() => setAccounts([]));
  }, [connectorId, token, status]);

  const save = (accountId: string) => {
    if (!token) return;
    setSaving(true);
    setProblem(null);
    connectors
      .metaChooseAccount(connectorId, accountId, token)
      .then((out) => {
        setCurrent(out.account);
        onSaved(out.account);
      })
      .catch((err: Error) => setProblem(err.message))
      .finally(() => setSaving(false));
  };

  const connected = status === 'connected' || (current !== null && status !== 'error');
  const shown: MetaSignInStatus = connected ? 'connected' : status;
  const label = (a: MetaInstagramAccount) => (a.username ? `@${a.username}` : a.id);

  return (
    <div role="status" className={`rounded-[10px] border border-[var(--border)] p-4 text-sm ${TONE[shown]}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold">
          {shown === 'connected' && current ? t('connected.titleAs', { account: label(current) }) : t(`${shown}.title`)}
        </p>
        <button onClick={onDismiss} className="text-xs underline">
          {t('dismiss')}
        </button>
      </div>

      {shown === 'connected' && (
        <>
          <p className="mt-1">{current ? t('connected.bodyAs', { account: label(current) }) : t('connected.body')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={onTest}>
              {t('testNow')}
            </Button>
            {accounts && accounts.length > 1 && (
              <Button size="sm" variant="secondary" onClick={() => setCurrent(null)}>
                {t('switchAccount')}
              </Button>
            )}
          </div>
        </>
      )}

      {shown === 'error' && (
        <>
          <p className="mt-1">{message || t('error.body')}</p>
          <div className="mt-3">
            <Button size="sm" variant="primary" onClick={onAuthorize} disabled={authorizing}>
              {t('authorizeAgain')}
            </Button>
          </div>
        </>
      )}

      {(shown === 'choose' || shown === 'no_account') && (
        <>
          <p className="mt-1">
            {accounts && accounts.length > 0
              ? t('choose.body')
              : reason === 'no_assets'
                ? t('no_account.bodyNoAssets')
                : t('no_account.body')}
          </p>
          {accounts && accounts.length > 0 && (
            <ul className="mt-3 space-y-2">
              {accounts.map((a) => (
                <li key={a.id}>
                  <Button variant="secondary" size="sm" className="w-full justify-between" disabled={saving} onClick={() => save(a.id)}>
                    <span>{label(a)}</span>
                    {a.pageName && <span className="text-xs opacity-70">{a.pageName}</span>}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^\d{5,25}$/.test(manualId.trim())) save(manualId.trim());
              else setProblem(t('manualInvalid'));
            }}
          >
            <input
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder="17841400000000000"
              aria-label={t('manualLabel')}
              className="min-w-[14rem] flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 font-mono text-xs text-[var(--text)]"
            />
            <Button size="sm" variant="secondary" type="submit" disabled={saving}>
              {t('manualSave')}
            </Button>
            <Button size="sm" variant="primary" type="button" onClick={onAuthorize} disabled={authorizing}>
              {t('authorizeAgain')}
            </Button>
          </form>
          <p className="mt-2 text-xs opacity-80">{t('manualHint')}</p>
        </>
      )}

      {problem && <p className="mt-2 text-xs">{problem}</p>}
    </div>
  );
}
