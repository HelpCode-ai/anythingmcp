'use client';

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

/** Next to "Active" in the connector list and on the connector page. */
export function AuthStatusPill({ connector }: { connector: AuthStatusFields }) {
  if (connector.authStatus === 'needs_reauth') {
    return (
      <StatusPill tone="danger" dot="var(--danger)" title={connector.authStatusMessage ?? undefined}>
        {isOAuth(connector) ? 'Sign-in expired' : 'Token refused'}
      </StatusPill>
    );
  }
  if (connector.authStatus === 'expiring') {
    return (
      <StatusPill tone="warn" dot="var(--warn)" title={connector.authStatusMessage ?? undefined}>
        Token expires soon
      </StatusPill>
    );
  }
  return null;
}

function formatDate(value?: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** On the connector page: what the provider said and what to do about it. */
export function AuthStatusBanner({ connector }: { connector: AuthStatusFields }) {
  const status = connector.authStatus;
  if (status !== 'needs_reauth' && status !== 'expiring') return null;
  const blocking = status === 'needs_reauth';
  const since = formatDate(connector.authStatusAt);
  const expires = formatDate(connector.tokenExpiresAt);
  return (
    <div
      role="status"
      className={
        blocking
          ? 'rounded-[10px] border border-[var(--border)] bg-[var(--t-danger-bg)] p-3 text-sm text-[var(--t-danger-fg)]'
          : 'rounded-[10px] border border-[var(--border)] bg-[var(--t-warn-bg)] p-3 text-sm text-[var(--t-warn-fg)]'
      }
    >
      <p className="font-medium">
        {blocking
          ? isOAuth(connector)
            ? 'The provider refused the sign-in, so tool calls stop here until you authorize again.'
            : 'The provider refused the access token, so tool calls stop here until you save a new one.'
          : `The access token stops working${expires ? ` on ${expires}` : ' soon'}.`}
      </p>
      {connector.authStatusMessage && <p className="mt-1">{connector.authStatusMessage}</p>}
      {blocking && since && <p className="mt-1 text-xs opacity-80">Since {since}</p>}
    </div>
  );
}
