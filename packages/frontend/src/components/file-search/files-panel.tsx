'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth-context';
import { ApiError, fileSearch, type FileSearchOverview, type FileTreeNode } from '@/lib/api';
import { cn } from '@/lib/utils';
import { FolderTree, formatBytes, formatDate, formatNumber, hintClass, inputClass, intervalLabel, labelClass } from './shared';

/**
 * The Files tab of a File Search connector (#1385): sync state and progress,
 * pause banners with the way out (Upgrade, Edit selection, Resume), counts
 * against the plan, runs and problem files, the description the AI reads,
 * and (Enterprise) folder permissions per role.
 */

const STATE_TONE: Record<string, string> = {
  active: 'bg-[var(--t-success-bg)] text-[var(--t-success-fg)]',
  syncing: 'bg-[var(--t-info-bg)] text-[var(--t-info-fg)]',
  draft: 'bg-[var(--t-neutral-bg)] text-[var(--t-neutral-fg)]',
  paused_quota: 'bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]',
  paused_licence: 'bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]',
  paused_error: 'bg-[var(--t-warn-bg)] text-[var(--t-warn-fg)]',
  paused_admin: 'bg-[var(--t-neutral-bg)] text-[var(--t-neutral-fg)]',
};

function err(e: unknown) {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
}

export function FilesPanel({ connectorId }: { connectorId: string }) {
  const t = useTranslations('fileSearch');
  const locale = useLocale();
  const { token, user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [o, setO] = useState<FileSearchOverview | null>(null);
  const [problems, setProblems] = useState<Array<{ path: string; status: string; lastError: string | null; size: number; attempts: number }>>([]);
  const [tree, setTree] = useState<FileTreeNode | null>(null);
  const [showTree, setShowTree] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');
  const [instructions, setInstructions] = useState('');
  const [editing, setEditing] = useState(false);
  const [rules, setRules] = useState<{ editable: boolean; roles: Array<{ id: string; name: string }>; rules: Array<{ roleId: string; pattern: string; effect: 'allow' | 'deny' }> } | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const ov = await fileSearch.overview(connectorId, token);
      setO(ov);
      if (!editing) {
        setSummary(ov.status.summary ?? '');
        setInstructions(ov.connector.instructions ?? '');
      }
      fileSearch.problems(connectorId, token).then(setProblems).catch(() => undefined);
    } catch (e) {
      setMsg({ tone: 'error', text: err(e) });
    }
  }, [token, connectorId, editing]);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow a running sync.
  useEffect(() => {
    if (!o || o.status.state !== 'syncing') return;
    const id = setInterval(() => void load(), 4000);
    return () => clearInterval(id);
  }, [o, load]);

  useEffect(() => {
    if (!token || !showTree || tree) return;
    fileSearch.tree(connectorId, token).then(setTree).catch(() => undefined);
  }, [token, showTree, tree, connectorId]);

  useEffect(() => {
    if (!token || !isAdmin) return;
    fileSearch.accessRules(connectorId, token).then(setRules).catch(() => undefined);
  }, [token, isAdmin, connectorId]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'ok', text: ok });
      await load();
    } catch (e) {
      setMsg({ tone: 'error', text: err(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!o) return <Card className="p-5 text-[13px] text-[var(--text-3)]">{msg?.text ?? t('loading')}</Card>;

  const s = o.status;
  const quota = o.access.allowed ? o.access.quota : null;
  const next = o.access.allowed ? o.access.next : null;
  const filesPct = quota?.maxFiles ? Math.min(100, Math.round((o.usage.files / quota.maxFiles) * 100)) : null;
  const manualLeft = quota?.manualSyncsPerDay != null ? Math.max(0, quota.manualSyncsPerDay - o.manualSyncsToday) : null;
  const paused = s.state.startsWith('paused_');

  if (s.state === 'draft') {
    return (
      <Card className="p-5">
        <div className="text-[14px] font-semibold text-[var(--text)]">{t('panel.draftTitle')}</div>
        <p className="mt-1 text-[13px] text-[var(--text-2)]">{t('panel.draftText')}</p>
        <Link href={`/connectors/new/file-search?id=${connectorId}&step=3`} className="mt-3 inline-flex h-9 items-center rounded-[9px] bg-[var(--brand)] px-3.5 text-[13px] font-semibold text-[var(--primary-foreground)]">
          {t('panel.continueSetup')}
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-4" id="files">
      {paused && (
        <div role="alert" className={cn('rounded-[12px] border p-4', s.state === 'paused_admin' ? 'border-[var(--border)] bg-[var(--surface-2)]' : 'border-[var(--danger)] bg-[var(--t-danger-bg)]')}>
          <div className="text-[14px] font-semibold text-[var(--text)]">{t(`panel.paused.${s.state}`)}</div>
          {s.pausedReason && <p className="mt-1 text-[13px] leading-[1.55] text-[var(--text)]">{s.pausedReason}</p>}
          <p className="mt-1 text-[12.5px] text-[var(--text-2)]">{t('panel.paused.stillSearching', { date: formatDate(s.lastSuccessAt, locale) })}</p>
          {isAdmin && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              {(s.state === 'paused_quota' || s.state === 'paused_licence') && (
                <Link href={`/settings/license?source=${s.state === 'paused_quota' ? 'file_quota' : 'file_search_licence'}`} className="inline-flex h-9 items-center justify-center rounded-[9px] bg-[var(--brand)] px-3.5 text-[13px] font-semibold text-[var(--primary-foreground)]">
                  {next ? t('panel.upgradeTo', { plan: next.plan }) : t('upgrade')}
                </Link>
              )}
              {s.state === 'paused_quota' && (
                <Link href={`/connectors/new/file-search?id=${connectorId}&step=3`} className="inline-flex h-9 items-center justify-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[13px] font-semibold text-[var(--text-2)]">
                  {t('panel.editSelection')}
                </Link>
              )}
              {s.state !== 'paused_licence' && (
                <Button variant="secondary" disabled={busy} onClick={() => act(() => fileSearch.resume(connectorId, token!), t('panel.resumed'))}>
                  {t('panel.resume')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={cn('rounded-full px-2.5 py-0.5 text-[12px] font-semibold', STATE_TONE[s.state] ?? STATE_TONE.active)}>{t(`states.${s.state}`)}</span>
          {s.summary && <span className="min-w-0 text-[13px] text-[var(--text-2)]">{s.summary}</span>}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-[10px] bg-[var(--surface-2)] p-3">
            <dt className="text-[11.5px] uppercase tracking-[0.04em] text-[var(--text-3)]">{t('panel.indexed')}</dt>
            <dd className="mt-0.5 text-[16px] font-semibold tabular-nums text-[var(--text)]">{formatNumber(s.byStatus.indexed ?? 0, locale)}</dd>
            <dd className="text-[12px] text-[var(--text-3)]">{t('panel.ofFiles', { n: formatNumber(s.files, locale) })}</dd>
          </div>
          <div className="rounded-[10px] bg-[var(--surface-2)] p-3">
            <dt className="text-[11.5px] uppercase tracking-[0.04em] text-[var(--text-3)]">{t('panel.size')}</dt>
            <dd className="mt-0.5 text-[16px] font-semibold tabular-nums text-[var(--text)]">{formatBytes(s.bytes)}</dd>
            <dd className="text-[12px] text-[var(--text-3)]">{t('panel.chars', { n: formatNumber(s.textChars, locale) })}</dd>
          </div>
          <div className="rounded-[10px] bg-[var(--surface-2)] p-3">
            <dt className="text-[11.5px] uppercase tracking-[0.04em] text-[var(--text-3)]">{t('panel.lastSync')}</dt>
            <dd className="mt-0.5 text-[13.5px] font-semibold text-[var(--text)]">{formatDate(s.lastSuccessAt, locale)}</dd>
          </div>
          <div className="rounded-[10px] bg-[var(--surface-2)] p-3">
            <dt className="text-[11.5px] uppercase tracking-[0.04em] text-[var(--text-3)]">{t('panel.nextSync')}</dt>
            <dd className="mt-0.5 text-[13.5px] font-semibold text-[var(--text)]">{s.state === 'syncing' ? t('panel.now') : formatDate(s.nextSyncAt, locale)}</dd>
            {s.syncIntervalMinutes && <dd className="text-[12px] text-[var(--text-3)]">{intervalLabel(s.syncIntervalMinutes, t)}</dd>}
          </div>
        </dl>

        {quota && (
          <div className="mt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12.5px] text-[var(--text-2)]">
              <span>{t('panel.planUsage', { used: formatNumber(o.usage.files, locale), max: formatNumber(quota.maxFiles, locale), plan: quota.plan })}</span>
              {filesPct != null && filesPct >= 80 && <span className="font-medium text-[var(--t-warn-fg)]">{t('panel.nearLimit', { pct: filesPct })}</span>}
            </div>
            {filesPct != null && (
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-[var(--border)]" aria-hidden>
                <div className="h-full rounded-full" style={{ width: `${Math.max(filesPct, 2)}%`, background: filesPct >= 100 ? 'var(--danger)' : filesPct >= 80 ? 'var(--warn, #d97706)' : 'var(--brand)' }} />
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button disabled={busy || s.state === 'syncing' || s.state === 'paused_licence' || manualLeft === 0} onClick={() => act(() => fileSearch.syncNow(connectorId, token!), t('panel.syncQueued'))}>
            {s.state === 'syncing' ? t('panel.syncing') : t('panel.syncNow')}
          </Button>
          {isAdmin && !paused && (
            <Button variant="secondary" disabled={busy} onClick={() => act(() => fileSearch.pause(connectorId, token!), t('panel.pausedMsg'))}>
              {t('panel.pause')}
            </Button>
          )}
          {isAdmin && (
            <Link href={`/connectors/new/file-search?id=${connectorId}&step=3`} className="inline-flex h-9 items-center justify-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[13px] font-semibold text-[var(--text-2)] hover:text-[var(--text)]">
              {t('panel.editSelection')}
            </Link>
          )}
          {isAdmin && quota && (
            <select
              aria-label={t('activate.interval')}
              className={cn(inputClass, 'sm:w-auto')}
              value={s.syncIntervalMinutes ?? 1440}
              onChange={(e) => act(() => fileSearch.setSchedule(connectorId, Number(e.target.value), token!), t('panel.scheduleSaved'))}
            >
              {[5, 15, 60, 360, 1440, 10080].map((m) => (
                <option key={m} value={m} disabled={m < quota.minIntervalMinutes}>
                  {intervalLabel(m, t)}{m < quota.minIntervalMinutes ? ` — ${t('activate.higherPlan')}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        {manualLeft != null && <p className={hintClass}>{t('panel.manualLeft', { n: manualLeft })}</p>}
        {msg && (
          <p role="status" className={cn('mt-2 text-[13px]', msg.tone === 'error' ? 'text-[var(--danger)]' : 'text-[var(--t-success-fg)]')}>
            {msg.text}
          </p>
        )}
      </Card>

      {/* Description */}
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[14px] font-semibold text-[var(--text)]">{t('panel.description')}</h3>
          {isAdmin && !editing && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{t('panel.edit')}</Button>
          )}
        </div>
        {o.instructionsDraft && o.instructionsDraft !== o.connector.instructions && isAdmin && !editing && (
          <div className="mt-3 rounded-[10px] border border-[var(--brand)] bg-[var(--brand-tint)] p-3 text-[13px]">
            {t('panel.newDraft')}{' '}
            <button type="button" className="font-semibold text-[var(--brand)] underline" onClick={() => { setInstructions(o.instructionsDraft!); setEditing(true); }}>
              {t('panel.reviewDraft')}
            </button>
          </div>
        )}
        {editing ? (
          <div className="mt-3 space-y-3">
            <div>
              <label className={labelClass} htmlFor="fp-summary">{t('describe.summary')}</label>
              <input id="fp-summary" className={inputClass} maxLength={160} value={summary} onChange={(e) => setSummary(e.target.value)} />
            </div>
            <div>
              <label className={labelClass} htmlFor="fp-instr">{t('describe.instructions')}</label>
              <textarea id="fp-instr" className={cn(inputClass, 'h-56 py-2')} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" onClick={() => { setEditing(false); setSummary(s.summary ?? ''); setInstructions(o.connector.instructions ?? ''); }}>{t('cancel')}</Button>
              <Button disabled={busy} onClick={() => act(async () => { await fileSearch.setDescription(connectorId, { summary, instructions }, token!); setEditing(false); }, t('panel.descriptionSaved'))}>
                {t('panel.save')}
              </Button>
            </div>
          </div>
        ) : (
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-[var(--surface-2)] p-3 font-sans text-[12.5px] leading-[1.55] text-[var(--text-2)]">
            {o.connector.instructions || t('panel.noDescription')}
          </pre>
        )}
      </Card>

      {/* Runs */}
      <Card className="p-4 sm:p-5">
        <h3 className="text-[14px] font-semibold text-[var(--text)]">{t('panel.runs')}</h3>
        {s.runs.length ? (
          <ul className="mt-3 divide-y divide-[var(--border)]">
            {s.runs.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 py-2.5 text-[12.5px] sm:flex-row sm:items-center sm:gap-3">
                <span className="w-40 shrink-0 text-[var(--text-2)]">{formatDate(r.startedAt, locale)}</span>
                <span className={cn('w-24 shrink-0 font-semibold', r.status === 'failed' ? 'text-[var(--danger)]' : r.status === 'paused' ? 'text-[var(--t-warn-fg)]' : 'text-[var(--text)]')}>{t(`runStatus.${r.status}`)}</span>
                <span className="min-w-0 text-[var(--text-3)]">
                  {r.error
                    ? r.error
                    : t('panel.runCounters', {
                        listed: formatNumber(r.counters.listed ?? 0, locale),
                        added: formatNumber((r.counters.new ?? 0) + (r.counters.changed ?? 0), locale),
                        extracted: formatNumber(r.counters.extracted ?? 0, locale),
                        deleted: formatNumber(r.counters.deleted ?? 0, locale),
                      })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={hintClass}>{t('panel.noRuns')}</p>
        )}
      </Card>

      {/* Problems */}
      {problems.length > 0 && (
        <Card className="p-4 sm:p-5">
          <h3 className="text-[14px] font-semibold text-[var(--text)]">{t('panel.problems', { n: problems.length })}</h3>
          <p className={hintClass}>{t('panel.problemsHint')}</p>
          <ul className="mt-3 space-y-2">
            {problems.slice(0, 50).map((p) => (
              <li key={p.path} className="rounded-[9px] bg-[var(--surface-2)] p-2.5 text-[12.5px]">
                <div className="break-all font-mono text-[var(--text)]">{p.path}</div>
                <div className="mt-0.5 text-[var(--text-3)]">{t(`entryStatus.${p.status}`)}{p.lastError ? ` — ${p.lastError}` : ''}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Folders */}
      <Card className="p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[14px] font-semibold text-[var(--text)]">{t('panel.folders')}</h3>
          <Button size="sm" variant="ghost" onClick={() => setShowTree((v) => !v)} aria-expanded={showTree}>{showTree ? t('panel.hide') : t('panel.show')}</Button>
        </div>
        {showTree && (tree ? <div className="mt-3"><FolderTree root={tree} excluded={new Set()} readOnly /></div> : <p className={hintClass}>{t('loading')}</p>)}
      </Card>

      {/* Folder permissions */}
      {isAdmin && rules && (
        <Card className="p-4 sm:p-5">
          <h3 className="text-[14px] font-semibold text-[var(--text)]">{t('rules.title')}</h3>
          <p className={hintClass}>{rules.editable ? t('rules.intro') : t('rules.enterprise')}</p>
          {rules.editable && (
            <div className="mt-3 space-y-2">
              {rules.rules.map((r, i) => (
                <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_110px_1.5fr_auto]">
                  <select aria-label={t('rules.role')} className={inputClass} value={r.roleId} onChange={(e) => setRules({ ...rules, rules: rules.rules.map((x, j) => (j === i ? { ...x, roleId: e.target.value } : x)) })}>
                    {rules.roles.map((ro) => <option key={ro.id} value={ro.id}>{ro.name}</option>)}
                  </select>
                  <select aria-label={t('rules.effect')} className={inputClass} value={r.effect} onChange={(e) => setRules({ ...rules, rules: rules.rules.map((x, j) => (j === i ? { ...x, effect: e.target.value as 'allow' | 'deny' } : x)) })}>
                    <option value="allow">{t('rules.allow')}</option>
                    <option value="deny">{t('rules.deny')}</option>
                  </select>
                  <input aria-label={t('rules.folder')} className={cn(inputClass, 'font-mono')} placeholder="Suppliers/Nordtor - 70100" value={r.pattern} onChange={(e) => setRules({ ...rules, rules: rules.rules.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)) })} />
                  <Button variant="ghost" size="sm" onClick={() => setRules({ ...rules, rules: rules.rules.filter((_, j) => j !== i) })}>{t('rules.remove')}</Button>
                </div>
              ))}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="secondary" size="sm" disabled={!rules.roles.length} onClick={() => setRules({ ...rules, rules: [...rules.rules, { roleId: rules.roles[0]?.id ?? '', pattern: '', effect: 'allow' }] })}>
                  {t('rules.add')}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => act(() => fileSearch.setAccessRules(connectorId, rules.rules.filter((r) => r.pattern.trim()), token!), t('rules.saved'))}>
                  {t('panel.save')}
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
