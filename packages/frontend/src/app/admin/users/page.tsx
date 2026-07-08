'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
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
      setMsg(`Error: ${err.message}`);
    } finally {
      setInviting(false);
    }
  };

  if (currentUser?.role !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2 text-[var(--text)]">Access Denied</h2>
          <p className="text-[var(--text-3)] mb-4">Only administrators can access this page.</p>
          <Link href="/" className="text-[var(--brand)] hover:underline">Back to Dashboard</Link>
        </div>
      </div>
    );
  }

  const inputClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)]';

  return (
    <AppShell
      title="User Management"
      actions={
        <Button
          variant={showInvite ? 'secondary' : 'primary'}
          size="sm"
          onClick={() => setShowInvite(!showInvite)}
        >
          {showInvite ? 'Cancel' : 'Invite User'}
        </Button>
      }
    >
      {msg && (
        <div
          className="mb-4 rounded-[9px] border px-3 py-2.5 text-[13px]"
          style={{ background: 'var(--t-info-bg)', color: 'var(--t-info-fg)', borderColor: 'var(--border)' }}
        >
          {msg}
          <button onClick={() => setMsg('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* Invite User Form */}
      {showInvite && (
        <Card className="mb-6 p-6 space-y-4">
          <h3 className="text-[15px] font-semibold text-[var(--text)]">Invite a New User</h3>
          <p className="text-xs text-[var(--text-3)]">
            Send an invitation email. The user will receive a link to create their account with the specified role.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">Email</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="user@example.com"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">App Role</label>
              <AppSelect
                value={inviteRole}
                onValueChange={setInviteRole}
                className={inputClass}
                options={ROLES.map((r) => ({ value: r, label: r }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">MCP Tool Role</label>
              <AppSelect
                value={inviteMcpRoleId}
                onValueChange={setInviteMcpRoleId}
                className={inputClass}
                options={[
                  { value: '', label: 'No restriction (full access)' },
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
                SMTP not configured. Share this invitation link manually:
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
              <tr>
                <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">Email</th>
                <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">Name</th>
                <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">Role</th>
                <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">MCP Role</th>
                <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">Joined</th>
                <th className="text-right px-4 py-3 font-medium text-[var(--text-2)]">Actions</th>
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
                    {u.id === currentUser?.id ? (
                      <Badge tone="neutral">{u.role}</Badge>
                    ) : (
                      <AppSelect
                        value={u.role}
                        onValueChange={(v) => handleRoleChange(u.id, v)}
                        className="h-8 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)]"
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
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleDelete(u.id, u.email)}
                      >
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p className="text-xs text-[var(--text-3)] mt-4">
        {userList.length} user{userList.length !== 1 ? 's' : ''} total.
        The first registered user automatically becomes ADMIN.
      </p>
    </AppShell>
  );
}
