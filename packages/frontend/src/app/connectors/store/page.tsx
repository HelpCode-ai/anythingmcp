'use client';

import Link from 'next/link';
import { useEffect, useState, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { adapters } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';
import { McpAssignModal } from '@/components/mcp-assign-modal';

const REGION_LABELS: Record<string, string> = {
  de: 'Germany',
  eu: 'Europe',
  us: 'United States',
  global: 'Global',
};

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
};

const AUTH_LABELS: Record<string, string> = {
  API_KEY: 'API Key',
  BEARER_TOKEN: 'Bearer Token',
  OAUTH2: 'OAuth 2.0',
  BASIC: 'Basic Auth',
  NONE: 'None (Public API)',
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
}

interface AdapterDetail extends AdapterItem {
  connector: {
    name: string;
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
  };
}

export default function AdapterStorePage() {
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
    } catch {
      // Fallback: use list data
      setConfigAdapter({
        ...adapter,
        connector: { name: adapter.name, type: 'REST', baseUrl: '', authType: 'API_KEY' },
      } as AdapterDetail);
      setCredentialValues({});
    } finally {
      setConfigLoading(false);
    }
  };

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
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Connectors', href: '/connectors' },
        ]}
        title="Adapter Store"
        actions={
          <Link
            href="/connectors/new"
            className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 flex items-center gap-1.5"
          >
            <PlusIcon />
            Custom Connector
          </Link>
        }
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex-1 w-full">
        {msg && (
          <div className="mb-4 p-3 rounded-md bg-[var(--info-bg)] text-[var(--info-text)] text-sm border border-[var(--info-border)] flex items-center justify-between">
            <span>{msg}</span>
            <button
              onClick={() => setMsg('')}
              className="ml-3 text-[var(--info-text)] hover:opacity-70 text-xs underline"
            >
              dismiss
            </button>
          </div>
        )}

        <div className="mb-8 text-center">
          <h2 className="text-2xl font-bold mb-2">Built-in Adapters</h2>
          <p className="text-[var(--muted-foreground)] text-sm max-w-lg mx-auto">
            Pre-configured connector recipes for popular APIs. Import with one click and just add your API key.
          </p>
        </div>

        {/* Search + Category Filters */}
        <div className="flex items-center gap-3 mb-4 justify-center">
          <div className="relative w-full max-w-sm">
            <SearchIcon />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search adapters..."
              aria-label="Search adapters"
              autoComplete="off"
              className="w-full border border-[var(--input)] rounded-md pl-9 pr-3 py-2 text-sm bg-[var(--background)]"
            />
          </div>
        </div>

        {categories.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 mb-6 justify-center">
            <button
              onClick={() => setActiveCategory(null)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                activeCategory === null
                  ? 'bg-[var(--brand)] text-white border-[var(--brand)]'
                  : 'border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--brand)] hover:text-[var(--foreground)]'
              }`}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  activeCategory === cat
                    ? 'bg-[var(--brand)] text-white border-[var(--brand)]'
                    : 'border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--brand)] hover:text-[var(--foreground)]'
                }`}
              >
                {CATEGORY_LABELS[cat] || cat}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="border border-[var(--border)] rounded-lg p-6 animate-pulse"
              >
                <div className="h-6 w-32 rounded bg-[var(--muted)] mb-3" />
                <div className="h-4 w-full rounded bg-[var(--muted)] mb-2" />
                <div className="h-4 w-2/3 rounded bg-[var(--muted)]" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-[var(--border)] rounded-lg">
            <p className="text-[var(--muted-foreground)]">
              {list.length === 0
                ? 'No adapters available yet.'
                : 'No adapters match your search.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((adapter) => (
              <div
                key={adapter.slug}
                className="border border-[var(--border)] rounded-lg p-6 hover:border-[var(--brand)] transition-colors flex flex-col"
              >
                <div className="flex items-start justify-between mb-3">
                  <h3 className="font-semibold text-lg">{adapter.name}</h3>
                  <div className="flex gap-1.5 flex-shrink-0">
                    {adapter.region && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400 uppercase">
                        {REGION_LABELS[adapter.region] || adapter.region}
                      </span>
                    )}
                  </div>
                </div>

                <p className="text-sm text-[var(--muted-foreground)] mb-4 flex-1">
                  {adapter.description}
                </p>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
                    {adapter.category && (
                      <span>{CATEGORY_LABELS[adapter.category] || adapter.category}</span>
                    )}
                    <span>{adapter.toolCount} tool{adapter.toolCount !== 1 ? 's' : ''}</span>
                  </div>

                  <button
                    onClick={() => handleImportClick(adapter)}
                    disabled={importing === adapter.slug || configLoading}
                    className="bg-[var(--brand)] text-white px-3 py-1.5 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {importing === adapter.slug ? (
                      'Importing...'
                    ) : (
                      <>
                        <DownloadIcon />
                        Import
                      </>
                    )}
                  </button>
                </div>

                {adapter.docsUrl && (
                  <a
                    href={adapter.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] underline"
                  >
                    API Documentation
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Credential Configuration Modal */}
      {configAdapter && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setConfigAdapter(null)}
          />
          <div className="relative bg-[var(--background)] border border-[var(--border)] rounded-lg shadow-lg w-full max-w-md mx-4 p-6">
            <button
              onClick={() => setConfigAdapter(null)}
              className="absolute top-3 right-3 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              aria-label="Close"
            >
              <CloseIcon />
            </button>

            <h3 className="text-lg font-semibold mb-1">
              Configure {configAdapter.name}
            </h3>
            <p className="text-sm text-[var(--muted-foreground)] mb-4">
              This adapter requires credentials to work. Enter them now or skip and configure later.
            </p>

            <div className="mb-3 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
              <LockIcon />
              <span>Auth type: {AUTH_LABELS[configAdapter.connector?.authType] || configAdapter.connector?.authType}</span>
            </div>

            <div className="space-y-3 mb-6">
              {configAdapter.requiredEnvVars.map((envVar) => (
                <div key={envVar}>
                  <label
                    htmlFor={`cred-${envVar}`}
                    className="block text-sm font-medium mb-1"
                  >
                    {formatEnvVarLabel(envVar)}
                  </label>
                  <input
                    id={`cred-${envVar}`}
                    type={envVar.toLowerCase().includes('secret') || envVar.toLowerCase().includes('password') || envVar.toLowerCase().includes('token') || envVar.toLowerCase().includes('key') ? 'password' : 'text'}
                    value={credentialValues[envVar] || ''}
                    onChange={(e) =>
                      setCredentialValues((prev) => ({
                        ...prev,
                        [envVar]: e.target.value,
                      }))
                    }
                    placeholder={envVar}
                    className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  />
                </div>
              ))}
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => doImport(configAdapter.slug)}
                className="px-4 py-2 rounded-md text-sm border border-[var(--border)] hover:bg-[var(--muted)]"
              >
                Skip for now
              </button>
              <button
                onClick={handleConfigSubmit}
                disabled={configAdapter.requiredEnvVars.some(
                  (v) => !credentialValues[v]?.trim(),
                )}
                className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                Import with credentials
              </button>
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

      <Footer />
    </div>
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
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--muted-foreground)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
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
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
