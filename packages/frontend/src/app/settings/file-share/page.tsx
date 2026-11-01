'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { ApiError, fileSearch, fileShare, type FileSearchPolicy, type FileShareLimits, type FileShareLink } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Pager, formatBytes, formatDate, formatNumber, hintClass, inputClass, labelClass } from '@/components/file-search/shared';

/**
 * Settings → File Share (#1387): active links with who made them, for which
 * file, until when and how often they were downloaded, with Revoke; the File
 * Share connector for agents; and (Enterprise) the workspace policy.
 */
const PAGE_SIZE = 20;

/** "3 h", "2 d": how long a link still works. */
function remaining(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

export default function FileSharePage() {
  const t = useTranslations('fileShare');
  const locale = useLocale();
  const { token, user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [links, setLinks] = useState<FileShareLink[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [access, setAccess] = useState<'' | 'public' | 'internal'>('');
  const [mine, setMine] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [limits, setLimits] = useState<FileShareLimits | null>(null);
  const [usage, setUsage] = useState<{ storedBytes: number; activeLinks: number; linksToday: number } | null>(null);
  const [connector, setConnector] = useState<{ id: string; name: string } | null>(null);
  const [policy, setPolicy] = useState<{ policy: FileSearchPolicy; editable: boolean } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fileShare.list(token, { page, pageSize: PAGE_SIZE, q: search, access: access || undefined, mine });
      // The last link of a page was revoked: show the page before.
      if (!r.links.length && r.total > 0 && page > 1) {
        setPage(Math.ceil(r.total / PAGE_SIZE));
        return;
      }
      setLinks(r.links);
      setTotal(r.total);
      setLimits(r.limits);
      setUsage(r.usage);
      setConnector(r.connector);
      if (isAdmin) setPolicy(await fileSearch.policy(token));
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setLoaded(true);
    }
  }, [token, isAdmin, page, search, access, mine]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'ok', text: ok });
      await load();
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[18px] font-semibold text-[var(--text)]">{t('title')}</h1>
        <p className="mt-1 text-[13px] text-[var(--text-2)]">{t('subtitle')}</p>
      </div>

      {msg && (
        <p role="status" className={cn('rounded-[10px] px-3 py-2 text-[13px]', msg.tone === 'error' ? 'bg-[var(--t-danger-bg)] text-[var(--text)]' : 'bg-[var(--t-success-bg)] text-[var(--text)]')}>
          {msg.text}
        </p>
      )}

      {loaded && !limits && (
        <Card className="p-5">
          <h2 className="text-[14px] font-semibold text-[var(--text)]">{t('locked.title')}</h2>
          <p className="mt-1 text-[13px] text-[var(--text-2)]">{t('locked.text')}</p>
          <a href="/settings/license?source=file_search_licence" className="mt-3 inline-flex h-9 items-center rounded-[9px] bg-[var(--brand)] px-3.5 text-[13px] font-semibold text-[var(--primary-foreground)]">{t('locked.cta')}</a>
        </Card>
      )}

      {limits && usage && (
        <Card className="p-4 sm:p-5">
          <h2 className="text-[14px] font-semibold text-[var(--text)]">{t('usage.title', { plan: limits.plan })}</h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              [t('usage.stored'), `${formatBytes(usage.storedBytes)} / ${limits.maxStoredBytes != null ? formatBytes(limits.maxStoredBytes) : '∞'}`],
              [t('usage.today'), `${formatNumber(usage.linksToday, locale)} / ${formatNumber(limits.maxLinksPerDay, locale)}`],
              [t('usage.validity'), limits.maxTtlHours != null ? t('usage.hours', { n: limits.maxTtlHours }) : t('usage.noLimit')],
              [t('usage.fileSize'), formatBytes(limits.maxFileBytes)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-[10px] bg-[var(--surface-2)] p-3">
                <dt className="text-[11.5px] uppercase tracking-[0.04em] text-[var(--text-3)]">{k}</dt>
                <dd className="mt-0.5 text-[14px] font-semibold tabular-nums text-[var(--text)]">{v}</dd>
              </div>
            ))}
          </dl>
          <p className={hintClass}>{limits.publicLinks ? t('usage.publicOn') : t('usage.publicOff')}</p>
        </Card>
      )}

      {limits && (
        <Card className="p-4 sm:p-5">
          <h2 className="text-[14px] font-semibold text-[var(--text)]">{t('connector.title')}</h2>
          <p className="mt-1 text-[13px] text-[var(--text-2)]">{connector ? t('connector.on', { name: connector.name }) : t('connector.off')}</p>
          {!connector && isAdmin && (
            <Button className="mt-3 w-full sm:w-auto" disabled={busy} onClick={() => run(() => fileShare.addConnector(token!), t('connector.added'))}>
              {t('connector.add')}
            </Button>
          )}
        </Card>
      )}

      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold text-[var(--text)]">{t('links.title')}</h2>
          {loaded && <span className="text-[12px] tabular-nums text-[var(--text-3)]">{t('links.count', { n: total })}</span>}
        </div>
        {(total > 0 || search || access || mine) && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="search"
              aria-label={t('links.searchLabel')}
              placeholder={t('links.search')}
              className={cn(inputClass, 'sm:max-w-xs')}
              value={query}
              onChange={(e) => {
                const v = e.target.value;
                setQuery(v);
                if (searchTimer.current) clearTimeout(searchTimer.current);
                searchTimer.current = setTimeout(() => {
                  setPage(1);
                  setSearch(v);
                }, 300);
              }}
            />
            <select
              aria-label={t('links.allAccess')}
              className={cn(inputClass, 'sm:w-auto')}
              value={access}
              onChange={(e) => {
                setPage(1);
                setAccess(e.target.value as '' | 'public' | 'internal');
              }}
            >
              <option value="">{t('links.allAccess')}</option>
              <option value="public">{t('links.onlyPublic')}</option>
              <option value="internal">{t('links.onlyInternal')}</option>
            </select>
            {isAdmin && (
              <label className="flex items-center gap-2 text-[13px] text-[var(--text-2)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--brand)]"
                  checked={mine}
                  onChange={(e) => {
                    setPage(1);
                    setMine(e.target.checked);
                  }}
                />
                {t('links.mine')}
              </label>
            )}
          </div>
        )}
        {!links.length ? (
          <p className={hintClass}>{!loaded ? t('links.loading') : search || access || mine ? t('links.noMatch') : t('links.empty')}</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--border)]">
            {links.map((l) => {
              const left = remaining(l.expiresAt);
              return (
                <li key={l.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="break-words text-[13.5px] font-medium text-[var(--text)]">{l.filename}</div>
                    <div className="mt-0.5 text-[12px] text-[var(--text-3)]">
                      {[
                        formatBytes(l.bytes),
                        l.access === 'public' ? t('links.public') : t('links.internal'),
                        l.expiresAt ? (left ? t('links.expiresIn', { time: left }) : t('links.until', { date: formatDate(l.expiresAt, locale) })) : t('links.noExpiry'),
                        t('links.downloads', { n: l.downloadCount }),
                        l.createdBy ? t('links.by', { name: l.createdBy }) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    {l.entryPath && <div className="mt-0.5 break-all font-mono text-[11.5px] text-[var(--text-3)]">{l.entryPath}</div>}
                  </div>
                  {confirmId === l.id ? (
                    <div className="flex flex-col gap-2 sm:items-end">
                      <span className="text-[12.5px] text-[var(--text-2)]">{t('links.confirm')}</span>
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" className="flex-1 sm:flex-none" disabled={busy} onClick={() => setConfirmId(null)}>
                          {t('links.cancel')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          className="flex-1 sm:flex-none"
                          disabled={busy}
                          onClick={() => run(() => fileShare.revoke(l.id, token!), t('links.revoked')).then(() => setConfirmId(null))}
                        >
                          {t('links.confirmYes')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" variant="outlineDanger" className="self-start sm:self-auto" disabled={busy} onClick={() => setConfirmId(l.id)}>
                      {t('links.revoke')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} busy={busy} />
      </Card>

      {isAdmin && policy && !policy.editable && (
        <Card className="p-4 sm:p-5">
          <h2 className="text-[14px] font-semibold text-[var(--text)]">{t('policy.title')}</h2>
          <p className="mt-1 text-[13px] text-[var(--text-2)]">{t('policy.locked')}</p>
          <ul className="mt-3 grid gap-1.5 text-[12.5px] text-[var(--text-2)] sm:grid-cols-2">
            {(['publicLinks', 'aiDrafting', 'allowPlainFtp'] as const).map((k) => (
              <li key={k} className="flex justify-between gap-3 rounded-[8px] bg-[var(--surface-2)] px-3 py-2">
                <span>{t(`policy.${k}.label`)}</span>
                <span className="font-medium text-[var(--text)]">{policy.policy[k] ? t('policy.on') : t('policy.off')}</span>
              </li>
            ))}
            <li className="flex justify-between gap-3 rounded-[8px] bg-[var(--surface-2)] px-3 py-2">
              <span>{t('policy.maxTtl')}</span>
              <span className="font-medium text-[var(--text)]">{policy.policy.maxTtlHours ?? t('policy.planDefault')}</span>
            </li>
          </ul>
          <a href="/settings/license?source=file_search_licence" className="mt-3 inline-flex text-[13px] font-semibold text-[var(--brand)] hover:underline">
            {t('locked.cta')}
          </a>
        </Card>
      )}

      {isAdmin && policy?.editable && (
        <Card className="p-4 sm:p-5">
          <h2 className="text-[14px] font-semibold text-[var(--text)]">{t('policy.title')}</h2>
          <p className={hintClass}>{t('policy.intro')}</p>
          <div className="mt-3 space-y-3">
            {(['publicLinks', 'aiDrafting', 'allowPlainFtp'] as const).map((k) => (
              <label key={k} className="flex items-start gap-2.5 text-[13px]">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
                  checked={policy.policy[k]}
                  disabled={busy}
                  onChange={(e) => run(() => fileSearch.setPolicy({ [k]: e.target.checked }, token!), t('policy.saved'))}
                />
                <span>
                  <span className="font-medium text-[var(--text)]">{t(`policy.${k}.label`)}</span>
                  <span className="block text-[12.5px] text-[var(--text-3)]">{t(`policy.${k}.hint`)}</span>
                </span>
              </label>
            ))}
            <div className="max-w-xs">
              <label className={labelClass} htmlFor="fsp-ttl">{t('policy.maxTtl')}</label>
              <input
                id="fsp-ttl"
                className={inputClass}
                inputMode="numeric"
                disabled={busy}
                defaultValue={policy.policy.maxTtlHours ?? ''}
                placeholder={t('policy.maxTtlPlaceholder')}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  void run(() => fileSearch.setPolicy({ maxTtlHours: v > 0 ? v : null }, token!), t('policy.saved'));
                }}
              />
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
