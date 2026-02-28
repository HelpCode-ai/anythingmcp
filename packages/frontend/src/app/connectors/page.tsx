'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { connectors } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';

type HealthStatus = { total: number; healthy: number; unhealthy: number; connectors: any[] } | null;

const TYPE_STYLES: Record<string, { text: string; bg: string; icon: string }> = {
  REST: { text: 'REST', bg: 'bg-blue-100 text-blue-700', icon: '{ }' },
  SOAP: { text: 'SOAP', bg: 'bg-orange-100 text-orange-700', icon: '</>' },
  GRAPHQL: { text: 'GraphQL', bg: 'bg-pink-100 text-pink-700', icon: 'GQL' },
  MCP: { text: 'MCP', bg: 'bg-purple-100 text-purple-700', icon: 'MCP' },
  DATABASE: { text: 'Database', bg: 'bg-emerald-100 text-emerald-700', icon: 'DB' },
  WEBHOOK: { text: 'Webhook', bg: 'bg-amber-100 text-amber-700', icon: 'WH' },
};

export default function ConnectorsPage() {
  const { token } = useAuth();
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [msg, setMsg] = useState('');
  const [showImportModal, setShowImportModal] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importingAll, setImportingAll] = useState(false);
  const [healthStatus, setHealthStatus] = useState<HealthStatus>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  useEffect(() => {
    if (!token) return;
    connectors.list(token).then(setList).catch(() => {}).finally(() => setLoading(false));
  }, [token]);

  const handleDelete = async (id: string) => {
    if (!token || !confirm('Delete this connector and all its tools?')) return;
    try {
      await connectors.delete(id, token);
      setList((prev) => prev.filter((c) => c.id !== id));
      setMsg('Connector deleted');
      setTimeout(() => setMsg(''), 3000);
    } catch {}
  };

  const handleImportSpec = async (id: string) => {
    if (!token) return;
    setMsg('Importing specification...');
    try {
      const result = await connectors.importSpec(id, token);
      setMsg(result.message);
      const updated = await connectors.list(token);
      setList(updated);
    } catch (err: any) {
      setMsg(`Import failed: ${err.message}`);
    }
    setTimeout(() => setMsg(''), 5000);
  };

  const handleExportAll = async () => {
    if (!token) return;
    try {
      const data = await connectors.exportAll(token);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `anythingtomcp-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg('Configuration exported');
      setTimeout(() => setMsg(''), 3000);
    } catch (err: any) {
      setMsg(`Export failed: ${err.message}`);
    }
  };

  const handleImportAll = async () => {
    if (!token || !importJson.trim()) return;
    setImportingAll(true);
    try {
      const parsed = JSON.parse(importJson);
      const data = parsed.connectors ? parsed : { connectors: Array.isArray(parsed) ? parsed : [parsed] };
      const result = await connectors.importAll(data, token);
      setMsg(result.message);
      setShowImportModal(false);
      setImportJson('');
      const updated = await connectors.list(token);
      setList(updated);
    } catch (err: any) {
      setMsg(`Import failed: ${err.message}`);
    } finally {
      setImportingAll(false);
    }
    setTimeout(() => setMsg(''), 5000);
  };

  const handleHealthCheck = async () => {
    if (!token) return;
    setCheckingHealth(true);
    setHealthStatus(null);
    try {
      const result = await connectors.healthCheck(token);
      setHealthStatus(result);
    } catch (err: any) {
      setMsg(`Health check failed: ${err.message}`);
    } finally {
      setCheckingHealth(false);
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImportJson(ev.target?.result as string);
    };
    reader.readAsText(file);
  };

  const filtered = list.filter((c) => {
    if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !c.baseUrl.toLowerCase().includes(search.toLowerCase())) return false;
    if (typeFilter && c.type !== typeFilter) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="Connectors"
        actions={
          <div className="flex gap-2">
            <button
              onClick={handleHealthCheck}
              disabled={checkingHealth}
              className="border border-[var(--border)] px-3 py-2 rounded-md text-sm hover:bg-[var(--accent)] disabled:opacity-50"
              title="Health check all connectors"
            >
              {checkingHealth ? 'Checking...' : 'Health Check'}
            </button>
            <button
              onClick={handleExportAll}
              className="border border-[var(--border)] px-3 py-2 rounded-md text-sm hover:bg-[var(--accent)]"
              title="Export all connectors as JSON"
            >
              Export
            </button>
            <button
              onClick={() => setShowImportModal(true)}
              className="border border-[var(--border)] px-3 py-2 rounded-md text-sm hover:bg-[var(--accent)]"
              title="Import connectors from JSON backup"
            >
              Import
            </button>
            <Link
              href="/connectors/new"
              className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 flex items-center gap-1.5"
            >
              <PlusIcon />
              Add Connector
            </Link>
          </div>
        }
      />

      <main className="max-w-7xl mx-auto px-6 py-8">
        {msg && (
          <div className="mb-4 p-3 rounded-md bg-blue-50 text-blue-700 text-sm border border-blue-200">
            {msg}
            <button onClick={() => setMsg('')} className="ml-2 underline">dismiss</button>
          </div>
        )}

        {/* Import Modal */}
        {showImportModal && (
          <div className="mb-6 border border-[var(--border)] rounded-lg p-6 bg-[var(--card)]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium">Import Connectors</h3>
              <button onClick={() => { setShowImportModal(false); setImportJson(''); }} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">&times;</button>
            </div>
            <p className="text-sm text-[var(--muted-foreground)] mb-3">
              Paste a previously exported JSON backup or upload a file. Duplicate connectors will be skipped.
            </p>
            <div className="mb-3">
              <label className="inline-block border border-[var(--border)] px-3 py-1.5 rounded text-sm cursor-pointer hover:bg-[var(--accent)]">
                Choose File
                <input type="file" accept=".json" onChange={handleImportFile} className="hidden" />
              </label>
            </div>
            <textarea
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              rows={8}
              placeholder='{"version":"1.0","connectors":[...]}'
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono"
            />
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleImportAll}
                disabled={importingAll || !importJson.trim()}
                className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {importingAll ? 'Importing...' : 'Import'}
              </button>
              <button
                onClick={() => { setShowImportModal(false); setImportJson(''); }}
                className="border border-[var(--border)] px-4 py-2 rounded-md text-sm hover:bg-[var(--accent)]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Health Check Results */}
        {healthStatus && (
          <div className="mb-6 border border-[var(--border)] rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium">Health Check Results</h3>
              <button onClick={() => setHealthStatus(null)} className="text-xs text-[var(--muted-foreground)] hover:underline">dismiss</button>
            </div>
            <div className="flex gap-4 mb-4 text-sm">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--success)]"></span> {healthStatus.healthy} healthy</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--destructive)]"></span> {healthStatus.unhealthy} unhealthy</span>
              <span className="text-[var(--muted-foreground)]">{healthStatus.total} total active</span>
            </div>
            {healthStatus.connectors.length > 0 && (
              <div className="space-y-2">
                {healthStatus.connectors.map((c: any, i: number) => (
                  <div key={i} className={`flex items-center justify-between p-2 rounded text-sm border ${c.status === 'healthy' ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${c.status === 'healthy' ? 'bg-[var(--success)]' : 'bg-[var(--destructive)]'}`}></span>
                      <span className="font-medium">{c.name}</span>
                      <span className="text-xs text-[var(--muted-foreground)]">{c.type}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-[var(--muted-foreground)]">{c.latencyMs}ms</span>
                      <span className={c.status === 'healthy' ? 'text-green-700' : 'text-red-700'}>{c.message}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div className="text-center py-16">
            <div className="inline-block w-6 h-6 border-2 border-[var(--brand)] border-t-transparent rounded-full animate-spin mb-3"></div>
            <p className="text-[var(--muted-foreground)]">Loading connectors...</p>
          </div>
        ) : list.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-[var(--border)] rounded-lg">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-[var(--brand-light)] flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1" />
                <path d="M19 15V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V9" />
                <path d="M21 21v-2h-4" />
                <path d="M3 5v2a1 1 0 0 0 1 1h1a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4a1 1 0 0 0-1 1" />
                <path d="M7 5H3" />
              </svg>
            </div>
            <h3 className="text-lg font-medium mb-2">No connectors yet</h3>
            <p className="text-[var(--muted-foreground)] mb-4 text-sm">
              Add your first API connector to start generating MCP tools.
            </p>
            <Link
              href="/connectors/new"
              className="inline-flex items-center gap-1.5 bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90"
            >
              <PlusIcon />
              Add Connector
            </Link>
          </div>
        ) : (
          <>
            {/* Search and Filter bar */}
            <div className="flex items-center gap-3 mb-6">
              <div className="relative flex-1 max-w-sm">
                <SearchIcon />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search connectors..."
                  className="w-full border border-[var(--input)] rounded-md pl-9 pr-3 py-2 text-sm bg-[var(--background)]"
                />
              </div>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
              >
                <option value="">All types</option>
                <option value="REST">REST</option>
                <option value="SOAP">SOAP</option>
                <option value="GRAPHQL">GraphQL</option>
                <option value="MCP">MCP</option>
                <option value="DATABASE">Database</option>
                <option value="WEBHOOK">Webhook</option>
              </select>
              <span className="text-sm text-[var(--muted-foreground)]">
                {filtered.length} connector{filtered.length !== 1 ? 's' : ''}
              </span>
            </div>

            <div className="space-y-3">
              {filtered.map((c) => {
                const ts = TYPE_STYLES[c.type] || { text: c.type, bg: 'bg-gray-100 text-gray-700', icon: '?' };
                return (
                  <div key={c.id} className="border border-[var(--border)] rounded-lg p-4 hover:border-[var(--brand)] transition-colors group">
                    <div className="flex items-center justify-between">
                      <Link href={`/connectors/${c.id}`} className="flex-1 min-w-0 hover:opacity-90">
                        <div className="flex items-center gap-3">
                          <span className={`text-xs font-bold px-2 py-1 rounded ${ts.bg}`}>{ts.icon}</span>
                          <h3 className="font-medium">{c.name}</h3>
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${c.isActive ? 'bg-[var(--success)]' : 'bg-gray-400'}`} />
                          <span className="text-xs text-[var(--muted-foreground)]">{c.isActive ? 'Active' : 'Inactive'}</span>
                        </div>
                        <div className="flex items-center gap-4 mt-1.5 text-sm text-[var(--muted-foreground)]">
                          <span className="font-mono text-xs truncate">{c.baseUrl}</span>
                          <span className="text-xs">{c.tools?.length || 0} tools</span>
                          <span className="text-xs">Auth: {c.authType}</span>
                        </div>
                      </Link>
                      <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        {(c.type === 'REST' || c.type === 'GRAPHQL' || c.type === 'SOAP') && (
                          <button
                            onClick={() => handleImportSpec(c.id)}
                            className="border border-[var(--border)] px-3 py-1 rounded text-xs hover:bg-[var(--accent)]"
                          >
                            Import Spec
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(c.id)}
                          className="border border-[var(--destructive)] text-[var(--destructive)] px-3 py-1 rounded text-xs hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--muted-foreground)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
