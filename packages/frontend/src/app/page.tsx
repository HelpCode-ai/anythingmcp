'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { connectors, audit } from '@/lib/api';

type HealthResult = { total: number; healthy: number; unhealthy: number; connectors: any[] } | null;

interface AnalyticsData {
  daily: Array<{ date: string; success: number; error: number; timeout: number; avgDuration: number }>;
  topTools: Array<{ name: string; count: number; errors: number; avgDuration: number }>;
  totalInvocations: number;
  successRate: number;
  avgDuration: number;
}
import { NavBar } from '@/components/nav-bar';

export default function DashboardPage() {
  const { token, user, isLoading } = useAuth();
  const [stats, setStats] = useState({ connectors: 0, tools: 0, invocations24h: 0, errors24h: 0 });
  const [recentConnectors, setRecentConnectors] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [healthResult, setHealthResult] = useState<HealthResult>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  useEffect(() => {
    if (!token) return;
    const load = async () => {
      try {
        const [connList, auditStats, analyticsData] = await Promise.all([
          connectors.list(token),
          audit.stats(token),
          audit.analytics(token).catch(() => null),
        ]);
        const totalTools = connList.reduce((sum: number, c: any) => sum + (c.tools?.length || 0), 0);
        setStats({
          connectors: connList.length,
          tools: totalTools,
          invocations24h: auditStats.invocations24h,
          errors24h: auditStats.errors24h,
        });
        setRecentConnectors(connList.slice(0, 5));
        if (analyticsData) setAnalytics(analyticsData);
        // Auto-run health check if there are connectors
        if (connList.length > 0) {
          connectors.healthCheck(token).then(setHealthResult).catch(() => {});
        }
      } catch {
        // Backend may not be running
      }
    };
    load();
  }, [token]);

  const handleHealthCheck = async () => {
    if (!token) return;
    setCheckingHealth(true);
    try {
      const result = await connectors.healthCheck(token);
      setHealthResult(result);
    } catch {}
    setCheckingHealth(false);
  };

  if (isLoading) return null;

  const apiUrl = typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : 'http://localhost:4000';

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <NavBar />

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h2 className="text-2xl font-semibold">Welcome back{user?.name ? `, ${user.name}` : ''}</h2>
          <p className="text-[var(--muted-foreground)] mt-1 text-sm">Here&apos;s an overview of your MCP server.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <StatCard
            title="Active Connectors"
            value={String(stats.connectors)}
            icon={<CableStatIcon />}
            color="brand"
          />
          <StatCard
            title="MCP Tools"
            value={String(stats.tools)}
            icon={<WrenchStatIcon />}
            color="success"
          />
          <StatCard
            title="Invocations (24h)"
            value={String(stats.invocations24h)}
            icon={<ActivityStatIcon />}
            color="brand"
          />
          <StatCard
            title="Errors (24h)"
            value={String(stats.errors24h)}
            icon={<AlertStatIcon />}
            color={stats.errors24h > 0 ? 'destructive' : 'success'}
          />
        </div>

        {/* Analytics Charts */}
        {analytics && analytics.totalInvocations > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            {/* 7-Day Invocation Chart */}
            <div className="md:col-span-2 border border-[var(--border)] rounded-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium">Invocations (7 days)</h3>
                <div className="flex items-center gap-3 text-xs">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[var(--brand)]"></span> Success</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[var(--destructive)]"></span> Error</span>
                </div>
              </div>
              <div className="flex items-end gap-1 h-32">
                {analytics.daily.map((day) => {
                  const total = day.success + day.error + day.timeout;
                  const maxTotal = Math.max(...analytics.daily.map(d => d.success + d.error + d.timeout), 1);
                  const height = (total / maxTotal) * 100;
                  const errorPct = total > 0 ? (day.error / total) * 100 : 0;
                  return (
                    <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
                      <div className="w-full relative" style={{ height: `${Math.max(height, 4)}%` }}>
                        <div
                          className="absolute bottom-0 w-full bg-[var(--brand)] rounded-t-sm"
                          style={{ height: `${100 - errorPct}%`, opacity: 0.8 }}
                        />
                        {errorPct > 0 && (
                          <div
                            className="absolute top-0 w-full bg-[var(--destructive)] rounded-t-sm"
                            style={{ height: `${errorPct}%`, opacity: 0.8 }}
                          />
                        )}
                      </div>
                      <span className="text-[9px] text-[var(--muted-foreground)]">
                        {day.date.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Summary Stats */}
            <div className="border border-[var(--border)] rounded-lg p-6 space-y-4">
              <h3 className="text-sm font-medium">7-Day Summary</h3>
              <div>
                <p className="text-xs text-[var(--muted-foreground)]">Success Rate</p>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex-1 h-2 bg-[var(--muted)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[var(--success)] rounded-full"
                      style={{ width: `${analytics.successRate}%` }}
                    />
                  </div>
                  <span className="text-sm font-bold">{analytics.successRate}%</span>
                </div>
              </div>
              <div>
                <p className="text-xs text-[var(--muted-foreground)]">Avg Response Time</p>
                <p className="text-lg font-bold">{analytics.avgDuration}ms</p>
              </div>
              <div>
                <p className="text-xs text-[var(--muted-foreground)]">Total Invocations</p>
                <p className="text-lg font-bold">{analytics.totalInvocations}</p>
              </div>
              {analytics.topTools.length > 0 && (
                <div>
                  <p className="text-xs text-[var(--muted-foreground)] mb-2">Top Tools</p>
                  <div className="space-y-1">
                    {analytics.topTools.slice(0, 5).map((t) => (
                      <div key={t.name} className="flex items-center justify-between text-xs">
                        <span className="font-mono truncate max-w-[140px]">{t.name}</span>
                        <span className="text-[var(--muted-foreground)]">{t.count}x</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Quick Actions */}
          <div className="border border-[var(--border)] rounded-lg p-6">
            <h3 className="text-lg font-medium mb-4">Quick Actions</h3>
            <div className="space-y-3">
              <Link
                href="/connectors/new"
                className="flex items-center gap-3 p-3 rounded-lg border border-[var(--border)] hover:border-[var(--brand)] hover:bg-[var(--brand-light)] transition-colors group"
              >
                <div className="w-9 h-9 rounded-lg bg-[var(--brand-light)] text-[var(--brand)] flex items-center justify-center group-hover:bg-[var(--brand)] group-hover:text-white transition-colors">
                  <PlusIcon />
                </div>
                <div>
                  <p className="font-medium text-sm">Add Connector</p>
                  <p className="text-xs text-[var(--muted-foreground)]">Connect a REST, SOAP, GraphQL, or Database API</p>
                </div>
              </Link>
              <Link
                href="/mcp-server"
                className="flex items-center gap-3 p-3 rounded-lg border border-[var(--border)] hover:border-[var(--brand)] hover:bg-[var(--brand-light)] transition-colors group"
              >
                <div className="w-9 h-9 rounded-lg bg-[var(--success-light)] text-[var(--success)] flex items-center justify-center group-hover:bg-[var(--success)] group-hover:text-white transition-colors">
                  <ServerStatIcon />
                </div>
                <div>
                  <p className="font-medium text-sm">Configure MCP Client</p>
                  <p className="text-xs text-[var(--muted-foreground)]">Get connection config for Claude, Cursor, or other clients</p>
                </div>
              </Link>
              <Link
                href="/logs"
                className="flex items-center gap-3 p-3 rounded-lg border border-[var(--border)] hover:border-[var(--brand)] hover:bg-[var(--brand-light)] transition-colors group"
              >
                <div className="w-9 h-9 rounded-lg bg-[var(--accent)] text-[var(--muted-foreground)] flex items-center justify-center group-hover:bg-[var(--brand)] group-hover:text-white transition-colors">
                  <LogsStatIcon />
                </div>
                <div>
                  <p className="font-medium text-sm">View Invocation Logs</p>
                  <p className="text-xs text-[var(--muted-foreground)]">Monitor tool calls, errors, and performance</p>
                </div>
              </Link>
            </div>
          </div>

          {/* MCP Server Status + Health + Recent Connectors */}
          <div className="space-y-6">
            <div className="border border-[var(--border)] rounded-lg p-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-medium">MCP Server</h3>
                <span className="flex items-center gap-1.5 text-xs text-[var(--success)] font-medium">
                  <span className="w-2 h-2 bg-[var(--success)] rounded-full animate-pulse"></span>
                  Running
                </span>
              </div>
              <code className="block bg-[var(--muted)] px-3 py-2 rounded text-xs font-mono">
                {apiUrl}/mcp
              </code>
            </div>

            {/* Connector Health */}
            <div className="border border-[var(--border)] rounded-lg p-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-medium">Connector Health</h3>
                <button
                  onClick={handleHealthCheck}
                  disabled={checkingHealth}
                  className="text-xs text-[var(--brand)] hover:underline disabled:opacity-50"
                >
                  {checkingHealth ? 'Checking...' : 'Refresh'}
                </button>
              </div>
              {healthResult ? (
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex-1 h-2 bg-[var(--muted)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--success)] rounded-full transition-all"
                        style={{ width: healthResult.total > 0 ? `${(healthResult.healthy / healthResult.total) * 100}%` : '0%' }}
                      />
                    </div>
                    <span className="text-sm font-medium">{healthResult.healthy}/{healthResult.total}</span>
                  </div>
                  <div className="space-y-1.5">
                    {healthResult.connectors.map((c: any, i: number) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${c.status === 'healthy' ? 'bg-[var(--success)]' : 'bg-[var(--destructive)]'}`}></span>
                          <span className="font-medium">{c.name}</span>
                        </div>
                        <span className="text-[var(--muted-foreground)]">{c.latencyMs}ms</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[var(--muted-foreground)]">
                  {checkingHealth ? 'Running health checks...' : 'No health data yet'}
                </p>
              )}
            </div>

            {recentConnectors.length > 0 && (
              <div className="border border-[var(--border)] rounded-lg p-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-medium">Recent Connectors</h3>
                  <Link href="/connectors" className="text-xs text-[var(--brand)] hover:underline">View all</Link>
                </div>
                <div className="space-y-2">
                  {recentConnectors.map((c) => (
                    <Link
                      key={c.id}
                      href={`/connectors/${c.id}`}
                      className="flex items-center justify-between p-2 rounded hover:bg-[var(--accent)] transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <ConnectorTypeIcon type={c.type} />
                        <span className="text-sm font-medium">{c.name}</span>
                      </div>
                      <span className="text-xs text-[var(--muted-foreground)]">{c.tools?.length || 0} tools</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function StatCard({ title, value, icon, color }: { title: string; value: string; icon: React.ReactNode; color: string }) {
  const colorMap: Record<string, string> = {
    brand: 'text-[var(--brand)] bg-[var(--brand-light)]',
    success: 'text-[var(--success)] bg-[var(--success-light)]',
    destructive: 'text-[var(--destructive)] bg-[var(--destructive-bg)]',
  };

  return (
    <div className="border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-[var(--muted-foreground)]">{title}</p>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colorMap[color] || colorMap.brand}`}>
          {icon}
        </div>
      </div>
      <p className="text-3xl font-bold">{value}</p>
    </div>
  );
}

function ConnectorTypeIcon({ type }: { type: string }) {
  const labels: Record<string, { text: string; bg: string }> = {
    REST: { text: 'REST', bg: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400' },
    SOAP: { text: 'SOAP', bg: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400' },
    GRAPHQL: { text: 'GQL', bg: 'bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-400' },
    MCP: { text: 'MCP', bg: 'bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-400' },
    DATABASE: { text: 'DB', bg: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400' },
    WEBHOOK: { text: 'WH', bg: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400' },
  };
  const l = labels[type] || { text: type, bg: 'bg-[var(--muted)] text-[var(--muted-foreground)]' };
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${l.bg}`}>{l.text}</span>
  );
}

/* Small stat icons */
function CableStatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1" />
      <path d="M19 15V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V9" />
      <path d="M21 21v-2h-4" />
      <path d="M3 5v2a1 1 0 0 0 1 1h1a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4a1 1 0 0 0-1 1" />
      <path d="M7 5H3" />
    </svg>
  );
}

function WrenchStatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function ActivityStatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
    </svg>
  );
}

function AlertStatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

function ServerStatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
      <line x1="6" x2="6.01" y1="6" y2="6" />
      <line x1="6" x2="6.01" y1="18" y2="18" />
    </svg>
  );
}

function LogsStatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 12H3" />
      <path d="M16 6H3" />
      <path d="M16 18H3" />
      <path d="M21 12h.01" />
      <path d="M21 6h.01" />
      <path d="M21 18h.01" />
    </svg>
  );
}
