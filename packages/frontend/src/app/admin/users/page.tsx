'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { users, auth, roles } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';

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
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2">Access Denied</h2>
          <p className="text-[var(--muted-foreground)] mb-4">Only administrators can access this page.</p>
          <Link href="/" className="text-[var(--brand)] hover:underline">Back to Dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="User Management"
        actions={
          <button
            onClick={() => setShowInvite(!showInvite)}
            className="bg-[var(--brand)] text-white px-3 py-1.5 rounded text-sm font-medium hover:brightness-90"
          >
            {showInvite ? 'Cancel' : 'Invite User'}
          </button>
        }
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex-1 w-full">
        {msg && (
          <div className="mb-4 p-3 rounded-md bg-[var(--info-bg)] text-[var(--info-text)] text-sm border border-[var(--info-border)]">
            {msg}
            <button onClick={() => setMsg('')} className="ml-2 underline">dismiss</button>
          </div>
        )}

        {/* Invite User Form */}
        {showInvite && (
          <div className="mb-6 border border-[var(--border)] rounded-lg p-6 space-y-4">
            <h3 className="text-lg font-medium">Invite a New User</h3>
            <p className="text-xs text-[var(--muted-foreground)]">
              Send an invitation email. The user will receive a link to create their account with the specified role.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
              <div>
                <label className="block text-sm font-medium mb-1">Email</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">App Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">MCP Tool Role</label>
                <select
                  value={inviteMcpRoleId}
                  onChange={(e) => setInviteMcpRoleId(e.target.value)}
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                >
                  <option value="">No restriction (full access)</option>
                  {roleList.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {inviteUrl && (
              <div className="border border-[var(--success-border)] bg-[var(--success-bg)] rounded-md p-3">
                <p className="text-xs font-medium text-[var(--success-text)] mb-1">
                  SMTP not configured. Share this invitation link manually:
                </p>
                <code className="text-xs font-mono bg-[var(--background)] px-3 py-2 rounded border border-[var(--border)] select-all break-all block">
                  {inviteUrl}
                </code>
              </div>
            )}

            <button
              onClick={handleInvite}
              disabled={inviting || !inviteEmail.trim()}
              className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
            >
              {inviting ? 'Sending...' : 'Send Invitation'}
            </button>
          </div>
        )}

        {loading ? (
          <p className="text-center text-[var(--muted-foreground)] py-16">Loading...</p>
        ) : (
          <div className="border border-[var(--border)] rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--muted)]">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Email</th>
                  <th className="text-left px-4 py-3 font-medium">Name</th>
                  <th className="text-left px-4 py-3 font-medium">Role</th>
                  <th className="text-left px-4 py-3 font-medium">MCP Role</th>
                  <th className="text-left px-4 py-3 font-medium">Joined</th>
                  <th className="text-right px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {userList.map((u) => (
                  <tr key={u.id} className="border-t border-[var(--border)]">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs">{u.email}</span>
                      {u.id === currentUser?.id && (
                        <span className="ml-2 text-xs bg-[var(--brand)] text-white px-1.5 py-0.5 rounded">you</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{u.name || '—'}</td>
                    <td className="px-4 py-3">
                      {u.id === currentUser?.id ? (
                        <span className="text-xs font-medium bg-[var(--muted)] px-2 py-1 rounded">{u.role}</span>
                      ) : (
                        <select
                          value={u.role}
                          onChange={(e) => handleRoleChange(u.id, e.target.value)}
                          className="border border-[var(--input)] rounded px-2 py-1 text-xs bg-[var(--background)]"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {u.role === 'ADMIN' ? (
                        <span className="text-xs text-[var(--muted-foreground)]">Full access</span>
                      ) : u.mcpRole ? (
                        <span className="text-xs bg-[var(--info-bg)] text-[var(--info-text)] px-1.5 py-0.5 rounded">{u.mcpRole.name}</span>
                      ) : (
                        <span className="text-xs text-[var(--muted-foreground)]">Unrestricted</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted-foreground)]">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {u.id !== currentUser?.id && (
                        <button
                          onClick={() => handleDelete(u.id, u.email)}
                          className="border border-[var(--destructive)] text-[var(--destructive)] px-2 py-1 rounded text-xs hover:bg-[var(--destructive-bg)]"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-[var(--muted-foreground)] mt-4">
          {userList.length} user{userList.length !== 1 ? 's' : ''} total.
          The first registered user automatically becomes ADMIN.
        </p>
      </main>
      <Footer />
    </div>
  );
}
