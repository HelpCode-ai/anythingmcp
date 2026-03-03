'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { mcpServers } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';

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

  const filtered = servers.filter((s) => {
    if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !(s.slug || '').toLowerCase().includes(search.toLowerCase()) && !(s.description || '').toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter === 'active' && !s.isActive) return false;
    if (statusFilter === 'inactive' && s.isActive) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="MCP Servers"
        actions={
          <button
            onClick={() => setShowCreate(true)}
            className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90"
          >
            + New MCP Server
          </button>
        }
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6 flex-1 w-full">
        {/* Create dialog */}
        {showCreate && (
          <div className="border border-[var(--brand)] rounded-lg p-6 bg-[var(--background)]">
            <h3 className="text-lg font-medium mb-4">Create MCP Server</h3>
            <div className="space-y-3 max-w-md">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Production, Development, Sales Tools"
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Description (optional)</label>
                <input
                  type="text"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="What this MCP server is for"
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim() || creating}
                  className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
                <button
                  onClick={() => { setShowCreate(false); setNewName(''); setNewDescription(''); }}
                  className="border border-[var(--border)] px-4 py-2 rounded-md text-sm hover:bg-[var(--accent)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Search & filters */}
        {!loading && servers.length > 0 && (
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search MCP servers..."
                className="w-full border border-[var(--input)] rounded-md pl-10 pr-3 py-2 text-sm bg-[var(--background)]"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        )}

        {/* Server list */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="border border-[var(--border)] rounded-lg p-6 animate-pulse">
                <div className="h-5 bg-[var(--muted)] rounded w-1/4 mb-3" />
                <div className="h-4 bg-[var(--muted)] rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : servers.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-[var(--muted-foreground)] mb-4">No MCP servers configured yet.</p>
            <button
              onClick={() => setShowCreate(true)}
              className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90"
            >
              Create your first MCP Server
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-[var(--muted-foreground)]">No MCP servers match your search.</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {filtered.map((s) => (
              <button
                key={s.id}
                onClick={() => router.push(`/mcp-server/${s.id}`)}
                className="border border-[var(--border)] rounded-lg p-4 sm:p-6 text-left hover:border-[var(--brand)] hover:bg-[var(--accent)]/50 transition-colors"
              >
                <div className="flex items-start sm:items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <h3 className="text-base sm:text-lg font-medium">{s.name}</h3>
                    <span className="text-xs font-mono text-[var(--muted-foreground)] bg-[var(--muted)] px-2 py-0.5 rounded">
                      {s.slug}
                    </span>
                  </div>
                  <span className={`flex items-center gap-1.5 text-xs font-medium flex-shrink-0 ${s.isActive ? 'text-[var(--success)]' : 'text-[var(--muted-foreground)]'}`}>
                    <span className={`w-2 h-2 rounded-full ${s.isActive ? 'bg-[var(--success)]' : 'bg-[var(--muted-foreground)]'}`} />
                    {s.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
                {s.description && (
                  <p className="text-sm text-[var(--muted-foreground)] mb-3">{s.description}</p>
                )}
                <div className="text-xs font-mono text-[var(--muted-foreground)] bg-[var(--muted)] px-2 py-1 rounded mb-3 truncate">
                  /mcp/{s.id}
                </div>
                <div className="flex gap-4 text-xs text-[var(--muted-foreground)]">
                  <span>{s._count?.connectors || 0} connectors</span>
                  <span>{s._count?.apiKeys || 0} API keys</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
