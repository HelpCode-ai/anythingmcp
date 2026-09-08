'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import {
  identityProviders,
  type IdentityProvider,
  type IdentityProviderInput,
} from '@/lib/api';
import { AppSelect } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/toast';
import { RoleMappingsPanel } from './role-mappings';
import { RecoveryCodesCard } from './recovery-codes';

/**
 * Per-type configuration fields.
 *
 * `issuer: true` means the type has no derivable issuer, so the admin must
 * supply one — for the others the server builds it and ignores anything sent,
 * which is what keeps a hostile URL out of the discovery fetch.
 */
const PROVIDER_TYPES: Record<
  string,
  {
    label: string;
    issuer: boolean;
    hint?: string;
    fields: { key: string; label: string; placeholder: string; help?: string }[];
  }
> = {
  ENTRA: {
    label: 'Microsoft Entra ID',
    issuer: false,
    fields: [
      {
        key: 'tenantId',
        label: 'Directory (tenant) ID',
        placeholder: '00000000-0000-0000-0000-000000000000',
        help: 'The tenant GUID from your app registration overview. A directory name such as contoso.onmicrosoft.com is not accepted.',
      },
    ],
  },
  GOOGLE: {
    label: 'Google Workspace',
    issuer: false,
    fields: [
      {
        key: 'hostedDomain',
        label: 'Workspace domain',
        placeholder: 'example.com',
        help: 'Strongly recommended. Without it Google is not authoritative for a non-gmail.com address, so any Google account could sign in.',
      },
    ],
  },
  OKTA: {
    label: 'Okta',
    issuer: true,
    hint: 'Use your Okta domain, e.g. https://acme.okta.com. Custom domains are not yet supported.',
    fields: [
      {
        key: 'authorizationServerId',
        label: 'Authorization server ID (optional)',
        placeholder: 'default',
      },
    ],
  },
  AUTH0: {
    label: 'Auth0',
    issuer: true,
    hint: 'Self-hosted deployments only.',
    fields: [
      {
        key: 'rolesClaimNamespace',
        label: 'Roles claim namespace',
        placeholder: 'https://your-app.example.com/roles',
        help: 'Auth0 silently drops custom claims that are not namespaced — the sign-in succeeds and the roles are simply missing.',
      },
    ],
  },
  GITHUB: {
    label: 'GitHub',
    issuer: false,
    hint: 'GitHub is not an OpenID Connect provider, so there is no discovery document to test.',
    fields: [
      {
        key: 'organization',
        label: 'Restrict to organization (optional)',
        placeholder: 'my-org',
      },
    ],
  },
  OIDC: {
    label: 'Generic OpenID Connect',
    issuer: true,
    hint: 'Self-hosted deployments only.',
    fields: [
      {
        key: 'groupsClaimName',
        label: 'Groups claim name (optional)',
        placeholder: 'groups',
      },
    ],
  },
};

const emptyForm = (): IdentityProviderInput & { config: Record<string, string> } => ({
  type: 'ENTRA',
  name: '',
  clientId: '',
  clientSecret: '',
  clientSecretExpiresAt: '',
  issuer: '',
  config: {},
  isActive: true,
  jitProvisioning: false,
  roleSyncEnabled: false,
  roleSyncSource: 'GROUPS',
  roleSyncFallback: 'DENY_ALL',
});

export default function IdentityProvidersPage() {
  const { token, user: currentUser } = useAuth();
  const toast = useToast();

  const [providers, setProviders] = useState<IdentityProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [mappingsFor, setMappingsFor] = useState<string | null>(null);
  const [enforcing, setEnforcing] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());

  const loadData = async () => {
    if (!token) return;
    try {
      setProviders(await identityProviders.list(token));
    } catch (err: any) {
      toast.show({ tone: 'error', title: 'Could not load providers', description: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const openCreate = () => {
    setForm(emptyForm());
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (p: IdentityProvider) => {
    setForm({
      type: p.type,
      name: p.name,
      clientId: p.clientId,
      // Never prefilled: the API does not return it, and an empty value means
      // "keep the stored one".
      clientSecret: '',
      clientSecretExpiresAt: p.clientSecretExpiresAt?.slice(0, 10) ?? '',
      issuer: p.issuer,
      config: (p.config ?? {}) as Record<string, string>,
      isActive: p.isActive,
      jitProvisioning: p.jitProvisioning,
      roleSyncEnabled: p.roleSyncEnabled,
      roleSyncSource: p.roleSyncSource,
      roleSyncFallback: p.roleSyncFallback,
      roleSyncDefaultRoleIds: p.roleSyncDefaultRoleIds ?? [],
    });
    setEditingId(p.id);
    setShowForm(true);
  };

  const handleEnforceSso = async (p: IdentityProvider, enforce: boolean) => {
    if (!token) return;
    // Confirm only on the way IN. Turning enforcement off removes a lockout
    // risk, and putting a dialog in front of that would be an obstacle in
    // exactly the moment someone is trying to undo a mistake.
    if (
      enforce &&
      !confirm(
        'Require single sign-on for this workspace?\n\nPassword sign-in stops working for every member. Your recovery codes become the only way in if the identity provider becomes unreachable.',
      )
    ) {
      return;
    }
    setEnforcing(p.id);
    try {
      await identityProviders.setEnforceSso(p.id, enforce, token);
      toast.show({
        tone: 'success',
        title: enforce ? 'Single sign-on required' : 'Password sign-in re-enabled',
      });
      await loadData();
    } catch (err: any) {
      toast.show({ tone: 'error', title: 'Could not change enforcement', description: err.message });
    } finally {
      setEnforcing(null);
    }
  };

  const handleSave = async () => {
    if (!token) return;
    setSaving(true);
    try {
      const spec = PROVIDER_TYPES[form.type];
      const payload: IdentityProviderInput = {
        ...form,
        // Drop blanks so an optional field left empty is absent rather than "".
        config: Object.fromEntries(
          Object.entries(form.config).filter(([, v]) => v.trim() !== ''),
        ),
        ...(spec.issuer ? { issuer: form.issuer } : { issuer: undefined }),
        clientSecret: form.clientSecret?.trim() ? form.clientSecret : undefined,
        clientSecretExpiresAt: form.clientSecretExpiresAt?.trim()
          ? new Date(form.clientSecretExpiresAt).toISOString()
          : null,
      };

      if (editingId) {
        await identityProviders.update(editingId, payload, token);
        toast.show({ tone: 'success', title: 'Provider updated' });
      } else {
        await identityProviders.create(payload, token);
        toast.show({ tone: 'success', title: 'Provider created' });
      }
      setShowForm(false);
      setEditingId(null);
      await loadData();
    } catch (err: any) {
      toast.show({ tone: 'error', title: 'Could not save', description: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (p: IdentityProvider) => {
    if (
      !token ||
      !confirm(
        `Delete "${p.name}"? Anyone who signs in through it will lose access, and members with password sign-in disabled will be locked out.`,
      )
    )
      return;
    try {
      await identityProviders.delete(p.id, token);
      toast.show({ tone: 'success', title: 'Provider deleted' });
      await loadData();
    } catch (err: any) {
      toast.show({ tone: 'error', title: 'Could not delete', description: err.message });
    }
  };

  const handleCopyLink = async (p: IdentityProvider) => {
    try {
      await navigator.clipboard.writeText(signInUrl(p));
      setCopiedId(p.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // navigator.clipboard is undefined on a non-HTTPS origin, which is the
      // normal case for a self-hosted deployment on a LAN address. Falling back
      // to a toast keeps the link reachable instead of failing silently.
      toast.show({
        tone: 'error',
        title: 'Could not copy',
        description: signInUrl(p),
      });
    }
  };

  const handleTest = async (p: IdentityProvider) => {
    if (!token) return;
    setTesting(p.id);
    try {
      const result = await identityProviders.test(p.id, token);
      toast.show({
        tone: result.ok ? 'success' : 'error',
        title: result.ok ? 'Connection OK' : 'Connection failed',
        description: result.message,
      });
    } catch (err: any) {
      toast.show({ tone: 'error', title: 'Test failed', description: err.message });
    } finally {
      setTesting(null);
    }
  };

  if (currentUser?.role !== 'ADMIN') {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <h2 className="text-xl font-bold text-[var(--text)] mb-2">Access Denied</h2>
          <p className="text-[var(--text-2)] mb-4">Only administrators can access this page.</p>
          <Link href="/settings" className="text-[var(--brand)] hover:underline">Back to Settings</Link>
        </div>
      </div>
    );
  }

  const inputClass =
    'w-full max-w-sm h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]';
  const labelClass = 'block text-[12.5px] font-medium text-[var(--text-2)] mb-1';
  const helpClass = 'text-[11.5px] text-[var(--text-3)] mt-1 max-w-sm';

  // Built from the browser's own origin rather than a configured base URL:
  // self-hosted deployments have no reliable public URL to read, and getting it
  // wrong hands the admin a link that silently sends members nowhere.
  const signInUrl = (p: IdentityProvider) =>
    `${typeof window === 'undefined' ? '' : window.location.origin}/sso/${p.initiateId}`;

  const spec = PROVIDER_TYPES[form.type];
  const expiringSoon = (p: IdentityProvider) => {
    if (!p.clientSecretExpiresAt) return false;
    const days =
      (new Date(p.clientSecretExpiresAt).getTime() - Date.now()) / 86_400_000;
    return days < 30;
  };

  return (
    <div className="space-y-6">
      {loading ? (
        <p className="text-center text-[var(--text-3)] py-16">Loading...</p>
      ) : (
        <Card className="p-[22px]">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="text-base font-semibold text-[var(--text)]">Single sign-on</h3>
              <p className="text-[13px] text-[var(--text-2)] mt-1 max-w-2xl">
                Let members sign in with your organization&apos;s identity provider instead of
                a password. Share the sign-in link below with them — it is the entry point
                for this workspace.
              </p>
            </div>
            <Button size="sm" onClick={showForm ? () => setShowForm(false) : openCreate}>
              {showForm ? 'Cancel' : 'Add provider'}
            </Button>
          </div>

          {showForm && (
            <div className="mb-5 p-4 rounded-[9px] bg-[var(--surface-2)] space-y-3">
              <div>
                <label className={labelClass}>Provider</label>
                <div className="max-w-sm">
                  <AppSelect
                    value={form.type}
                    onValueChange={(v) =>
                      // Reset the config: the fields belong to the old type and
                      // would fail validation against the new one.
                      setForm({ ...form, type: v, config: {}, issuer: '' })
                    }
                    options={Object.entries(PROVIDER_TYPES).map(([value, t]) => ({
                      value,
                      label: t.label,
                    }))}
                    disabled={Boolean(editingId)}
                  />
                </div>
                {editingId && (
                  <p className={helpClass}>
                    The provider type cannot be changed after creation — the stored settings
                    were validated against it. Create a new provider instead.
                  </p>
                )}
                {spec.hint && <p className={helpClass}>{spec.hint}</p>}
              </div>

              <div>
                <label className={labelClass}>Display name</label>
                <input
                  className={inputClass}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Sign in with Microsoft"
                />
                <p className={helpClass}>Shown on the sign-in button.</p>
              </div>

              {spec.issuer && (
                <div>
                  <label className={labelClass}>Issuer URL</label>
                  <input
                    className={inputClass}
                    value={form.issuer ?? ''}
                    onChange={(e) => setForm({ ...form, issuer: e.target.value })}
                    placeholder="https://acme.okta.com"
                  />
                </div>
              )}

              {spec.fields.map((f) => (
                <div key={f.key}>
                  <label className={labelClass}>{f.label}</label>
                  <input
                    className={inputClass}
                    value={form.config[f.key] ?? ''}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        config: { ...form.config, [f.key]: e.target.value },
                      })
                    }
                    placeholder={f.placeholder}
                  />
                  {f.help && <p className={helpClass}>{f.help}</p>}
                </div>
              ))}

              <div>
                <label className={labelClass}>Client ID</label>
                <input
                  className={inputClass}
                  value={form.clientId}
                  onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                />
              </div>

              <div>
                <label className={labelClass}>
                  Client secret {editingId && <span className="font-normal">(leave blank to keep)</span>}
                </label>
                <input
                  type="password"
                  className={inputClass}
                  value={form.clientSecret ?? ''}
                  onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                  placeholder={editingId ? '••••••••' : ''}
                  autoComplete="new-password"
                />
                {editingId && (
                  <p className={helpClass}>
                    The secret is never sent back to the browser, so it cannot be shown here.
                  </p>
                )}
              </div>

              <div>
                <label className={labelClass}>Secret expires on (optional)</label>
                <input
                  type="date"
                  className={inputClass}
                  value={form.clientSecretExpiresAt ?? ''}
                  onChange={(e) =>
                    setForm({ ...form, clientSecretExpiresAt: e.target.value })
                  }
                />
                <p className={helpClass}>
                  Microsoft caps client secrets at 24 months. Recording the date here turns a
                  silent expiry into a warning.
                </p>
              </div>

              <label className="flex items-start gap-2 text-[13px] text-[var(--text)] max-w-sm">
                <input
                  type="checkbox"
                  className="mt-[3px] accent-[var(--brand)]"
                  checked={form.jitProvisioning ?? false}
                  onChange={(e) =>
                    setForm({ ...form, jitProvisioning: e.target.checked })
                  }
                />
                <span>
                  Create accounts on first sign-in
                  <span className="block text-[11.5px] text-[var(--text-3)]">
                    Off by default. With this on, anyone who can authenticate at your identity
                    provider joins this workspace as a Viewer — including guests you may have
                    invited there for other reasons.
                  </span>
                </span>
              </label>

              <div className="pt-1 space-y-2 border-t border-[var(--border)]">
                <label className="flex items-start gap-2 text-[13px] text-[var(--text)] pt-2">
                  <input
                    type="checkbox"
                    className="accent-[var(--brand)] mt-0.5"
                    checked={form.roleSyncEnabled ?? false}
                    onChange={(e) => setForm({ ...form, roleSyncEnabled: e.target.checked })}
                  />
                  <span>
                    Sync roles from the directory on every sign-in
                    <span className="block text-[11.5px] text-[var(--text-3)]">
                      Rights are then maintained where joiners and leavers are already
                      handled. Roles an admin assigned by hand are never removed by a sync.
                    </span>
                  </span>
                </label>

                {form.roleSyncEnabled && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pl-6">
                    <div>
                      <label className={labelClass}>Read roles from</label>
                      <AppSelect
                        value={form.roleSyncSource ?? 'GROUPS'}
                        onValueChange={(v) => setForm({ ...form, roleSyncSource: v })}
                        options={[
                          { value: 'GROUPS', label: 'Security / Microsoft 365 groups' },
                          { value: 'APP_ROLES', label: 'Application roles' },
                        ]}
                      />
                      <p className={helpClass}>
                        Groups reuse what the directory already maintains, at the cost of
                        matching on object IDs rather than readable names. Application roles
                        read better but have to be declared in the app manifest first.
                      </p>
                    </div>
                    <div>
                      <label className={labelClass}>When nothing matches</label>
                      <AppSelect
                        value={form.roleSyncFallback ?? 'DENY_ALL'}
                        onValueChange={(v) => setForm({ ...form, roleSyncFallback: v })}
                        options={[
                          { value: 'DENY_ALL', label: 'Grant no tools' },
                          { value: 'KEEP_EXISTING', label: 'Leave existing roles alone' },
                          { value: 'DEFAULT_ROLE', label: 'Grant a default role' },
                        ]}
                      />
                      <p className={helpClass}>
                        &ldquo;Grant no tools&rdquo; is the default deliberately: a user
                        holding no MCP role at all is treated as unrestricted, so the
                        alternative to denying is granting everything.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 text-[13px] text-[var(--text)]">
                <input
                  type="checkbox"
                  className="accent-[var(--brand)]"
                  checked={form.isActive ?? true}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                Active
              </label>

              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving || !form.name.trim() || !form.clientId.trim()}
                >
                  {saving ? 'Saving...' : editingId ? 'Save changes' : 'Create provider'}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {providers.length === 0 && !showForm ? (
            <p className="text-[13px] text-[var(--text-3)] py-6 text-center">
              No identity providers configured. Members sign in with a password.
            </p>
          ) : (
            <div className="space-y-2">
              {providers.map((p) => (
                <div
                  key={p.id}
                  className="rounded-[9px] border border-[var(--border)] p-3"
                >
                 <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-[var(--text)]">{p.name}</span>
                      <Badge tone="neutral">{PROVIDER_TYPES[p.type]?.label ?? p.type}</Badge>
                      {!p.isActive && <Badge tone="warn">Inactive</Badge>}
                      {p.enforceSso && <Badge tone="danger">SSO required</Badge>}
                      {expiringSoon(p) && <Badge tone="danger">Secret expiring</Badge>}
                    </div>
                    <p className="text-[12px] text-[var(--text-3)] mt-1 truncate">{p.issuer}</p>
                    {p.jitProvisioning && (
                      <p className="text-[11.5px] text-[var(--text-3)] mt-0.5">
                        Creates accounts on first sign-in
                      </p>
                    )}
                    {/*
                      The only way an admin can reach this link. Providers are
                      deliberately NOT listed on the public sign-in page in
                      cloud — that would let anyone enumerate which workspaces
                      exist and which directory each belongs to — so without
                      showing it here the configured provider is unreachable.
                    */}
                    <div className="flex items-center gap-2 mt-2">
                      <code className="text-[11.5px] text-[var(--text-2)] bg-[var(--surface-2)] rounded px-1.5 py-0.5 truncate">
                        {signInUrl(p)}
                      </code>
                      <button
                        type="button"
                        className="text-[11.5px] text-[var(--brand)] hover:underline shrink-0"
                        onClick={() => handleCopyLink(p)}
                      >
                        {copiedId === p.id ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="outlineBrand"
                      onClick={() => handleTest(p)}
                      disabled={testing === p.id}
                    >
                      {testing === p.id ? 'Testing...' : 'Test'}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => openEdit(p)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => handleDelete(p)}>
                      Delete
                    </Button>
                  </div>
                 </div>
                 {/*
                   Kept collapsed by default: most workspaces run SSO without
                   role sync, and an always-open editor for a table they do not
                   use is the loudest thing on the page.
                 */}
                 <div className="mt-2 flex items-center gap-4 flex-wrap">
                   <button
                     type="button"
                     className="text-[11.5px] text-[var(--brand)] hover:underline"
                     onClick={() => setMappingsFor(mappingsFor === p.id ? null : p.id)}
                   >
                     {mappingsFor === p.id ? 'Hide role mappings' : 'Role mappings'}
                   </button>
                   <label className="flex items-center gap-2 text-[11.5px] text-[var(--text-2)]">
                     <input
                       type="checkbox"
                       className="accent-[var(--brand)]"
                       checked={p.enforceSso}
                       disabled={enforcing === p.id}
                       onChange={(e) => handleEnforceSso(p, e.target.checked)}
                     />
                     Require single sign-on
                   </label>
                 </div>
                 {mappingsFor === p.id && token && (
                   <RoleMappingsPanel provider={p} token={token} />
                 )}
                </div>
              ))}
            </div>
          )}

          {token && <RecoveryCodesCard token={token} />}
        </Card>
      )}
    </div>
  );
}
