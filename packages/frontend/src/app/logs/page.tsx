'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { audit } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';

export default function LogsPage() {
  const { token } = useAuth();
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    audit
      .invocations(token, {
        limit: 200,
        ...(statusFilter ? { status: statusFilter } : {}),
      })
      .then(setLogs)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, statusFilter]);

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="Logs"
      />

      <main className="max-w-7xl mx-auto px-6 py-8 flex-1 w-full">
        <div className="border border-[var(--border)] rounded-lg">
          <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
            <h3 className="font-medium">Tool Invocation Logs ({logs.length})</h3>
            <div className="flex gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="border border-[var(--input)] rounded-md px-2 py-1 text-sm bg-[var(--background)]"
              >
                <option value="">All statuses</option>
                <option value="SUCCESS">Success</option>
                <option value="ERROR">Error</option>
                <option value="TIMEOUT">Timeout</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left bg-[var(--muted)]">
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">Time</th>
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">Tool</th>
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">Status</th>
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">Duration</th>
                  <th className="px-4 py-3 font-medium text-[var(--muted-foreground)]">Client</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-[var(--muted-foreground)]">
                      <div className="inline-block w-5 h-5 border-2 border-[var(--brand)] border-t-transparent rounded-full animate-spin mb-2"></div>
                      <p>Loading logs...</p>
                    </td>
                  </tr>
                ) : logs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-[var(--muted-foreground)]">
                      <p className="text-sm">No invocations yet. Tools will be logged here once MCP clients start using them.</p>
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr key={log.id} className="border-b border-[var(--border)] hover:bg-[var(--accent)] transition-colors">
                      <td className="px-4 py-3 text-[var(--muted-foreground)] text-xs">{formatTime(log.createdAt)}</td>
                      <td className="px-4 py-3 font-medium font-mono text-xs">{log.tool?.name || log.toolId}</td>
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
                      <td className="px-4 py-3 text-[var(--muted-foreground)] text-xs">{log.clientInfo || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
