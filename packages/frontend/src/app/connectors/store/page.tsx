'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '@/lib/auth-context';
import { adapters } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { McpAssignModal } from '@/components/mcp-assign-modal';

const REGION_LABELS: Record<string, string> = {
  de: 'Germany',
  eu: 'Europe',
  us: 'United States',
  global: 'Global',
  intl: 'International',
};

const REGION_FLAGS: Record<string, string> = {
  de: '🇩🇪',
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
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-xl font-bold text-white ring-1 ring-inset ring-black/5"
      style={{
        width: size,
        height: size,
        background: brandColor(adapter.slug),
        fontSize: size >= 56 ? 22 : 14,
      }}
    >
      {monogramOf(adapter.name)}
    </div>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
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

const AUTH_LABELS: Record<string, string> = {
  API_KEY: 'API Key',
  BEARER_TOKEN: 'Bearer Token',
  OAUTH2: 'OAuth 2.0',
  BASIC: 'Basic Auth',
  BASIC_AUTH: 'Basic Auth',
  QUERY_AUTH: 'Query Param Auth',
  LOGIN_TOKEN: 'Login Token',
  NONE: 'Public API',
};

interface AdapterItem {
  slug: string;
  name: string;
  description: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  toolCount: number;
  authType?: string;
}

interface AdapterDetail extends AdapterItem {
  // Long-form, Markdown-formatted help authored on the adapter JSON.
  // Rendered inside the install modal so users see "where to find your
  // refresh_token", auth-flow gotchas, etc. without leaving the page.
  instructions?: string;
  connector: {
    name: string;
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
  };
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
  const [importing, setImporting] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  // Credential modal state
  const [configAdapter, setConfigAdapter] = useState<AdapterDetail | null>(null);
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  // Per-field reveal toggle for password-masked credential inputs in the
  // install modal. Keyed by env var name so each "Show/Hide" button
  // toggles only its own field. Reset together with credentialValues.
  const [revealedCredentials, setRevealedCredentials] = useState<Record<string, boolean>>({});
  const [configLoading, setConfigLoading] = useState(false);

  // MCP assignment modal state
  const [importedConnector, setImportedConnector] = useState<{ id: string; name: string } | null>(null);

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

  const doImport = async (slug: string, credentials?: Record<string, string>) => {
    if (!token) return;
    setImporting(slug);
    setMsg('');
    setConfigAdapter(null);
    try {
      const adapter = list.find((a) => a.slug === slug);
      const result = await adapters.import(slug, token, credentials);
      setMsg(result.message);
      setImporting(null);
      // Show MCP assignment modal
      setImportedConnector({ id: result.connectorId, name: adapter?.name || slug });
    } catch (err: any) {
      setMsg(`Import failed: ${err.message}`);
      setImporting(null);
    }
  };

  const handleImportClick = async (adapter: AdapterItem) => {
    if (!token) return;

    // If no auth required, import directly
    if (!adapter.requiredEnvVars || adapter.requiredEnvVars.length === 0) {
      await doImport(adapter.slug);
      return;
    }

    // Fetch full adapter detail to show in modal
    setConfigLoading(true);
    try {
      const detail = await adapters.get(adapter.slug, token);
      setConfigAdapter(detail);
      setCredentialValues({});
      setRevealedCredentials({});
    } catch {
      // Fallback: use list data
      setConfigAdapter({
        ...adapter,
        connector: { name: adapter.name, type: 'REST', baseUrl: '', authType: 'API_KEY' },
      } as AdapterDetail);
      setCredentialValues({});
      setRevealedCredentials({});
    } finally {
      setConfigLoading(false);
    }
  };

  // Auto-import when ?install=<slug> is present (e.g. from website marketplace)
  useEffect(() => {
    if (autoInstallTriggered.current || loading || !token || list.length === 0) return;
    const installSlug = searchParams.get('install');
    if (!installSlug) return;
    const adapter = list.find((a) => a.slug === installSlug);
    if (!adapter) return;
    autoInstallTriggered.current = true;
    handleImportClick(adapter);
  }, [loading, list, token, searchParams]);

  const handleConfigSubmit = () => {
    if (!configAdapter) return;
    const creds = Object.keys(credentialValues).length > 0 ? credentialValues : undefined;
    doImport(configAdapter.slug, creds);
  };

  // Derive unique categories from the loaded adapters
  const categories = [...new Set(list.map((a) => a.category).filter(Boolean))];

  const filtered = list.filter((a) => {
    if (activeCategory && a.category !== activeCategory) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      a.name.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.category?.toLowerCase().includes(q) ||
      a.region?.toLowerCase().includes(q)
    );
  });

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
        {msg && (
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
        )}

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
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setActiveCategory(null)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  activeCategory === null
                    ? 'border-[var(--brand)] bg-[var(--brand)] text-white'
                    : 'border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
                )}
              >
                All
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    activeCategory === cat
                      ? 'border-[var(--brand)] bg-[var(--brand)] text-white'
                      : 'border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
                  )}
                >
                  {CATEGORY_LABELS[cat] || cat}
                </button>
              ))}
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
          <div className="rounded-[14px] border border-dashed border-[var(--border)] py-16 text-center">
            <p className="text-[var(--text-3)]">
              {list.length === 0
                ? 'No adapters available yet.'
                : 'No adapters match your search.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((adapter) => {
              const isPublic = adapter.authType === 'NONE';
              const isImporting = importing === adapter.slug;
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
                          {CATEGORY_LABELS[adapter.category] || adapter.category}
                        </span>
                        <span className="text-[var(--border-strong)]">·</span>
                        <span>{REGION_LABELS[adapter.region] || adapter.region}</span>
                      </div>
                    </div>
                  </div>

                  <p className="mt-3 line-clamp-3 flex-1 text-sm leading-relaxed text-[var(--text-2)]">
                    {adapter.description}
                  </p>

                  <div className="mt-4 flex items-center justify-between gap-3 border-t border-dashed border-[var(--border)] pt-3">
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
                    <div className="flex items-center gap-1.5">
                      {adapter.authType && (
                        <Badge
                          tone={isPublic ? 'emerald' : 'neutral'}
                          className="gap-1 font-mono uppercase tracking-wider"
                        >
                          {isPublic ? <SparklesIcon /> : <LockIcon />}
                          {AUTH_LABELS[adapter.authType] || adapter.authType}
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
                        disabled={isImporting || configLoading}
                        className="h-7 gap-1 px-2.5"
                      >
                        {isImporting ? 'Importing…' : (
                          <>
                            Install
                            <ArrowRightIcon />
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Credential Configuration Modal */}
      {configAdapter && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setConfigAdapter(null)}
          />
          <div className="relative mx-4 flex max-h-[90vh] w-full max-w-md flex-col rounded-[14px] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)]">
            <button
              onClick={() => setConfigAdapter(null)}
              className="absolute right-3 top-3 z-10 text-[var(--text-3)] hover:text-[var(--text)]"
              aria-label="Close"
            >
              <CloseIcon />
            </button>

            {/* Scrollable content region. Keeps the footer actions pinned and
                reachable even when an adapter has many env vars (the modal is
                capped at 90vh instead of growing past the viewport). */}
            <div className="flex-1 overflow-y-auto p-6">
            <h3 className="mb-1 text-lg font-semibold tracking-[-0.01em]">
              Configure {configAdapter.name}
            </h3>
            <p className="mb-4 text-sm text-[var(--text-2)]">
              This adapter requires credentials to work. Enter them now or skip and configure later.
            </p>

            <div className="mb-3 flex items-center gap-2 text-xs text-[var(--text-3)]">
              <LockIcon />
              <span>Auth type: {AUTH_LABELS[configAdapter.connector?.authType] || configAdapter.connector?.authType}</span>
            </div>

            {/* Setup instructions — collapsible details block, default open
                so first-time users see how to obtain each credential. The
                content is the same Markdown stored on the adapter JSON's
                `instructions` field. */}
            {configAdapter.instructions && (
              <details className="mb-4 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)]" open>
                <summary className="cursor-pointer select-none rounded-[9px] px-3 py-2 text-sm font-medium hover:bg-[var(--surface-3)]">
                  📖 How to get these credentials
                </summary>
                <div className="prose prose-sm max-w-none px-3 pb-3 pt-1 text-[13px] leading-relaxed dark:prose-invert max-h-[40vh] overflow-y-auto">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {configAdapter.instructions}
                  </ReactMarkdown>
                </div>
              </details>
            )}

            <div className="space-y-3">
              {configAdapter.requiredEnvVars.map((envVar) => {
                const isSecret =
                  envVar.toLowerCase().includes('secret') ||
                  envVar.toLowerCase().includes('password') ||
                  envVar.toLowerCase().includes('token') ||
                  envVar.toLowerCase().includes('key');
                const visible = revealedCredentials[envVar] === true;
                return (
                  <div key={envVar}>
                    <label
                      htmlFor={`cred-${envVar}`}
                      className="mb-1 block text-sm font-medium"
                    >
                      {formatEnvVarLabel(envVar)}
                    </label>
                    <div className="relative">
                      <input
                        id={`cred-${envVar}`}
                        type={isSecret && !visible ? 'password' : 'text'}
                        value={credentialValues[envVar] || ''}
                        onChange={(e) =>
                          setCredentialValues((prev) => ({
                            ...prev,
                            [envVar]: e.target.value,
                          }))
                        }
                        placeholder={envVar}
                        className={cn(
                          'w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-3)] focus:border-[var(--border-strong)] focus:outline-none',
                          isSecret && 'pr-16'
                        )}
                      />
                      {isSecret && (
                        <button
                          type="button"
                          onClick={() =>
                            setRevealedCredentials((prev) => ({
                              ...prev,
                              [envVar]: !visible,
                            }))
                          }
                          className="absolute inset-y-0 right-0 px-2 text-xs text-[var(--text-3)] hover:text-[var(--text)]"
                          aria-label={visible ? 'Hide value' : 'Show value'}
                        >
                          {visible ? 'Hide' : 'Show'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            </div>

            {/* Pinned footer — always visible, never scrolls out of reach. */}
            <div className="flex shrink-0 justify-end gap-3 border-t border-[var(--border)] p-6 py-4">
              <Button
                variant="secondary"
                onClick={() => doImport(configAdapter.slug)}
              >
                Skip for now
              </Button>
              <Button
                onClick={handleConfigSubmit}
                disabled={configAdapter.requiredEnvVars.some(
                  (v) => !credentialValues[v]?.trim(),
                )}
              >
                Import with credentials
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* MCP Server Assignment Modal */}
      {importedConnector && token && (
        <McpAssignModal
          connectorId={importedConnector.id}
          connectorName={importedConnector.name}
          token={token}
          onDone={(mcpServerId) => {
            setImportedConnector(null);
            if (mcpServerId) {
              router.push(`/mcp-server/${mcpServerId}`);
            } else {
              router.push(`/connectors/${importedConnector.id}`);
            }
          }}
          onClose={() => {
            setImportedConnector(null);
            router.push(`/connectors/${importedConnector.id}`);
          }}
        />
      )}
    </AppShell>
  );
}

/** Convert ENV_VAR_NAME to a human-readable label */
function formatEnvVarLabel(envVar: string): string {
  return envVar
    .replace(/^(PAYONE_|DHL_|IS24_|WECLAPP_|DESTATIS_|N26_|TEAMVIEWER_|MFR_|FASTBILL_|BILLOMAT_|DATEV_|SCOPEVISIO_|KENJO_)/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
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

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
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
