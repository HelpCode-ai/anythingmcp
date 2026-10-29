'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useLocale, useTranslations } from 'next-intl';
import { connectors, type CredentialScope, type MyConnectorCredential } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/badge';

/**
 * Who signs in to the provider for an OAuth2 connector: one shared
 * authorization, or every user with their own account (Enterprise). With
 * per-user sign-in each call carries the caller's own token, so the provider's
 * own permissions decide what each user sees; a user who has not connected
 * gets an error with a link here, never someone else's data.
 *
 * The owner or an admin switches the mode; every member connects their own
 * account. Enterprise is checked by the server, which answers 403 without it;
 * without it a shared connector shows no card at all, as before this feature.
 */
export function UserCredentialsCard({
  connectorId,
  credentialScope,
  canManage,
  isMcp,
  onScopeChanged,
}: {
  connectorId: string;
  credentialScope: CredentialScope;
  canManage: boolean;
  isMcp: boolean;
  onScopeChanged: () => void;
}) {
  const { token } = useAuth();
  const t = useTranslations('userCredentials');
  const locale = useLocale();
  const [mine, setMine] = useState<MyConnectorCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The mode change waiting for confirmation: it signs people out either way.
  const [pendingScope, setPendingScope] = useState<CredentialScope | null>(null);
  const perUser = credentialScope === 'USER';

  const loadMine = useCallback(() => {
    if (!token) return;
    connectors
      .getMyCredential(connectorId, token)
      .then(setMine)
      .catch(() => setMine(null));
  }, [token, connectorId]);

  // Read again after the mode changes: switching back to shared signs everyone out.
  useEffect(() => loadMine(), [loadMine, credentialScope]);

  const switchScope = async () => {
    if (!token || !pendingScope) return;
    setBusy(true);
    setError('');
    try {
      await connectors.setCredentialScope(connectorId, pendingScope, token);
      setPendingScope(null);
      onScopeChanged();
    } catch (err: any) {
      setPendingScope(null);
      setError(err?.message || t('scopeError'));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      const result = await connectors.oauthAuthorize(connectorId, token);
      if (result.authorizationUrl) {
        window.location.href = result.authorizationUrl;
        return;
      }
      if (result.error) setError(result.error);
    } catch (err: any) {
      setError(err?.message || t('connectError'));
    }
    setBusy(false);
  };

  const disconnect = async () => {
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      await connectors.disconnectMyCredential(connectorId, token);
      loadMine();
    } catch (err: any) {
      setError(err?.message || t('disconnectError'));
    } finally {
      setBusy(false);
    }
  };

  // A shared connector of a workspace without Enterprise (or still loading):
  // nothing to offer, so the page stays as it was.
  if (!perUser && !mine?.available) return null;

  return (
    <Card className="p-[22px]">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
            {t('title')}
            <StatusPill tone={perUser ? 'purple' : 'neutral'}>{perUser ? t('perUser') : t('shared')}</StatusPill>
          </h3>
          <p className="text-sm text-[var(--text-3)] max-w-prose">
            {perUser
              ? t('perUserBody', { target: isMcp ? 'mcp' : 'provider' })
              : t('sharedBody')}
          </p>
        </div>
        {canManage && (
          <Button
            variant="secondary"
            size="md"
            onClick={() => setPendingScope(perUser ? 'SHARED' : 'USER')}
            disabled={busy}
          >
            {perUser ? t('switchToShared') : t('switchToUser')}
          </Button>
        )}
      </div>

      {perUser && (
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          {mine?.connected ? (
            <>
              {mine.authStatus === 'needs_reauth' ? (
                <StatusPill tone="danger" dot="var(--danger)" title={mine.authStatusMessage ?? undefined}>
                  {t('expired')}
                </StatusPill>
              ) : (
                <StatusPill tone="success" dot="var(--success)">
                  {mine.authorizedAt
                    ? t('connectedSince', { date: new Date(mine.authorizedAt).toLocaleDateString(locale) })
                    : t('connected')}
                </StatusPill>
              )}
              <Button variant="primary" size="md" onClick={connect} disabled={busy}>
                {busy ? t('redirecting') : t('signInAgain')}
              </Button>
              <Button variant="outlineDanger" size="md" onClick={disconnect} disabled={busy}>
                {t('disconnect')}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="lg" onClick={connect} disabled={busy}>
              {busy ? t('redirecting') : t('connect')}
            </Button>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}

      <Dialog.Root open={!!pendingScope} onOpenChange={(open) => { if (!open && !busy) setPendingScope(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
            <Dialog.Title className="mb-2 text-lg font-semibold text-[var(--text)]">
              {pendingScope === 'USER' ? t('dialog.titleUser') : t('dialog.titleShared')}
            </Dialog.Title>
            <Dialog.Description className="mb-5 text-sm text-[var(--text-3)]">
              {pendingScope === 'USER'
                ? t('dialog.bodyUser')
                : t('dialog.bodyShared')}
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <Dialog.Close className={cn(buttonVariants({ variant: 'secondary', size: 'md' }))} disabled={busy}>
                {t('dialog.cancel')}
              </Dialog.Close>
              <Button variant="primary" size="md" onClick={switchScope} disabled={busy}>
                {busy ? t('dialog.saving') : t('dialog.switch')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Card>
  );
}
