'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { audit, type AuditBreakdowns } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { cn } from '@/lib/utils';

type Analytics = Awaited<ReturnType<typeof audit.analytics>>;

const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

export default function AnalyticsPage() {
  const { token } = useAuth();
  const [days, setDays] = useState(30);
  const [bd, setBd] = useState<AuditBreakdowns | null>(null);
  const [an, setAn] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    Promise.all([audit.breakdowns(token, days), audit.analytics(token, days)])
      .then(([b, a]) => {
        setBd(b);
        setAn(a);
      })
      .catch((e) => setError(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [token, days]);

  useEffect(() => load(), [load]);

  const hasRates = !!bd && (bd.rates.callMicros > 0 || bd.rates.proxyCallMicros > 0);
  const successRate =
    bd && bd.total > 0 ? Math.round(((bd.total - bd.errors) / bd.total) * 100) : null;

  return (
    <AppShell
      title="Analytics"
      subtitle="Tool-call volume, success rate and cost across your MCP server."
      actions={
        <div className="flex items-center gap-0.5 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={cn(
                'rounded-[7px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                days === r.days
                  ? 'bg-[var(--brand)] text-white'
                  : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex flex-col gap-[18px]">
        {error && (
          <div className="rounded-[11px] border border-[var(--danger)]/30 bg-[var(--t-danger-bg)] px-4 py-3 text-sm text-[var(--t-danger-fg)]">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-[var(--text-3)]">Loading…</p>
        ) : !bd ? null : (
          <>
            {/* Metric tiles */}
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label={`Tool calls · ${bd.days}d`}
                value={bd.total.toLocaleString()}
                hint="total invocations"
                iconTone="info"
                icon={<ActivityStatIcon />}
              />
              <StatCard
                label="Success rate"
                value={successRate != null ? `${successRate}%` : '—'}
                hint={`${bd.errors.toLocaleString()} error${bd.errors === 1 ? '' : 's'}`}
                hintTone={bd.errors > 0 ? 'warn' : 'ok'}
                iconTone={bd.errors > 0 ? 'warn' : 'emerald'}
                icon={<CheckStatIcon />}
              />
              <StatCard
                label="Proxy calls"
                value={bd.proxyCalls.toLocaleString()}
                hint="metered"
                iconTone="purple"
                icon={<ProxyStatIcon />}
              />
              <StatCard
                label="Est. cost"
                value={hasRates ? formatCost(bd.estCostMicros) : '—'}
                hint={hasRates ? 'volume-based' : 'set COST_PER_CALL_MICROS'}
                iconTone="emerald"
                icon={<CostStatIcon />}
              />
            </div>

            {/* Invocations over time */}
            {an && (
              <Card className="p-5">
                <div className="mb-[18px] flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">Invocations over time</div>
                    <div className="mt-0.5 text-xs text-[var(--text-3)]">
                      Last {bd.days} days
                    </div>
                  </div>
                  <div className="flex gap-3.5 text-xs text-[var(--text-2)]">
                    <span className="flex items-center gap-[5px]">
                      <span className="h-2 w-2 rounded-sm bg-[var(--brand)]" />Success
                    </span>
                    <span className="flex items-center gap-[5px]">
                      <span className="h-2 w-2 rounded-sm bg-[var(--danger)]" />Error
                    </span>
                  </div>
                </div>
                <DailyTimeline daily={an.daily} />
              </Card>
            )}

            {/* Top tools + Calls by connector */}
            <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
              <Card className="p-5">
                <div className="mb-3.5 text-sm font-semibold">Top tools</div>
                <TopTools rows={an?.topTools ?? []} />
              </Card>
              <Breakdown title="Calls by connector" rows={bd.byConnector} showDot />
            </div>

            {/* Secondary breakdowns */}
            <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
              <Breakdown title="Calls by MCP server" rows={bd.byServer} />
              <Breakdown title="Calls by user" rows={bd.byUser} />
            </div>

            <p className="text-xs text-[var(--text-3)]">
              Cost is volume-based (no LLM tokens): calls × COST_PER_CALL_MICROS + proxy calls ×
              COST_PER_PROXY_CALL_MICROS. Configure the rates as environment variables.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}

function DailyTimeline({
  daily,
}: {
  daily: Array<{ date: string; success: number; error: number; timeout: number }>;
}) {
  const max = Math.max(1, ...daily.map((d) => d.success + d.error + d.timeout));
  // Thin the x-axis labels so they don't overlap on 30/90-day ranges.
  const labelEvery = Math.max(1, Math.ceil(daily.length / 8));
  return (
    <div className="flex h-[170px] items-end gap-1.5">
      {daily.map((d, i) => {
        const total = d.success + d.error + d.timeout;
        const errored = d.error + d.timeout;
        const height = (total / max) * 100;
        const errorPct = total > 0 ? (errored / total) * 100 : 0;
        const showLabel = i % labelEvery === 0 || i === daily.length - 1;
        return (
          <div
            key={d.date}
            className="flex h-full flex-1 flex-col items-center justify-end gap-2"
            title={`${d.date}: ${total} call${total === 1 ? '' : 's'}${errored > 0 ? ` · ${errored} error${errored === 1 ? '' : 's'}` : ''}`}
          >
            <div className="flex h-[140px] w-full items-end">
              {total === 0 ? (
                <div className="mx-auto h-px w-[62%] bg-[var(--border)]" />
              ) : (
                <div
                  className="relative mx-auto w-[62%] rounded-t-[5px] bg-[var(--brand)]"
                  style={{ height: `${Math.max(height, 4)}%`, minHeight: 6 }}
                >
                  {errorPct > 0 && (
                    <div
                      className="absolute inset-x-0 top-0 rounded-t-[5px] bg-[var(--danger)]"
                      style={{ height: `${errorPct}%` }}
                    />
                  )}
                </div>
              )}
            </div>
            <span className="h-3 whitespace-nowrap text-[10px] text-[var(--text-3)]">
              {showLabel ? d.date.slice(5) : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TopTools({
  rows,
}: {
  rows: Array<{ name: string; count: number; errors: number }>;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-[var(--text-3)]">No data in range.</p>;
  }
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r) => (
        <div key={r.name}>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <span className="truncate font-mono text-[var(--text-2)]" title={r.name}>
              {r.name}
            </span>
            <span className="flex-shrink-0 tabular-nums text-[var(--text-3)]">
              {r.count.toLocaleString()}
              {r.errors > 0 && (
                <span className="text-[var(--danger)]"> · {r.errors} err</span>
              )}
            </span>
          </div>
          <div className="h-[7px] overflow-hidden rounded-full bg-[var(--surface-3)]">
            <div
              className="h-full rounded-full bg-[var(--brand)]"
              style={{ width: `${(r.count / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const DOT_COLORS = [
  'var(--brand)',
  'var(--ok)',
  'var(--t-purple-fg)',
  'var(--warn)',
  'var(--t-pink-fg)',
  'var(--t-info-fg)',
  'var(--danger)',
  'var(--t-emerald-fg)',
];

function Breakdown({
  title,
  rows,
  showDot = false,
}: {
  title: string;
  rows: Array<{ id: string | null; label: string; count: number; errors: number }>;
  showDot?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card className="p-5">
      <div className="mb-3.5 text-sm font-semibold">{title}</div>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--text-3)]">No data in range.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r, i) => (
            <div key={r.id ?? r.label}>
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  {showDot && (
                    <span
                      className="h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ background: DOT_COLORS[i % DOT_COLORS.length] }}
                    />
                  )}
                  <span className="truncate text-[var(--text-2)]" title={r.label}>
                    {r.label}
                  </span>
                </span>
                <span className="flex-shrink-0 tabular-nums text-[var(--text-3)]">
                  {r.count.toLocaleString()}
                  {r.errors > 0 && (
                    <span className="text-[var(--danger)]"> · {r.errors} err</span>
                  )}
                </span>
              </div>
              <div className="h-[7px] overflow-hidden rounded-full bg-[var(--surface-3)]">
                <div
                  className="h-full rounded-full bg-[var(--brand)]"
                  style={{ width: `${(r.count / max) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Micros = millionths of a currency unit. Show a compact monetary-ish value. */
function formatCost(micros: number): string {
  const units = micros / 1_000_000;
  return units >= 1 ? units.toFixed(2) : units.toFixed(4);
}

/* Stat icons */
function ActivityStatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
  );
}
function CheckStatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
  );
}
function ProxyStatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h16M4 12l4-4M4 12l4 4M20 12l-4-4M20 12l-4 4" /></svg>
  );
}
function CostStatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
  );
}
