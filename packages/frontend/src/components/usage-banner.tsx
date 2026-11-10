'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { license } from '@/lib/api';
import { pausedByPlanSets } from '@/lib/use-plan-fit';
import { useAuth } from '@/lib/auth-context';
import { useManagePlan } from '@/lib/use-manage-plan';
import { buildEnterpriseContactUrl } from '@/lib/marketing';

type Usage = Awaited<ReturnType<typeof license.getUsage>>;

const NEXT_TIER: Record<string, string> = {
  starter: 'Team',
  // Past Team there is no self-service plan: Enterprise is a quote, so the
  // banner links to the contact form instead of the billing portal.
  team: 'Enterprise',
  // No nudge for business/enterprise — they're at unlimited or near it.
};

const UTM = { utm_source: 'soft-warn', utm_medium: 'banner', utm_campaign: 'usage-cap' };

/**
 * Soft-warn upgrade nudge. Renders when the current org is over any cap
 * (connectors, MCP servers, or users) AND a higher tier exists. Non-blocking
 * — the user can keep working; this just suggests an upgrade. Caps are
 * advisory by product decision (May 2026).
 *
 * After an automatic downgrade (`pausedByPlan` in the usage), it says instead
 * how many connectors and MCP servers the plan paused, with the way to switch
 * which ones are active and the upgrade.
 */
export function UsageBanner() {
  const { token, deploymentMode } = useAuth();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const managePlan = useManagePlan(UTM);

  // Cloud only: these are the Cloud plans' limits. A self-hosted instance has
  // its own (EditionBanner).
  useEffect(() => {
    if (!token || deploymentMode !== 'cloud') return;
    license.getUsage(token).then(setUsage).catch(() => {});
  }, [token, deploymentMode]);

  if (!usage || !usage.plan || dismissed) return null;

  // After an automatic downgrade: say what the plan paused and how to swap.
  // Calm on purpose: nothing was deleted, and the user picks what stays on.
  const paused = pausedByPlanSets(usage);
  const pausedConnectors = paused.connectors.size;
  const pausedServers = paused.mcpServers.size;
  if (pausedConnectors + pausedServers > 0) {
    const parts = [
      pausedConnectors ? `${pausedConnectors} connector${pausedConnectors === 1 ? '' : 's'}` : null,
      pausedServers ? `${pausedServers} MCP server${pausedServers === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    const upgradeToTeam = usage.plan === 'starter';
    return (
      <div
        data-testid="usage-banner-paused"
        className="text-sm py-2 px-4 text-center"
        style={{ backgroundColor: 'var(--t-info-bg)', color: 'var(--t-info-fg)' }}
      >
        <span>
          {parts.join(' and ')} {pausedConnectors + pausedServers === 1 ? 'is' : 'are'} paused by your plan.
        </span>{' '}
        <Link href={pausedConnectors ? '/connectors' : '/mcp-server'} className="underline font-medium hover:no-underline">
          Switch which ones are active
        </Link>
        {', or '}
        {upgradeToTeam ? (
          <a
            href={managePlan.href}
            onClick={managePlan.onClick}
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-medium hover:no-underline"
          >
            upgrade to Team
          </a>
        ) : (
          <a
            href={buildEnterpriseContactUrl(UTM)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-medium hover:no-underline"
          >
            ask about Enterprise
          </a>
        )}
        .{' '}
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

  if (!usage.isOverAny) return null;
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
      {next === 'Enterprise' ? (
        <a
          href={buildEnterpriseContactUrl(UTM)}
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium hover:no-underline"
        >
          Contact us
        </a>
      ) : (
        <a
          // Only Starter and Team see this banner, so everyone who clicks it
          // already has a subscription: change it, do not buy a second one.
          href={managePlan.href}
          onClick={managePlan.onClick}
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium hover:no-underline"
        >
          Change plan
        </a>
      )}{' '}
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
