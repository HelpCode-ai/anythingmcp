'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { roles, connectors, tools as toolsApi, users } from '@/lib/api';
import { AppSelect } from '@/components/ui/select';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

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
    'w-full max-w-sm h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)]';

  return (
    <AppShell
      title="MCP Role Management"
    >
      <div className="space-y-6">
        {msg && (
          <div
            className="rounded-[9px] border px-3 py-2.5 text-[13px]"
            style={{ background: 'var(--t-info-bg)', color: 'var(--t-info-fg)', borderColor: 'var(--border)' }}
          >
            {msg}
            <button onClick={() => setMsg('')} className="ml-2 underline">dismiss</button>
          </div>
        )}

        {loading ? (
          <p className="text-center text-[var(--text-3)] py-16">Loading...</p>
        ) : (
          <>
            {/* Roles Section */}
            <Card className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-[15px] font-semibold text-[var(--text)]">Custom Roles</h3>
                  <p className="text-xs text-[var(--text-3)] mt-1">
                    Create roles to control which MCP tools different users can access.
                    Users without a role have full access. ADMIN always has full access.
                  </p>
                </div>
                <Button
                  variant={showCreate ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={() => setShowCreate(!showCreate)}
                >
                  {showCreate ? 'Cancel' : 'Create Role'}
                </Button>
              </div>

              {/* Create Role Form */}
              {showCreate && (
                <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-4 mb-4 space-y-3">
                  <div>
                    <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">Role Name</label>
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="e.g. Read Only, Support Team"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">Description</label>
                    <input
                      type="text"
                      value={newDesc}
                      onChange={(e) => setNewDesc(e.target.value)}
                      placeholder="What this role is for..."
                      className={inputClass}
                    />
                  </div>
                  <Button onClick={handleCreate} disabled={!newName.trim()}>
                    Create
                  </Button>
                </div>
              )}

              {/* Role List */}
              {roleList.length === 0 ? (
                <p className="text-sm text-[var(--text-3)] text-center py-4">
                  No custom roles yet. Create one to start restricting tool access.
                </p>
              ) : (
                <div className="space-y-3">
                  {roleList.map((role) => (
                    <div key={role.id} className="rounded-[9px] border border-[var(--border)] p-4">
                      {editingId === role.id ? (
                        <div className="space-y-3">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className={inputClass}
                          />
                          <input
                            type="text"
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            placeholder="Description"
                            className={inputClass}
                          />
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => handleUpdate(role.id)}>Save</Button>
                            <Button variant="secondary" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm text-[var(--text)]">{role.name}</span>
                              {role.isSystem && (
                                <Badge tone="neutral">system</Badge>
                              )}
                            </div>
                            {role.description && (
                              <p className="text-xs text-[var(--text-3)] mt-0.5">{role.description}</p>
                            )}
                            <div className="flex gap-4 mt-1 text-xs text-[var(--text-3)]">
                              <span>{role._count.users} user{role._count.users !== 1 ? 's' : ''}</span>
                              <span>{role._count.toolAccess} tool{role._count.toolAccess !== 1 ? 's' : ''} assigned</span>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="outlineBrand"
                              size="sm"
                              onClick={() => handleManageTools(role.id)}
                            >
                              Manage Tools
                            </Button>
                            {!role.isSystem && (
                              <>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => { setEditingId(role.id); setEditName(role.name); setEditDesc(role.description || ''); }}
                                >
                                  Edit
                                </Button>
                                <Button
                                  variant="danger"
                                  size="sm"
                                  onClick={() => handleDelete(role.id, role.name)}
                                >
                                  Delete
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Tool Access Manager */}
                      {managingToolsForRole === role.id && (
                        <div className="mt-4 pt-4 border-t border-[var(--border)]">
                          <h4 className="text-sm font-medium mb-2 text-[var(--text)]">
                            Select tools this role can access
                          </h4>
                          <p className="text-xs text-[var(--text-3)] mb-3">
                            Only checked tools will be available to users with this role.
                            If no tools are selected, the role has no MCP tool access.
                          </p>
                          {allTools.length === 0 ? (
                            <p className="text-xs text-[var(--text-3)]">No tools available. Create connectors and tools first.</p>
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
                                  <label key={tool.id} className="flex items-center gap-2 text-sm cursor-pointer p-1.5 rounded-[9px] hover:bg-[var(--surface-2)]">
                                    <input
                                      type="checkbox"
                                      checked={selectedToolIds.includes(tool.id)}
                                      onChange={() => toggleToolId(tool.id)}
                                    />
                                    <div className="min-w-0">
                                      <span className="font-mono text-xs text-[var(--text)]">{tool.name}</span>
                                      <span className="text-[10px] text-[var(--text-3)] ml-1">({tool.connectorName})</span>
                                    </div>
                                  </label>
                                ))}
                              </div>
                            </>
                          )}
                          <div className="flex gap-2 mt-3">
                            <Button
                              size="sm"
                              onClick={handleSaveToolAccess}
                              disabled={savingTools}
                            >
                              {savingTools ? 'Saving...' : `Save (${selectedToolIds.length} tools)`}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setManagingToolsForRole(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* User MCP Role Assignment */}
            <Card className="p-6">
              <div className="mb-4">
                <h3 className="text-[15px] font-semibold text-[var(--text)]">User MCP Role Assignment</h3>
                <p className="text-xs text-[var(--text-3)] mt-1">
                  Assign MCP roles to users to control which tools they can access via MCP.
                  Users without a role have unrestricted access. ADMIN users always have full access.
                </p>
              </div>

              <div className="rounded-[9px] border border-[var(--border)] overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--surface-2)]">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">User</th>
                      <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">App Role</th>
                      <th className="text-left px-4 py-3 font-medium text-[var(--text-2)]">MCP Tool Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userList.map((u) => (
                      <tr key={u.id} className="border-t border-[var(--border)]">
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs text-[var(--text)]">{u.email}</span>
                          {u.name && <span className="text-xs text-[var(--text-3)] ml-2">{u.name}</span>}
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone="neutral">{u.role}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          {u.role === 'ADMIN' ? (
                            <span className="text-xs text-[var(--text-3)]">Full access (admin)</span>
                          ) : (
                            <AppSelect
                              value={u.mcpRoleId || ''}
                              onValueChange={(v) => handleAssignRole(u.id, v || null)}
                              className="h-8 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)]"
                              options={[
                                { value: '', label: 'No restriction (full access)' },
                                ...roleList.map((r) => ({ value: r.id, label: r.name })),
                              ]}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
