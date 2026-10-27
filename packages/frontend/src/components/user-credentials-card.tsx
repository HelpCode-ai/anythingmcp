'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
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
      setError(err?.message || 'Could not change the sign-in mode.');
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
      setError(err?.message || 'Could not start the sign-in.');
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
      setError(err?.message || 'Could not disconnect.');
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
            Sign-in
            <StatusPill tone={perUser ? 'purple' : 'neutral'}>{perUser ? 'Per user' : 'Shared'}</StatusPill>
          </h3>
          <p className="text-sm text-[var(--text-3)] max-w-prose">
            {perUser
              ? `Every user connects their own account. Calls carry the caller's own sign-in, so ${
                  isMcp ? 'the remote server' : 'the provider'
                } shows each user only what their account may see.`
              : 'One authorization serves every user of this workspace: everyone sees what that account can see.'}
          </p>
        </div>
        {canManage && (
          <Button
            variant="secondary"
            size="md"
            onClick={() => setPendingScope(perUser ? 'SHARED' : 'USER')}
            disabled={busy}
          >
            {perUser ? 'Use one shared sign-in' : 'Require each user to sign in (Enterprise)'}
          </Button>
        )}
      </div>

      {perUser && (
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          {mine?.connected ? (
            <>
              {mine.authStatus === 'needs_reauth' ? (
                <StatusPill tone="danger" dot="var(--danger)" title={mine.authStatusMessage ?? undefined}>
                  Your sign-in expired
                </StatusPill>
              ) : (
                <StatusPill tone="success" dot="var(--success)">
                  Your account is connected
                  {mine.authorizedAt ? ` since ${new Date(mine.authorizedAt).toLocaleDateString()}` : ''}
                </StatusPill>
              )}
              <Button variant="primary" size="md" onClick={connect} disabled={busy}>
                {busy ? 'Redirecting...' : 'Sign in again'}
              </Button>
              <Button variant="outlineDanger" size="md" onClick={disconnect} disabled={busy}>
                Disconnect my account
              </Button>
            </>
          ) : (
            <Button variant="primary" size="lg" onClick={connect} disabled={busy}>
              {busy ? 'Redirecting...' : 'Connect my account'}
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
              {pendingScope === 'USER' ? 'Require each user to sign in' : 'Use one shared sign-in'}
            </Dialog.Title>
            <Dialog.Description className="mb-5 text-sm text-[var(--text-3)]">
              {pendingScope === 'USER'
                ? 'The authorization stored on this connector is removed. Every user then connects their own account before their calls work.'
                : "Every user's own sign-in is removed, and the connector needs one authorization of its own again. Everyone then sees what that one account can see."}
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <Dialog.Close className={cn(buttonVariants({ variant: 'secondary', size: 'md' }))} disabled={busy}>
                Cancel
              </Dialog.Close>
              <Button variant="primary" size="md" onClick={switchScope} disabled={busy}>
                {busy ? 'Saving…' : 'Switch'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Card>
  );
}
