'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { connectors, audit, knowledgeGraph } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';

type HealthResult = { total: number; healthy: number; unhealthy: number; connectors: any[] } | null;

interface AnalyticsData {
  daily: Array<{ date: string; success: number; error: number; timeout: number; avgDuration: number }>;
  topTools: Array<{ name: string; count: number; errors: number; avgDuration: number }>;
  totalInvocations: number;
  successRate: number;
  avgDuration: number;
}

export default function DashboardPage() {
  const { token, user, isLoading } = useAuth();
  const [stats, setStats] = useState({ connectors: 0, tools: 0, invocations24h: 0, errors24h: 0 });
  const [recentConnectors, setRecentConnectors] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [healthResult, setHealthResult] = useState<HealthResult>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [kgStats, setKgStats] = useState<{ nodes: number; edges: number } | null>(null);

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
        if (connList.length > 0) {
          connectors.healthCheck(token).then(setHealthResult).catch(() => {});
          // Knowledge-graph teaser counts (free static/observational layers; no AI).
          knowledgeGraph.stats(token)
            .then((s) => setKgStats({ nodes: s.nodes, edges: s.edges }))
            .catch(() => {});
        }
      } catch {
        // Backend may not be running
      } finally {
        setDataLoading(false);
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
    ? window.location.hostname === 'localhost'
      ? `${window.location.protocol}//${window.location.hostname}:4000`
      : window.location.origin
    : 'http://localhost:4000';

  const maxTotal = analytics?.daily?.length
    ? Math.max(...analytics.daily.map((d) => d.success + d.error + d.timeout), 1)
    : 1;

  return (
    <AppShell
      title={`Welcome back${user?.name ? `, ${user.name}` : ''}`}
      subtitle="Here's an overview of your MCP server."
      actions={
        <Link href="/connectors/new">
          <Button>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New connector
          </Button>
        </Link>
      }
    >
      <div className="flex flex-col gap-[18px]">
        {/* First-run nudge */}
        {!dataLoading && stats.connectors === 0 && (
          <div className="flex flex-col gap-3 rounded-[14px] border border-[var(--brand)]/30 bg-[var(--brand-tint)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold">You&apos;re 60 seconds from your first AI superpower</div>
              <div className="mt-0.5 text-xs text-[var(--text-2)]">
                Pick a pre-built connector from the marketplace or paste your own OpenAPI spec.
              </div>
            </div>
            <Link href="/welcome" className="shrink-0">
              <Button>Connect your first tool →</Button>
            </Link>
          </div>
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Active connectors"
            value={dataLoading ? '—' : stats.connectors}
            hint={
              healthResult
                ? `${healthResult.healthy} healthy · ${healthResult.unhealthy} down`
                : 'connectors configured'
            }
            iconTone="info"
            icon={<CableStatIcon />}
          />
          <StatCard
            label="MCP tools"
            value={dataLoading ? '—' : stats.tools}
            hint={`across ${stats.connectors} source${stats.connectors === 1 ? '' : 's'}`}
            iconTone="emerald"
            icon={<WrenchStatIcon />}
          />
          <StatCard
            label="Invocations · 24h"
            value={dataLoading ? '—' : stats.invocations24h.toLocaleString()}
            hint="last 24 hours"
            iconTone="info"
            icon={<ActivityStatIcon />}
          />
          <StatCard
            label="Errors · 24h"
            value={dataLoading ? '—' : stats.errors24h}
            hint={
              stats.invocations24h > 0
                ? `${((stats.errors24h / stats.invocations24h) * 100).toFixed(2)}% error rate`
                : 'no invocations'
            }
            hintTone={stats.errors24h > 0 ? 'warn' : 'muted'}
            iconTone={stats.errors24h > 0 ? 'warn' : 'emerald'}
            icon={<AlertStatIcon />}
          />
        </div>

        {/* Chart + summary */}
        {analytics && analytics.totalInvocations > 0 && (
          <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[2fr_1fr]">
            <Card className="p-5">
              <div className="mb-[18px] flex items-center justify-between">
                <div className="text-sm font-semibold">Invocations · last 7 days</div>
                <div className="flex gap-3.5 text-xs text-[var(--text-2)]">
                  <span className="flex items-center gap-[5px]"><span className="h-2 w-2 rounded-sm bg-[var(--brand)]" />Success</span>
                  <span className="flex items-center gap-[5px]"><span className="h-2 w-2 rounded-sm bg-[var(--danger)]" />Error</span>
                </div>
              </div>
              <div className="flex h-[150px] items-end gap-2.5">
                {analytics.daily.map((day) => {
                  const total = day.success + day.error + day.timeout;
                  const height = (total / maxTotal) * 100;
                  const errorPct = total > 0 ? (day.error / total) * 100 : 0;
                  return (
                    <div key={day.date} className="flex flex-1 flex-col items-center gap-2">
                      <div className="flex h-[130px] w-full items-end">
                        <div
                          className="relative mx-auto w-[62%] rounded-t-[5px] bg-[var(--brand)]"
                          style={{ height: `${Math.max(height, 6)}%`, minHeight: 8 }}
                          title={`${total} calls`}
                        >
                          <div className="absolute inset-x-0 top-0 rounded-t-[5px] bg-[var(--danger)]" style={{ height: `${errorPct}%` }} />
                        </div>
                      </div>
                      <span className="text-[11px] text-[var(--text-3)]">{day.date.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card className="flex flex-col gap-4 p-5">
              <div className="text-sm font-semibold">7-day summary</div>
              <div>
                <div className="mb-1.5 flex justify-between text-[12.5px] text-[var(--text-2)]">
                  <span>Success rate</span>
                  <span className="font-semibold text-[var(--text)]">{analytics.successRate}%</span>
                </div>
                <div className="h-[7px] overflow-hidden rounded-full bg-[var(--surface-3)]">
                  <div className="h-full rounded-full bg-[var(--ok)]" style={{ width: `${analytics.successRate}%` }} />
                </div>
              </div>
              <div className="flex gap-5">
                <div>
                  <div className="text-xs text-[var(--text-3)]">Avg response</div>
                  <div className="text-xl font-semibold tracking-[-0.02em]">{analytics.avgDuration} ms</div>
                </div>
                <div>
                  <div className="text-xs text-[var(--text-3)]">Total calls</div>
                  <div className="text-xl font-semibold tracking-[-0.02em]">{analytics.totalInvocations.toLocaleString()}</div>
                </div>
              </div>
              {analytics.topTools.length > 0 && (
                <div className="border-t border-[var(--border)] pt-3">
                  <div className="mb-2 text-xs text-[var(--text-3)]">Top tools</div>
                  {analytics.topTools.slice(0, 5).map((t) => (
                    <div key={t.name} className="flex items-center justify-between py-[3px] text-[12.5px]">
                      <span className="truncate font-mono text-[var(--text-2)]">{t.name}</span>
                      <span className="ml-2 flex-shrink-0 text-[var(--text-3)]">{t.count}x</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {/* Health + Quick actions */}
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
          {/* Connector health */}
          <Card className="p-5">
            <div className="mb-3.5 flex items-center justify-between">
              <div className="text-sm font-semibold">Connector health</div>
              <button onClick={handleHealthCheck} disabled={checkingHealth} className="text-xs text-[var(--brand)] hover:underline disabled:opacity-50">
                {checkingHealth ? 'Checking…' : 'Refresh'}
              </button>
            </div>
            {dataLoading ? (
              <div className="space-y-3" style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-3 w-full rounded bg-[var(--surface-3)]" />
                ))}
              </div>
            ) : healthResult ? (
              <div>
                <div className="mb-3.5 flex items-center gap-3">
                  <div className="h-[7px] flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
                    <div className="h-full rounded-full bg-[var(--ok)] transition-all" style={{ width: healthResult.total > 0 ? `${(healthResult.healthy / healthResult.total) * 100}%` : '0%' }} />
                  </div>
                  <span className="text-[13px] font-semibold">{healthResult.healthy}/{healthResult.total}</span>
                </div>
                {healthResult.connectors.map((c: any, i: number) => (
                  <div key={i} className="flex items-center justify-between py-1.5 text-[13px]">
                    <div className="flex items-center gap-2">
                      <span className="h-[7px] w-[7px] rounded-full" style={{ background: c.status === 'healthy' ? 'var(--ok)' : 'var(--danger)' }} />
                      <span className="font-medium">{c.name}</span>
                    </div>
                    <span className="font-mono text-xs text-[var(--text-3)]">{c.latencyMs}ms</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[var(--text-3)]">No health data yet</p>
            )}

            <div className="mt-4 border-t border-[var(--border)] pt-4">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.05em] text-[var(--text-3)]">MCP endpoint</div>
              <code className="block overflow-x-auto rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 font-mono text-xs text-[var(--text-2)]">
                {apiUrl}/mcp
              </code>
            </div>
          </Card>

          {/* Quick actions */}
          <Card className="flex flex-col gap-2.5 p-5">
            <div className="mb-1 text-sm font-semibold">Quick actions</div>
            <QuickAction href="/connectors/new" tone="info" title="Add a connector" desc="REST, SOAP, GraphQL, DB or MCP" icon={<PlusIcon />} />
            <QuickAction href="/mcp-server" tone="emerald" title="Configure a client" desc="Claude, ChatGPT, Cursor…" icon={<ServerStatIcon />} />
            <QuickAction
              href="/knowledge-graph"
              tone="purple"
              title="Explore the graph"
              desc={
                kgStats && kgStats.nodes > 0
                  ? `${kgStats.nodes} entities · ${kgStats.edges} connections`
                  : 'See how your data connects'
              }
              icon={<KgStatIcon />}
            />

            {recentConnectors.length > 0 && (
              <div className="mt-2 border-t border-[var(--border)] pt-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs text-[var(--text-3)]">Recent connectors</div>
                  <Link href="/connectors" className="text-xs text-[var(--brand)] hover:underline">View all</Link>
                </div>
                {recentConnectors.map((c) => (
                  <Link key={c.id} href={`/connectors/${c.id}`} className="flex items-center justify-between rounded-lg p-2 hover:bg-[var(--surface-2)]">
                    <span className="text-[13px] font-medium">{c.name}</span>
                    <span className="text-xs text-[var(--text-3)]">{c.tools?.length || 0} tools</span>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

const tileTone: Record<string, React.CSSProperties> = {
  info: { background: 'var(--t-info-bg)', color: 'var(--t-info-fg)' },
  emerald: { background: 'var(--t-emerald-bg)', color: 'var(--t-emerald-fg)' },
  purple: { background: 'var(--t-purple-bg)', color: 'var(--t-purple-fg)' },
};

function QuickAction({ href, tone, title, desc, icon }: { href: string; tone: string; title: string; desc: string; icon: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-[11px] border border-[var(--border)] p-3 transition-colors hover:border-[var(--brand)] hover:bg-[var(--brand-tint)]"
    >
      <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[9px]" style={tileTone[tone]}>
        {icon}
      </span>
      <span>
        <span className="block text-[13px] font-semibold text-[var(--text)]">{title}</span>
        <span className="block text-xs text-[var(--text-3)]">{desc}</span>
      </span>
    </Link>
  );
}

/* Small stat icons */
function CableStatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 15V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V9" /></svg>
  );
}
function WrenchStatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" /></svg>
  );
}
function ActivityStatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
  );
}
function AlertStatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z" /><path d="M12 9v4M12 17h.01" /></svg>
  );
}
function PlusIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
  );
}
function ServerStatIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="20" height="8" x="2" y="2" rx="2" /><rect width="20" height="8" x="2" y="14" rx="2" /></svg>
  );
}
function KgStatIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="6" r="2.4" /><circle cx="19" cy="6" r="2.4" /><circle cx="12" cy="18" r="2.4" /><path d="M7.2 7.2 10.6 16M16.8 7.2 13.4 16M7 6h10" /></svg>
  );
}
