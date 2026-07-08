'use client';

import { useEffect, useState } from 'react';
import { license } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { buildPricingUrl } from '@/lib/marketing';

type Usage = Awaited<ReturnType<typeof license.getUsage>>;

const NEXT_TIER: Record<string, string> = {
  starter: 'Team',
  team: 'Business',
  // No nudge for business/enterprise — they're at unlimited or near it.
};

/**
 * Soft-warn upgrade nudge. Renders when the current org is over any cap
 * (connectors, MCP servers, or users) AND a higher tier exists. Non-blocking
 * — the user can keep working; this just suggests an upgrade. Caps are
 * advisory by product decision (May 2026).
 */
export function UsageBanner() {
  const { token } = useAuth();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!token) return;
    license.getUsage(token).then(setUsage).catch(() => {});
  }, [token]);

  if (!usage || !usage.plan || !usage.isOverAny || dismissed) return null;
  const next = NEXT_TIER[usage.plan];
  if (!next) return null;

  const overAxes: string[] = [];
  if (usage.connectors.isOver) {
    overAxes.push(`${usage.connectors.current}/${usage.connectors.max} connectors`);
  }
  if (usage.mcpServers.isOver) {
    overAxes.push(`${usage.mcpServers.current}/${usage.mcpServers.max} MCP servers`);
  }
  if (usage.users.isOver) {
    overAxes.push(`${usage.users.current}/${usage.users.max} users`);
  }

  return (
    <div
      className="text-sm py-2 px-4 text-center"
      style={{
        backgroundColor: 'var(--t-warn-bg)',
        color: 'var(--t-warn-fg)',
      }}
    >
      <span>
        You&apos;re using <strong>{overAxes.join(', ')}</strong> — upgrade to{' '}
        <strong>{next}</strong> for higher limits.
      </span>{' '}
      <a
        href={`${buildPricingUrl()}&utm_source=soft-warn&utm_medium=banner&utm_campaign=usage-cap`}
        target="_blank"
        rel="noopener noreferrer"
        className="underline font-medium hover:no-underline"
      >
        Upgrade now
      </a>{' '}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded hover:bg-black/10"
      >
        ×
      </button>
    </div>
  );
}
