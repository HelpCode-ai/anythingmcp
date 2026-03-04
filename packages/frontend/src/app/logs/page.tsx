'use client';

import { Fragment, useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { audit, connectors as connectorsApi, mcpServers } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';

const PAGE_SIZE = 50;

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

function UserCell({ log }: { log: any }) {
  const ci = parseClientInfo(log.clientInfo);
  const email = log.user?.email || ci?.userEmail;
  const method = ci?.authMethod;
  const keyName = ci?.apiKeyName;

  if (!email && !method) return <span>-</span>;

  return (
    <div className="flex flex-col gap-0.5">
      {email && <span className="truncate max-w-[150px]" title={email}>{email}</span>}
      <span className="text-[10px] text-[var(--muted-foreground)]">
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

  const colSpan = 7;

  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="Logs"
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex-1 w-full">
        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tool name..."
              className="w-full border border-[var(--input)] rounded-md pl-10 pr-3 py-2 text-sm bg-[var(--background)]"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
          >
            <option value="">All statuses</option>
            <option value="SUCCESS">Success</option>
            <option value="ERROR">Error</option>
            <option value="TIMEOUT">Timeout</option>
          </select>
          <select
            value={connectorFilter}
            onChange={(e) => setConnectorFilter(e.target.value)}
            className="border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
          >
            <option value="">All connectors</option>
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            value={mcpServerFilter}
            onChange={(e) => setMcpServerFilter(e.target.value)}
            className="border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
          >
            <option value="">All MCP servers</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="flex items-center gap-1.5 border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] hover:bg-[var(--accent)] transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>

        <div className="border border-[var(--border)] rounded-lg">
          <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
            <h3 className="font-medium">Tool Invocation Logs</h3>
            <span className="text-sm text-[var(--muted-foreground)]">
              Page {page + 1}{logs.length > 0 ? ` (${logs.length} results)` : ''}
            </span>
          </div>

          {/* Desktop table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left bg-[var(--muted)]">
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">Time</th>
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">Tool</th>
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">Connector</th>
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">User</th>
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">Server</th>
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">Status</th>
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">Duration</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={colSpan} className="px-4 py-8 text-center text-[var(--muted-foreground)]">
                      <div className="inline-block w-5 h-5 border-2 border-[var(--brand)] border-t-transparent rounded-full animate-spin mb-2"></div>
                      <p>Loading logs...</p>
                    </td>
                  </tr>
                ) : logs.length === 0 ? (
                  <tr>
                    <td colSpan={colSpan} className="px-4 py-12 text-center text-[var(--muted-foreground)]">
                      <p className="text-sm">{page > 0 ? 'No more results.' : 'No invocations found.'}</p>
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <Fragment key={log.id}>
                      <tr
                        onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                        className="border-b border-[var(--border)] hover:bg-[var(--accent)] transition-colors cursor-pointer"
                      >
                        <td className="px-4 py-3 text-[var(--muted-foreground)] text-xs whitespace-nowrap">{formatTime(log.createdAt)}</td>
                        <td className="px-4 py-3 font-medium font-mono text-xs">{log.tool?.name || log.toolId}</td>
                        <td className="px-4 py-3 text-xs text-[var(--muted-foreground)]">
                          {log.tool?.connector?.name || '-'}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <UserCell log={log} />
                        </td>
                        <td className="px-4 py-3 text-xs text-[var(--muted-foreground)]">
                          {log.mcpServer?.name || '-'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            log.status === 'SUCCESS' ? 'bg-[var(--success-bg)] text-[var(--success-text)]' :
                            log.status === 'ERROR' ? 'bg-[var(--destructive-bg)] text-[var(--destructive-text)]' :
                            'bg-[var(--warning-bg)] text-[var(--warning-text)]'
                          }`}>
                            {log.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[var(--muted-foreground)] text-xs">{log.durationMs ? `${log.durationMs}ms` : '-'}</td>
                      </tr>
                      {expandedId === log.id && (
                        <tr>
                          <td colSpan={colSpan} className="px-4 py-4 bg-[var(--muted)]/50 border-b border-[var(--border)]">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-full">
                              <div>
                                <h4 className="text-xs font-medium mb-2 text-[var(--muted-foreground)] uppercase tracking-wide">Input Parameters</h4>
                                <pre className="bg-[var(--background)] border border-[var(--border)] rounded-md p-3 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all">
                                  {formatJson(log.input)}
                                </pre>
                              </div>
                              <div>
                                <h4 className="text-xs font-medium mb-2 text-[var(--muted-foreground)] uppercase tracking-wide">
                                  {log.status === 'ERROR' ? 'Error' : 'Output'}
                                </h4>
                                <pre className="bg-[var(--background)] border border-[var(--border)] rounded-md p-3 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all">
                                  {log.error || formatJson(log.output)}
                                </pre>
                              </div>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-4 text-xs text-[var(--muted-foreground)]">
                              {log.user?.email && <span>User: {log.user.email}</span>}
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
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile card layout */}
          <div className="sm:hidden divide-y divide-[var(--border)]">
            {loading ? (
              <div className="px-4 py-8 text-center text-[var(--muted-foreground)]">
                <div className="inline-block w-5 h-5 border-2 border-[var(--brand)] border-t-transparent rounded-full animate-spin mb-2"></div>
                <p>Loading logs...</p>
              </div>
            ) : logs.length === 0 ? (
              <div className="px-4 py-12 text-center text-[var(--muted-foreground)]">
                <p className="text-sm">{page > 0 ? 'No more results.' : 'No invocations found.'}</p>
              </div>
            ) : (
              logs.map((log) => (
                <div key={log.id}>
                  <button
                    onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                    className="w-full text-left px-4 py-3 hover:bg-[var(--accent)] transition-colors"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-xs font-medium truncate flex-1 mr-2">{log.tool?.name || log.toolId}</span>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium flex-shrink-0 ${
                        log.status === 'SUCCESS' ? 'bg-[var(--success-bg)] text-[var(--success-text)]' :
                        log.status === 'ERROR' ? 'bg-[var(--destructive-bg)] text-[var(--destructive-text)]' :
                        'bg-[var(--warning-bg)] text-[var(--warning-text)]'
                      }`}>
                        {log.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
                      <span>{formatTime(log.createdAt)}</span>
                      {log.durationMs && <span>{log.durationMs}ms</span>}
                      {log.user?.email && <span>{log.user.email}</span>}
                      {log.mcpServer?.name && <span>{log.mcpServer.name}</span>}
                    </div>
                  </button>
                  {expandedId === log.id && (
                    <div className="px-4 py-3 bg-[var(--muted)]/50 space-y-3">
                      <div>
                        <h4 className="text-xs font-medium mb-1 text-[var(--muted-foreground)] uppercase tracking-wide">Input</h4>
                        <pre className="bg-[var(--background)] border border-[var(--border)] rounded-md p-2 text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
                          {formatJson(log.input)}
                        </pre>
                      </div>
                      <div>
                        <h4 className="text-xs font-medium mb-1 text-[var(--muted-foreground)] uppercase tracking-wide">
                          {log.status === 'ERROR' ? 'Error' : 'Output'}
                        </h4>
                        <pre className="bg-[var(--background)] border border-[var(--border)] rounded-md p-2 text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
                          {log.error || formatJson(log.output)}
                        </pre>
                      </div>
                      <div className="flex flex-wrap gap-3 text-xs text-[var(--muted-foreground)]">
                        {log.user?.email && <span>User: {log.user.email}</span>}
                        {log.mcpServer && <span>Server: {log.mcpServer.name}</span>}
                        {log.tool?.connector && <span>Connector: {log.tool.connector.name}</span>}
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border)]">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0 || loading}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-[var(--input)] rounded-md hover:bg-[var(--accent)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Previous
            </button>
            <span className="text-sm text-[var(--muted-foreground)]">Page {page + 1}</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasMore || loading}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-[var(--input)] rounded-md hover:bg-[var(--accent)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
