'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { roles, connectors, tools as toolsApi, users } from '@/lib/api';

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

export default function SettingsRolesPage() {
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
  const [collapsedConnectors, setCollapsedConnectors] = useState<Set<string>>(new Set());
  const [toolSearch, setToolSearch] = useState('');

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
    setToolSearch('');
    // Auto-collapse all connectors when there are many tools to avoid overflow
    if (allTools.length > 10) {
      const allConnectors = new Set(allTools.map((t) => t.connectorName));
      setCollapsedConnectors(allConnectors);
    } else {
      setCollapsedConnectors(new Set());
    }
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

  // Group tools by connector
  const toolsByConnector = allTools.reduce<Record<string, ToolItem[]>>((acc, tool) => {
    if (!acc[tool.connectorName]) acc[tool.connectorName] = [];
    acc[tool.connectorName].push(tool);
    return acc;
  }, {});
  const connectorNames = Object.keys(toolsByConnector).sort();

  const toggleConnector = (connectorName: string) => {
    setCollapsedConnectors((prev) => {
      const next = new Set(prev);
      if (next.has(connectorName)) next.delete(connectorName);
      else next.add(connectorName);
      return next;
    });
  };

  const selectAllForConnector = (connectorName: string) => {
    const ids = toolsByConnector[connectorName].map((t) => t.id);
    setSelectedToolIds((prev) => [...new Set([...prev, ...ids])]);
  };

  const deselectAllForConnector = (connectorName: string) => {
    const ids = new Set(toolsByConnector[connectorName].map((t) => t.id));
    setSelectedToolIds((prev) => prev.filter((id) => !ids.has(id)));
  };

  const connectorSelectedCount = (connectorName: string) =>
    toolsByConnector[connectorName].filter((t) => selectedToolIds.includes(t.id)).length;

  const filteredToolsByConnector = (connectorName: string) => {
    if (!toolSearch.trim()) return toolsByConnector[connectorName];
    const q = toolSearch.toLowerCase();
    return toolsByConnector[connectorName].filter((t) => t.name.toLowerCase().includes(q));
  };

  if (currentUser?.role !== 'ADMIN') {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2">Access Denied</h2>
          <p className="text-[var(--muted-foreground)] mb-4">Only administrators can access this page.</p>
          <Link href="/settings" className="text-[var(--brand)] hover:underline">Back to Settings</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
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
                className="bg-[var(--brand)] text-white px-3 py-1.5 rounded text-sm font-medium hover:opacity-90"
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
                  className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
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
                          <button onClick={() => handleUpdate(role.id)} className="bg-[var(--brand)] text-white px-3 py-1.5 rounded text-sm hover:opacity-90">Save</button>
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
                            {/* Global actions and search */}
                            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                              <div className="flex gap-3 items-center">
                                <button
                                  onClick={() => setSelectedToolIds(allTools.map((t) => t.id))}
                                  className="text-xs text-[var(--brand)] hover:underline font-medium"
                                >
                                  Select all ({allTools.length})
                                </button>
                                <button
                                  onClick={() => setSelectedToolIds([])}
                                  className="text-xs text-[var(--brand)] hover:underline font-medium"
                                >
                                  Deselect all
                                </button>
                                <span className="text-xs text-[var(--muted-foreground)]">
                                  {selectedToolIds.length}/{allTools.length} selected
                                </span>
                              </div>
                              <input
                                type="text"
                                value={toolSearch}
                                onChange={(e) => setToolSearch(e.target.value)}
                                placeholder="Search tools..."
                                className="border border-[var(--input)] rounded-md px-2.5 py-1 text-xs bg-[var(--background)] w-48"
                              />
                            </div>

                            {/* Connectors accordion */}
                            <div className="max-h-80 overflow-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                              {connectorNames.map((connectorName) => {
                                const tools = filteredToolsByConnector(connectorName);
                                const total = toolsByConnector[connectorName].length;
                                const selected = connectorSelectedCount(connectorName);
                                const isCollapsed = collapsedConnectors.has(connectorName);

                                if (toolSearch.trim() && tools.length === 0) return null;

                                return (
                                  <div key={connectorName}>
                                    {/* Connector header */}
                                    <div className="flex items-center justify-between px-3 py-2.5 bg-[var(--muted)] hover:bg-[var(--accent)] transition-colors">
                                      <button
                                        onClick={() => toggleConnector(connectorName)}
                                        className="flex items-center gap-2 flex-1 text-left"
                                      >
                                        <svg
                                          className={`w-3.5 h-3.5 text-[var(--muted-foreground)] transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                                          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                                        >
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                        </svg>
                                        <span className="text-sm font-medium">{connectorName}</span>
                                        <span className="text-[10px] text-[var(--muted-foreground)] bg-[var(--background)] px-1.5 py-0.5 rounded-full">
                                          {selected}/{total}
                                        </span>
                                      </button>
                                      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                                        <button
                                          onClick={() => selectAllForConnector(connectorName)}
                                          className="text-[10px] text-[var(--brand)] hover:underline"
                                        >
                                          All
                                        </button>
                                        <button
                                          onClick={() => deselectAllForConnector(connectorName)}
                                          className="text-[10px] text-[var(--brand)] hover:underline"
                                        >
                                          None
                                        </button>
                                      </div>
                                    </div>

                                    {/* Tools list */}
                                    {!isCollapsed && (
                                      <div className="px-3 py-2 grid grid-cols-1 sm:grid-cols-2 gap-0.5">
                                        {tools.map((tool) => (
                                          <label
                                            key={tool.id}
                                            className="flex items-center gap-2 text-sm cursor-pointer px-2 py-1.5 rounded hover:bg-[var(--accent)]"
                                          >
                                            <input
                                              type="checkbox"
                                              checked={selectedToolIds.includes(tool.id)}
                                              onChange={() => toggleToolId(tool.id)}
                                              className="shrink-0"
                                            />
                                            <span className="font-mono text-xs truncate">{tool.name}</span>
                                          </label>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        )}
                        <div className="flex gap-2 mt-3">
                          <button
                            onClick={handleSaveToolAccess}
                            disabled={savingTools}
                            className="bg-[var(--brand)] text-white px-4 py-1.5 rounded text-sm font-medium hover:opacity-90 disabled:opacity-50"
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
    </div>
  );
}
