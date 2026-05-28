'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { adapters, users } from '@/lib/api';
import { LogoIcon } from '@/components/nav-bar';

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
      <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
        <div className="text-sm text-[var(--muted-foreground)]">Loading…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="border-b border-[var(--border)] bg-[var(--card)]">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LogoIcon size={28} />
            <span className="font-semibold">
              Anything<span className="text-[var(--brand)]">MCP</span>
            </span>
          </div>
          <button
            onClick={handleSkip}
            disabled={skipping}
            className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-50"
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
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
            Connect your first tool, {user.name?.split(' ')[0] || 'friend'}.
          </h1>
          <p className="text-[var(--muted-foreground)] max-w-xl mx-auto">
            AnythingMCP turns any API into MCP tools your AI agent can call.
            Pick a starter from the marketplace or paste your own OpenAPI
            spec — should take about a minute.
          </p>
        </div>

        {/* Two big paths — marketplace vs custom */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
          <Link
            href="/connectors/store?from=welcome"
            className="group border border-[var(--border)] rounded-xl p-6 bg-[var(--card)] hover:border-[var(--brand)] hover:bg-[var(--brand-light)] transition-colors text-left"
          >
            <div className="text-xs uppercase tracking-wider text-[var(--brand)] font-mono mb-2">
              Recommended
            </div>
            <h2 className="text-lg font-semibold mb-1.5">
              Browse the marketplace
            </h2>
            <p className="text-sm text-[var(--muted-foreground)] mb-4">
              180+ pre-built connectors. OAuth, API keys, refresh-token
              rotation — all wired up. Click → install → done.
            </p>
            <div className="text-sm font-medium text-[var(--brand)] group-hover:underline">
              Open marketplace →
            </div>
          </Link>

          <Link
            href="/connectors/new?from=welcome"
            className="group border border-[var(--border)] rounded-xl p-6 bg-[var(--card)] hover:border-[var(--brand)] hover:bg-[var(--brand-light)] transition-colors text-left"
          >
            <div className="text-xs uppercase tracking-wider text-[var(--muted-foreground)] font-mono mb-2">
              Bring your own
            </div>
            <h2 className="text-lg font-semibold mb-1.5">Add your own API</h2>
            <p className="text-sm text-[var(--muted-foreground)] mb-4">
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
            <h3 className="text-sm font-semibold mb-3 text-[var(--muted-foreground)]">
              Popular starters
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {starters.map((a) => (
                <Link
                  key={a.slug}
                  href={`/connectors/store?install=${encodeURIComponent(a.slug)}&from=welcome`}
                  className="border border-[var(--border)] rounded-lg p-3 bg-[var(--card)] hover:border-[var(--brand)] hover:bg-[var(--brand-light)] transition-colors flex items-center gap-3"
                >
                  <div className="text-2xl shrink-0">
                    {a.icon === 'sendcloud' && '📦'}
                    {a.icon === 'playtomic' && '🎾'}
                    {a.icon === 'github' && '🐙'}
                    {a.icon === 'twitter' && '🐦'}
                    {a.icon === 'slack' && '💬'}
                    {a.icon === 'notion' && '📝'}
                    {a.icon === 'stripe' && '💳'}
                    {a.icon === 'helpscout' && '🛟'}
                    {![
                      'sendcloud',
                      'playtomic',
                      'github',
                      'twitter',
                      'slack',
                      'notion',
                      'stripe',
                      'helpscout',
                    ].includes(a.icon) && '🔌'}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{a.name}</div>
                    <div className="text-xs text-[var(--muted-foreground)] truncate">
                      {a.toolCount} tools
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        <p className="mt-10 text-center text-xs text-[var(--muted-foreground)]">
          You can always come back and add more connectors from the dashboard.
        </p>
      </main>
    </div>
  );
}
