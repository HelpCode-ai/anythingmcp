import { ForbiddenException } from '@nestjs/common';

/**
 * Cloud plan caps on connectors, MCP servers and users (Team trial plan,
 * 2026-11-09). How hard they are is switched by PLAN_CAPS_ENFORCE:
 *
 *  - `dry-run` (default): nothing is refused or paused; the backend logs what
 *    it would do, so the numbers can be checked against the warnings first;
 *  - `on`: a paid plan refuses a new or re-activated connector, MCP server or
 *    member above its cap, and a downgrade pauses the least used items;
 *  - `off`: neither, and no logging.
 *
 * The Cloud trial's cap on creating connectors and MCP servers was hard
 * before this switch existed and stays hard in every mode.
 */
export type PlanCapsMode = 'off' | 'dry-run' | 'on';

export function planCapsMode(env: NodeJS.ProcessEnv = process.env): PlanCapsMode {
  const v = (env.PLAN_CAPS_ENFORCE ?? '').trim().toLowerCase();
  return v === 'on' || v === 'off' ? v : 'dry-run';
}

export type PlanCapAxis = 'connectors' | 'mcpServers' | 'users' | 'fileSearchConnectors' | 'webhooks';

/**
 * How many connectors of a Cloud workspace may receive inbound webhooks
 * (`webhookEnabled`), by plan (#1393). The trial has the Team limit; null is
 * no limit. A licence feature `maxWebhookConnectors` overrides the plan, so a
 * customer can get more by arrangement. An unknown plan is not capped.
 */
const WEBHOOK_CONNECTOR_CAPS: Record<string, number | null> = {
  starter: 1,
  trial: 5,
  team: 5,
  business: null,
  enterprise: null,
};

export function webhookConnectorCap(plan: string | null | undefined, override?: unknown): number | null {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) return override;
  if (!plan) return null;
  return WEBHOOK_CONNECTOR_CAPS[plan] ?? null;
}

/** The 403 the dashboard recognises (`code: 'PLAN_LIMIT'`) and turns into the swap dialog. */
export class PlanLimitException extends ForbiddenException {
  constructor(axis: PlanCapAxis, max: number, current: number, message: string) {
    super({ statusCode: 403, code: 'PLAN_LIMIT', axis, max, current, message });
  }
}

/** OrgSettings key holding what the last automatic downgrade paused. */
export const PAUSED_BY_PLAN_KEY = 'plan_caps_paused';

/** What the last automatic downgrade paused, most used first. */
export interface PausedByPlan {
  plan: string;
  at: string;
  connectors: string[];
  mcpServers: string[];
  fileSearch: string[];
}

export function parsePausedByPlan(raw: string | null | undefined): PausedByPlan | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    const ids = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : []);
    if (!v || typeof v !== 'object') return null;
    return {
      plan: typeof v.plan === 'string' ? v.plan : '',
      at: typeof v.at === 'string' ? v.at : '',
      connectors: ids(v.connectors),
      mcpServers: ids(v.mcpServers),
      fileSearch: ids(v.fileSearch),
    };
  } catch {
    return null;
  }
}

/**
 * Plans by how much they include, for telling a downgrade from an upgrade.
 * The Cloud trial has the Team limits. No licence counts as below every plan.
 */
const PLAN_RANK: Record<string, number> = { starter: 1, trial: 2, team: 2, business: 3, enterprise: 4 };

export function planRank(plan: string | null | undefined): number | null {
  if (!plan) return 0;
  return PLAN_RANK[plan] ?? null;
}
