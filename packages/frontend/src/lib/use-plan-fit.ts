'use client';

import { useCallback, useEffect, useState } from 'react';
import { license, type FitPlanId, type LicenseUsage, type PlanFits } from './api';
import { useAuth } from './auth-context';

/**
 * Cloud: what this workspace keeps and loses on Starter and Team
 * (GET /api/license/plan-fit). undefined while loading or when `enabled` is
 * false; null when the server has no answer (self-hosted answers 404, an
 * older backend has no endpoint), so callers simply show nothing.
 */
export function usePlanFit(enabled: boolean, plan?: FitPlanId): PlanFits | null | undefined {
  const { token, deploymentMode } = useAuth();
  const [fits, setFits] = useState<PlanFits | null | undefined>(undefined);
  const on = enabled && !!token && deploymentMode === 'cloud';
  useEffect(() => {
    if (!on || !token) return;
    let live = true;
    license
      .getPlanFit(token, plan)
      .then((r) => {
        if (live) setFits(r && typeof r.plans === 'object' && r.plans ? r.plans : null);
      })
      .catch(() => {
        if (live) setFits(null);
      });
    return () => {
      live = false;
    };
  }, [on, token, plan]);
  return on ? fits : undefined;
}

/**
 * Cloud: the workspace's usage against its plan (GET /api/license/usage),
 * with the connectors and MCP servers the last downgrade paused. null until
 * loaded, and always on self-hosted. `reload` asks again (after a swap).
 */
export function usePlanUsage(): { usage: LicenseUsage | null; reload: () => void } {
  const { token, deploymentMode } = useAuth();
  const [usage, setUsage] = useState<LicenseUsage | null>(null);
  const [nonce, setNonce] = useState(0);
  const cloud = deploymentMode === 'cloud';
  useEffect(() => {
    if (!token || !cloud) return;
    let live = true;
    license
      .getUsage(token)
      .then((u) => {
        if (live) setUsage(u && typeof u === 'object' && u.connectors ? u : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [token, cloud, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { usage: cloud ? usage : null, reload };
}

/** The ids the last automatic downgrade paused, as sets; empty when none or unknown. */
export function pausedByPlanSets(usage: LicenseUsage | null | undefined): {
  connectors: ReadonlySet<string>;
  mcpServers: ReadonlySet<string>;
} {
  const p = usage?.pausedByPlan;
  return {
    connectors: new Set(Array.isArray(p?.connectors) ? p.connectors : []),
    mcpServers: new Set(Array.isArray(p?.mcpServers) ? p.mcpServers : []),
  };
}

/**
 * Whether one more active item of `axis` is over the plan, as far as the
 * client can tell. Only once the server pauses by plan (it reports
 * `pausedByPlan`): before that, the caps are advisory and activating stays
 * allowed, so the client must not refuse what the server accepts.
 */
export function atPlanCap(usage: LicenseUsage | null | undefined, axis: 'connectors' | 'mcpServers'): boolean {
  if (!usage || usage.pausedByPlan === undefined) return false;
  const a = usage[axis];
  return !!a && a.max != null && a.current >= a.max;
}

/** The plan whose limits apply now, for plan-fit: a trial runs on Team's. */
export function fitPlanOf(plan: string | null | undefined): FitPlanId | null {
  if (plan === 'starter') return 'starter';
  if (plan === 'team' || plan === 'trial') return 'team';
  return null;
}
