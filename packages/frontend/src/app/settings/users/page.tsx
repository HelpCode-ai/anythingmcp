'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import * as Dialog from '@radix-ui/react-dialog';
import { useAuth } from '@/lib/auth-context';
import {
  users,
  auth,
  roles,
  knowledgeGraph,
  memory as memoryApi,
  type LearningMode,
  type MemoryAccessLevel,
  type MemoryAccessSetting,
} from '@/lib/api';
import { AppSelect } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge, StatusPill } from '@/components/ui/badge';
import { useEdition } from '@/lib/use-edition';
import { EnterpriseNotice } from '@/components/enterprise-notice';

const ROLES = ['ADMIN', 'EDITOR', 'VIEWER'] as const;

type UsersT = ReturnType<typeof useTranslations<'settingsUsers'>>;

function memoryOptions(tu: UsersT, workspaceDefault: MemoryAccessLevel) {
  return [
    { value: 'inherit', label: tu('memoryDefault', { level: workspaceDefault }) },
    { value: 'none', label: tu('memoryLevels.none') },
    { value: 'read', label: tu('memoryLevels.read') },
    { value: 'personal', label: tu('memoryLevels.personal') },
    { value: 'contribute', label: tu('memoryLevels.contribute') },
  ];
}

function learningOptions(tu: UsersT, workspaceDefault: boolean) {
  return [
    { value: 'inherit', label: workspaceDefault ? tu('learningDefaultOn') : tu('learningDefaultOff') },
    { value: 'on', label: tu('on') },
    { value: 'off', label: tu('off') },
  ];
}

function getInvitationStatus(invite: any): 'pending' | 'expired' {
  return new Date(invite.expiresAt) < new Date() ? 'expired' : 'pending';
}

export default function SettingsUsersPage() {
  const { token, user: currentUser } = useAuth();
  const t = useTranslations('settingsUsers');
  const locale = useLocale();
  const [userList, setUserList] = useState<any[]>([]);
  const [invitationList, setInvitationList] = useState<any[]>([]);
  const [roleList, setRoleList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const { edition, reload: reloadEdition } = useEdition();
  const seatsFull =
    edition !== null && edition.seatLimit !== null && edition.seatsUsed >= edition.seatLimit;

  // Invite form
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('EDITOR');
  const [inviteMcpRoleId, setInviteMcpRoleId] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviteEmailError, setInviteEmailError] = useState('');

  // Force re-authentication dialog (per user)
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; email: string } | null>(null);
  const [revokeApiKeys, setRevokeApiKeys] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Skill learning: whose requests may feed AI skill suggestions.
  const [learningDefault, setLearningDefault] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [eraseIntents, setEraseIntents] = useState(false);
  const [learningSaving, setLearningSaving] = useState(false);

  // Workspace memory (Enterprise): what each user's AI clients may do with it.
  const [memoryDefault, setMemoryDefault] = useState<MemoryAccessLevel | null>(null);

  const loadData = async () => {
    if (!token) return;
    try {
      const [userData, roleData, invitationData, kgSettings] = await Promise.all([
        users.list(token),
        roles.list(token).catch(() => []),
        users.invitations(token).catch(() => []),
        knowledgeGraph.getSettings(token).catch(() => null),
      ]);
      memoryApi
        .status(token)
        .then((st) => setMemoryDefault(st.licensed ? st.settings.defaultAccess : null))
        .catch(() => setMemoryDefault(null));
      setUserList(userData);
      setLearningDefault(!!kgSettings?.captureIntent);
      setRoleList(roleData);
      setInvitationList(invitationData);
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [token]);

  const handleRoleChange = async (userId: string, newRole: string) => {
    if (!token) return;
    try {
      await users.updateRole(userId, newRole, token);
      setUserList((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)),
      );
      setMsg(t('roleUpdated', { role: newRole }));
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const handleLearningChange = async (userIds: string[], mode: LearningMode) => {
    if (!token || userIds.length === 0) return;
    setLearningSaving(true);
    try {
      const clearIntents = mode !== 'on' && eraseIntents;
      const result = await knowledgeGraph.learning.setMembers(token, { userIds, mode, clearIntents });
      setUserList((prev) =>
        prev.map((u) => (userIds.includes(u.id) ? { ...u, learningMode: mode } : u)),
      );
      const parts = [t('learningUpdated', { count: userIds.length })];
      if (clearIntents) parts.push(t('requestsErased', { count: result.intentsCleared }));
      setMsg(parts.join(' '));
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    } finally {
      setLearningSaving(false);
    }
  };

  const handleMemoryChange = async (userIds: string[], access: MemoryAccessSetting) => {
    if (!token || userIds.length === 0) return;
    setLearningSaving(true);
    try {
      await memoryApi.setAccess(token, userIds, access);
      setUserList((prev) =>
        prev.map((u) => (userIds.includes(u.id) ? { ...u, memoryAccess: access } : u)),
      );
      setMsg(t('memoryUpdated', { count: userIds.length }));
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    } finally {
      setLearningSaving(false);
    }
  };

  const handleErasePersonalMemory = async (userIds: string[]) => {
    if (
      !token ||
      userIds.length === 0 ||
      !confirm(t('confirmEraseMemory', { count: userIds.length }))
    )
      return;
    try {
      let erased = 0;
      for (const id of userIds) erased += (await memoryApi.erasePersonal(token, id)).erased;
      setMsg(t('memoryErased', { count: erased }));
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const toggleSelected = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleDeactivate = async (userId: string, email: string) => {
    if (
      !token ||
      !confirm(t('confirmDeactivate', { email }))
    )
      return;
    try {
      await users.deactivate(userId, token);
      setUserList((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, active: false, deactivatedAt: new Date().toISOString() } : u)),
      );
      setMsg(t('deactivated'));
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const handleReactivate = async (userId: string) => {
    if (!token) return;
    try {
      await users.reactivate(userId, token);
      setUserList((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, active: true, deactivatedAt: null } : u)),
      );
      setMsg(t('reactivated'));
      reloadEdition();
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const closeRevokeDialog = () => {
    setRevokeTarget(null);
    setRevokeApiKeys(false);
    setRevoking(false);
    setRevokeError(null);
  };

  const handleRevokeSessions = async () => {
    if (!token || !revokeTarget) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      const result = await users.revokeSessions(revokeTarget.id, { revokeApiKeys }, token);
      const parts = [t('signedOut', { email: revokeTarget.email })];
      if (revokeApiKeys) parts.push(t('keysDeactivated', { count: result.apiKeysRevoked }));
      if (result.crossOrgMemberships > 0) {
        parts.push(t('otherWorkspaces', { count: result.crossOrgMemberships }));
      }
      setMsg(parts.join(' '));
      closeRevokeDialog();
    } catch (err: any) {
      setRevokeError(err?.message || t('revokeFailed'));
      setRevoking(false);
    }
  };

  const handleDelete = async (userId: string, email: string) => {
    if (!token || !confirm(t('confirmDelete', { email }))) return;
    try {
      await users.delete(userId, token);
      setUserList((prev) => prev.filter((u) => u.id !== userId));
      setMsg(t('deleted'));
      reloadEdition();
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const handleRevokeInvitation = async (inviteId: string, email: string) => {
    if (!token || !confirm(t('confirmRevokeInvite', { email }))) return;
    try {
      await users.deleteInvitation(inviteId, token);
      setInvitationList((prev) => prev.filter((i) => i.id !== inviteId));
      setMsg(t('inviteRevoked'));
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const handleInvite = async () => {
    if (!token || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteUrl('');
    setInviteEmailError('');
    try {
      const result = await auth.inviteUser(
        {
          email: inviteEmail.trim(),
          role: inviteRole,
          mcpRoleId: inviteMcpRoleId || undefined,
        },
        token,
      );
      setMsg(result.message);
      setInviteUrl(result.inviteUrl);
      if (result.emailError) {
        setInviteEmailError(result.emailError);
      }
      // Reload invitations to show the new one
      users.invitations(token).then(setInvitationList).catch(() => {});
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    } finally {
      setInviting(false);
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

  const inputClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]';
  const labelClass = 'block text-[12.5px] font-medium text-[var(--text-2)] mb-1';
  const selectClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)]';

  return (
    <div className="space-y-6">
      <Dialog.Root open={revokeTarget !== null} onOpenChange={(open) => { if (!open) closeRevokeDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
            <Dialog.Title className="text-base font-semibold text-[var(--text)] mb-2">{t('revokeDialog.title')}</Dialog.Title>
            <Dialog.Description className="text-sm text-[var(--text-2)] mb-4">
              {t.rich('revokeDialog.description', {
                email: revokeTarget?.email ?? '',
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </Dialog.Description>

            <div className="space-y-3">
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
              <Button variant="primary" onClick={handleRevokeSessions} disabled={revoking}>
                {revoking ? t('revokeDialog.signingOut') : t('revokeDialog.submit')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-[var(--text)]">{t('title')}</h2>
          <p className="text-sm text-[var(--text-2)]">
            {t('intro')}
            {edition && edition.seatLimit !== null && (
              <>
                {' '}
                {edition.seatsUsed <= edition.seatLimit
                  ? t('seats', { used: edition.seatsUsed, limit: edition.seatLimit })
                  : t('seatsOver', { used: edition.seatsUsed, limit: edition.seatLimit })}
              </>
            )}
          </p>
        </div>
        <Button size="sm" onClick={() => setShowInvite(!showInvite)} disabled={seatsFull && !showInvite}>
          {showInvite ? t('cancel') : t('inviteUser')}
        </Button>
      </div>

      {msg && (
        <div className="p-3 rounded-[9px] text-sm flex items-center" style={{ background: 'var(--t-info-bg)', color: 'var(--t-info-fg)' }}>
          {msg}
          <button onClick={() => setMsg('')} className="ml-2 underline">{t('dismiss')}</button>
        </div>
      )}

      {seatsFull && edition!.edition === 'community' && (
        <EnterpriseNotice
          edition={edition!}
          title={`Community includes ${edition!.seatLimit} users`}
          body="Everyone here keeps working. To invite more people, choose a paid plan. Single sign-on and SCIM come with Enterprise."
          upgrade="plans"
        />
      )}

      {seatsFull && edition!.edition !== 'community' && (
        <div className="p-3 rounded-[9px] text-sm" style={{ background: 'var(--t-warn-bg)', color: 'var(--t-warn-fg)' }}>
          {t.rich('licenseSeats', {
            limit: edition!.seatLimit!,
            link: (chunks) => <Link href="/settings/license" className="underline font-medium">{chunks}</Link>,
          })}
        </div>
      )}

      {/* Invite User Form */}
      {showInvite && (
        <Card className="p-[22px] space-y-4">
          <h3 className="text-sm font-semibold text-[var(--text)]">{t('invite.title')}</h3>
          <p className="text-xs text-[var(--text-2)]">
            {t('invite.body')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            <div>
              <label className={labelClass}>{t('invite.email')}</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="user@example.com"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>{t('invite.appRole')}</label>
              <AppSelect
                value={inviteRole}
                onValueChange={setInviteRole}
                className={selectClass}
                options={ROLES.map((r) => ({ value: r, label: r }))}
              />
            </div>
            <div>
              <label className={labelClass}>{t('invite.mcpRole')}</label>
              <AppSelect
                value={inviteMcpRoleId}
                onValueChange={setInviteMcpRoleId}
                className={selectClass}
                options={[
                  { value: '', label: t('invite.noRestriction') },
                  ...roleList.map((r) => ({ value: r.id, label: r.name })),
                ]}
              />
            </div>
          </div>

          {inviteUrl && (
            <div className="space-y-2">
              {inviteEmailError && (
                <div className="rounded-[9px] p-3" style={{ background: 'var(--t-danger-bg)', color: 'var(--t-danger-fg)' }}>
                  <p className="text-xs font-medium mb-1">
                    {t('invite.emailFailed')}
                  </p>
                  <p className="text-xs">{inviteEmailError}</p>
                </div>
              )}
              <div className="border border-[var(--border)] bg-[var(--surface-2)] rounded-[9px] p-3">
                <p className="text-xs font-medium text-[var(--text)] mb-1">
                  {t('invite.link')}
                </p>
                <code className="text-xs font-mono bg-[var(--surface)] px-3 py-2 rounded-[9px] border border-[var(--border)] select-all break-all block text-[var(--text)]">
                  {inviteUrl}
                </code>
              </div>
            </div>
          )}

          <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
            {inviting ? t('invite.sending') : t('invite.send')}
          </Button>
        </Card>
      )}

      {selected.size > 0 && (
        <Card className="p-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-[var(--text)]">
            {t('bulk.selected', { count: selected.size })}
          </span>
          {learningOptions(t, learningDefault).map((o) => (
            <Button
              key={o.value}
              variant="secondary"
              size="sm"
              disabled={learningSaving}
              onClick={() => handleLearningChange([...selected], o.value as LearningMode)}
            >
              {o.label}
            </Button>
          ))}
          <label className="flex items-center gap-2 text-xs text-[var(--text-2)]">
            <input
              type="checkbox"
              checked={eraseIntents}
              onChange={(e) => setEraseIntents(e.target.checked)}
            />
            {t('bulk.eraseWhenOff')}
          </label>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs underline text-[var(--text-2)]">
            {t('bulk.clear')}
          </button>
          {memoryDefault && (
            <div className="flex w-full flex-wrap items-center gap-3 border-t border-[var(--border)] pt-3">
              <span className="text-sm font-medium text-[var(--text)]">{t('bulk.memory')}</span>
              {memoryOptions(t, memoryDefault).map((o) => (
                <Button
                  key={o.value}
                  variant="secondary"
                  size="sm"
                  disabled={learningSaving}
                  onClick={() => handleMemoryChange([...selected], o.value as MemoryAccessSetting)}
                >
                  {o.label}
                </Button>
              ))}
              <Button
                variant="danger"
                size="sm"
                className="ml-auto"
                onClick={() => handleErasePersonalMemory([...selected])}
              >
                {t('bulk.eraseMemory')}
              </Button>
            </div>
          )}
        </Card>
      )}

      {loading ? (
        <p className="text-center text-[var(--text-3)] py-16">{t('loading')}</p>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[840px] text-sm">
            <thead className="bg-[var(--surface-2)]">
              <tr className="text-[var(--text-2)]">
                <th className="pl-4 py-3 w-8">
                  <input
                    type="checkbox"
                    aria-label={t('table.selectAll')}
                    checked={userList.length > 0 && selected.size === userList.length}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(userList.map((u) => u.id)) : new Set())
                    }
                  />
                </th>
                <th className="text-left px-4 py-3 font-semibold">{t('table.email')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('table.name')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('table.status')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('table.role')}</th>
                <th className="text-left px-4 py-3 font-semibold">{t('table.mcpRole')}</th>
                <th
                  className="text-left px-4 py-3 font-semibold"
                  title={t('table.learningHint')}
                >
                  {t('table.learning')}
                </th>
                {memoryDefault && (
                  <th
                    className="text-left px-4 py-3 font-semibold"
                    title={t('table.memoryHint')}
                  >
                    {t('table.memory')}
                  </th>
                )}
                <th className="text-left px-4 py-3 font-semibold">{t('table.date')}</th>
                <th className="text-right px-4 py-3 font-semibold">{t('table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {userList.map((u) => (
                <tr key={u.id} className="border-t border-[var(--border)]">
                  <td className="pl-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={t('table.select', { email: u.email })}
                      checked={selected.has(u.id)}
                      onChange={() => toggleSelected(u.id)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-[var(--text)]">{u.email}</span>
                    {u.id === currentUser?.id && (
                      <Badge tone="brand" className="ml-2">{t('table.you')}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[var(--text)]">{u.name || '—'}</td>
                  <td className="px-4 py-3">
                    {u.deactivatedAt ? (
                      <StatusPill tone="danger" dot="var(--danger, #dc2626)">{t('table.deactivated')}</StatusPill>
                    ) : (
                      <StatusPill tone="success" dot="var(--ok)">{t('table.active')}</StatusPill>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.id === currentUser?.id ? (
                      <Badge tone="neutral">{u.role}</Badge>
                    ) : (
                      <AppSelect
                        value={u.role}
                        disabled={Boolean(u.deactivatedAt)}
                        onValueChange={(v) => handleRoleChange(u.id, v)}
                        className="h-8 rounded-[9px] border border-[var(--border)] px-2 text-xs bg-[var(--surface)] text-[var(--text)]"
                        options={ROLES.map((r) => ({ value: r, label: r }))}
                      />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.role === 'ADMIN' ? (
                      <span className="text-xs text-[var(--text-3)]">{t('table.fullAccess')}</span>
                    ) : u.mcpRole ? (
                      <Badge tone="info">{u.mcpRole.name}</Badge>
                    ) : (
                      <span
                        className="text-xs text-[var(--text-3)]"
                        title={t('table.noRoleHint')}
                      >
                        {t('table.noRole')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <AppSelect
                        value={u.learningMode ?? 'inherit'}
                        disabled={learningSaving}
                        onValueChange={(v) => handleLearningChange([u.id], v as LearningMode)}
                        className="h-8 whitespace-nowrap rounded-[9px] border border-[var(--border)] px-2 text-xs bg-[var(--surface)] text-[var(--text)]"
                        options={learningOptions(t, learningDefault)}
                      />
                      {u.learningOptOut && (
                        <Badge tone="neutral" title={t('table.optedOutHint')}>
                          {t('table.optedOut')}
                        </Badge>
                      )}
                    </div>
                  </td>
                  {memoryDefault && (
                    <td className="px-4 py-3">
                      <AppSelect
                        value={u.memoryAccess ?? 'inherit'}
                        disabled={learningSaving}
                        onValueChange={(v) => handleMemoryChange([u.id], v as MemoryAccessSetting)}
                        className="h-8 whitespace-nowrap rounded-[9px] border border-[var(--border)] px-2 text-xs bg-[var(--surface)] text-[var(--text)]"
                        options={memoryOptions(t, memoryDefault)}
                      />
                    </td>
                  )}
                  <td className="px-4 py-3 text-[var(--text-3)]">
                    {new Date(u.createdAt).toLocaleDateString(locale)}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {u.id !== currentUser?.id && (
                      <div className="inline-flex gap-2">
                        {u.deactivatedAt ? (
                          <Button variant="secondary" size="sm" onClick={() => handleReactivate(u.id)}>
                            {t('table.reactivate')}
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              title={t('table.signOutHint')}
                              onClick={() => setRevokeTarget({ id: u.id, email: u.email })}
                            >
                              {t('table.signOut')}
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => handleDeactivate(u.id, u.email)}>
                              {t('table.deactivate')}
                            </Button>
                          </>
                        )}
                        <Button variant="danger" size="sm" onClick={() => handleDelete(u.id, u.email)}>
                          {t('table.delete')}
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {invitationList.map((inv) => {
                const status = getInvitationStatus(inv);
                return (
                  <tr key={`inv-${inv.id}`} className="border-t border-[var(--border)] opacity-75">
                    <td className="pl-4 py-3" />
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-[var(--text)]">{inv.email}</span>
                    </td>
                    <td className="px-4 py-3 text-[var(--text-3)]">—</td>
                    <td className="px-4 py-3">
                      {status === 'pending' ? (
                        <Badge tone="warn">{t('table.pending')}</Badge>
                      ) : (
                        <Badge tone="danger">{t('table.expired')}</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone="neutral">{inv.role}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-[var(--text-3)]">—</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-[var(--text-3)]">{t('table.default')}</span>
                    </td>
                    {memoryDefault && (
                      <td className="px-4 py-3">
                        <span className="text-xs text-[var(--text-3)]">{t('table.default')}</span>
                      </td>
                    )}
                    <td className="px-4 py-3 text-[var(--text-3)]">
                      <span title={t('table.expires', { date: new Date(inv.expiresAt).toLocaleString(locale) })}>
                        {new Date(inv.createdAt).toLocaleDateString(locale)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="danger" size="sm" onClick={() => handleRevokeInvitation(inv.id, inv.email)}>
                        {t('table.revoke')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <p className="text-xs text-[var(--text-3)]">
        {t('footer', { users: userList.length, invites: invitationList.length })}
      </p>
    </div>
  );
}
