'use client';

import { useLocale, useTranslations } from 'next-intl';
import { StatusPill } from '@/components/ui/badge';

/**
 * Credential health recorded by the backend (connector.authStatus):
 * `needs_reauth` when the provider refused the credential for good (calls
 * fail at once until it is replaced), `expiring` when a pasted token will
 * stop working soon and cannot be renewed.
 */
export interface AuthStatusFields {
  authStatus?: string | null;
  authStatusCode?: string | null;
  authStatusMessage?: string | null;
  authStatusAt?: string | null;
  tokenExpiresAt?: string | null;
  authType?: string;
}

function isOAuth(connector: AuthStatusFields): boolean {
  return connector.authType === 'OAUTH2';
}

/**
 * A saved key, token or password the service kept refusing on tool calls
 * (backend: credential-refusal-tracker). Unlike a revoked sign-in nothing is
 * blocked and there is nothing to authorize: valid credentials have to be
 * saved, and the next call that works removes the status.
 */
export function isCredentialsRefused(connector: AuthStatusFields): boolean {
  return connector.authStatus === 'needs_reauth' && connector.authStatusCode === 'credential_refused';
}

/** Next to "Active" in the connector list and on the connector page. */
export function AuthStatusPill({ connector }: { connector: AuthStatusFields }) {
  const t = useTranslations('authStatus');
  if (connector.authStatus === 'needs_reauth') {
    return (
      <StatusPill tone="danger" dot="var(--danger)" title={connector.authStatusMessage ?? undefined}>
        {isCredentialsRefused(connector)
          ? t('pill.credentialsRefused')
          : isOAuth(connector)
            ? t('pill.signInExpired')
            : t('pill.tokenRefused')}
      </StatusPill>
    );
  }
  if (connector.authStatus === 'expiring') {
    return (
      <StatusPill tone="warn" dot="var(--warn)" title={connector.authStatusMessage ?? undefined}>
        {t('pill.expiresSoon')}
      </StatusPill>
    );
  }
  return null;
}

function formatDate(value: string | null | undefined, locale: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * On the connector page: what the provider said and what to do about it.
 * `action` is the way to fix it from here (a button), shown beside the text.
 */
export function AuthStatusBanner({ connector, action }: { connector: AuthStatusFields; action?: React.ReactNode }) {
  const t = useTranslations('authStatus');
  const locale = useLocale();
  const status = connector.authStatus;
  if (status !== 'needs_reauth' && status !== 'expiring') return null;
  const blocking = status === 'needs_reauth';
  const since = formatDate(connector.authStatusAt, locale);
  const expires = formatDate(connector.tokenExpiresAt, locale);
  const tone = blocking
    ? 'border-[var(--border)] bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]'
    : 'border-[var(--border)] bg-[var(--t-warn-bg)] text-[var(--t-warn-fg)]';
  return (
    // Stacked on a phone, so the text keeps the full width and the action sits under it.
    <div role="status" className={`flex flex-col gap-3 rounded-[10px] border p-3 text-sm sm:flex-row sm:items-center ${tone}`}>
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {blocking
            ? isCredentialsRefused(connector)
              ? t('banner.credentialsRefused')
              : isOAuth(connector)
                ? t('banner.signInRefused')
                : t('banner.tokenRefused')
            : expires
              ? t('banner.expiresOn', { date: expires })
              : t('banner.expiresSoon')}
        </p>
        {connector.authStatusMessage && <p className="mt-1">{connector.authStatusMessage}</p>}
        {blocking && since && <p className="mt-1 text-xs opacity-80">{t('banner.since', { date: since })}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
