'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { users, auth, roles } from '@/lib/api';
import { AppSelect } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge, StatusPill } from '@/components/ui/badge';

const ROLES = ['ADMIN', 'EDITOR', 'VIEWER'] as const;

function getInvitationStatus(invite: any): 'pending' | 'expired' {
  return new Date(invite.expiresAt) < new Date() ? 'expired' : 'pending';
}

export default function SettingsUsersPage() {
  const { token, user: currentUser } = useAuth();
  const [userList, setUserList] = useState<any[]>([]);
  const [invitationList, setInvitationList] = useState<any[]>([]);
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
  const [inviteEmailError, setInviteEmailError] = useState('');

  const loadData = async () => {
    if (!token) return;
    try {
      const [userData, roleData, invitationData] = await Promise.all([
        users.list(token),
        roles.list(token).catch(() => []),
        users.invitations(token).catch(() => []),
      ]);
      setUserList(userData);
      setRoleList(roleData);
      setInvitationList(invitationData);
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
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
      setMsg(`Role updated to ${newRole}`);
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const handleDelete = async (userId: string, email: string) => {
    if (!token || !confirm(`Delete user ${email}? This cannot be undone.`)) return;
    try {
      await users.delete(userId, token);
      setUserList((prev) => prev.filter((u) => u.id !== userId));
      setMsg('User deleted');
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const handleRevokeInvitation = async (inviteId: string, email: string) => {
    if (!token || !confirm(`Revoke invitation for ${email}?`)) return;
    try {
      await users.deleteInvitation(inviteId, token);
      setInvitationList((prev) => prev.filter((i) => i.id !== inviteId));
      setMsg('Invitation revoked');
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
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
      setMsg(`Error: ${err.message}`);
    } finally {
      setInviting(false);
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
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]';
  const labelClass = 'block text-[12.5px] font-medium text-[var(--text-2)] mb-1';
  const selectClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)]';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-[var(--text)]">User Management</h2>
          <p className="text-sm text-[var(--text-2)]">Manage users and send invitations.</p>
        </div>
        <Button size="sm" onClick={() => setShowInvite(!showInvite)}>
          {showInvite ? 'Cancel' : 'Invite User'}
        </Button>
      </div>

      {msg && (
        <div className="p-3 rounded-[9px] text-sm flex items-center" style={{ background: 'var(--t-info-bg)', color: 'var(--t-info-fg)' }}>
          {msg}
          <button onClick={() => setMsg('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* Invite User Form */}
      {showInvite && (
        <Card className="p-[22px] space-y-4">
          <h3 className="text-sm font-semibold text-[var(--text)]">Invite a New User</h3>
          <p className="text-xs text-[var(--text-2)]">
            Send an invitation email. The user will receive a link to create their account with the specified role.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            <div>
              <label className={labelClass}>Email</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="user@example.com"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>App Role</label>
              <AppSelect
                value={inviteRole}
                onValueChange={setInviteRole}
                className={selectClass}
                options={ROLES.map((r) => ({ value: r, label: r }))}
              />
            </div>
            <div>
              <label className={labelClass}>MCP Tool Role</label>
              <AppSelect
                value={inviteMcpRoleId}
                onValueChange={setInviteMcpRoleId}
                className={selectClass}
                options={[
                  { value: '', label: 'No restriction (full access)' },
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
                    Failed to send email:
                  </p>
                  <p className="text-xs">{inviteEmailError}</p>
                </div>
              )}
              <div className="border border-[var(--border)] bg-[var(--surface-2)] rounded-[9px] p-3">
                <p className="text-xs font-medium text-[var(--text)] mb-1">
                  Invitation link (share manually):
                </p>
                <code className="text-xs font-mono bg-[var(--surface)] px-3 py-2 rounded-[9px] border border-[var(--border)] select-all break-all block text-[var(--text)]">
                  {inviteUrl}
                </code>
              </div>
            </div>
          )}

          <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
            {inviting ? 'Sending...' : 'Send Invitation'}
          </Button>
        </Card>
      )}

      {loading ? (
        <p className="text-center text-[var(--text-3)] py-16">Loading...</p>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--surface-2)]">
              <tr className="text-[var(--text-2)]">
                <th className="text-left px-4 py-3 font-semibold">Email</th>
                <th className="text-left px-4 py-3 font-semibold">Name</th>
                <th className="text-left px-4 py-3 font-semibold">Status</th>
                <th className="text-left px-4 py-3 font-semibold">Role</th>
                <th className="text-left px-4 py-3 font-semibold">MCP Role</th>
                <th className="text-left px-4 py-3 font-semibold">Date</th>
                <th className="text-right px-4 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {userList.map((u) => (
                <tr key={u.id} className="border-t border-[var(--border)]">
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-[var(--text)]">{u.email}</span>
                    {u.id === currentUser?.id && (
                      <Badge tone="brand" className="ml-2">you</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[var(--text)]">{u.name || '—'}</td>
                  <td className="px-4 py-3">
                    <StatusPill tone="success" dot="var(--ok)">Active</StatusPill>
                  </td>
                  <td className="px-4 py-3">
                    {u.id === currentUser?.id ? (
                      <Badge tone="neutral">{u.role}</Badge>
                    ) : (
                      <AppSelect
                        value={u.role}
                        onValueChange={(v) => handleRoleChange(u.id, v)}
                        className="h-8 rounded-[9px] border border-[var(--border)] px-2 text-xs bg-[var(--surface)] text-[var(--text)]"
                        options={ROLES.map((r) => ({ value: r, label: r }))}
                      />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.role === 'ADMIN' ? (
                      <span className="text-xs text-[var(--text-3)]">Full access</span>
                    ) : u.mcpRole ? (
                      <Badge tone="info">{u.mcpRole.name}</Badge>
                    ) : (
                      <span className="text-xs text-[var(--text-3)]">Unrestricted</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[var(--text-3)]">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {u.id !== currentUser?.id && (
                      <Button variant="danger" size="sm" onClick={() => handleDelete(u.id, u.email)}>
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {invitationList.map((inv) => {
                const status = getInvitationStatus(inv);
                return (
                  <tr key={`inv-${inv.id}`} className="border-t border-[var(--border)] opacity-75">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-[var(--text)]">{inv.email}</span>
                    </td>
                    <td className="px-4 py-3 text-[var(--text-3)]">—</td>
                    <td className="px-4 py-3">
                      {status === 'pending' ? (
                        <Badge tone="warn">Pending</Badge>
                      ) : (
                        <Badge tone="danger">Expired</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone="neutral">{inv.role}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-[var(--text-3)]">—</span>
                    </td>
                    <td className="px-4 py-3 text-[var(--text-3)]">
                      <span title={`Expires: ${new Date(inv.expiresAt).toLocaleString()}`}>
                        {new Date(inv.createdAt).toLocaleDateString()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="danger" size="sm" onClick={() => handleRevokeInvitation(inv.id, inv.email)}>
                        Revoke
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
        {userList.length} user{userList.length !== 1 ? 's' : ''}
        {invitationList.length > 0 && (
          <>, {invitationList.length} pending invitation{invitationList.length !== 1 ? 's' : ''}</>
        )}
        {' '}total.
        The first registered user automatically becomes ADMIN.
      </p>
    </div>
  );
}
