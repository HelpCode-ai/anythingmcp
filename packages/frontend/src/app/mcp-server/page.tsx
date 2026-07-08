'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { mcpServers } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/badge';
import { AppSelect } from '@/components/ui/select';

export default function McpServerListPage() {
  const { token } = useAuth();
  const router = useRouter();
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    mcpServers.list(token).then(setServers).catch(() => {}).finally(() => setLoading(false));
  }, [token]);

  const handleCreate = async () => {
    if (!token || !newName.trim()) return;
    setCreating(true);
    try {
      const server = await mcpServers.create(
        { name: newName.trim(), description: newDescription.trim() || undefined },
        token,
      );
      setServers((prev) => [...prev, server]);
      setNewName('');
      setNewDescription('');
      setShowCreate(false);
      router.push(`/mcp-server/${server.id}`);
    } catch {
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(`/mcp/${id}`).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1500);
    }).catch(() => {});
  };

  const filtered = servers.filter((s) => {
    if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !(s.slug || '').toLowerCase().includes(search.toLowerCase()) && !(s.description || '').toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter === 'active' && !s.isActive) return false;
    if (statusFilter === 'inactive' && s.isActive) return false;
    return true;
  });

  return (
    <AppShell
      title="MCP Servers"
      actions={
        <Button onClick={() => setShowCreate(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          New MCP Server
        </Button>
      }
    >
      <div className="flex flex-col gap-[18px]">
        {/* Create dialog */}
        {showCreate && (
          <Card className="border-[var(--brand)] p-6">
            <h3 className="mb-4 text-base font-semibold tracking-[-0.01em]">Create MCP Server</h3>
            <div className="max-w-md space-y-3">
              <div>
                <label className="mb-1 block text-[13px] font-medium text-[var(--text-2)]">Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Production, Development, Sales Tools"
                  className="w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-[13px] font-medium text-[var(--text-2)]">Description (optional)</label>
                <input
                  type="text"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="What this MCP server is for"
                  className="w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
                  {creating ? 'Creating…' : 'Create'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => { setShowCreate(false); setNewName(''); setNewDescription(''); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Search & filters */}
        {!loading && servers.length > 0 && (
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-3)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search MCP servers…"
                className="w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] py-2 pl-10 pr-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]"
              />
            </div>
            <AppSelect
              value={statusFilter}
              onValueChange={setStatusFilter}
              className="rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              options={[
                { value: '', label: 'All statuses' },
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
              ]}
            />
          </div>
        )}

        {/* Server list */}
        {loading ? (
          <div className="grid gap-4">
            {[1, 2].map((i) => (
              <Card key={i} className="p-6" style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>
                <div className="mb-3 h-5 w-1/4 rounded bg-[var(--surface-3)]" />
                <div className="h-4 w-1/2 rounded bg-[var(--surface-3)]" />
              </Card>
            ))}
          </div>
        ) : servers.length === 0 ? (
          <Card className="flex flex-col items-center gap-4 px-6 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-[12px]" style={{ background: 'var(--t-emerald-bg)', color: 'var(--t-emerald-fg)' }}>
              <ServerIcon />
            </span>
            <p className="text-sm text-[var(--text-3)]">No MCP servers configured yet.</p>
            <Button onClick={() => setShowCreate(true)}>Create your first MCP Server</Button>
          </Card>
        ) : filtered.length === 0 ? (
          <Card className="px-6 py-12 text-center">
            <p className="text-sm text-[var(--text-3)]">No MCP servers match your search.</p>
          </Card>
        ) : (
          <div className="grid gap-4">
            {filtered.map((s) => {
              const active = !!s.isActive;
              return (
                <Card
                  key={s.id}
                  onClick={() => router.push(`/mcp-server/${s.id}`)}
                  className="cursor-pointer p-5 transition-colors hover:border-[var(--brand)]"
                >
                  {/* Header: icon tile + name/slug + status */}
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px]" style={{ background: 'var(--t-emerald-bg)', color: 'var(--t-emerald-fg)' }}>
                        <ServerIcon />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text)]">{s.name}</h3>
                          {s.slug && (
                            <span className="rounded-md bg-[var(--surface-2)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-3)]">
                              {s.slug}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-[var(--text-3)]">
                          {s._count?.apiKeys || 0} client{(s._count?.apiKeys || 0) === 1 ? '' : 's'} connected
                        </div>
                      </div>
                    </div>
                    <StatusPill
                      tone={active ? 'success' : 'danger'}
                      dot={active ? 'var(--ok)' : 'var(--danger)'}
                      className="flex-shrink-0"
                    >
                      {active ? 'Active' : 'Inactive'}
                    </StatusPill>
                  </div>

                  {s.description && (
                    <p className="mb-3 text-[13px] text-[var(--text-2)]">{s.description}</p>
                  )}

                  {/* Endpoint URL row with copy */}
                  <div className="mb-4 flex items-center gap-2 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text-2)]">
                      /mcp/{s.id}
                    </code>
                    <button
                      type="button"
                      onClick={(e) => handleCopy(e, s.id)}
                      aria-label="Copy endpoint URL"
                      title="Copy endpoint URL"
                      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] text-[var(--text-3)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
                    >
                      {copiedId === s.id ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                      ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="13" height="13" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                      )}
                    </button>
                  </div>

                  {/* Stats row */}
                  <div className="flex flex-wrap gap-x-6 gap-y-1.5 border-t border-[var(--border)] pt-3 text-xs">
                    <span className="text-[var(--text-3)]">
                      <span className="font-semibold text-[var(--text)]">{s._count?.connectors || 0}</span> connectors
                    </span>
                    <span className="text-[var(--text-3)]">
                      <span className="font-semibold text-[var(--text)]">{s._count?.apiKeys || 0}</span> API keys
                    </span>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ServerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" /><rect width="20" height="8" x="2" y="14" rx="2" /><path d="M6 6h.01M6 18h.01" /></svg>
  );
}
