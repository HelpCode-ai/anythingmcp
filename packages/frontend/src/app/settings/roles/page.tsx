'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { roles, connectors, tools as toolsApi, users } from '@/lib/api';
import { AppSelect } from '@/components/ui/select';
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

export default function SettingsRolesPage() {
  const t = useTranslations('settingsRoles');
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
        const list = await toolsApi.list(c.id, token);
        for (const tool of list) {
          allToolsList.push({ id: tool.id, name: tool.name, connectorName: c.name });
        }
      }
      setAllTools(allToolsList);
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
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
      setMsg(t('created'));
      loadData();
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const handleUpdate = async (id: string) => {
    if (!token) return;
    try {
      await roles.update(id, { name: editName, description: editDesc || undefined }, token);
      setEditingId(null);
      setMsg(t('updated'));
      loadData();
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!token || !confirm(t('confirmDelete', { name }))) return;
    try {
      await roles.delete(id, token);
      setMsg(t('deleted'));
      loadData();
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const handleManageTools = async (roleId: string) => {
    if (!token) return;
    setManagingToolsForRole(roleId);
    setToolSearch('');
    // Auto-collapse all connectors when there are many tools to avoid overflow
    if (allTools.length > 10) {
      const allConnectors = new Set(allTools.map((x) => x.connectorName));
      setCollapsedConnectors(allConnectors);
    } else {
      setCollapsedConnectors(new Set());
    }
    try {
      const access = await roles.getToolAccess(roleId, token);
      setSelectedToolIds(access.map((a: any) => a.tool.id));
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
    }
  };

  const handleSaveToolAccess = async () => {
    if (!token || !managingToolsForRole) return;
    setSavingTools(true);
    try {
      await roles.setToolAccess(managingToolsForRole, selectedToolIds, token);
      setManagingToolsForRole(null);
      setMsg(t('toolAccessUpdated'));
      loadData();
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
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
      setMsg(t('assigned'));
    } catch (err: any) {
      setMsg(t('error', { message: err.message }));
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
    const ids = toolsByConnector[connectorName].map((x) => x.id);
    setSelectedToolIds((prev) => [...new Set([...prev, ...ids])]);
  };

  const deselectAllForConnector = (connectorName: string) => {
    const ids = new Set(toolsByConnector[connectorName].map((x) => x.id));
    setSelectedToolIds((prev) => prev.filter((id) => !ids.has(id)));
  };

  const connectorSelectedCount = (connectorName: string) =>
    toolsByConnector[connectorName].filter((x) => selectedToolIds.includes(x.id)).length;

  const filteredToolsByConnector = (connectorName: string) => {
    if (!toolSearch.trim()) return toolsByConnector[connectorName];
    const q = toolSearch.toLowerCase();
    return toolsByConnector[connectorName].filter((x) => x.name.toLowerCase().includes(q));
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
    'w-full max-w-sm h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]';
  const labelClass = 'block text-[12.5px] font-medium text-[var(--text-2)] mb-1';

  return (
    <div className="space-y-6">
      {msg && (
        <div className="p-3 rounded-[9px] text-sm flex items-center" style={{ background: 'var(--t-info-bg)', color: 'var(--t-info-fg)' }}>
          {msg}
          <button onClick={() => setMsg('')} className="ml-2 underline">{t('dismiss')}</button>
        </div>
      )}

      {loading ? (
        <p className="text-center text-[var(--text-3)] py-16">{t('loading')}</p>
      ) : (
        <>
          {/* Roles Section */}
          <Card className="p-[22px]">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text)]">{t('title')}</h3>
                <p className="text-xs text-[var(--text-2)] mt-1">
                  {t('intro')}
                </p>
              </div>
              <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
                {showCreate ? t('cancel') : t('createRole')}
              </Button>
            </div>

            {/* Create Role Form */}
            {showCreate && (
              <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-4 mb-4 space-y-3">
                <div>
                  <label className={labelClass}>{t('form.name')}</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t('form.namePlaceholder')}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>{t('form.description')}</label>
                  <input
                    type="text"
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    placeholder={t('form.descriptionPlaceholder')}
                    className={inputClass}
                  />
                </div>
                <Button onClick={handleCreate} disabled={!newName.trim()}>
                  {t('form.create')}
                </Button>
              </div>
            )}

            {/* Role List */}
            {roleList.length === 0 ? (
              <p className="text-sm text-[var(--text-3)] text-center py-4">
                {t('empty')}
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
                          placeholder={t('form.description')}
                          className={inputClass}
                        />
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => handleUpdate(role.id)}>{t('save')}</Button>
                          <Button variant="secondary" size="sm" onClick={() => setEditingId(null)}>{t('cancel')}</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-[var(--text)]">{role.name}</span>
                            {role.isSystem && (
                              <Badge tone="neutral">{t('system')}</Badge>
                            )}
                          </div>
                          {role.description && (
                            <p className="text-xs text-[var(--text-2)] mt-0.5">{role.description}</p>
                          )}
                          <div className="flex gap-4 mt-1 text-xs text-[var(--text-3)]">
                            <span>{t('userCount', { count: role._count.users })}</span>
                            <span>{t('toolCount', { count: role._count.toolAccess })}</span>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="outlineBrand" size="sm" onClick={() => handleManageTools(role.id)}>
                            {t('manageTools')}
                          </Button>
                          {!role.isSystem && (
                            <>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => { setEditingId(role.id); setEditName(role.name); setEditDesc(role.description || ''); }}
                              >
                                {t('edit')}
                              </Button>
                              <Button variant="danger" size="sm" onClick={() => handleDelete(role.id, role.name)}>
                                {t('delete')}
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Tool Access Manager */}
                    {managingToolsForRole === role.id && (
                      <div className="mt-4 pt-4 border-t border-[var(--border)]">
                        <h4 className="text-sm font-semibold text-[var(--text)] mb-2">
                          {t('access.title')}
                        </h4>
                        <p className="text-xs text-[var(--text-2)] mb-3">
                          {t('access.body')}
                        </p>
                        {allTools.length === 0 ? (
                          <p className="text-xs text-[var(--text-3)]">{t('access.noTools')}</p>
                        ) : (
                          <>
                            {/* Global actions and search */}
                            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                              <div className="flex gap-3 items-center">
                                <button
                                  onClick={() => setSelectedToolIds(allTools.map((x) => x.id))}
                                  className="text-xs text-[var(--brand)] hover:underline font-medium"
                                >
                                  {t('access.selectAll', { count: allTools.length })}
                                </button>
                                <button
                                  onClick={() => setSelectedToolIds([])}
                                  className="text-xs text-[var(--brand)] hover:underline font-medium"
                                >
                                  {t('access.deselectAll')}
                                </button>
                                <span className="text-xs text-[var(--text-3)]">
                                  {t('access.selected', { selected: selectedToolIds.length, total: allTools.length })}
                                </span>
                              </div>
                              <input
                                type="text"
                                value={toolSearch}
                                onChange={(e) => setToolSearch(e.target.value)}
                                placeholder={t('access.search')}
                                className="h-8 rounded-[9px] border border-[var(--border)] px-2.5 text-xs bg-[var(--surface)] text-[var(--text)] w-48 outline-none focus:border-[var(--brand)]"
                              />
                            </div>

                            {/* Connectors accordion */}
                            <div className="max-h-80 overflow-auto border border-[var(--border)] rounded-[9px] divide-y divide-[var(--border)]">
                              {connectorNames.map((connectorName) => {
                                const tools = filteredToolsByConnector(connectorName);
                                const total = toolsByConnector[connectorName].length;
                                const selected = connectorSelectedCount(connectorName);
                                const isCollapsed = collapsedConnectors.has(connectorName);

                                if (toolSearch.trim() && tools.length === 0) return null;

                                return (
                                  <div key={connectorName}>
                                    {/* Connector header */}
                                    <div className="flex items-center justify-between px-3 py-2.5 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] transition-colors">
                                      <button
                                        onClick={() => toggleConnector(connectorName)}
                                        className="flex items-center gap-2 flex-1 text-left"
                                      >
                                        <svg
                                          className={`w-3.5 h-3.5 text-[var(--text-3)] transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                                          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                                        >
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                        </svg>
                                        <span className="text-sm font-medium text-[var(--text)]">{connectorName}</span>
                                        <span className="text-[10px] text-[var(--text-3)] bg-[var(--surface)] px-1.5 py-0.5 rounded-full">
                                          {selected}/{total}
                                        </span>
                                      </button>
                                      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                                        <button
                                          onClick={() => selectAllForConnector(connectorName)}
                                          className="text-[10px] text-[var(--brand)] hover:underline"
                                        >
                                          {t('access.all')}
                                        </button>
                                        <button
                                          onClick={() => deselectAllForConnector(connectorName)}
                                          className="text-[10px] text-[var(--brand)] hover:underline"
                                        >
                                          {t('access.none')}
                                        </button>
                                      </div>
                                    </div>

                                    {/* Tools list */}
                                    {!isCollapsed && (
                                      <div className="px-3 py-2 grid grid-cols-1 sm:grid-cols-2 gap-0.5">
                                        {tools.map((tool) => (
                                          <label
                                            key={tool.id}
                                            className="flex items-center gap-2 text-sm cursor-pointer px-2 py-1.5 rounded-[9px] hover:bg-[var(--surface-2)]"
                                          >
                                            <input
                                              type="checkbox"
                                              checked={selectedToolIds.includes(tool.id)}
                                              onChange={() => toggleToolId(tool.id)}
                                              className="shrink-0 accent-[var(--brand)]"
                                            />
                                            <span className="font-mono text-xs truncate text-[var(--text)]">{tool.name}</span>
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
                          <Button size="sm" onClick={handleSaveToolAccess} disabled={savingTools}>
                            {savingTools ? t('access.saving') : t('access.save', { count: selectedToolIds.length })}
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setManagingToolsForRole(null)}>
                            {t('cancel')}
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
          <Card className="p-[22px]">
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-[var(--text)]">{t('assign.title')}</h3>
              <p className="text-xs text-[var(--text-2)] mt-1">
                {t('assign.intro')}
              </p>
            </div>

            <div className="border border-[var(--border)] rounded-[9px] overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="bg-[var(--surface-2)]">
                  <tr className="text-[var(--text-2)]">
                    <th className="text-left px-4 py-3 font-semibold">{t('assign.user')}</th>
                    <th className="text-left px-4 py-3 font-semibold">{t('assign.appRole')}</th>
                    <th className="text-left px-4 py-3 font-semibold">{t('assign.mcpRole')}</th>
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
                          <span className="text-xs text-[var(--text-3)]">{t('assign.fullAccess')}</span>
                        ) : (
                          <AppSelect
                            value={u.mcpRoleId || ''}
                            onValueChange={(v) => handleAssignRole(u.id, v || null)}
                            className="h-8 rounded-[9px] border border-[var(--border)] px-2 text-xs bg-[var(--surface)] text-[var(--text)]"
                            options={[
                              { value: '', label: t('assign.noRestriction') },
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
  );
}
