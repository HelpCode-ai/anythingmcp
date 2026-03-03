'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { roles, connectors, tools as toolsApi, users } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';

interface RoleItem {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  _count: { users: number; toolAccess: number };
}

interface ToolItem {
  id: string;
  name: string;
  connectorName: string;
}

interface UserItem {
  id: string;
  email: string;
  name: string | null;
  role: string;
  mcpRoleId: string | null;
  mcpRole: { id: string; name: string } | null;
}

export default function AdminRolesPage() {
  const { token, user: currentUser } = useAuth();
  const [roleList, setRoleList] = useState<RoleItem[]>([]);
  const [allTools, setAllTools] = useState<ToolItem[]>([]);
  const [userList, setUserList] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  // Create role
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  // Edit role
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  // Tool access
  const [managingToolsForRole, setManagingToolsForRole] = useState<string | null>(null);
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [savingTools, setSavingTools] = useState(false);

  // User assignment
  const [assigningUser, setAssigningUser] = useState(false);

  const loadData = async () => {
    if (!token) return;
    try {
      const [roleData, connectorData, userData] = await Promise.all([
        roles.list(token),
        connectors.list(token),
        users.list(token),
      ]);
      setRoleList(roleData);
      setUserList(userData);

      // Flatten all tools from connectors
      const allToolsList: ToolItem[] = [];
      for (const c of connectorData) {
        const t = await toolsApi.list(c.id, token);
        for (const tool of t) {
          allToolsList.push({ id: tool.id, name: tool.name, connectorName: c.name });
        }
      }
      setAllTools(allToolsList);
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [token]);

  const handleCreate = async () => {
    if (!token || !newName.trim()) return;
    try {
      await roles.create({ name: newName.trim(), description: newDesc.trim() || undefined }, token);
      setNewName('');
      setNewDesc('');
      setShowCreate(false);
      setMsg('Role created');
      loadData();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const handleUpdate = async (id: string) => {
    if (!token) return;
    try {
      await roles.update(id, { name: editName, description: editDesc || undefined }, token);
      setEditingId(null);
      setMsg('Role updated');
      loadData();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!token || !confirm(`Delete role "${name}"? Users with this role will be unassigned.`)) return;
    try {
      await roles.delete(id, token);
      setMsg('Role deleted');
      loadData();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const handleManageTools = async (roleId: string) => {
    if (!token) return;
    setManagingToolsForRole(roleId);
    try {
      const access = await roles.getToolAccess(roleId, token);
      setSelectedToolIds(access.map((a: any) => a.tool.id));
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const handleSaveToolAccess = async () => {
    if (!token || !managingToolsForRole) return;
    setSavingTools(true);
    try {
      await roles.setToolAccess(managingToolsForRole, selectedToolIds, token);
      setManagingToolsForRole(null);
      setMsg('Tool access updated');
      loadData();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setSavingTools(false);
    }
  };

  const handleAssignRole = async (userId: string, roleId: string | null) => {
    if (!token) return;
    try {
      await roles.assignToUser(userId, roleId, token);
      setUserList((prev) =>
        prev.map((u) =>
          u.id === userId
            ? { ...u, mcpRoleId: roleId, mcpRole: roleId ? roleList.find((r) => r.id === roleId) ? { id: roleId, name: roleList.find((r) => r.id === roleId)!.name } : null : null }
            : u,
        ),
      );
      setMsg('MCP role assigned');
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const toggleToolId = (toolId: string) => {
    setSelectedToolIds((prev) =>
      prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [...prev, toolId],
    );
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
        title="MCP Role Management"
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex-1 w-full space-y-6">
        {msg && (
          <div className="p-3 rounded-md bg-[var(--info-bg)] text-[var(--info-text)] text-sm border border-[var(--info-border)]">
            {msg}
            <button onClick={() => setMsg('')} className="ml-2 underline">dismiss</button>
          </div>
        )}

        {loading ? (
          <p className="text-center text-[var(--muted-foreground)] py-16">Loading...</p>
        ) : (
          <>
            {/* Roles Section */}
            <div className="border border-[var(--border)] rounded-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-medium">Custom Roles</h3>
                  <p className="text-xs text-[var(--muted-foreground)] mt-1">
                    Create roles to control which MCP tools different users can access.
                    Users without a role have full access. ADMIN always has full access.
                  </p>
                </div>
                <button
                  onClick={() => setShowCreate(!showCreate)}
                  className="bg-[var(--brand)] text-white px-3 py-1.5 rounded text-sm font-medium hover:brightness-90"
                >
                  {showCreate ? 'Cancel' : 'Create Role'}
                </button>
              </div>

              {/* Create Role Form */}
              {showCreate && (
                <div className="border border-[var(--border)] rounded-md p-4 mb-4 space-y-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">Role Name</label>
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="e.g. Read Only, Support Team"
                      className="w-full max-w-sm border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Description</label>
                    <input
                      type="text"
                      value={newDesc}
                      onChange={(e) => setNewDesc(e.target.value)}
                      placeholder="What this role is for..."
                      className="w-full max-w-sm border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                    />
                  </div>
                  <button
                    onClick={handleCreate}
                    disabled={!newName.trim()}
                    className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
                  >
                    Create
                  </button>
                </div>
              )}

              {/* Role List */}
              {roleList.length === 0 ? (
                <p className="text-sm text-[var(--muted-foreground)] text-center py-4">
                  No custom roles yet. Create one to start restricting tool access.
                </p>
              ) : (
                <div className="space-y-3">
                  {roleList.map((role) => (
                    <div key={role.id} className="border border-[var(--border)] rounded-md p-4">
                      {editingId === role.id ? (
                        <div className="space-y-3">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full max-w-sm border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                          />
                          <input
                            type="text"
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            placeholder="Description"
                            className="w-full max-w-sm border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                          />
                          <div className="flex gap-2">
                            <button onClick={() => handleUpdate(role.id)} className="bg-[var(--brand)] text-white px-3 py-1.5 rounded text-sm hover:brightness-90">Save</button>
                            <button onClick={() => setEditingId(null)} className="border border-[var(--border)] px-3 py-1.5 rounded text-sm hover:bg-[var(--accent)]">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{role.name}</span>
                              {role.isSystem && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--muted)] text-[var(--muted-foreground)]">system</span>
                              )}
                            </div>
                            {role.description && (
                              <p className="text-xs text-[var(--muted-foreground)] mt-0.5">{role.description}</p>
                            )}
                            <div className="flex gap-4 mt-1 text-xs text-[var(--muted-foreground)]">
                              <span>{role._count.users} user{role._count.users !== 1 ? 's' : ''}</span>
                              <span>{role._count.toolAccess} tool{role._count.toolAccess !== 1 ? 's' : ''} assigned</span>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleManageTools(role.id)}
                              className="border border-[var(--brand)] text-[var(--brand)] px-2 py-1 rounded text-xs hover:bg-[var(--brand-light)]"
                            >
                              Manage Tools
                            </button>
                            {!role.isSystem && (
                              <>
                                <button
                                  onClick={() => { setEditingId(role.id); setEditName(role.name); setEditDesc(role.description || ''); }}
                                  className="border border-[var(--border)] px-2 py-1 rounded text-xs hover:bg-[var(--accent)]"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => handleDelete(role.id, role.name)}
                                  className="border border-[var(--destructive)] text-[var(--destructive)] px-2 py-1 rounded text-xs hover:bg-[var(--destructive-bg)]"
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Tool Access Manager */}
                      {managingToolsForRole === role.id && (
                        <div className="mt-4 pt-4 border-t border-[var(--border)]">
                          <h4 className="text-sm font-medium mb-2">
                            Select tools this role can access
                          </h4>
                          <p className="text-xs text-[var(--muted-foreground)] mb-3">
                            Only checked tools will be available to users with this role.
                            If no tools are selected, the role has no MCP tool access.
                          </p>
                          {allTools.length === 0 ? (
                            <p className="text-xs text-[var(--muted-foreground)]">No tools available. Create connectors and tools first.</p>
                          ) : (
                            <>
                              <div className="flex gap-2 mb-3">
                                <button
                                  onClick={() => setSelectedToolIds(allTools.map((t) => t.id))}
                                  className="text-xs text-[var(--brand)] hover:underline"
                                >
                                  Select all
                                </button>
                                <button
                                  onClick={() => setSelectedToolIds([])}
                                  className="text-xs text-[var(--brand)] hover:underline"
                                >
                                  Deselect all
                                </button>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-60 overflow-auto">
                                {allTools.map((tool) => (
                                  <label key={tool.id} className="flex items-center gap-2 text-sm cursor-pointer p-1.5 rounded hover:bg-[var(--accent)]">
                                    <input
                                      type="checkbox"
                                      checked={selectedToolIds.includes(tool.id)}
                                      onChange={() => toggleToolId(tool.id)}
                                    />
                                    <div className="min-w-0">
                                      <span className="font-mono text-xs">{tool.name}</span>
                                      <span className="text-[10px] text-[var(--muted-foreground)] ml-1">({tool.connectorName})</span>
                                    </div>
                                  </label>
                                ))}
                              </div>
                            </>
                          )}
                          <div className="flex gap-2 mt-3">
                            <button
                              onClick={handleSaveToolAccess}
                              disabled={savingTools}
                              className="bg-[var(--brand)] text-white px-4 py-1.5 rounded text-sm font-medium hover:brightness-90 disabled:opacity-50"
                            >
                              {savingTools ? 'Saving...' : `Save (${selectedToolIds.length} tools)`}
                            </button>
                            <button
                              onClick={() => setManagingToolsForRole(null)}
                              className="border border-[var(--border)] px-3 py-1.5 rounded text-sm hover:bg-[var(--accent)]"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* User MCP Role Assignment */}
            <div className="border border-[var(--border)] rounded-lg p-6">
              <div className="mb-4">
                <h3 className="text-lg font-medium">User MCP Role Assignment</h3>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">
                  Assign MCP roles to users to control which tools they can access via MCP.
                  Users without a role have unrestricted access. ADMIN users always have full access.
                </p>
              </div>

              <div className="border border-[var(--border)] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--muted)]">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium">User</th>
                      <th className="text-left px-4 py-3 font-medium">App Role</th>
                      <th className="text-left px-4 py-3 font-medium">MCP Tool Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userList.map((u) => (
                      <tr key={u.id} className="border-t border-[var(--border)]">
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs">{u.email}</span>
                          {u.name && <span className="text-xs text-[var(--muted-foreground)] ml-2">{u.name}</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs font-medium bg-[var(--muted)] px-2 py-1 rounded">{u.role}</span>
                        </td>
                        <td className="px-4 py-3">
                          {u.role === 'ADMIN' ? (
                            <span className="text-xs text-[var(--muted-foreground)]">Full access (admin)</span>
                          ) : (
                            <select
                              value={u.mcpRoleId || ''}
                              onChange={(e) => handleAssignRole(u.id, e.target.value || null)}
                              className="border border-[var(--input)] rounded px-2 py-1 text-xs bg-[var(--background)]"
                            >
                              <option value="">No restriction (full access)</option>
                              {roleList.map((r) => (
                                <option key={r.id} value={r.id}>{r.name}</option>
                              ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
