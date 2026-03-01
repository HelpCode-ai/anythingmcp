'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { users } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';

const ROLES = ['ADMIN', 'EDITOR', 'VIEWER'] as const;

export default function AdminUsersPage() {
  const { token, user: currentUser } = useAuth();
  const [userList, setUserList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!token) return;
    users
      .list(token)
      .then(setUserList)
      .catch((err) => setMsg(`Error: ${err.message}`))
      .finally(() => setLoading(false));
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

  if (currentUser?.role !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2">Access Denied</h2>
          <p className="text-[var(--muted-foreground)] mb-4">Only administrators can access this page.</p>
          <Link href="/" className="text-[var(--primary)] hover:underline">Back to Dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="User Management"
      />

      <main className="max-w-7xl mx-auto px-6 py-8 flex-1 w-full">
        {msg && (
          <div className="mb-4 p-3 rounded-md bg-[var(--info-bg)] text-[var(--info-text)] text-sm border border-[var(--info-border)]">
            {msg}
            <button onClick={() => setMsg('')} className="ml-2 underline">dismiss</button>
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
                        <span className="ml-2 text-xs bg-[var(--primary)] text-[var(--primary-foreground)] px-1.5 py-0.5 rounded">you</span>
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
