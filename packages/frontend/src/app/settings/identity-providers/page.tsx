'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { useEdition } from '@/lib/use-edition';
import { EnterpriseNotice } from '@/components/enterprise-notice';
import {
  identityProviders,
  roles,
  type IdentityProvider,
  type IdentityProviderInput,
} from '@/lib/api';
import { AppSelect } from '@/components/ui/select';
import { MultiSelect } from '@/components/ui/multi-select';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/toast';
import { RoleMappingsPanel } from './role-mappings';
import { RecoveryCodesCard } from './recovery-codes';
import { ScimPanel } from './scim-panel';

/**
 * Per-type configuration fields.
 *
 * `issuer: true` means the type has no derivable issuer, so the admin must
 * supply one — for the others the server builds it and ignores anything sent,
 * which is what keeps a hostile URL out of the discovery fetch.
 *
 * The type names, hints and field labels are in messages/*.json under
 * `settingsSso.types.<TYPE>`; `hint` and `help` say whether there is one.
 */
const PROVIDER_TYPES: Record<
  string,
  {
    issuer: boolean;
    hint?: boolean;
    fields: { key: string; placeholder: string; help?: boolean }[];
  }
> = {
  ENTRA: {
    issuer: false,
    fields: [{ key: 'tenantId', placeholder: '00000000-0000-0000-0000-000000000000', help: true }],
  },
  GOOGLE: {
    issuer: false,
    fields: [{ key: 'hostedDomain', placeholder: 'example.com', help: true }],
  },
  OKTA: {
    issuer: true,
    hint: true,
    fields: [{ key: 'authorizationServerId', placeholder: 'default' }],
  },
  AUTH0: {
    issuer: true,
    hint: true,
    fields: [{ key: 'rolesClaimNamespace', placeholder: 'https://your-app.example.com/roles', help: true }],
  },
  GITHUB: {
    issuer: false,
    hint: true,
    fields: [{ key: 'organization', placeholder: 'my-org' }],
  },
  OIDC: {
    issuer: true,
    hint: true,
    fields: [{ key: 'groupsClaimName', placeholder: 'groups' }],
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
  roleSyncDefaultRoleIds: [],
});

// True when the client secret runs out within 30 days.
function expiringSoon(p: IdentityProvider): boolean {
  if (!p.clientSecretExpiresAt) return false;
  const days = (new Date(p.clientSecretExpiresAt).getTime() - Date.now()) / 86_400_000;
  return days < 30;
}

export default function IdentityProvidersPage() {
  const t = useTranslations('settingsSso');
  const { token, user: currentUser, deploymentMode, deploymentModeLoaded } = useAuth();
  const toast = useToast();
  // Identity providers are a self-hosted feature: in cloud the API answers
  // 404, so do not even ask — render the explanation instead.
  const isCloud = deploymentMode === 'cloud';
  const { edition } = useEdition();
  // Existing providers stay listed and deletable; setting one up needs Enterprise
  // (a licence, the trial or the transition period: `edition.business`).
  const locked = edition !== null && !edition.business;

  const [providers, setProviders] = useState<IdentityProvider[]>([]);
  const [mcpRoles, setMcpRoles] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [mappingsFor, setMappingsFor] = useState<string | null>(null);
  const [scimFor, setScimFor] = useState<string | null>(null);
  const [enforcing, setEnforcing] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());

  const loadData = async () => {
    // The token is restored from localStorage synchronously, the deployment
    // mode arrives with /health/server-info: wait for it, or cloud would fire
    // the self-hosted-only request (and its error toast) before knowing.
    if (!token || !deploymentModeLoaded) return;
    if (isCloud) {
      setLoading(false);
      return;
    }
    try {
      const [list, roleList] = await Promise.all([
        identityProviders.list(token),
        roles.list(token).catch(() => []),
      ]);
      setProviders(list);
      setMcpRoles(roleList);
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.loadFailed'), description: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isCloud, deploymentModeLoaded]);

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
        t('confirmEnforce'),
      )
    ) {
      return;
    }
    setEnforcing(p.id);
    try {
      await identityProviders.setEnforceSso(p.id, enforce, token);
      toast.show({
        tone: 'success',
        title: enforce ? t('toast.enforced') : t('toast.passwordReenabled'),
      });
      await loadData();
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.enforceFailed'), description: err.message });
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
        toast.show({ tone: 'success', title: t('toast.updated') });
      } else {
        await identityProviders.create(payload, token);
        toast.show({ tone: 'success', title: t('toast.created') });
      }
      setShowForm(false);
      setEditingId(null);
      await loadData();
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.saveFailed'), description: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (p: IdentityProvider) => {
    if (
      !token ||
      !confirm(
        t('confirmDelete', { name: p.name }),
      )
    )
      return;
    try {
      await identityProviders.delete(p.id, token);
      toast.show({ tone: 'success', title: t('toast.deleted') });
      await loadData();
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.deleteFailed'), description: err.message });
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
        title: t('toast.copyFailed'),
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
        title: result.ok ? t('toast.testOk') : t('toast.testFailed'),
        description: result.message,
      });
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.testError'), description: err.message });
    } finally {
      setTesting(null);
    }
  };

  if (currentUser?.role !== 'ADMIN') {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <h2 className="text-xl font-bold text-[var(--text)] mb-2">{t('accessDenied.title')}</h2>
          <p className="text-[var(--text-2)] mb-4">{t('accessDenied.body')}</p>
          <Link href="/settings" className="text-[var(--brand)] hover:underline">{t('accessDenied.back')}</Link>
        </div>
      </div>
    );
  }

  if (isCloud) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center max-w-md">
          <h2 className="text-xl font-bold text-[var(--text)] mb-2">{t('cloud.title')}</h2>
          <p className="text-[var(--text-2)] mb-4">
            {t('cloud.body')}
          </p>
          <Link href="/settings" className="text-[var(--brand)] hover:underline">{t('accessDenied.back')}</Link>
        </div>
      </div>
    );
  }

  // "Grant a default role" with nothing selected is a trap: the backend
  // silently degrades it to "grant no tools". Refuse to save that.
  const defaultRoleMissing =
    Boolean(form.roleSyncEnabled) &&
    form.roleSyncFallback === 'DEFAULT_ROLE' &&
    (form.roleSyncDefaultRoleIds ?? []).length === 0;

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
  return (
    <div className="space-y-6">
      {locked && (
        <EnterpriseNotice
          edition={edition!}
          title="Single sign-on and SCIM are part of AnythingMCP Enterprise"
          body={
            providers.length > 0
              ? 'The providers below keep signing members in. Adding or changing a provider, turning on SCIM or requiring single sign-on needs Enterprise.'
              : 'Connect Entra ID, Google, Okta or any OIDC provider, provision users with SCIM and map directory groups to roles.'
          }
          upgrade="enterprise"
        />
      )}
      {loading ? (
        <p className="text-center text-[var(--text-3)] py-16">{t('loading')}</p>
      ) : (
        <Card className="p-[22px]">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="text-base font-semibold text-[var(--text)]">{t('title')}</h3>
              <p className="text-[13px] text-[var(--text-2)] mt-1 max-w-2xl">
                {t('intro')}
              </p>
            </div>
            <Button size="sm" onClick={showForm ? () => setShowForm(false) : openCreate} disabled={locked && !showForm}>
              {showForm ? t('cancel') : t('add')}
            </Button>
          </div>

          {showForm && (
            <div className="mb-5 p-4 rounded-[9px] bg-[var(--surface-2)] space-y-3">
              <div>
                <label className={labelClass}>{t('form.provider')}</label>
                <div className="max-w-sm">
                  <AppSelect
                    value={form.type}
                    onValueChange={(v) =>
                      // Reset the config: the fields belong to the old type and
                      // would fail validation against the new one.
                      setForm({ ...form, type: v, config: {}, issuer: '' })
                    }
                    options={Object.keys(PROVIDER_TYPES).map((value) => ({
                      value,
                      label: t(`types.${value}.label`),
                    }))}
                    disabled={Boolean(editingId)}
                  />
                </div>
                {editingId && (
                  <p className={helpClass}>
                    {t('form.typeLocked')}
                  </p>
                )}
                {spec.hint && <p className={helpClass}>{t(`types.${form.type}.hint`)}</p>}
              </div>

              <div>
                <label className={labelClass}>{t('form.name')}</label>
                <input
                  className={inputClass}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t('form.namePlaceholder')}
                />
                <p className={helpClass}>{t('form.nameHelp')}</p>
              </div>

              {spec.issuer && (
                <div>
                  <label className={labelClass}>{t('form.issuer')}</label>
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
                  <label className={labelClass}>{t(`types.${form.type}.fields.${f.key}.label`)}</label>
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
                  {f.help && <p className={helpClass}>{t(`types.${form.type}.fields.${f.key}.help`)}</p>}
                </div>
              ))}

              <div>
                <label className={labelClass}>{t('form.clientId')}</label>
                <input
                  className={inputClass}
                  value={form.clientId}
                  onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                />
              </div>

              <div>
                <label className={labelClass}>
                  {t('form.clientSecret')} {editingId && <span className="font-normal">{t('form.keepBlank')}</span>}
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
                    {t('form.secretHidden')}
                  </p>
                )}
              </div>

              <div>
                <label className={labelClass}>{t('form.secretExpires')}</label>
                <input
                  type="date"
                  className={inputClass}
                  value={form.clientSecretExpiresAt ?? ''}
                  onChange={(e) =>
                    setForm({ ...form, clientSecretExpiresAt: e.target.value })
                  }
                />
                <p className={helpClass}>
                  {t('form.secretExpiresHelp')}
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
                  {t('form.jit')}
                  <span className="block text-[11.5px] text-[var(--text-3)]">
                    {t('form.jitHelp')}
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
                    {t('form.roleSync')}
                    <span className="block text-[11.5px] text-[var(--text-3)]">
                      {t('form.roleSyncHelp')}
                    </span>
                  </span>
                </label>

                {form.roleSyncEnabled && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pl-6">
                    <div>
                      <label className={labelClass}>{t('form.source')}</label>
                      <AppSelect
                        value={form.roleSyncSource ?? 'GROUPS'}
                        onValueChange={(v) => setForm({ ...form, roleSyncSource: v })}
                        options={[
                          { value: 'GROUPS', label: t('form.sources.GROUPS') },
                          { value: 'APP_ROLES', label: t('form.sources.APP_ROLES') },
                        ]}
                      />
                      <p className={helpClass}>
                        {t('form.sourceHelp')}
                      </p>
                    </div>
                    <div>
                      <label className={labelClass}>{t('form.fallback')}</label>
                      <AppSelect
                        value={form.roleSyncFallback ?? 'DENY_ALL'}
                        onValueChange={(v) => setForm({ ...form, roleSyncFallback: v })}
                        options={[
                          { value: 'DENY_ALL', label: t('form.fallbacks.DENY_ALL') },
                          { value: 'KEEP_EXISTING', label: t('form.fallbacks.KEEP_EXISTING') },
                          { value: 'DEFAULT_ROLE', label: t('form.fallbacks.DEFAULT_ROLE') },
                        ]}
                      />
                      <p className={helpClass}>
                        {t('form.fallbackHelp')}
                      </p>
                    </div>
                    {form.roleSyncFallback === 'DEFAULT_ROLE' && (
                      <div className="md:col-span-2">
                        <label className={labelClass}>{t('form.defaultRoles')}</label>
                        <MultiSelect
                          value={form.roleSyncDefaultRoleIds ?? []}
                          onValueChange={(ids) => setForm({ ...form, roleSyncDefaultRoleIds: ids })}
                          options={mcpRoles.map((r) => ({ value: r.id, label: r.name }))}
                          placeholder={t('form.defaultRolesPlaceholder')}
                          emptyMessage={t('form.noRoles')}
                          className="max-w-sm"
                        />
                        <p className={helpClass}>
                          {t('form.defaultRolesHelp')}
                        </p>
                      </div>
                    )}
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
                {t('form.active')}
              </label>

              {defaultRoleMissing && (
                <p className="text-[12.5px] text-[var(--danger)]">
                  {t('form.defaultRoleMissing')}
                </p>
              )}
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving || !form.name.trim() || !form.clientId.trim() || defaultRoleMissing}
                >
                  {saving ? t('form.saving') : editingId ? t('form.saveChanges') : t('form.create')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setShowForm(false)}>
                  {t('cancel')}
                </Button>
              </div>
            </div>
          )}

          {providers.length === 0 && !showForm ? (
            <p className="text-[13px] text-[var(--text-3)] py-6 text-center">
              {t('empty')}
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
                      <Badge tone="neutral">{PROVIDER_TYPES[p.type] ? t(`types.${p.type}.label`) : p.type}</Badge>
                      {!p.isActive && <Badge tone="warn">{t('list.inactive')}</Badge>}
                      {p.enforceSso && <Badge tone="danger">{t('list.ssoRequired')}</Badge>}
                      {p.scimEnabled && <Badge tone="neutral">SCIM</Badge>}
                      {expiringSoon(p) && <Badge tone="danger">{t('list.secretExpiring')}</Badge>}
                    </div>
                    <p className="text-[12px] text-[var(--text-3)] mt-1 truncate">{p.issuer}</p>
                    {p.jitProvisioning && (
                      <p className="text-[11.5px] text-[var(--text-3)] mt-0.5">
                        {t('list.jit')}
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
                        {copiedId === p.id ? t('copied') : t('copy')}
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
                      {testing === p.id ? t('list.testing') : t('list.test')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => openEdit(p)}>
                      {t('list.edit')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => handleDelete(p)}>
                      {t('list.delete')}
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
                     {mappingsFor === p.id ? t('list.hideMappings') : t('list.mappings')}
                   </button>
                   {p.type === 'ENTRA' && (
                     <button
                       type="button"
                       className="text-[11.5px] text-[var(--brand)] hover:underline"
                       onClick={() => setScimFor(scimFor === p.id ? null : p.id)}
                     >
                       {scimFor === p.id ? t('list.hideScim') : t('list.scim')}
                     </button>
                   )}
                   <label className="flex items-center gap-2 text-[11.5px] text-[var(--text-2)]">
                     <input
                       type="checkbox"
                       className="accent-[var(--brand)]"
                       checked={p.enforceSso}
                       disabled={enforcing === p.id}
                       onChange={(e) => handleEnforceSso(p, e.target.checked)}
                     />
                     {t('list.enforce')}
                   </label>
                 </div>
                 {mappingsFor === p.id && token && (
                   <RoleMappingsPanel provider={p} token={token} />
                 )}
                 {scimFor === p.id && token && (
                   <ScimPanel provider={p} token={token} onChanged={loadData} />
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
