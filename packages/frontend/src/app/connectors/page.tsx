'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { connectors } from '@/lib/api';
import * as Dialog from '@radix-ui/react-dialog';
import { AppSelect } from '@/components/ui/select';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Badge, StatusPill, type Tone } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type HealthStatus = { total: number; healthy: number; unhealthy: number; connectors: any[] } | null;

const TYPE_STYLES: Record<string, { text: string; bg: string; icon: string }> = {
  REST: { text: 'REST', bg: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400', icon: '{ }' },
  SOAP: { text: 'SOAP', bg: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400', icon: '</>' },
  GRAPHQL: { text: 'GraphQL', bg: 'bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-400', icon: 'GQL' },
  MCP: { text: 'MCP', bg: 'bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-400', icon: 'MCP' },
  DATABASE: { text: 'Database', bg: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400', icon: 'DB' },
};

/** Connector TYPE → redesign Badge tone. */
const TYPE_TONE: Record<string, Tone> = {
  REST: 'info',
  DATABASE: 'emerald',
  DB: 'emerald',
  SOAP: 'warn',
  GRAPHQL: 'pink',
  MCP: 'purple',
};

/** Human-readable label for a connector type Badge. */
function typeLabel(type: string): string {
  return TYPE_STYLES[type]?.text ?? type;
}

/** First-letters of a connector name, for the square icon fallback. */
function initials(name: string): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Brand logo for a connector, with initials fallback.
 *
 * The backend enriches every connector with `icon` resolved from the source
 * adapter (see `resolveAdapterIcon`). If the icon is set AND the file is
 * present under /logos/connectors/<icon>.svg, render the brand mark. If the
 * file 404s or the connector wasn't imported from an adapter, fall back to
 * a 42px rounded tile with the connector's initials.
 */
function ConnectorLogo({ icon, name }: { icon?: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (icon && !failed) {
    return (
      <span className="inline-flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-[11px] bg-white p-1.5 ring-1 ring-black/5 dark:ring-white/10">
        <img
          src={`/logos/connectors/${icon}.svg`}
          alt={icon}
          className="h-full w-full object-contain"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span className="inline-flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-[11px] bg-[var(--surface-2)] text-sm font-semibold text-[var(--text-2)]">
      {initials(name)}
    </span>
  );
}

const SUPPORTED_TYPES = [
  { type: 'REST', label: 'REST APIs' },
  { type: 'GRAPHQL', label: 'GraphQL' },
  { type: 'SOAP', label: 'SOAP' },
  { type: 'MCP', label: 'MCP' },
  { type: 'DATABASE', label: 'Database' },
];

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
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!token) return;
    connectors.list(token).then(setList).catch(() => {}).finally(() => setLoading(false));
  }, [token]);

  const handleDelete = useCallback(async () => {
    if (!token || !deleteConfirm) return;
    setDeleting(true);
    try {
      await connectors.delete(deleteConfirm.id, token);
      setList((prev) => prev.filter((c) => c.id !== deleteConfirm.id));
      setMsg('Connector deleted');
      setTimeout(() => setMsg(''), 3000);
    } catch {} finally {
      setDeleting(false);
      setDeleteConfirm(null);
    }
  }, [token, deleteConfirm]);

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
      a.download = `anythingmcp-backup-${new Date().toISOString().slice(0, 10)}.json`;
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

  const headerActions = (
    <div className="flex gap-2">
      <Button
        variant="secondary"
        size="md"
        onClick={handleHealthCheck}
        disabled={checkingHealth}
        title="Health check all connectors"
      >
        <HeartPulseIcon />
        <span className="hidden sm:inline">{checkingHealth ? 'Checking...' : 'Health Check'}</span>
      </Button>
      <Button variant="secondary" size="md" onClick={handleExportAll} title="Export all connectors as JSON">
        <DownloadIcon />
        <span className="hidden sm:inline">Export</span>
      </Button>
      <Button variant="secondary" size="md" onClick={() => setShowImportModal(true)} title="Import connectors from JSON backup">
        <UploadIcon />
        <span className="hidden sm:inline">Import</span>
      </Button>
      <Link
        href="/connectors/store"
        title="Browse pre-built adapter recipes"
        className={cn(buttonVariants({ variant: 'secondary', size: 'md' }))}
      >
        <StoreIcon />
        <span className="hidden sm:inline">Adapters</span>
      </Link>
      <Link href="/connectors/new" className={cn(buttonVariants({ variant: 'primary', size: 'md' }))}>
        <PlusIcon />
        Add Connector
      </Link>
    </div>
  );

  return (
    <AppShell title="Connectors" actions={headerActions}>
      {msg && (
        <div className="mb-4 flex items-center justify-between rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
          <span>{msg}</span>
          <button onClick={() => setMsg('')} className="ml-3 text-xs text-[var(--text-3)] underline hover:text-[var(--text)]">dismiss</button>
        </div>
      )}

      {/* Import Modal (Radix Dialog) */}
      <Dialog.Root open={showImportModal} onOpenChange={(open) => { setShowImportModal(open); if (!open) setImportJson(''); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
            <div className="mb-4 flex items-center justify-between">
              <Dialog.Title className="text-lg font-semibold text-[var(--text)]">Import Connectors</Dialog.Title>
              <Dialog.Close className="rounded-sm p-1 text-[var(--text-3)] hover:text-[var(--text)]">
                <CloseIcon />
              </Dialog.Close>
            </div>
            <Dialog.Description className="mb-4 text-sm text-[var(--text-3)]">
              Paste a previously exported JSON backup or upload a file. Duplicate connectors will be skipped.
            </Dialog.Description>
            <div className="mb-3">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-2)] hover:border-[var(--border-strong)] hover:text-[var(--text)]">
                <UploadIcon size={14} />
                Choose File
                <input type="file" accept=".json" onChange={handleImportFile} className="hidden" />
              </label>
            </div>
            <textarea
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              rows={8}
              placeholder='{"version":"1.0","connectors":[...]}'
              className="w-full rounded-[9px] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-sm text-[var(--text)]"
            />
            <div className="mt-4 flex gap-2">
              <Button variant="primary" size="md" onClick={handleImportAll} disabled={importingAll || !importJson.trim()}>
                {importingAll ? 'Importing...' : 'Import'}
              </Button>
              <Dialog.Close className={cn(buttonVariants({ variant: 'secondary', size: 'md' }))}>
                Cancel
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Delete Confirmation Dialog */}
      <Dialog.Root open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
            <Dialog.Title className="mb-2 text-lg font-semibold text-[var(--text)]">Delete Connector</Dialog.Title>
            <Dialog.Description className="mb-5 text-sm text-[var(--text-3)]">
              Are you sure you want to delete <strong className="text-[var(--text)]">{deleteConfirm?.name}</strong> and all its tools? This action cannot be undone.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <Dialog.Close className={cn(buttonVariants({ variant: 'secondary', size: 'md' }))}>
                Cancel
              </Dialog.Close>
              <Button variant="danger" size="md" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Health Check Results */}
      {healthStatus && (
        <Card className="mb-6 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-[var(--text)]">Health Check Results</h3>
            <button onClick={() => setHealthStatus(null)} className="text-xs text-[var(--text-3)] hover:underline">dismiss</button>
          </div>
          <div className="mb-4 flex gap-4 text-sm text-[var(--text-2)]">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--ok)' }}></span> {healthStatus.healthy} healthy</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--danger)' }}></span> {healthStatus.unhealthy} unhealthy</span>
            <span className="text-[var(--text-3)]">{healthStatus.total} total active</span>
          </div>
          {healthStatus.connectors.length > 0 && (
            <div className="space-y-2">
              {healthStatus.connectors.map((c: any, i: number) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] p-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: c.status === 'healthy' ? 'var(--ok)' : 'var(--danger)' }}></span>
                    <span className="font-medium text-[var(--text)]">{c.name}</span>
                    <span className="text-xs text-[var(--text-3)]">{c.type}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-[var(--text-3)]">{c.latencyMs}ms</span>
                    <span style={{ color: c.status === 'healthy' ? 'var(--ok)' : 'var(--danger)' }}>{c.message}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {loading ? (
        /* Skeleton loading state */
        <div className="grid gap-[14px] sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse p-[18px]">
              <div className="mb-[14px] flex items-start gap-3">
                <div className="h-[42px] w-[42px] rounded-[11px] bg-[var(--surface-2)]" />
                <div className="flex-1 space-y-2 pt-1">
                  <div className="h-4 w-32 rounded bg-[var(--surface-2)]" />
                  <div className="h-3 w-44 rounded bg-[var(--surface-2)]" />
                </div>
                <div className="h-5 w-12 rounded bg-[var(--surface-2)]" />
              </div>
              <div className="flex items-center justify-between border-t border-[var(--border)] pt-[13px]">
                <div className="flex gap-4">
                  <div className="h-7 w-10 rounded bg-[var(--surface-2)]" />
                  <div className="h-7 w-10 rounded bg-[var(--surface-2)]" />
                </div>
                <div className="h-5 w-16 rounded-full bg-[var(--surface-2)]" />
              </div>
            </Card>
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-[var(--border-strong)] py-16 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--brand-tint)]">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1" />
              <path d="M19 15V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V9" />
              <path d="M21 21v-2h-4" />
              <path d="M3 5v2a1 1 0 0 0 1 1h1a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4a1 1 0 0 0-1 1" />
              <path d="M7 5H3" />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-semibold text-[var(--text)]">No connectors yet</h3>
          <p className="mb-2 text-sm text-[var(--text-3)]">
            Add your first API connector to start generating MCP tools.
          </p>
          <p className="mb-6 text-xs text-[var(--text-3)]">
            Supports {SUPPORTED_TYPES.map((t) => t.label).join(', ')}
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link href="/connectors/new" className={cn(buttonVariants({ variant: 'primary', size: 'md' }))}>
              <PlusIcon />
              Add Connector
            </Link>
            <Link href="/connectors/store" className={cn(buttonVariants({ variant: 'secondary', size: 'md' }))}>
              <StoreIcon />
              Browse Adapters
            </Link>
            <Button variant="secondary" size="md" onClick={() => setShowImportModal(true)}>
              <UploadIcon size={14} />
              Import from Backup
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Search and Filter bar */}
          <div className="mb-[18px] flex flex-wrap items-center gap-[10px]">
            <div className="relative min-w-[200px] flex-1">
              <SearchIcon />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter connectors…"
                aria-label="Search connectors by name or URL"
                className="h-9 w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)]"
              />
            </div>
            <AppSelect
              value={typeFilter}
              onValueChange={setTypeFilter}
              className="h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)]"
              options={[
                { value: '', label: 'All types' },
                { value: 'REST', label: 'REST' },
                { value: 'SOAP', label: 'SOAP' },
                { value: 'GRAPHQL', label: 'GraphQL' },
                { value: 'MCP', label: 'MCP' },
                { value: 'DATABASE', label: 'Database' },
              ]}
            />
            <span className="text-[13px] text-[var(--text-3)]">
              {filtered.length} connector{filtered.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="grid gap-[14px] sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((c) => {
              const tone: Tone = TYPE_TONE[c.type] ?? 'neutral';
              return (
                <Card
                  key={c.id}
                  className="group relative flex flex-col p-[18px] transition-[border-color,box-shadow] hover:border-[var(--border-strong)] hover:shadow-[var(--shadow)]"
                >
                  <Link href={`/connectors/${c.id}`} className="absolute inset-0 z-0" aria-label={c.name} />
                  <div className="relative z-0 mb-[14px] flex items-start gap-3 pointer-events-none">
                    <ConnectorLogo icon={c.icon} name={c.name} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14.5px] font-semibold text-[var(--text)]">{c.name}</span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[12px] text-[var(--text-3)]">{c.baseUrl}</div>
                    </div>
                    <Badge tone={tone} className="flex-shrink-0">{typeLabel(c.type)}</Badge>
                  </div>
                  <div className="relative z-0 mt-auto flex items-center justify-between border-t border-[var(--border)] pt-[13px] pointer-events-none">
                    <div className="flex gap-4">
                      <div>
                        <div className="text-[11px] text-[var(--text-3)]">Tools</div>
                        <div className="text-[14px] font-semibold text-[var(--text)]">{c.tools?.length || 0}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-[var(--text-3)]">Auth</div>
                        <div className="text-[14px] font-semibold text-[var(--text)]">{c.authType}</div>
                      </div>
                    </div>
                    <StatusPill
                      tone={c.isActive ? 'success' : 'neutral'}
                      dot={c.isActive ? 'var(--ok)' : 'var(--text-3)'}
                    >
                      {c.isActive ? 'Active' : 'Inactive'}
                    </StatusPill>
                  </div>
                  {/* Hover actions (above the full-card link) */}
                  <div className="relative z-10 mt-[14px] flex gap-2 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    {(c.type === 'REST' || c.type === 'GRAPHQL' || c.type === 'SOAP') && (
                      <Button variant="secondary" size="sm" onClick={() => handleImportSpec(c.id)}>
                        Import Spec
                      </Button>
                    )}
                    <Button variant="danger" size="sm" onClick={() => setDeleteConfirm({ id: c.id, name: c.name })}>
                      Delete
                    </Button>
                  </div>
                </Card>
              );
            })}

            {/* Add a connector tile */}
            <Link
              href="/connectors/new"
              className={cn(
                'flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-dashed border-[var(--border-strong)] p-[18px] text-[var(--text-2)]',
                'transition-colors hover:border-[var(--brand)] hover:bg-[var(--brand-tint)] hover:text-[var(--brand)]'
              )}
            >
              <span className="flex h-[38px] w-[38px] items-center justify-center rounded-[10px] bg-[var(--surface-2)]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              </span>
              <span className="text-[13px] font-semibold">Add a connector</span>
              <span className="text-[12px] text-[var(--text-3)]">Import a spec or pick an adapter</span>
            </Link>
          </div>
        </>
      )}
    </AppShell>
  );
}

/* SVG Icon Components */

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
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function HeartPulseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}

function UploadIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" x2="12" y1="3" y2="15" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function StoreIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" />
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" />
      <path d="M2 7h20" />
      <path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7" />
    </svg>
  );
}
