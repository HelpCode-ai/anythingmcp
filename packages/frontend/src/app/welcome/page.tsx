'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { adapters, users } from '@/lib/api';
import { setupNeeds } from '@/lib/setup-needs';
import { LogoIcon } from '@/components/logo-icon';
import { ConnectorLogo } from '@/components/connector-logo';
import { StarterPack } from '@/components/starter-pack';
import { searchCatalog } from '@/lib/catalog-search';
import { useCatalogSearchReport } from '@/lib/use-catalog-search-report';

// Shown when the ranking can't be loaded: what the cloud ranked in October
// 2026. The live list comes from /api/adapters/popular-connectors.
const FALLBACK_SLUGS = ['telegram-bot', 'etsy', 'odoo', 'woocommerce', 'weclapp', 'lexware-office', 'getmyinvoices', 'google-search-console'];

export default function WelcomePage() {
  const { token, user, isLoading } = useAuth();
  const router = useRouter();
  const [starters, setStarters] = useState<any[]>([]);
  const [skipping, setSkipping] = useState(false);
  const [catalog, setCatalog] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const t = useTranslations('welcome');

  useEffect(() => {
    // Bounce to /login if the user landed here unauthenticated.
    if (!isLoading && !token) router.replace('/login?redirect=/welcome');
  }, [isLoading, token, router]);

  useEffect(() => {
    // Fetch the catalog so we can show real logos + descriptions for
    // the starter set. If the catalog endpoint fails we degrade
    // gracefully to the two empty CTA cards.
    if (!token) return;
    adapters
      .list(token)
      .then((all: any[]) => setCatalog(Array.isArray(all) ? all : []))
      .catch(() => setCatalog([]));
    adapters
      .popularConnectors(token)
      .then((res) => setStarters(Array.isArray(res?.items) ? res.items : []))
      .catch(() => setStarters([]));
  }, [token]);

  // The same ranked, typo-tolerant search as the store and the chat.
  const searchEntries = useMemo(
    () => catalog.map((a) => ({ ...a, text: [a.description ?? '', a.category ?? ''] })),
    [catalog],
  );
  const searchResult = useMemo(
    () => (query.trim() ? searchCatalog(searchEntries, query) : null),
    [searchEntries, query],
  );
  const matches = searchResult ? searchResult.hits.map((h) => h.entry) : [];
  const reportPicked = useCatalogSearchReport(
    token,
    'welcome',
    query,
    catalog.length > 0 ? searchResult : null,
  );

  const popular =
    starters.length > 0
      ? starters
      : (FALLBACK_SLUGS.map((slug) => catalog.find((a) => a.slug === slug)).filter(Boolean) as any[]);

  const handleSkip = async () => {
    if (!token || skipping) return;
    setSkipping(true);
    try {
      await users.updateOnboardingState({ completed: true }, token);
    } catch {
      // Non-blocking: even if the PATCH fails, the redirect still
      // happens; the gate will fire again next page load.
    }
    router.replace('/');
  };

  if (isLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
        <div className="text-sm text-[var(--text-2)]">{t('loading')}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] bg-[var(--brand-tint)] text-[var(--brand)]">
              <LogoIcon size={20} />
            </span>
            <span className="font-semibold">
              Anything<span className="text-[var(--brand)]">MCP</span>
            </span>
          </div>
          <button
            onClick={handleSkip}
            disabled={skipping}
            className="text-sm text-[var(--text-2)] hover:text-[var(--text)] disabled:opacity-50"
          >
            {skipping ? t('skipping') : t('skip')}
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="text-center mb-10">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--brand)] font-mono mb-3">
            {t('eyebrow')}
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3 text-[var(--text)]">
            {user.name?.split(' ')[0] ? t('title', { name: user.name.split(' ')[0] }) : t('titleNoName')}
          </h1>
          <p className="text-[var(--text-2)] max-w-xl mx-auto">
            {t('intro')}
          </p>
        </div>

        {/* What do you want to connect? Search first: people arrive with an
            app in mind, and every result opens the guided setup. */}
        {token && user.role !== 'VIEWER' && (
          <section className="mb-10">
            <label htmlFor="connect-search" className="mb-2 block text-sm font-semibold text-[var(--text)]">
              {t('searchLabel')}
            </label>
            <input
              id="connect-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="w-full rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[16px] text-[var(--text)] placeholder:text-[var(--text-3)] focus:border-[var(--border-strong)] focus:outline-none"
            />
            {!query.trim() && popular.length > 0 && (
              <p className="mt-4 text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-3)]">
                {t('popular')}
              </p>
            )}
            <div className="mt-3 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-4">
              {(query.trim() ? matches.slice(0, 8) : popular).map((a) => (
                <Link
                  key={a.slug}
                  href={`/connectors/setup/${encodeURIComponent(a.slug)}`}
                  onClick={() => reportPicked(a.slug)}
                  className="flex items-center gap-3 rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[var(--shadow-sm)] transition-colors hover:border-[var(--brand)] hover:bg-[var(--brand-tint)]"
                >
                  <ConnectorLogo icon={a.icon} name={a.name} small />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[var(--text)]">{a.name}</div>
                    <div className="truncate text-xs text-[var(--text-2)]" title={setupNeeds(a)}>
                      {a.installed ? t('alreadyAdded') : setupNeeds(a)}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
            {query.trim() && catalog.length > 0 && matches.length === 0 && (
                <p className="mt-3 text-sm text-[var(--text-2)]">
                  {t.rich('noMatch', {
                    link: (chunks) => (
                      <Link href="/connectors/new?from=welcome" className="text-[var(--brand)] underline">{chunks}</Link>
                    ),
                  })}
                </p>
              )}
          </section>
        )}

        {/* Two big paths — marketplace vs custom */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
          <Link
            href="/connectors/store?from=welcome"
            className="group border border-[var(--border)] rounded-[14px] p-6 bg-[var(--surface)] shadow-[var(--shadow-sm)] hover:border-[var(--brand)] hover:bg-[var(--brand-tint)] transition-colors text-left"
          >
            <div className="text-xs uppercase tracking-wider text-[var(--brand)] font-mono mb-2">
              {t('marketplace.eyebrow')}
            </div>
            <h2 className="text-lg font-semibold mb-1.5 text-[var(--text)]">
              {t('marketplace.title')}
            </h2>
            <p className="text-sm text-[var(--text-2)] mb-4">
              {t('marketplace.body')}
            </p>
            <div className="text-sm font-medium text-[var(--brand)] group-hover:underline">
              {t('marketplace.cta')}
            </div>
          </Link>

          <Link
            href="/connectors/new?from=welcome"
            className="group border border-[var(--border)] rounded-[14px] p-6 bg-[var(--surface)] shadow-[var(--shadow-sm)] hover:border-[var(--brand)] hover:bg-[var(--brand-tint)] transition-colors text-left"
          >
            <div className="text-xs uppercase tracking-wider text-[var(--text-3)] font-mono mb-2">
              {t('custom.eyebrow')}
            </div>
            <h2 className="text-lg font-semibold mb-1.5 text-[var(--text)]">{t('custom.title')}</h2>
            <p className="text-sm text-[var(--text-2)] mb-4">
              {t('custom.body')}
            </p>
            <div className="text-sm font-medium text-[var(--brand)] group-hover:underline">
              {t('custom.cta')}
            </div>
          </Link>
        </div>

        {/* Keyless demos, opt-in, for trying AnythingMCP before setting up a
            real app. Viewers can't add connectors. */}
        {token && user.role !== 'VIEWER' && (
          <StarterPack token={token} />
        )}

        {/* Differentiator teaser — what makes AnythingMCP "smart" beyond a
            proxy. It's empty for a brand-new account, so this is a concept
            hook (no data, no AI), nudging toward the graph once tools exist. */}
        <div className="mt-10 rounded-[14px] border border-[var(--border)] bg-[var(--brand-tint)] p-6">
          <div className="flex items-start gap-4">
            <span className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface)] text-[var(--brand)]">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="6" r="2.4" /><circle cx="19" cy="6" r="2.4" /><circle cx="12" cy="18" r="2.4" /><path d="M7.2 7.2 10.6 16M16.8 7.2 13.4 16M7 6h10" /></svg>
            </span>
            <div>
              <h3 className="text-base font-semibold text-[var(--text)]">{t('graph.title')}</h3>
              <p className="mt-1 text-sm text-[var(--text-2)]">
                {t.rich('graph.body', { strong: (chunks) => <strong>{chunks}</strong> })}
              </p>
              <Link href="/knowledge-graph" className="mt-3 inline-block text-sm font-medium text-[var(--brand)] hover:underline">
                {t('graph.cta')}
              </Link>
            </div>
          </div>
        </div>

        <p className="mt-10 text-center text-xs text-[var(--text-2)]">
          {t('comeBack')}
        </p>
      </main>
    </div>
  );
}
