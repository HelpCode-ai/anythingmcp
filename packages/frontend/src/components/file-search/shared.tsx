'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { FileSearchAccess, FileSearchBudget, FileSourceTestResult, FileTreeNode } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export const inputClass =
  'h-9 w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--border-strong)] focus-visible:ring-2 focus-visible:ring-[var(--brand-ring)]';
export const labelClass = 'mb-1.5 block text-[12.5px] font-medium text-[var(--text)]';
export const hintClass = 'mt-1 text-[12px] leading-[1.5] text-[var(--text-3)]';

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatNumber(n: number | null | undefined, locale?: string): string {
  if (n == null) return '∞';
  return n.toLocaleString(locale);
}

export function formatDate(iso: string | null | undefined, locale?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function intervalLabel(minutes: number, t: ReturnType<typeof useTranslations>): string {
  if (minutes % (7 * 24 * 60) === 0) return t('interval.weekly');
  if (minutes % (24 * 60) === 0) return t('interval.daily');
  if (minutes % 60 === 0) return minutes === 60 ? t('interval.hourly') : t('interval.hours', { n: minutes / 60 });
  return t('interval.minutes', { n: minutes });
}

/** Wizard step 2: what the test checked, one line per step. */
export function TestChecklist({ result }: { result: FileSourceTestResult }) {
  const t = useTranslations('fileSearch');
  return (
    <ol className="space-y-1.5" aria-label={t('test.checklist')}>
      {result.steps.map((s) => (
        <li key={s.key} className="flex items-start gap-2.5 text-[13px]">
          <span
            aria-hidden
            className={cn(
              'mt-[2px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
              s.ok ? 'bg-[var(--t-success-bg)] text-[var(--t-success-fg)]' : 'bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]',
            )}
          >
            {s.ok ? '✓' : '!'}
          </span>
          <span className="min-w-0">
            <span className={cn('font-medium', s.ok ? 'text-[var(--text)]' : 'text-[var(--danger)]')}>{t(`test.steps.${s.key}`)}</span>
            {!s.ok && s.detail && <span className="mt-0.5 block text-[12.5px] text-[var(--text-2)]">{s.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Live budget: selected files and bytes against the plan. */
export function BudgetBar({ budget, onUpgrade }: { budget: FileSearchBudget; onUpgrade?: () => void }) {
  const t = useTranslations('fileSearch');
  const used = budget.files + budget.usedByOtherConnectors.files;
  const max = budget.maxFiles;
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const bytesUsed = budget.bytes + budget.usedByOtherConnectors.bytes;
  const bytesPct = budget.maxBytes ? Math.min(100, Math.round((bytesUsed / budget.maxBytes) * 100)) : 0;
  const tone = !budget.fits ? 'var(--danger)' : pct >= 80 || bytesPct >= 80 ? 'var(--warn, #d97706)' : 'var(--ok, #16a34a)';
  return (
    <div className={cn('rounded-[12px] border p-3.5', budget.fits ? 'border-[var(--border)] bg-[var(--surface-2)]' : 'border-[var(--danger)] bg-[var(--t-danger-bg)]')} role="status" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="text-[13px] font-semibold text-[var(--text)]">
          {t('budget.selected', { files: formatNumber(budget.files), size: formatBytes(budget.bytes) })}
        </div>
        <div className="text-[12.5px] text-[var(--text-2)]">
          {max == null ? t('budget.unlimited') : t('budget.plan', { plan: budget.plan, max: formatNumber(max) })}
        </div>
      </div>
      {max != null && (
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--border)]" aria-hidden>
          <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(pct, 2)}%`, background: tone }} />
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--text-3)]">
        <span>{t('budget.textFiles', { n: formatNumber(budget.textFiles) })}</span>
        {budget.nameOnly > 0 && <span>{t('budget.nameOnly', { n: formatNumber(budget.nameOnly) })}</span>}
        {budget.tooLarge > 0 && <span>{t('budget.tooLarge', { n: formatNumber(budget.tooLarge), max: formatBytes(budget.maxFileBytes) })}</span>}
        {budget.usedByOtherConnectors.files > 0 && <span>{t('budget.others', { n: formatNumber(budget.usedByOtherConnectors.files) })}</span>}
        {budget.maxBytes != null && <span>{t('budget.bytes', { used: formatBytes(bytesUsed), max: formatBytes(budget.maxBytes) })}</span>}
      </div>
      {!budget.fits && (
        <div className="mt-3 flex flex-col gap-2 border-t border-[var(--danger)]/30 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12.5px] text-[var(--text)]">
            {budget.next
              ? t('budget.overWithNext', { plan: budget.next.plan, max: formatNumber(budget.next.quota.maxFiles) })
              : t('budget.over')}
          </p>
          {onUpgrade && (
            <Button size="sm" variant="primary" onClick={onUpgrade} className="w-full sm:w-auto">
              {t('upgrade')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Folder tree with checkboxes and counts; unticking a folder excludes it and everything below. */
export function FolderTree({
  root,
  excluded,
  onToggle,
  readOnly = false,
}: {
  root: FileTreeNode;
  excluded: Set<string>;
  onToggle?: (path: string, include: boolean) => void;
  readOnly?: boolean;
}) {
  const t = useTranslations('fileSearch');
  const [open, setOpen] = useState<Set<string>>(() => new Set(root.children.length <= 8 ? root.children.map((c) => c.path) : []));
  const [query, setQuery] = useState('');
  const isExcluded = (p: string) => [...excluded].some((e) => p === e || p.startsWith(e + '/'));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return root.children;
    const keep = (n: FileTreeNode): FileTreeNode | null => {
      const kids = n.children.map(keep).filter(Boolean) as FileTreeNode[];
      return n.name.toLowerCase().includes(q) || kids.length ? { ...n, children: kids } : null;
    };
    return root.children.map(keep).filter(Boolean) as FileTreeNode[];
  }, [root, query]);

  const Row = ({ n, depth }: { n: FileTreeNode; depth: number }) => {
    const ex = isExcluded(n.path);
    const parentEx = [...excluded].some((e) => n.path.startsWith(e + '/'));
    const expanded = open.has(n.path) || !!query.trim();
    return (
      <li>
        <div className={cn('flex min-h-[36px] items-center gap-2 rounded-[8px] pr-2 text-[13px] hover:bg-[var(--surface-2)]', ex && 'opacity-60')} style={{ paddingLeft: 4 + depth * 16 }}>
          {n.children.length ? (
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--text-3)] hover:text-[var(--text)]"
              aria-label={expanded ? t('tree.collapse', { name: n.name }) : t('tree.expand', { name: n.name })}
              aria-expanded={expanded}
              onClick={() => setOpen((s) => { const x = new Set(s); if (x.has(n.path)) x.delete(n.path); else x.add(n.path); return x; })}
            >
              <span className={cn('inline-block transition-transform', expanded && 'rotate-90')}>›</span>
            </button>
          ) : (
            <span className="w-7 shrink-0" />
          )}
          {!readOnly && (
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 accent-[var(--brand)]"
              checked={!ex}
              disabled={parentEx}
              aria-label={t('tree.include', { name: n.name })}
              onChange={(e) => onToggle?.(n.path, e.target.checked)}
            />
          )}
          <span className="min-w-0 flex-1 truncate" title={n.path}>{n.name}</span>
          {n.archive && <span className="shrink-0 rounded-full bg-[var(--t-warn-bg)] px-2 py-[1px] text-[11px] text-[var(--t-warn-fg)]">{t('tree.archive')}</span>}
          <span className="shrink-0 tabular-nums text-[12px] text-[var(--text-3)]">{t('tree.files', { n: formatNumber(n.files) })}</span>
          <span className="hidden w-16 shrink-0 text-right tabular-nums text-[12px] text-[var(--text-3)] sm:inline">{formatBytes(n.bytes)}</span>
        </div>
        {expanded && n.children.length > 0 && (
          <ul>{n.children.map((c) => <Row key={c.path} n={c} depth={depth + 1} />)}</ul>
        )}
      </li>
    );
  };

  return (
    <div>
      {root.children.length > 8 && (
        <input className={cn(inputClass, 'mb-2')} placeholder={t('tree.filter')} aria-label={t('tree.filter')} value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      <ul className="max-h-[420px] overflow-y-auto rounded-[10px] border border-[var(--border)] p-1.5" aria-label={t('tree.label')}>
        {visible.map((c) => <Row key={c.path} n={c} depth={0} />)}
        {!visible.length && <li className="p-3 text-[13px] text-[var(--text-3)]">{t('tree.empty')}</li>}
      </ul>
    </div>
  );
}

/** Self-hosted Community after the trial, a Cloud workspace without a plan: why it is locked and how to open it. */
export function LockedCard({ access, onStartTrial, busy }: { access: Extract<FileSearchAccess, { allowed: false }>; onStartTrial?: () => void; busy?: boolean }) {
  const t = useTranslations('fileSearch');
  return (
    <Card className="p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[var(--brand-tint)] text-[var(--brand)]" aria-hidden>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-[var(--text)]">{t('locked.title')}</h2>
          <p className="mt-1 text-[13px] leading-[1.55] text-[var(--text-2)]">{access.message}</p>
          <ul className="mt-3 space-y-1 text-[13px] text-[var(--text-2)]">
            <li>• {t('locked.point1')}</li>
            <li>• {t('locked.point2')}</li>
            <li>• {t('locked.point3')}</li>
          </ul>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            {access.trialAvailable && onStartTrial && (
              <Button onClick={onStartTrial} disabled={busy}>{t('locked.startTrial')}</Button>
            )}
            <Link href="/settings/license" className="inline-flex h-9 items-center justify-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[13px] font-semibold text-[var(--text-2)] hover:border-[var(--border-strong)] hover:text-[var(--text)]">
              {access.trialAvailable ? t('locked.buy') : t('locked.activate')}
            </Link>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** "21–40 of 137" with previous / next, for lists paged on the server. */
export function Pager({ page, pageSize, total, onPage, busy }: { page: number; pageSize: number; total: number; onPage: (page: number) => void; busy?: boolean }) {
  const t = useTranslations('fileSearch.pager');
  if (total <= pageSize) return null;
  const pages = Math.ceil(total / pageSize);
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <nav aria-label={t('label')} className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
      <span className="text-[12px] tabular-nums text-[var(--text-3)]">{t('range', { from, to, total })}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>
          {t('prev')}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy || page >= pages} onClick={() => onPage(page + 1)}>
          {t('next')}
        </Button>
      </div>
    </nav>
  );
}
