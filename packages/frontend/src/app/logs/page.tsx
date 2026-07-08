'use client';

import { Fragment, useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { audit, connectors as connectorsApi, mcpServers } from '@/lib/api';
import { AppSelect } from '@/components/ui/select';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusPill, type Tone } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;

const GRID_COLS = '90px 1.5fr 1.2fr 70px 90px 90px';

function parseClientInfo(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function authMethodLabel(method: string | undefined): string {
  switch (method) {
    case 'mcp_api_key': return 'API Key';
    case 'jwt': return 'JWT';
    case 'static_api_key': return 'Static Key';
    case 'static_bearer': return 'Static Bearer';
    case 'none': return 'No Auth';
    default: return method || '-';
  }
}

function statusTone(status: string | undefined): Tone {
  switch (status) {
    case 'SUCCESS': return 'success';
    case 'ERROR': return 'danger';
    case 'TIMEOUT': return 'warn';
    default: return 'neutral';
  }
}

function statusDot(status: string | undefined): string {
  switch (status) {
    case 'SUCCESS': return 'var(--ok)';
    case 'ERROR': return 'var(--danger)';
    case 'TIMEOUT': return 'var(--warn)';
    default: return 'var(--text-3)';
  }
}

/** Visual response-code chip derived from the invocation status (no extra data). */
function statusCode(status: string | undefined): string {
  switch (status) {
    case 'SUCCESS': return '200';
    case 'TIMEOUT': return '504';
    case 'ERROR': return '500';
    default: return '—';
  }
}

function UserCell({ log }: { log: any }) {
  const ci = parseClientInfo(log.clientInfo);
  const email = log.user?.email || ci?.userEmail;
  const method = ci?.authMethod;
  const keyName = ci?.apiKeyName;

  if (!email && !method) return <span>-</span>;

  return (
    <div className="flex flex-col gap-0.5">
      {email && <span className="truncate max-w-[150px]" title={email}>{email}</span>}
      <span className="text-[10px] text-[var(--text-3)]">
        {keyName ? `${keyName}` : authMethodLabel(method)}
      </span>
    </div>
  );
}

export default function LogsPage() {
  const { token } = useAuth();
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [connectorFilter, setConnectorFilter] = useState<string>('');
  const [mcpServerFilter, setMcpServerFilter] = useState<string>('');
  const [connectors, setConnectors] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [statusFilter, debouncedSearch, connectorFilter, mcpServerFilter]);

  // Load connectors and MCP servers for filter dropdowns
  useEffect(() => {
    if (!token) return;
    connectorsApi.list(token).then(setConnectors).catch(() => {});
    mcpServers.list(token).then(setServers).catch(() => {});
  }, [token]);

  const fetchLogs = useCallback(() => {
    if (!token) return;
    setLoading(true);
    audit
      .invocations(token, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        ...(connectorFilter ? { connectorId: connectorFilter } : {}),
        ...(mcpServerFilter ? { mcpServerId: mcpServerFilter } : {}),
      })
      .then((data) => {
        setLogs(data);
        setHasMore(data.length === PAGE_SIZE);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, page, statusFilter, debouncedSearch, connectorFilter, mcpServerFilter]);

  // Load logs
  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  const formatJson = (data: any) => {
    if (!data) return '-';
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  // Segmented status filter (All / Success / Errors / Timeouts)
  const segments: { value: string; label: string }[] = [
    { value: '', label: 'All' },
    { value: 'SUCCESS', label: 'Success' },
    { value: 'ERROR', label: 'Errors' },
    { value: 'TIMEOUT', label: 'Timeouts' },
  ];

  const exportButton = (
    <Button
      variant="secondary"
      size="md"
      onClick={fetchLogs}
      disabled={loading}
      title="Refresh"
    >
      <svg
        className={cn('h-3.5 w-3.5', loading && 'animate-spin')}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      Refresh
    </Button>
  );

  return (
    <AppShell
      title="Audit Log"
      subtitle="Tool invocation history across your connectors and MCP servers."
      actions={exportButton}
    >
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        {/* Segmented status filter */}
        <div className="inline-flex gap-0.5 rounded-[10px] bg-[var(--surface-2)] p-[3px]">
          {segments.map((seg) => {
            const active = statusFilter === seg.value;
            return (
              <button
                key={seg.value || 'all'}
                onClick={() => setStatusFilter(seg.value)}
                className={cn(
                  'rounded-[7px] px-3.5 py-1.5 text-[12.5px] font-medium transition-colors',
                  active
                    ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--text-3)] hover:text-[var(--text)]'
                )}
              >
                {seg.label}
              </button>
            );
          })}
        </div>

        {/* Search box */}
        <div className="flex h-[34px] min-w-[200px] flex-1 items-center gap-2 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text-3)]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by tool or connector…"
            className="w-full bg-transparent text-[12.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
          />
        </div>

        {/* Connector / Server filters */}
        <AppSelect
          value={connectorFilter}
          onValueChange={setConnectorFilter}
          className="h-[34px] rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[12.5px] text-[var(--text-2)]"
          options={[
            { value: '', label: 'All connectors' },
            ...connectors.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <AppSelect
          value={mcpServerFilter}
          onValueChange={setMcpServerFilter}
          className="h-[34px] rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[12.5px] text-[var(--text-2)]"
          options={[
            { value: '', label: 'All MCP servers' },
            ...servers.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />

        {/* Export */}
        <Button variant="secondary" size="md" disabled title="Export (coming soon)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
          </svg>
          Export
        </Button>
      </div>

      {/* Table card */}
      <Card className="overflow-hidden">
        {/* Header row */}
        <div
          className="grid items-center gap-3 border-b border-[var(--border)] bg-[var(--surface-2)] px-[18px] py-[11px] text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text-3)]"
          style={{ gridTemplateColumns: GRID_COLS }}
        >
          <span>Time</span>
          <span>Tool</span>
          <span>Connector</span>
          <span>Code</span>
          <span>Duration</span>
          <span>Status</span>
        </div>

        {/* Rows */}
        {loading ? (
          <div className="px-[18px] py-10 text-center text-[var(--text-3)]">
            <div className="mb-2 inline-block h-5 w-5 animate-spin rounded-full border-2 border-[var(--brand)] border-t-transparent"></div>
            <p className="text-sm">Loading logs…</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="px-[18px] py-14 text-center text-[var(--text-3)]">
            <p className="text-sm">{page > 0 ? 'No more results.' : 'No invocations found.'}</p>
          </div>
        ) : (
          logs.map((log) => {
            const tone = statusTone(log.status);
            const isExpanded = expandedId === log.id;
            return (
              <Fragment key={log.id}>
                <div
                  onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  className="grid cursor-pointer items-center gap-3 border-b border-[var(--border)] px-[18px] py-[11px] text-[13px] transition-colors hover:bg-[var(--surface-2)]"
                  style={{ gridTemplateColumns: GRID_COLS }}
                >
                  <span className="font-mono text-[12px] text-[var(--text-3)] whitespace-nowrap overflow-hidden text-ellipsis" title={formatTime(log.createdAt)}>
                    {formatTime(log.createdAt)}
                  </span>
                  <span className="font-mono text-[12.5px] font-medium whitespace-nowrap overflow-hidden text-ellipsis" title={log.tool?.name || log.toolId}>
                    {log.tool?.name || log.toolId}
                  </span>
                  <span className="text-[var(--text-2)] whitespace-nowrap overflow-hidden text-ellipsis">
                    {log.tool?.connector?.name || '-'}
                  </span>
                  <span
                    className="justify-self-start rounded-md px-[7px] py-0.5 font-mono text-[12px] font-semibold"
                    style={tone === 'success'
                      ? { background: 'var(--t-success-bg)', color: 'var(--t-success-fg)' }
                      : tone === 'neutral'
                        ? { background: 'var(--t-neutral-bg)', color: 'var(--t-neutral-fg)' }
                        : { background: 'var(--t-danger-bg)', color: 'var(--t-danger-fg)' }}
                  >
                    {statusCode(log.status)}
                  </span>
                  <span className="font-mono text-[12px] text-[var(--text-2)]">
                    {log.durationMs ? `${log.durationMs}ms` : '-'}
                  </span>
                  <StatusPill tone={tone} dot={statusDot(log.status)} className="justify-self-start">
                    {log.status}
                  </StatusPill>
                </div>

                {isExpanded && (
                  <div className="border-b border-[var(--border)] bg-[var(--surface-2)] px-[18px] py-4">
                    <div className="grid max-w-full grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <h4 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Input Parameters</h4>
                        <pre className="max-h-64 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-xs">
                          {formatJson(log.input)}
                        </pre>
                      </div>
                      <div>
                        <h4 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                          {log.status === 'ERROR' ? 'Error' : 'Output'}
                        </h4>
                        <pre className="max-h-64 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-xs">
                          {log.error || formatJson(log.output)}
                        </pre>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-4 text-xs text-[var(--text-3)]">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-[var(--text-2)]">User:</span>
                        <UserCell log={log} />
                      </div>
                      {(() => {
                        const ci = parseClientInfo(log.clientInfo);
                        if (!ci) return null;
                        return (
                          <>
                            {ci.authMethod && <span>Auth: {authMethodLabel(ci.authMethod)}</span>}
                            {ci.apiKeyName && <span>Key: {ci.apiKeyName}</span>}
                          </>
                        );
                      })()}
                      {log.mcpServer && <span>Server: {log.mcpServer.name}</span>}
                      {log.tool?.connector && <span>Connector: {log.tool.connector.name} ({log.tool.connector.type})</span>}
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })
        )}

        {/* Pagination */}
        <div className="flex items-center justify-between px-[18px] py-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Previous
          </Button>
          <span className="text-[12.5px] text-[var(--text-3)]">
            Page {page + 1}{logs.length > 0 ? ` · ${logs.length} results` : ''}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasMore || loading}
          >
            Next
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Button>
        </div>
      </Card>
    </AppShell>
  );
}
