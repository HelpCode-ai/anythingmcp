'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { audit, type AuditBreakdowns } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { cn } from '@/lib/utils';

type Analytics = Awaited<ReturnType<typeof audit.analytics>>;

const RANGES = [7, 30, 90];

export default function AnalyticsPage() {
  const { token } = useAuth();
  const t = useTranslations('analytics');
  const [days, setDays] = useState(30);
  const [bd, setBd] = useState<AuditBreakdowns | null>(null);
  const [an, setAn] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  // null: no error. '' : failed without a message, shown with the fallback text.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    Promise.all([audit.breakdowns(token, days), audit.analytics(token, days)])
      .then(([b, a]) => {
        setBd(b);
        setAn(a);
      })
      .catch((e) => setError(e.message || ''))
      .finally(() => setLoading(false));
  }, [token, days]);

  useEffect(() => load(), [load]);

  const hasRates = !!bd && (bd.rates.callMicros > 0 || bd.rates.proxyCallMicros > 0);
  const successRate =
    bd && bd.total > 0 ? Math.round(((bd.total - bd.errors) / bd.total) * 100) : null;

  return (
    <AppShell
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <div className="flex items-center gap-0.5 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] p-0.5">
          {RANGES.map((range) => (
            <button
              key={range}
              onClick={() => setDays(range)}
              className={cn(
                'rounded-[7px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                days === range
                  ? 'bg-[var(--brand)] text-[var(--primary-foreground)]'
                  : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
              )}
            >
              {t('range', { days: range })}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex flex-col gap-[18px]">
        {error !== null && (
          <div className="rounded-[11px] border border-[var(--danger)]/30 bg-[var(--t-danger-bg)] px-4 py-3 text-sm text-[var(--t-danger-fg)]">
            {error || t('loadFailed')}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-[var(--text-3)]">{t('loading')}</p>
        ) : !bd ? null : (
          <>
            {/* Metric tiles */}
            <div className="grid grid-cols-2 gap-3 sm:gap-3.5 lg:grid-cols-4">
              <StatCard
                label={t('stats.toolCalls', { days: bd.days })}
                value={bd.total.toLocaleString()}
                hint={t('stats.toolCallsHint')}
                iconTone="info"
                icon={<ActivityStatIcon />}
              />
              <StatCard
                label={t('stats.successRate')}
                value={successRate != null ? `${successRate}%` : '—'}
                hint={t('stats.errors', { count: bd.errors })}
                hintTone={bd.errors > 0 ? 'warn' : 'ok'}
                iconTone={bd.errors > 0 ? 'warn' : 'emerald'}
                icon={<CheckStatIcon />}
              />
              <StatCard
                label={t('stats.proxyCalls')}
                value={bd.proxyCalls.toLocaleString()}
                hint={t('stats.proxyCallsHint')}
                iconTone="purple"
                icon={<ProxyStatIcon />}
              />
              <StatCard
                label={t('stats.estCost')}
                value={hasRates ? formatCost(bd.estCostMicros) : '—'}
                hint={hasRates ? t('stats.estCostHint') : t('stats.noRate')}
                iconTone="emerald"
                icon={<CostStatIcon />}
              />
            </div>

            {/* Invocations over time */}
            {an && (
              <Card className="p-5">
                <div className="mb-[18px] flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">{t('timeline.title')}</div>
                    <div className="mt-0.5 text-xs text-[var(--text-3)]">
                      {t('timeline.lastDays', { days: bd.days })}
                    </div>
                  </div>
                  <div className="flex gap-3.5 text-xs text-[var(--text-2)]">
                    <span className="flex items-center gap-[5px]">
                      <span className="h-2 w-2 rounded-sm bg-[var(--brand)]" />{t('timeline.success')}
                    </span>
                    <span className="flex items-center gap-[5px]">
                      <span className="h-2 w-2 rounded-sm bg-[var(--danger)]" />{t('timeline.error')}
                    </span>
                  </div>
                </div>
                <DailyTimeline daily={an.daily} />
              </Card>
            )}

            {/* Top tools + Calls by connector */}
            <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
              <Card className="p-5">
                <div className="mb-3.5 text-sm font-semibold">{t('topTools')}</div>
                <TopTools rows={an?.topTools ?? []} />
              </Card>
              <Breakdown title={t('byConnector')} rows={bd.byConnector} showDot />
            </div>

            {/* Secondary breakdowns */}
            <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
              <Breakdown title={t('byServer')} rows={bd.byServer} />
              <Breakdown title={t('byUser')} rows={bd.byUser} />
            </div>

            <p className="text-xs text-[var(--text-3)]">
              {t('costNote')}
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
  const t = useTranslations('analytics.timeline');
  const max = Math.max(1, ...daily.map((d) => d.success + d.error + d.timeout));
  // Thin the x-axis labels so they don't overlap on 30/90-day ranges. The
  // labels are centred under a column a few pixels wide, so the ones at the
  // very ends would hang off the chart: the offset keeps them inboard, and
  // every other label is dropped on a phone, where there is half the room.
  const labelEvery = Math.max(1, Math.ceil(daily.length / 8));
  const labelOffset = Math.floor(labelEvery / 2);
  return (
    <div className="flex h-[170px] items-end gap-1 sm:gap-1.5">
      {daily.map((d, i) => {
        const total = d.success + d.error + d.timeout;
        const errored = d.error + d.timeout;
        const height = (total / max) * 100;
        const errorPct = total > 0 ? (errored / total) * 100 : 0;
        const labelIndex = (i - labelOffset) / labelEvery;
        const showLabel = labelEvery === 1 || (Number.isInteger(labelIndex) && labelIndex >= 0);
        return (
          <div
            key={d.date}
            className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2"
            title={
              errored > 0
                ? t('dayTitleWithErrors', { date: d.date, total, errors: errored })
                : t('dayTitle', { date: d.date, total })
            }
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
            <span
              className={cn(
                'h-3 max-w-full overflow-visible whitespace-nowrap text-[10px] text-[var(--text-3)]',
                showLabel && labelEvery > 1 && labelIndex % 2 === 1 && 'max-sm:invisible'
              )}
            >
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
  const t = useTranslations('analytics');
  if (rows.length === 0) {
    return <p className="text-sm text-[var(--text-3)]">{t('noData')}</p>;
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
                <span className="text-[var(--danger)]"> · {t('errShort', { count: r.errors })}</span>
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
  const t = useTranslations('analytics');
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card className="p-5">
      <div className="mb-3.5 text-sm font-semibold">{title}</div>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--text-3)]">{t('noData')}</p>
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
                    <span className="text-[var(--danger)]"> · {t('errShort', { count: r.errors })}</span>
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
