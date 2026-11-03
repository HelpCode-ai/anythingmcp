'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { fileSearchSetupPath, type FileSearchEntryPoint } from '@/lib/file-search-catalog';

/**
 * Under a catalog search box: a storage or document query ("synology",
 * "nas", "Dateiserver") also gets File Search, so people learn the AI can
 * search inside the files and not only call the system's API. `entries` are
 * the suggestions of catalog-search.ts (CatalogSearchResult.fileSearch),
 * already limited to what this deployment offers (no network folder on the
 * Cloud); the button opens the wizard for the first one.
 */
export function FileSearchSearchHint({
  entries,
  from,
  onPick,
}: {
  entries: ReadonlyArray<{ slug: string; name: string }>;
  from: Extract<FileSearchEntryPoint, 'store_hint' | 'welcome_hint'>;
  onPick?: (slug: string) => void;
}) {
  const t = useTranslations('fileSearch.searchHint');
  const first = entries[0];
  const href = first ? fileSearchSetupPath(first.slug, from) : null;
  if (!first || !href) return null;
  return (
    <div
      role="note"
      className="flex flex-col gap-3 rounded-[12px] border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      style={{
        background: 'var(--t-info-bg)',
        color: 'var(--t-info-fg)',
        borderColor: 'color-mix(in srgb, var(--t-info-fg) 25%, transparent)',
      }}
    >
      <div className="flex min-w-0 items-start gap-3">
        <FolderSearchIcon />
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-[var(--text)]">{t('title')}</p>
          <p className="mt-0.5 text-[13px] leading-[1.5] text-[var(--text-2)]">{t('body')}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
        <Link
          href={href}
          onClick={() => onPick?.(first.slug)}
          className="inline-flex h-8 items-center justify-center rounded-[9px] bg-[var(--brand)] px-3 text-[13px] font-semibold text-[var(--primary-foreground)]"
        >
          {t('cta')}
        </Link>
        <span className="text-[11.5px] text-[var(--text-3)]">{t('for', { name: first.name })}</span>
      </div>
    </div>
  );
}

function FolderSearchIcon() {
  return (
    <svg
      aria-hidden
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 shrink-0"
    >
      <path d="M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1" />
      <circle cx="17" cy="17" r="3" />
      <path d="m21 21-1.9-1.9" />
    </svg>
  );
}
