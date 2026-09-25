'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { adapters, users } from '@/lib/api';
import { LogoIcon } from '@/components/logo-icon';
import { ConnectorLogo } from '@/components/connector-logo';
import { StarterPack } from '@/components/starter-pack';

// A small, curated subset of slugs known to actually work end-to-end
// today, ordered by popularity from the production analytics
// (Sendcloud + Playtomic lead, then GitHub/Twitter/Slack as broadly
// useful starters). We don't fetch and re-rank: a stable list keeps
// the wizard predictable, and the user can switch to the full
// /connectors/store from the CTA below.
const STARTER_SLUGS = [
  'sendcloud',
  'playtomic-public',
  'github',
  'twitter',
  'slack',
  'notion',
  'stripe',
  'help-scout',
];

export default function WelcomePage() {
  const { token, user, isLoading } = useAuth();
  const router = useRouter();
  const [starters, setStarters] = useState<any[]>([]);
  const [skipping, setSkipping] = useState(false);

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
      .then((all: any[]) => {
        const bySlug = new Map(all.map((a) => [a.slug, a]));
        setStarters(
          STARTER_SLUGS.map((s) => bySlug.get(s)).filter(Boolean) as any[],
        );
      })
      .catch(() => setStarters([]));
  }, [token]);

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
        <div className="text-sm text-[var(--text-2)]">Loading…</div>
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
            {skipping ? 'Skipping…' : 'Skip for now'}
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="text-center mb-10">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--brand)] font-mono mb-3">
            Welcome
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3 text-[var(--text)]">
            Connect your first tool, {user.name?.split(' ')[0] || 'friend'}.
          </h1>
          <p className="text-[var(--text-2)] max-w-xl mx-auto">
            AnythingMCP turns any API into MCP tools your AI agent can call.
            Start with a few ready-made connectors, pick more from the
            marketplace, or bring your own API.
          </p>
        </div>

        {/* Starter pack: keyless connectors, ticked by default, added in one
            click and put on the user's MCP server. It replaces the old
            single-connector demo, and offers the same live "Try it" call
            for each connector once it is added. */}
        {token && <StarterPack token={token} />}

        {/* Two big paths — marketplace vs custom */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
          <Link
            href="/connectors/store?from=welcome"
            className="group border border-[var(--border)] rounded-[14px] p-6 bg-[var(--surface)] shadow-[var(--shadow-sm)] hover:border-[var(--brand)] hover:bg-[var(--brand-tint)] transition-colors text-left"
          >
            <div className="text-xs uppercase tracking-wider text-[var(--brand)] font-mono mb-2">
              Recommended
            </div>
            <h2 className="text-lg font-semibold mb-1.5 text-[var(--text)]">
              Browse the marketplace
            </h2>
            <p className="text-sm text-[var(--text-2)] mb-4">
              180+ pre-built connectors. OAuth, API keys, refresh-token
              rotation — all wired up. Click → install → done.
            </p>
            <div className="text-sm font-medium text-[var(--brand)] group-hover:underline">
              Open marketplace →
            </div>
          </Link>

          <Link
            href="/connectors/new?from=welcome"
            className="group border border-[var(--border)] rounded-[14px] p-6 bg-[var(--surface)] shadow-[var(--shadow-sm)] hover:border-[var(--brand)] hover:bg-[var(--brand-tint)] transition-colors text-left"
          >
            <div className="text-xs uppercase tracking-wider text-[var(--text-3)] font-mono mb-2">
              Bring your own
            </div>
            <h2 className="text-lg font-semibold mb-1.5 text-[var(--text)]">Add your own API</h2>
            <p className="text-sm text-[var(--text-2)] mb-4">
              Paste an OpenAPI URL or JSON spec and we generate MCP tools
              for every endpoint. Works for REST, SOAP, GraphQL.
            </p>
            <div className="text-sm font-medium text-[var(--brand)] group-hover:underline">
              Start from scratch →
            </div>
          </Link>
        </div>

        {/* Starter shortcuts — real logos + 1-click install */}
        {starters.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold mb-3 text-[var(--text-2)]">
              Popular connectors (sign in with your account)
            </h3>
            <div className="grid grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-4 gap-3">
              {starters.map((a) => (
                <Link
                  key={a.slug}
                  href={`/connectors/store?install=${encodeURIComponent(a.slug)}&from=welcome`}
                  className="border border-[var(--border)] rounded-[12px] p-3 bg-[var(--surface)] shadow-[var(--shadow-sm)] hover:border-[var(--brand)] hover:bg-[var(--brand-tint)] transition-colors flex items-center gap-3"
                >
                  <ConnectorLogo icon={a.icon} name={a.name} small />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate text-[var(--text)]">{a.name}</div>
                    <div className="text-xs text-[var(--text-2)] truncate">
                      {a.toolCount} tools
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
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
              <h3 className="text-base font-semibold text-[var(--text)]">More than a proxy — it learns how your tools connect</h3>
              <p className="mt-1 text-sm text-[var(--text-2)]">
                As you use your connectors, AnythingMCP builds a <strong>knowledge graph</strong> of how your
                entities relate and turns recurring patterns into <strong>skills</strong> — so your agent chains
                the right tools in the right order instead of guessing. It gets smarter the more you use it.
              </p>
              <Link href="/knowledge-graph" className="mt-3 inline-block text-sm font-medium text-[var(--brand)] hover:underline">
                Explore the knowledge graph →
              </Link>
            </div>
          </div>
        </div>

        <p className="mt-10 text-center text-xs text-[var(--text-2)]">
          You can always come back and add more connectors from the dashboard.
        </p>
      </main>
    </div>
  );
}
