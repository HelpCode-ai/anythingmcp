'use client';

import { useEffect, useState } from 'react';
import { identityProviders, type IdentityProvider, type ScimStatus } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/toast';

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
      toast.show({ tone: 'error', title: 'Could not load provisioning status', description: err.message });
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
      toast.show({ tone: 'error', title: 'Copy failed', description: 'Select the value and copy it manually.' });
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
      toast.show({ tone: 'error', title: 'Provisioning change failed', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleEnable = () =>
    run(() => identityProviders.setScim(provider.id, true, token), 'Provisioning enabled');

  const handleRotate = () => {
    if (
      !confirm(
        'Rotate the SCIM token?\n\nThe current token stops working immediately. Entra provisioning fails until you paste the new token into the enterprise application.',
      )
    )
      return;
    return run(() => identityProviders.rotateScimToken(provider.id, token), 'Token rotated');
  };

  const handleResync = async () => {
    setBusy(true);
    try {
      const r = await identityProviders.resyncRoles(provider.id, token);
      toast.show({
        tone: 'success',
        title: `Resynced ${r.total} member${r.total === 1 ? '' : 's'}`,
        description: `${r.applied} changed, ${r.unchanged} unchanged${r.failed ? `, ${r.failed} failed` : ''}${r.lastAdminProtected ? `, ${r.lastAdminProtected} last-admin protected` : ''}.`,
      });
      await load();
    } catch (err: any) {
      toast.show({ tone: 'error', title: 'Resync failed', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = () => {
    if (
      !confirm(
        'Turn off SCIM provisioning?\n\nEntra will no longer be able to create, update or deactivate accounts here. Existing accounts, memberships and roles are left as they are.',
      )
    )
      return;
    return run(async () => {
      await identityProviders.disableScim(provider.id, token);
    }, 'Provisioning disabled');
  };

  const labelClass = 'block text-[11.5px] font-medium text-[var(--text-3)] mb-1';
  const codeClass =
    'text-[11.5px] text-[var(--text-2)] bg-[var(--surface-2)] rounded px-1.5 py-0.5 break-all';
  const stale =
    status?.enabled && status.lastRequestAt
      ? Date.now() - new Date(status.lastRequestAt).getTime() > 2 * 3600_000
      : false;

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-3">
      <div>
        <h4 className="text-[13px] font-semibold text-[var(--text)]">Provisioning (SCIM)</h4>
        <p className="text-[11.5px] text-[var(--text-3)] mt-1 max-w-2xl">
          Let Entra create accounts, update them, and — the part that matters — deactivate
          them the moment someone is disabled or removed in the directory, with no sign-in
          required. Without this, a leaver keeps any MCP key they already hold until an
          administrator deactivates them by hand.
        </p>
      </div>

      {status && !status.supported && (
        <p className="text-[12px] text-[var(--text-3)]">
          Provisioning is available for Microsoft Entra ID providers.
        </p>
      )}

      {issued && (
        <div className="p-3 rounded-[9px] bg-[var(--surface-2)] space-y-3">
          <p className="text-[12px] text-[var(--text)] font-medium">
            Save the token now — it cannot be shown again.
          </p>
          <div>
            <label className={labelClass}>Tenant URL</label>
            <div className="flex items-center gap-2">
              <code className={codeClass}>{tenantUrl}</code>
              <button type="button" className="text-[11.5px] text-[var(--brand)] hover:underline shrink-0" onClick={() => copy(tenantUrl, 'url')}>
                {copied === 'url' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <div>
            <label className={labelClass}>Secret token</label>
            <div className="flex items-center gap-2">
              <code className={codeClass}>{revealed ? issued : '•'.repeat(24)}</code>
              <button type="button" className="text-[11.5px] text-[var(--brand)] hover:underline shrink-0" onClick={() => setRevealed((v) => !v)}>
                {revealed ? 'Hide' : 'Reveal'}
              </button>
              <button type="button" className="text-[11.5px] text-[var(--brand)] hover:underline shrink-0" onClick={() => copy(issued, 'token')}>
                {copied === 'token' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <Button size="sm" onClick={() => setIssued(null)}>
            I have saved it
          </Button>
        </div>
      )}

      {status && status.supported && !status.enabled && !issued && (
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={handleEnable} disabled={busy}>
            {busy ? 'Enabling...' : 'Enable provisioning'}
          </Button>
          {status.unlinkedMemberCount > 0 && (
            <span className="text-[11.5px] text-[var(--text-3)]">
              {status.unlinkedMemberCount} existing member{status.unlinkedMemberCount === 1 ? '' : 's'} have no Microsoft identity yet — Entra will report a conflict for them until they sign in with Microsoft once.
            </span>
          )}
        </div>
      )}

      {status && status.enabled && !issued && (
        <div className="space-y-2">
          <div>
            <label className={labelClass}>Tenant URL</label>
            <div className="flex items-center gap-2">
              <code className={codeClass}>{tenantUrl}</code>
              <button type="button" className="text-[11.5px] text-[var(--brand)] hover:underline shrink-0" onClick={() => copy(tenantUrl, 'url')}>
                {copied === 'url' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-[var(--text-3)]">
            <span>Token issued {status.issuedAt ? new Date(status.issuedAt).toLocaleDateString() : '—'}</span>
            <span>
              Last request from Entra{' '}
              {status.lastRequestAt ? new Date(status.lastRequestAt).toLocaleString() : 'never'}
              {stale && <Badge tone="warn" className="ml-1">stale</Badge>}
            </span>
            <span>Users provisioned {status.userCount}</span>
            <span>Groups synced {status.groupCount}</span>
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="secondary" onClick={handleRotate} disabled={busy}>
              Rotate token
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleResync}
              disabled={busy || !provider.roleSyncEnabled || provider.roleSyncSource !== 'GROUPS'}
              title={
                !provider.roleSyncEnabled
                  ? 'Turn on role sync under Edit first'
                  : provider.roleSyncSource !== 'GROUPS'
                    ? 'Only applies when roles are read from groups'
                    : undefined
              }
            >
              Resync roles now
            </Button>
            <Button size="sm" variant="danger" onClick={handleDisable} disabled={busy}>
              Disable
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
            {showSteps ? 'Hide' : 'How to set this up in Entra'}
          </button>
          {showSteps && (
            <ol className="mt-2 space-y-1 text-[11.5px] text-[var(--text-2)] list-decimal pl-5 max-w-2xl">
              <li>
                Entra admin center → <strong>Enterprise applications</strong> → <strong>New application</strong> →
                <strong> Create your own application</strong> → <em>Integrate any other application you don&apos;t find
                in the gallery</em>. Name it something like <em>AnythingMCP provisioning</em>.
                <br />
                This has to be a <strong>second, non-gallery app</strong>: the app you registered for sign-in came from
                <em> App registrations</em>, and Entra leaves <strong>Get started</strong> greyed out on those with
                &ldquo;automatic provisioning … is not supported&rdquo;.
              </li>
              <li>
                <strong>Users and groups → Add user/group</strong>: assign the same groups you assigned to the sign-in
                app. Assignment does not carry over between the two apps, and only assigned groups are provisioned.
              </li>
              <li><strong>Provisioning</strong> → Provisioning Mode: <strong>Automatic</strong>.</li>
              <li>
                <strong>Connectivity</strong> (older tenants show this inline as <em>Admin Credentials</em>):
                authentication method <strong>Bearer authentication</strong>, then paste the{' '}
                <strong>Tenant URL</strong> and the <strong>Secret Token</strong> above → <strong>Test connection</strong>.
                Entra refuses to save until the test passes.
              </li>
              <li>
                <strong>Attribute mapping</strong>: leave <code>userName</code> ← <code>userPrincipalName</code> and
                <code> active</code> as they are, but <strong>change <code>externalId</code></strong> — its stock source
                is <code>mailNickname</code>, it must be <code>objectId</code>. Otherwise the same person ends up with
                one account from SCIM and another from sign-in.
              </li>
              <li>Settings → Scope: <em>Sync only assigned users and groups</em>. Only groups assigned under <strong>Users and groups</strong> are provisioned — the same rule as the groups claim.</li>
              <li><strong>Save</strong>, then <strong>Start provisioning</strong>. The first cycle creates <em>every</em> assigned user; later ones run about every 40 minutes.</li>
              <li>To test one user without waiting: <strong>Provision on demand</strong>. Use it again after disabling the user in Entra.</li>
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
