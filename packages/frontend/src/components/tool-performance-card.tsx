'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { audit, connectors, mcpServers, type Connector, type McpServer } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AppSelect } from '@/components/ui/select';

const PAGE_SIZE = 25;
const HOURS = [24, 168, 720];

type Performance = Awaited<ReturnType<typeof audit.toolPerformance>>;

export function ToolPerformanceCard() {
  const { token } = useAuth();
  const t = useTranslations('analytics.performance');
  const format = useFormatter();
  const locale = useLocale();
  const [query, setQuery] = useState({ hours: 24, connectorId: '', mcpServerId: '', page: 0, attempt: 0 });
  const [result, setResult] = useState<{
    query: typeof query;
    token: string;
    data: Performance | null;
    error: boolean;
  } | null>(null);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [options, setOptions] = useState<{
    token: string;
    connectors: Connector[];
    servers: McpServer[];
    error: boolean;
  } | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    Promise.all([connectors.list(token), mcpServers.list(token)])
      .then(([connectorList, serverList]) => {
        if (!cancelled) setOptions({ token, connectors: connectorList, servers: serverList, error: false });
      })
      .catch(() => {
        if (!cancelled) setOptions({ token, connectors: [], servers: [], error: true });
      });
    return () => { cancelled = true; };
  }, [token, optionsAttempt]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    audit.toolPerformance(token, {
      hours: query.hours,
      limit: PAGE_SIZE,
      offset: query.page * PAGE_SIZE,
      connectorId: query.connectorId,
      mcpServerId: query.mcpServerId,
    })
      .then((data) => {
        if (!cancelled) setResult({ query, token, data, error: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ query, token, data: null, error: true });
      });
    return () => { cancelled = true; };
  }, [token, query]);

  // A new selection shows loading immediately; an older response cannot label it.
  const current = result?.query === query && result.token === token ? result : null;
  const loading = current === null;
  const data = current?.data;
  const choices = options?.token === token ? options : null;
  const setFilter = (filter: 'connectorId' | 'mcpServerId', value: string) =>
    setQuery((previous) => ({ ...previous, [filter]: value, page: 0 }));
  const latency = (value: number | null) => value === null ? '—' : `${format.number(value, { maximumFractionDigits: 1 })} ms`;

  return (
    <Card className="min-w-0 overflow-hidden" role="region" aria-labelledby="tool-performance-title">
      <div className="p-5 pb-4">
        <h2 id="tool-performance-title" className="text-sm font-semibold">{t('title')}</h2>
        <p className="mt-1 text-xs text-[var(--text-3)]">{t('description')}</p>
        <div className="mt-4 flex flex-wrap gap-2.5">
          <AppSelect
            aria-label={t('range')}
            value={String(query.hours)}
            onValueChange={(value) => setQuery((previous) => ({ ...previous, hours: Number(value), page: 0 }))}
            options={HOURS.map((hours) => ({ value: String(hours), label: t(`ranges.${hours}`) }))}
            className="h-[34px] rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[12.5px] text-[var(--text-2)]"
          />
          <AppSelect
            aria-label={t('connector')}
            value={query.connectorId}
            onValueChange={(value) => setFilter('connectorId', value)}
            disabled={!choices || choices.error}
            options={[
              { value: '', label: t('allConnectors') },
              ...(choices?.connectors ?? []).map((connector) => ({ value: connector.id, label: connector.name })),
            ]}
            className="h-[34px] max-w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[12.5px] text-[var(--text-2)]"
          />
          <AppSelect
            aria-label={t('server')}
            value={query.mcpServerId}
            onValueChange={(value) => setFilter('mcpServerId', value)}
            disabled={!choices || choices.error}
            options={[
              { value: '', label: t('allServers') },
              ...(choices?.servers ?? []).map((server) => ({ value: server.id, label: server.name })),
            ]}
            className="h-[34px] max-w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[12.5px] text-[var(--text-2)]"
          />
        </div>
        {choices?.error && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--danger)]" role="alert">
            <span>{t('filtersFailed')}</span>
            <Button variant="secondary" size="sm" onClick={() => setOptionsAttempt((attempt) => attempt + 1)}>{t('retry')}</Button>
          </div>
        )}
      </div>

      <div aria-busy={loading}>
        {loading ? (
          <p className="px-5 pb-5 text-sm text-[var(--text-3)]" role="status">{t('loading')}</p>
        ) : current.error ? (
          <div className="flex flex-wrap items-center gap-3 px-5 pb-5" role="alert">
            <p className="text-sm text-[var(--danger)]">{t('loadFailed')}</p>
            <Button variant="secondary" size="sm" onClick={() => setQuery((previous) => ({ ...previous, attempt: previous.attempt + 1 }))}>{t('retry')}</Button>
          </div>
        ) : !data?.items.length ? (
          <p className="px-5 pb-5 text-sm text-[var(--text-3)]">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] text-left text-xs">
              <caption className="sr-only">{t('title')}</caption>
              <thead className="border-y border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-3)]">
                <tr>
                  {['tool', 'server', 'calls', 'errorRate', 'p50', 'p95', 'p99', 'lastError'].map((column) => (
                    <th key={column} scope="col" className="px-4 py-3 font-medium">{t(`columns.${column}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {data.items.map((row) => (
                  <tr key={`${row.toolId}:${row.connectorId}:${row.mcpServerId ?? ''}`}>
                    <td className="max-w-[230px] px-4 py-3 align-top">
                      <div className="break-words font-mono text-[var(--text)]">{row.toolName}</div>
                      <div className="mt-1 break-words text-[var(--text-3)]">{row.connectorName}</div>
                    </td>
                    <td className="max-w-[160px] break-words px-4 py-3 align-top text-[var(--text-2)]">{row.mcpServerName ?? row.mcpServerId ?? t('noServer')}</td>
                    <td className="px-4 py-3 align-top tabular-nums">{format.number(row.calls)}</td>
                    <td className="px-4 py-3 align-top tabular-nums">
                      <div className={row.errors > 0 ? 'text-[var(--danger)]' : 'text-[var(--text-2)]'}>{format.number(row.errorRate, { maximumFractionDigits: 2 })}%</div>
                      <div className="mt-1 whitespace-nowrap text-[10px] text-[var(--text-3)]">{t('errors', { count: row.errors })}</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 align-top tabular-nums">
                      {latency(row.p50Ms)}
                      <div className="mt-1 text-[10px] text-[var(--text-3)]">{t('samples', { count: row.latencySampleCount })}</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 align-top tabular-nums">{latency(row.p95Ms)}</td>
                    <td className="whitespace-nowrap px-4 py-3 align-top tabular-nums">{latency(row.p99Ms)}</td>
                    <td className="w-[240px] max-w-[300px] px-4 py-3 align-top">
                      {row.lastError !== null ? (
                        <details className="group">
                          <summary className="flex cursor-pointer list-none items-start gap-1 break-words text-[var(--danger)] [&::-webkit-details-marker]:hidden">
                            <ChevronRight aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
                            <span className="min-w-0 line-clamp-2">{row.lastError || t('showError')}</span>
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap break-words text-[var(--text-2)]">{row.lastError}</p>
                          {row.lastErrorAt && <time dateTime={row.lastErrorAt} className="mt-1 block text-[10px] text-[var(--text-3)]">{new Date(row.lastErrorAt).toLocaleString(locale)}</time>}
                        </details>
                      ) : <span className="text-[var(--text-3)]">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-3">
        <span className="text-xs text-[var(--text-3)]">{t('page', { page: query.page + 1 })}</span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={loading || query.page === 0} onClick={() => setQuery((previous) => ({ ...previous, page: previous.page - 1 }))}>{t('previous')}</Button>
          <Button variant="secondary" size="sm" disabled={loading || !data?.hasMore} onClick={() => setQuery((previous) => ({ ...previous, page: previous.page + 1 }))}>{t('next')}</Button>
        </div>
        <p className="w-full text-xs text-[var(--text-3)]">{t('samplingNote')}</p>
      </div>
    </Card>
  );
}
