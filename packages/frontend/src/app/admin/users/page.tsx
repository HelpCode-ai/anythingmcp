'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { users, auth, roles } from '@/lib/api';
import { AppSelect } from '@/components/ui/select';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const ROLES = ['ADMIN', 'EDITOR', 'VIEWER'] as const;

export default function AdminUsersPage() {
  const { token, user: currentUser } = useAuth();
  const t = useTranslations('settingsUsers');
  const ta = useTranslations('adminPages');
  const locale = useLocale();
  const [userList, setUserList] = useState<any[]>([]);
  const [roleList, setRoleList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  // Invite form
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('EDITOR');
  const [inviteMcpRoleId, setInviteMcpRoleId] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState('');

  const loadData = async () => {
    if (!token) return;
    try {
      const [userData, roleData] = await Promise.all([
        users.list(token),
        roles.list(token).catch(() => []),
      ]);
      setUserList(userData);
      setRoleList(roleData);
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
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const handleDelete = async (userId: string, email: string) => {
    if (!token || !confirm(t('confirmDelete', { email }))) return;
    try {
      await users.delete(userId, token);
      setUserList((prev) => prev.filter((u) => u.id !== userId));
      setMsg(t('deleted'));
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const handleInvite = async () => {
    if (!token || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteUrl('');
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
      if (result.inviteUrl) {
        setInviteUrl(result.inviteUrl);
      } else {
        setInviteEmail('');
        setInviteRole('EDITOR');
        setInviteMcpRoleId('');
        setShowInvite(false);
      }
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    } finally {
      setInviting(false);
    }
  };

  if (currentUser?.role !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2 text-[var(--text)]">{t('accessDenied.title')}</h2>
          <p className="text-[var(--text-3)] mb-4">{t('accessDenied.body')}</p>
          <Link href="/" className="text-[var(--brand)] hover:underline">{ta('backToDashboard')}</Link>
        </div>
      </div>
    );
  }

  const inputClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)]';

  return (
    <AppShell
      title={t('title')}
      actions={
        <Button
          variant={showInvite ? 'secondary' : 'primary'}
          size="sm"
          onClick={() => setShowInvite(!showInvite)}
        >
          {showInvite ? t('cancel') : t('inviteUser')}
        </Button>
      }
    >
      {msg && (
        <div
          className="mb-4 rounded-[9px] border px-3 py-2.5 text-[13px]"
          style={{ background: 'var(--t-info-bg)', color: 'var(--t-info-fg)', borderColor: 'var(--border)' }}
        >
          {msg}
          <button onClick={() => setMsg('')} className="ml-2 underline">{t('dismiss')}</button>
        </div>
      )}

      {/* Invite User Form */}
      {showInvite && (
        <Card className="mb-6 p-6 space-y-4">
          <h3 className="text-[15px] font-semibold text-[var(--text)]">{t('invite.title')}</h3>
          <p className="text-xs text-[var(--text-3)]">
            {t('invite.body')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">{t('invite.email')}</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="user@example.com"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">{t('invite.appRole')}</label>
              <AppSelect
                value={inviteRole}
                onValueChange={setInviteRole}
                className={inputClass}
                options={ROLES.map((r) => ({ value: r, label: r }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">{t('invite.mcpRole')}</label>
              <AppSelect
                value={inviteMcpRoleId}
                onValueChange={setInviteMcpRoleId}
                className={inputClass}
                options={[
                  { value: '', label: t('invite.noRestriction') },
                  ...roleList.map((r) => ({ value: r.id, label: r.name })),
                ]}
              />
            </div>
          </div>

          {inviteUrl && (
            <div
              className="rounded-[9px] border p-3"
              style={{ background: 'var(--t-success-bg)', color: 'var(--t-success-fg)', borderColor: 'var(--border)' }}
            >
              <p className="text-xs font-medium mb-1">
                {ta('users.inviteNoSmtp')}
              </p>
              <code className="text-xs font-mono bg-[var(--surface)] text-[var(--text)] px-3 py-2 rounded-[9px] border border-[var(--border)] select-all break-all block">
                {inviteUrl}
              </code>
            </div>
          )}

          <Button
            onClick={handleInvite}
            disabled={inviting || !inviteEmail.trim()}
          >
            {inviting ? t('invite.sending') : t('invite.send')}
          </Button>
        </Card>
      )}

      {loading ? (
        <p className="text-center text-[var(--text-3)] py-16">{t('loading')}</p>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[var(--surface-2)]">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">{t('table.email')}</th>
                <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">{t('table.name')}</th>
                <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">{t('table.role')}</th>
                <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">{t('table.mcpRole')}</th>
                <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">{ta('users.joined')}</th>
                <th className="text-right px-4 py-3 font-medium text-[var(--text-2)]">{t('table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {userList.map((u) => (
                <tr key={u.id} className="border-t border-[var(--border)]">
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-[var(--text)]">{u.email}</span>
                    {u.id === currentUser?.id && (
                      <Badge tone="brand" className="ml-2">{t('table.you')}</Badge>
                    )}
                    {u.deactivatedAt && (
                      <Badge tone="danger" className="ml-2">{t('table.deactivated')}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[var(--text)]">{u.name || '—'}</td>
                  <td className="px-4 py-3">
                    {u.id === currentUser?.id ? (
                      <Badge tone="neutral">{u.role}</Badge>
                    ) : (
                      <AppSelect
                        value={u.role}
                        disabled={Boolean(u.deactivatedAt)}
                        onValueChange={(v) => handleRoleChange(u.id, v)}
                        className="h-8 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)]"
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
                      <span className="text-xs text-[var(--text-3)]">{ta('users.unrestricted')}</span>
                    )}
                  </td>
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
                          <Button variant="secondary" size="sm" onClick={() => handleDeactivate(u.id, u.email)}>
                            {t('table.deactivate')}
                          </Button>
                        )}
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleDelete(u.id, u.email)}
                        >
                          {t('table.delete')}
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p className="text-xs text-[var(--text-3)] mt-4">
        {t('footer', { users: userList.length, invites: 0 })}
      </p>
    </AppShell>
  );
}
