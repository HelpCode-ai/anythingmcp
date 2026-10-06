'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { adapters } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { adapterAuthLabel, adapterNeedsCredentials, cn } from '@/lib/utils';
import { matchesSearch } from '@/lib/marketplace-search';
import { isTrialLimitMessage, TrialLimitNotice } from '@/lib/trial-limit';
import { useCatalogSearchReport } from '@/lib/use-catalog-search-report';

const REGION_LABELS: Record<string, string> = {
  de: 'Germany',
  at: 'Austria',
  ch: 'Switzerland',
  it: 'Italy',
  es: 'Spain',
  fr: 'France',
  nl: 'Netherlands',
  be: 'Belgium',
  se: 'Sweden',
  dk: 'Denmark',
  gb: 'United Kingdom',
  uk: 'United Kingdom',
  in: 'India',
  br: 'Brazil',
  ng: 'Nigeria',
  jp: 'Japan',
  eu: 'Europe',
  us: 'United States',
  global: 'Global',
  intl: 'International',
};

const REGION_FLAGS: Record<string, string> = {
  de: '🇩🇪',
  at: '🇦🇹',
  ch: '🇨🇭',
  it: '🇮🇹',
  es: '🇪🇸',
  fr: '🇫🇷',
  nl: '🇳🇱',
  be: '🇧🇪',
  se: '🇸🇪',
  dk: '🇩🇰',
  eu: '🇪🇺',
  global: '🌐',
  intl: '🌐',
  uk: '🇬🇧',
  gb: '🇬🇧',
  in: '🇮🇳',
  br: '🇧🇷',
  ng: '🇳🇬',
  jp: '🇯🇵',
};

/* Deterministic colour palette for the monogram fallback when no SVG exists.
   Mirrors lib/adapters.ts on the marketing site for visual consistency. */
const MONOGRAM_PALETTE = [
  '#2563eb', '#7c3aed', '#0ea5e9', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#14b8a6', '#6366f1', '#84cc16',
  '#0891b2', '#a855f7', '#f97316', '#06b6d4', '#22c55e',
];

function monogramOf(name: string): string {
  const stripped = name.replace(/[().]/g, '').trim();
  const parts = stripped.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return stripped.slice(0, 2).toUpperCase();
}

function brandColor(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return MONOGRAM_PALETTE[h % MONOGRAM_PALETTE.length];
}

/**
 * Monogram colour for a given tile fill. The palette is shared with the
 * marketing site, so the fills stay exactly as they are; what changes is
 * which ink goes on top. White only clears 4.5:1 on the two darkest
 * swatches — on #84cc16 it is 1.98:1 — so the letters follow the fill.
 */
function monogramInk(bg: string): string {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(bg.slice(1, 3), 16));
  const g = channel(parseInt(bg.slice(3, 5), 16));
  const b = channel(parseInt(bg.slice(5, 7), 16));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const INK_LUMINANCE = 0.004703; // #0c0f14
  const onWhite = 1.05 / (luminance + 0.05);
  const onInk = (luminance + 0.05) / (INK_LUMINANCE + 0.05);
  return onWhite >= onInk ? '#ffffff' : '#0c0f14';
}

/* Brand logo or coloured monogram fallback. Matches the marketing-site
   Marketplace card visual exactly so the in-app store feels like the same
   product surface. */
function BrandTile({ adapter, size = 44 }: { adapter: AdapterItem; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (adapter.icon && !failed) {
    return (
      <div
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-xl p-1.5 bg-white ring-1 ring-black/5 dark:ring-white/10"
        style={{ width: size, height: size }}
      >
        <img
          src={`/logos/connectors/${adapter.icon}.svg`}
          alt={adapter.name}
          width={size - 12}
          height={size - 12}
          className="h-full w-full object-contain"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }
  const fill = brandColor(adapter.slug);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-xl font-bold ring-1 ring-inset ring-black/5"
      style={{
        width: size,
        height: size,
        background: fill,
        color: monogramInk(fill),
        fontSize: size >= 56 ? 22 : 14,
      }}
    >
      {monogramOf(adapter.name)}
    </div>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  monitoring: 'Monitoring',
  'time-tracking': 'Time Tracking',
  dms: 'Document Management',
  transport: 'Transport',
  itsm: 'IT Service Management',
  wholesale: 'Wholesale',
  construction: 'Construction',
  productivity: 'Productivity',
  storage: 'Storage',
  data: 'Data',
  infrastructure: 'Infrastructure',
  healthcare: 'Healthcare',
  database: 'Database',
  food: 'Food',
  gaming: 'Gaming',
  logistics: 'Logistics',
  finance: 'Finance',
  government: 'Government',
  erp: 'ERP',
  banking: 'Banking',
  remote: 'Remote Access',
  'real-estate': 'Real Estate',
  'field-service': 'Field Service',
  accounting: 'Accounting',
  hr: 'HR',
  messaging: 'Messaging',
  crm: 'CRM',
  email: 'Email',
  advertising: 'Advertising',
  'marketing-automation': 'Marketing Automation',
  'project-management': 'Project Management',
  scheduling: 'Scheduling',
  forms: 'Forms',
  support: 'Customer Support',
  payments: 'Payments',
  'e-commerce': 'E-commerce',
  analytics: 'Analytics',
  publishing: 'Publishing',
  'e-signature': 'E-signature',
  enrichment: 'Lead Enrichment',
  knowledge: 'Knowledge Base',
  social: 'Social',
  maps: 'Maps & Geo',
  travel: 'Travel',
  cms: 'CMS',
  sports: 'Sports',
};

/**
 * Filter chip. Taller on a phone than the 26px the desktop density gave it:
 * these sit in a row you scroll with a thumb, and a small target on a
 * scrolling surface is a mis-tap waiting to happen.
 */
const CHIP =
  'flex min-h-[34px] flex-shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors sm:min-h-0 sm:px-3 sm:py-1 sm:text-xs';
const CHIP_ON = 'border-[var(--brand)] bg-[var(--brand)] text-[var(--primary-foreground)]';
const CHIP_OFF =
  'border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-strong)] hover:text-[var(--text)]';

/**
 * Title-case an unlabelled slug rather than printing it raw. The catalog gains
 * categories over time and `time-tracking` in a filter chip reads as a bug.
 */
function categoryLabel(slug: string): string {
  if (CATEGORY_LABELS[slug]) return CATEGORY_LABELS[slug];
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface AdapterItem {
  slug: string;
  name: string;
  description: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  // Env vars that may legitimately stay blank (e.g. Destatis GENESIS needs no
  // password when an API token is used). Prompted, but never block Import.
  optionalEnvVars?: string[];
  toolCount: number;
  authType?: string;
}

export default function AdapterStorePage() {
  return (
    <Suspense>
      <AdapterStoreContent />
    </Suspense>
  );
}

function AdapterStoreContent() {
  const { token } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [list, setList] = useState<AdapterItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [msg, setMsg] = useState('');

  // Track whether auto-install from ?install= param has been triggered
  const autoInstallTriggered = useRef(false);

  useEffect(() => {
    if (!token) return;
    adapters
      .list(token)
      .then(setList)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  // Every install goes through the guided setup: it asks for what the
  // connector needs, checks it against the API before saving, and runs the
  // provider sign-in for OAuth connectors. The old dialog's "Skip for now"
  // created connectors that failed every call.
  const handleImportClick = (adapter: AdapterItem) => {
    reportPicked(adapter.slug);
    router.push(`/connectors/setup/${encodeURIComponent(adapter.slug)}`);
  };

  // Auto-import when ?install=<slug> is present (e.g. from website marketplace)
  useEffect(() => {
    if (autoInstallTriggered.current || loading || !token || list.length === 0) return;
    const installSlug = searchParams.get('install');
    if (!installSlug) return;
    const adapter = list.find((a) => a.slug === installSlug);
    if (!adapter) return;
    autoInstallTriggered.current = true;
    router.replace(`/connectors/setup/${encodeURIComponent(adapter.slug)}`);
  }, [loading, list, token, searchParams, router]);

  /**
   * Categories ranked by how much of the catalog each one holds, so the first
   * chips are the ones most likely to be wanted. In load order, 45 categories
   * of one to twenty-four adapters all looked equally important.
   */
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of list) {
      if (a.category) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([slug, count]) => ({ slug, count, label: categoryLabel(slug) }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [list]);

  /**
   * Twelve is about two wrapped rows on a desktop and three swipes on a
   * phone. Uncapped, the phone row ran 4957px — thirteen screens — to reach
   * the last chip, and fifteen of these categories hold one or two adapters
   * each: a chip that filters 257 down to 1 is better served by the search
   * box. The rest stay one tap away behind "More".
   */
  const CATEGORY_CAP = 12;
  const shownCategories = showAllCategories
    ? categories
    : categories.slice(0, CATEGORY_CAP);
  const hiddenCategoryCount = categories.length - shownCategories.length;
  // A category picked from the expanded list stays on screen after collapsing.
  const activeIsHidden =
    !!activeCategory && !shownCategories.some((c) => c.slug === activeCategory);

  // Match what the card actually says, not just the stored slug: the card
  // reads "GERMANY" and "E-commerce", so those are the words people type.
  const matchesQuery = (a: AdapterItem) =>
    matchesSearch(
      [
        a.name,
        a.description,
        a.slug,
        a.category ?? '',
        categoryLabel(a.category ?? ''),
        a.region ?? '',
        REGION_LABELS[a.region] ?? '',
      ],
      search,
    );

  const filtered = list.filter((a) => {
    if (activeCategory && a.category !== activeCategory) return false;
    if (!search.trim()) return true;
    return matchesQuery(a);
  });

  // Reported across the whole catalog, not the category chip: the question
  // is whether we have the app at all.
  const reportPicked = useCatalogSearchReport(
    token,
    'store',
    search,
    loading || !search.trim() ? null : list.filter(matchesQuery).length,
  );

  return (
    <AppShell
      backTo={{ label: 'Connectors', href: '/connectors' }}
      title="Marketplace"
      subtitle="Pre-configured connector recipes for popular APIs. Import with one click and just add your API key."
      actions={
        <Link href="/connectors/new">
          <Button>
            <PlusIcon />
            Custom Connector
          </Button>
        </Link>
      }
    >
      <div className="flex flex-col gap-[18px]">
        {msg && isTrialLimitMessage(msg) ? (
          <TrialLimitNotice message={msg.replace(/^Import failed:\s*/, '')} />
        ) : msg ? (
          <div
            className="flex items-center justify-between rounded-[11px] border px-4 py-3 text-sm"
            style={{ background: 'var(--t-info-bg)', color: 'var(--t-info-fg)', borderColor: 'color-mix(in srgb, var(--t-info-fg) 25%, transparent)' }}
          >
            <span>{msg}</span>
            <button
              onClick={() => setMsg('')}
              className="ml-3 text-xs underline hover:opacity-70"
            >
              dismiss
            </button>
          </div>
        ) : null}

        {/* Search + Category Filters */}
        <div className="flex flex-col gap-3">
          <div className="relative w-full max-w-md">
            <SearchIcon />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search adapters..."
              aria-label="Search adapters"
              autoComplete="off"
              className="h-9 w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)] focus:border-[var(--border-strong)] focus:outline-none"
            />
          </div>

          {categories.length > 1 && (
            <div className="flex flex-col gap-2">
              {/* Phones get one scrolling row instead of fourteen wrapped
                  ones: 45 chips filled the whole screen before a single
                  adapter appeared. Ranked by size, so the row starts with
                  the categories most people are after, and the trailing
                  fade says there is more to the right. From sm up the chips
                  wrap, capped until "Show all" — that was five rows too. */}
              <div
                className={cn(
                  'flex items-center gap-2',
                  'max-sm:scrollbar-none max-sm:scroll-fade-x max-sm:-mx-4 max-sm:overflow-x-auto max-sm:px-4 max-sm:pb-0.5',
                  'sm:flex-wrap'
                )}
              >
                <button
                  onClick={() => setActiveCategory(null)}
                  aria-pressed={activeCategory === null}
                  className={cn(CHIP, activeCategory === null ? CHIP_ON : CHIP_OFF)}
                >
                  All
                </button>
                {(activeIsHidden
                  ? [...shownCategories, categories.find((c) => c.slug === activeCategory)!]
                  : shownCategories
                ).map((cat) => {
                  const active = activeCategory === cat.slug;
                  return (
                    <button
                      key={cat.slug}
                      onClick={() => setActiveCategory(active ? null : cat.slug)}
                      aria-pressed={active}
                      className={cn(CHIP, active ? CHIP_ON : CHIP_OFF)}
                    >
                      {cat.label}
                      {/* The count turns a wall of equal-looking words into
                          something you can read the catalogue's shape from. */}
                      <span className={cn('tabular-nums', active ? 'opacity-70' : 'text-[var(--text-3)]')}>
                        {cat.count}
                      </span>
                    </button>
                  );
                })}
                {hiddenCategoryCount > 0 && (
                  <button
                    onClick={() => setShowAllCategories(true)}
                    className={cn(CHIP, CHIP_OFF, 'border-dashed')}
                  >
                    +{hiddenCategoryCount} more
                  </button>
                )}
                {showAllCategories && (
                  <button
                    onClick={() => setShowAllCategories(false)}
                    className={cn(CHIP, 'border-transparent text-[var(--text-3)] hover:text-[var(--text)]')}
                  >
                    Show fewer
                  </button>
                )}
              </div>

              {/* What the filters actually did, in one line. */}
              <p className="text-[11.5px] text-[var(--text-3)]">
                {filtered.length === list.length
                  ? `${list.length} adapters`
                  : `${filtered.length} of ${list.length} adapters`}
                {activeCategory && ` · ${categoryLabel(activeCategory)}`}
              </p>
            </div>
          )}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="p-5" style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>
                <div className="mb-3 h-6 w-32 rounded bg-[var(--surface-3)]" />
                <div className="mb-2 h-4 w-full rounded bg-[var(--surface-3)]" />
                <div className="h-4 w-2/3 rounded bg-[var(--surface-3)]" />
              </Card>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-[var(--border)] px-5 py-16 text-center">
            {list.length === 0 ? (
              <p className="text-[var(--text-3)]">No adapters available yet.</p>
            ) : (
              <>
                <p className="text-sm text-[var(--text-2)]">
                  Nothing matches{search ? ` “${search}”` : ''}
                  {activeCategory ? ` in ${categoryLabel(activeCategory)}` : ''}.
                </p>
                <p className="mx-auto mt-1 max-w-[46ch] text-[13px] text-[var(--text-3)]">
                  Any REST, SOAP, GraphQL or SQL system can still become a
                  connector — the adapters are just a head start.
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSearch('');
                      setActiveCategory(null);
                    }}
                  >
                    Clear filters
                  </Button>
                  <Link href="/connectors/new" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}>
                    Build a custom connector
                  </Link>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((adapter) => {
              const isPublic = !adapterNeedsCredentials(adapter);
              /* log-ish 1..10 segment scale, same as the marketing-site card */
              const fillCount = Math.max(
                1,
                Math.min(10, Math.round(Math.log2(adapter.toolCount + 1) * 2.2)),
              );
              return (
                <Card
                  key={adapter.slug}
                  className="group relative flex flex-col p-5 transition-colors hover:border-[var(--border-strong)]"
                >
                  <div className="flex items-start gap-3">
                    <BrandTile adapter={adapter} size={44} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[15px] font-semibold leading-tight tracking-[-0.01em]">
                          {adapter.name}
                        </span>
                        <span aria-hidden className="shrink-0 text-sm">
                          {REGION_FLAGS[adapter.region] || '🌐'}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider text-[var(--text-3)]">
                        <span>
                          {categoryLabel(adapter.category)}
                        </span>
                        <span className="text-[var(--border-strong)]">·</span>
                        <span>{REGION_LABELS[adapter.region] || adapter.region}</span>
                      </div>
                    </div>
                  </div>

                  <p className="mt-3 line-clamp-3 flex-1 text-sm leading-relaxed text-[var(--text-2)]">
                    {adapter.description}
                  </p>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-dashed border-[var(--border)] pt-3">
                    <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--text-3)]">
                      <span className="font-semibold text-[var(--text)]">
                        {adapter.toolCount}
                      </span>
                      <span>tool{adapter.toolCount !== 1 ? 's' : ''}</span>
                      <span aria-hidden className="ml-1 inline-flex gap-[1.5px]">
                        {Array.from({ length: 10 }, (_, i) => (
                          <span
                            key={i}
                            className="block h-[6px] w-[3px] rounded-[1px]"
                            style={{ background: i < fillCount ? 'var(--brand)' : 'var(--surface-3)' }}
                          />
                        ))}
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5">
                      {adapter.authType && (
                        <Badge
                          tone={isPublic ? 'emerald' : 'neutral'}
                          className="max-w-full min-w-0 gap-1 truncate font-mono uppercase tracking-wider"
                        >
                          {isPublic ? <SparklesIcon /> : <LockIcon />}
                          {adapterAuthLabel(adapter)}
                        </Badge>
                      )}
                      {adapter.docsUrl && (
                        <a
                          href={adapter.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="API documentation"
                          aria-label="API documentation"
                          className="inline-flex size-7 items-center justify-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-3)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                        >
                          <ExternalLinkIcon />
                        </a>
                      )}
                      <Button
                        size="sm"
                        onClick={() => handleImportClick(adapter)}
                        className="h-7 gap-1 px-2.5"
                      >
                        Install
                        <ArrowRightIcon />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

    </AppShell>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}
