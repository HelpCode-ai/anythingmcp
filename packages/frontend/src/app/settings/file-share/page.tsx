'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { ApiError, fileSearch, fileShare, type FileSearchPolicy, type FileShareLimits, type FileShareLink } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatBytes, formatDate, formatNumber, hintClass, inputClass, labelClass } from '@/components/file-search/shared';

/**
 * Settings → File Share (#1387): active links with who made them, for which
 * file, until when and how often they were downloaded, with Revoke; the File
 * Share connector for agents; and (Enterprise) the workspace policy.
 */
export default function FileSharePage() {
  const t = useTranslations('fileShare');
  const locale = useLocale();
  const { token, user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [links, setLinks] = useState<FileShareLink[]>([]);
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
      const r = await fileShare.list(token);
      setLinks(r.links);
      setLimits(r.limits);
      setUsage(r.usage);
      setConnector(r.connector);
      if (isAdmin) setPolicy(await fileSearch.policy(token));
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setLoaded(true);
    }
  }, [token, isAdmin]);

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
        <h2 className="text-[14px] font-semibold text-[var(--text)]">{t('links.title')}</h2>
        {!links.length ? (
          <p className={hintClass}>{loaded ? t('links.empty') : t('links.loading')}</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--border)]">
            {links.map((l) => (
              <li key={l.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="break-words text-[13.5px] font-medium text-[var(--text)]">{l.filename}</div>
                  <div className="mt-0.5 text-[12px] text-[var(--text-3)]">
                    {[
                      formatBytes(l.bytes),
                      l.access === 'public' ? t('links.public') : t('links.internal'),
                      l.expiresAt ? t('links.until', { date: formatDate(l.expiresAt, locale) }) : t('links.noExpiry'),
                      t('links.downloads', { n: l.downloadCount }),
                      l.createdBy ? t('links.by', { name: l.createdBy }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {l.entryPath && <div className="mt-0.5 break-all font-mono text-[11.5px] text-[var(--text-3)]">{l.entryPath}</div>}
                </div>
                <Button size="sm" variant="outlineDanger" className="w-full sm:w-auto" disabled={busy} onClick={() => run(() => fileShare.revoke(l.id, token!), t('links.revoked'))}>
                  {t('links.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {isAdmin && policy && (
        <Card className="p-4 sm:p-5">
          <h2 className="text-[14px] font-semibold text-[var(--text)]">{t('policy.title')}</h2>
          <p className={hintClass}>{policy.editable ? t('policy.intro') : t('policy.enterprise')}</p>
          <div className="mt-3 space-y-3">
            {(['publicLinks', 'aiDrafting', 'allowPlainFtp'] as const).map((k) => (
              <label key={k} className="flex items-start gap-2.5 text-[13px]">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
                  checked={policy.policy[k]}
                  disabled={!policy.editable || busy}
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
                disabled={!policy.editable || busy}
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
