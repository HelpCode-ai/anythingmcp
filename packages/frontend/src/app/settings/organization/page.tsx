'use client';

import { useState, useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { organizations, knowledgeGraph, type KgSettings } from '@/lib/api';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/badge';

export default function OrganizationSettingsPage() {
  const { token, user, orgName, orgs, setOrgName, switchOrg, replaceSession, logout } = useAuth();
  const t = useTranslations('settingsOrg');
  const locale = useLocale();
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [createdAt, setCreatedAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  // Colours used to come from message.includes('success') and
  // createMessage.includes('created'), which only work in English.
  const [messageIsError, setMessageIsError] = useState(false);

  // Create new org
  const [newOrgName, setNewOrgName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState('');
  const [createMessageIsError, setCreateMessageIsError] = useState(false);

  // Delete organization
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Security: force every member to sign in again
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeConfirmName, setRevokeConfirmName] = useState('');
  const [revokeIncludeSelf, setRevokeIncludeSelf] = useState(true);
  const [revokeApiKeys, setRevokeApiKeys] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeResult, setRevokeResult] = useState<string | null>(null);

  // Knowledge graph feature toggles
  const [kg, setKg] = useState<KgSettings | null>(null);
  const [kgSaving, setKgSaving] = useState(false);

  const isAdmin = user?.role === 'ADMIN';

  useEffect(() => {
    if (!token) return;
    organizations.getCurrent(token).then((org) => {
      setName(org.name);
      setOrgId(org.id);
      setCreatedAt(org.createdAt);
    }).catch(() => {});
    knowledgeGraph.getSettings(token).then(setKg).catch(() => {});
  }, [token]);

  const updateFlag = async (patch: { enabled?: boolean; llmEnabled?: boolean; captureIntent?: boolean; autoExtend?: boolean; skillAutoApply?: boolean; edgeAutoApply?: boolean }) => {
    if (!token || !kg) return;
    setKgSaving(true);
    try {
      setKg(await knowledgeGraph.updateSettings(token, patch));
    } catch {
      /* keep previous state */
    } finally {
      setKgSaving(false);
    }
  };

  const handleSave = async () => {
    if (!token || !name.trim()) return;
    setSaving(true);
    setMessage('');
    try {
      const updated = await organizations.updateCurrent({ name: name.trim() }, token);
      setName(updated.name);
      setOrgName(updated.name);
      setMessageIsError(false);
      setMessage(t('updated'));
    } catch (err: any) {
      setMessageIsError(true);
      setMessage(err.message || t('updateFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteOrg = async () => {
    if (!token) return;
    if (deleteConfirmName.trim() !== name.trim()) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await organizations.deleteCurrent({ confirmName: deleteConfirmName.trim() }, token);
      replaceSession(result.accessToken, result.user, result.organization?.name ?? null);
      window.location.href = '/';
    } catch (err: any) {
      setDeleteError(err?.message || t('deleteFailed'));
      setDeleting(false);
    }
  };

  const resetRevokeDialog = () => {
    setRevokeOpen(false);
    setRevokeConfirmName('');
    setRevokeIncludeSelf(true);
    setRevokeApiKeys(false);
    setRevoking(false);
    setRevokeError(null);
  };

  const handleRevokeWorkspaceSessions = async () => {
    if (!token) return;
    if (revokeConfirmName.trim() !== name.trim()) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      const result = await organizations.revokeSessions(
        { confirmName: revokeConfirmName.trim(), excludeSelf: !revokeIncludeSelf, revokeApiKeys },
        token,
      );
      if (result.selfIncluded) {
        // Our own token is now below the watermark; the next request would
        // 401 anyway. Leave cleanly instead of failing on a later click.
        logout();
        window.location.href = '/login';
        return;
      }
      const parts = [t('membersSignedOut', { count: result.membersAffected })];
      if (result.crossOrgMembersAffected > 0) {
        parts.push(t('crossOrg', { count: result.crossOrgMembersAffected }));
      }
      if (revokeApiKeys) parts.push(t('keysDeactivated', { count: result.apiKeysRevoked }));
      setRevokeResult(parts.join(' '));
      resetRevokeDialog();
    } catch (err: any) {
      setRevokeError(err?.message || t('revokeFailed'));
      setRevoking(false);
    }
  };

  const resetDeleteOrgDialog = () => {
    setDeleteOpen(false);
    setDeleteConfirmName('');
    setDeleteError(null);
    setDeleting(false);
  };

  const handleCreateOrg = async () => {
    if (!token || !newOrgName.trim()) return;
    setCreating(true);
    setCreateMessage('');
    try {
      const newOrg = await organizations.create(newOrgName.trim(), token);
      setCreateMessageIsError(false);
      setCreateMessage(t('created'));
      setNewOrgName('');
      await switchOrg(newOrg.id);
    } catch (err: any) {
      setCreateMessageIsError(true);
      setCreateMessage(err.message || t('createFailed'));
      setCreating(false);
    }
  };

  const inputClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]';
  const inputReadonlyClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text-3)] cursor-not-allowed';
  const labelClass = 'block text-[12.5px] font-medium text-[var(--text-2)] mb-1';

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-[var(--text)]">{t('title')}</h2>
        <p className="text-sm text-[var(--text-2)]">
          {isAdmin
            ? t('introAdmin')
            : t('introMember')}
        </p>
      </div>

      {/* Current organization — editable only for ADMIN */}
      <Card className="p-5 space-y-4">
        <div>
          <label className={labelClass}>{t('name')}</label>
          {isAdmin ? (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              placeholder={t('namePlaceholder')}
            />
          ) : (
            <p className="flex h-9 items-center rounded-[9px] bg-[var(--surface-2)] border border-[var(--border)] px-3 text-sm text-[var(--text-2)]">
              {name}
            </p>
          )}
        </div>

        <div>
          <label className={labelClass}>{t('id')}</label>
          <input
            type="text"
            value={orgId}
            readOnly
            className={inputReadonlyClass}
          />
        </div>

        <div>
          <label className={labelClass}>{t('yourRole')}</label>
          <p className="text-sm text-[var(--text-2)]">{user?.role}</p>
        </div>

        {createdAt && (
          <div>
            <label className={labelClass}>{t('createdAt')}</label>
            <p className="text-sm text-[var(--text-2)]">
              {new Date(createdAt).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
          </div>
        )}

        {message && (
          <p className={`text-sm ${messageIsError ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
            {message}
          </p>
        )}

        {isAdmin && (
          <div className="pt-2">
            <Button onClick={handleSave} disabled={saving || !name.trim()}>
              {saving ? t('saving') : t('save')}
            </Button>
          </div>
        )}
      </Card>

      {/* Features */}
      <Card className="p-5 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--text)]">{t('features.title')}</h3>

        <FeatureToggle
          label={t('features.kg.label')}
          description={t('features.kg.description')}
          checked={!!kg?.enabled}
          disabled={!isAdmin || kgSaving || !kg}
          isAdmin={isAdmin}
          onToggle={() => updateFlag({ enabled: !kg?.enabled })}
        />

        {kg?.llmAvailable && (
          <FeatureToggle
            label={t('features.llm.label')}
            description={t('features.llm.description')}
            checked={!!kg?.llmEnabled}
            disabled={!isAdmin || kgSaving || !kg?.enabled}
            isAdmin={isAdmin}
            onToggle={() => updateFlag({ llmEnabled: !kg?.llmEnabled })}
          />
        )}

        {kg?.llmAvailable && (
          <FeatureToggle
            label={t('features.edgeAutoApply.label')}
            description={t('features.edgeAutoApply.description')}
            checked={!!kg?.edgeAutoApply}
            disabled={!isAdmin || kgSaving || !kg?.enabled || !kg?.llmEnabled}
            isAdmin={isAdmin}
            onToggle={() => updateFlag({ edgeAutoApply: !kg?.edgeAutoApply })}
          />
        )}

        <FeatureToggle
          label={t('features.captureIntent.label')}
          description={t('features.captureIntent.description')}
          checked={!!kg?.captureIntent}
          disabled={!isAdmin || kgSaving || !kg?.enabled}
          isAdmin={isAdmin}
          onToggle={() => updateFlag({ captureIntent: !kg?.captureIntent })}
        />

        {kg?.llmAvailable && (
          <FeatureToggle
            label={t('features.autoExtend.label')}
            description={t('features.autoExtend.description')}
            checked={!!kg?.autoExtend}
            disabled={!isAdmin || kgSaving || !kg?.enabled || !kg?.llmEnabled}
            isAdmin={isAdmin}
            onToggle={() => updateFlag({ autoExtend: !kg?.autoExtend })}
          />
        )}

        {kg?.llmAvailable && (
          <FeatureToggle
            label={t('features.skillAutoApply.label')}
            description={t('features.skillAutoApply.description')}
            checked={!!kg?.skillAutoApply}
            disabled={!isAdmin || kgSaving || !kg?.enabled || !kg?.llmEnabled}
            isAdmin={isAdmin}
            onToggle={() => updateFlag({ skillAutoApply: !kg?.skillAutoApply })}
          />
        )}
      </Card>

      {/* Security — ADMIN only. Reversible actions live here, not in the Danger Zone. */}
      {isAdmin && (
        <Card className="p-5 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--text)]">{t('security.title')}</h3>
          <p className="text-xs text-[var(--text-2)]">
            {t('security.body')}
          </p>
          <Button variant="secondary" onClick={() => { setRevokeResult(null); setRevokeOpen(true); }}>
            {t('security.button')}
          </Button>
          {revokeResult && <p className="text-xs text-[var(--ok)]">{revokeResult}</p>}
        </Card>
      )}

      <Dialog.Root open={revokeOpen} onOpenChange={(open) => { if (!open) resetRevokeDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
            <Dialog.Title className="text-base font-semibold text-[var(--text)] mb-2">{t('revokeDialog.title')}</Dialog.Title>
            <Dialog.Description className="text-sm text-[var(--text-2)] mb-4">
              {t.rich('revokeDialog.description', { name, strong: (chunks) => <strong>{chunks}</strong> })}
            </Dialog.Description>

            <div className="space-y-3">
              <div>
                <label className={labelClass}>
                  {t.rich('revokeDialog.typeConfirm', { name, code: (chunks) => <code className="font-mono">{chunks}</code> })}
                </label>
                <input
                  type="text"
                  value={revokeConfirmName}
                  onChange={(e) => setRevokeConfirmName(e.target.value)}
                  className={inputClass}
                  autoComplete="off"
                  placeholder={name}
                />
              </div>
              <label className="flex items-start gap-2 text-sm text-[var(--text)]">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={revokeIncludeSelf}
                  onChange={(e) => setRevokeIncludeSelf(e.target.checked)}
                />
                <span>
                  {t('revokeDialog.alsoMe')}
                  <span className="block text-xs text-[var(--text-2)]">
                    {t('revokeDialog.alsoMeHint')}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-[var(--text)]">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={revokeApiKeys}
                  onChange={(e) => setRevokeApiKeys(e.target.checked)}
                />
                <span>
                  {t('revokeDialog.alsoKeys')}
                  <span className="block text-xs text-[var(--text-2)]">
                    {t.rich('revokeDialog.alsoKeysHint', { code: (chunks) => <code className="font-mono">{chunks}</code> })}
                  </span>
                </span>
              </label>
              {revokeError && <p className="text-sm text-[var(--danger)]">{revokeError}</p>}
            </div>

            <div className="flex gap-2 justify-end mt-6">
              <Dialog.Close asChild>
                <Button variant="secondary">{t('revokeDialog.cancel')}</Button>
              </Dialog.Close>
              <Button
                variant="primary"
                onClick={handleRevokeWorkspaceSessions}
                disabled={revoking || revokeConfirmName.trim() !== name.trim()}
              >
                {revoking ? t('revokeDialog.signingOut') : t('revokeDialog.submit')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Danger Zone — ADMIN only */}
      {isAdmin && (
        <Card className="p-5 space-y-3 border-[var(--danger)]/30 bg-[var(--t-danger-bg)]">
          <h3 className="text-sm font-semibold text-[var(--danger)]">{t('danger.title')}</h3>
          <p className="text-xs text-[var(--text-2)]">
            {t('danger.body')}
          </p>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            {t('danger.button')}
          </Button>
        </Card>
      )}

      <Dialog.Root open={deleteOpen} onOpenChange={(open) => { if (!open) resetDeleteOrgDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
            <Dialog.Title className="text-base font-semibold text-[var(--text)] mb-2">{t('deleteDialog.title')}</Dialog.Title>
            <Dialog.Description className="text-sm text-[var(--text-2)] mb-4">
              {t.rich('deleteDialog.description', { name, strong: (chunks) => <strong>{chunks}</strong> })}
            </Dialog.Description>

            <div className="space-y-3">
              <div>
                <label className={labelClass}>
                  {t.rich('deleteDialog.typeConfirm', { name, code: (chunks) => <code className="font-mono">{chunks}</code> })}
                </label>
                <input
                  type="text"
                  value={deleteConfirmName}
                  onChange={(e) => setDeleteConfirmName(e.target.value)}
                  className={inputClass}
                  autoComplete="off"
                  placeholder={name}
                />
              </div>
              {deleteError && (
                <p className="text-sm text-[var(--danger)]">{deleteError}</p>
              )}
            </div>

            <div className="flex gap-2 justify-end mt-6">
              <Dialog.Close asChild>
                <Button variant="secondary">{t('deleteDialog.cancel')}</Button>
              </Dialog.Close>
              <Button
                variant="danger"
                onClick={handleDeleteOrg}
                disabled={deleting || deleteConfirmName.trim() !== name.trim()}
              >
                {deleting ? t('deleteDialog.deleting') : t('deleteDialog.submit')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* My organizations list + create new — available to ALL users */}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-[var(--text)]">{t('myOrgs.title')}</h3>
        {orgs && orgs.length > 0 && (
          <div className="mt-3">
            {orgs.map((org, index) => {
              const isActive = org.id === user?.organizationId;
              return (
                <div key={org.id}>
                  {index > 0 && (
                    <div className="border-t border-[var(--border)]" />
                  )}
                  <div className={`flex items-center justify-between px-2 rounded-[9px] ${isActive ? 'bg-[var(--surface-2)] py-[7px] my-[7px]' : 'py-2.5'}`}>
                    <div className="min-w-0">
                      <p className={`text-sm truncate text-[var(--text)] ${isActive ? 'font-medium' : ''}`}>
                        {org.name}
                      </p>
                      <p className="text-xs text-[var(--text-3)]">
                        {t('myOrgs.joined', { role: org.role, date: new Date(org.joinedAt).toLocaleDateString(locale) })}
                      </p>
                    </div>
                    {isActive ? (
                      <StatusPill tone="brand" className="flex-shrink-0">{t('myOrgs.active')}</StatusPill>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => switchOrg(org.id)} className="flex-shrink-0">
                        {t('myOrgs.switch')}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="space-y-2 mt-8">
          <p className="text-xs font-medium text-[var(--text-3)]">{t('myOrgs.createTitle')}</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newOrgName}
              onChange={(e) => setNewOrgName(e.target.value)}
              className="flex-1 h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]"
              placeholder={t('myOrgs.createPlaceholder')}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateOrg(); }}
            />
            <Button onClick={handleCreateOrg} disabled={creating || !newOrgName.trim()} className="sm:flex-shrink-0">
              {creating ? t('myOrgs.creating') : t('myOrgs.create')}
            </Button>
          </div>
          {createMessage && (
            <p className={`text-sm ${createMessageIsError ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
              {createMessage}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

function FeatureToggle({
  label,
  description,
  checked,
  disabled,
  isAdmin,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  isAdmin: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('settingsOrg');
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text)]">{label}</p>
        <p className="text-xs text-[var(--text-2)] mt-0.5">{description}</p>
      </div>
      <button
        onClick={onToggle}
        disabled={disabled}
        role="switch"
        aria-checked={checked}
        title={isAdmin ? '' : t('features.onlyAdmins')}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
          checked ? 'bg-[var(--brand)]' : 'bg-[var(--border-strong)]'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}
