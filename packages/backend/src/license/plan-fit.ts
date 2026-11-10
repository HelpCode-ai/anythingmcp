import { quotaForPlan } from '../file-search/file-search-quotas';
import { codeToolCapForPlan, inlineCodeAllowedForPlan } from './code-mode-quotas';
import { monthlyCodeRunCapForPlan } from './code-run-quotas';

/**
 * What a Cloud workspace would keep and lose on a given plan: the data behind
 * the "What changes with Starter" block on the paywall, the reactivation page
 * and the checkout, and the list of connectors and MCP servers the automatic
 * downgrade pauses. One ranking is used for both, so the warning and the
 * downgrade always name the same items.
 *
 * Pure functions over a snapshot of the workspace; `PlanFitService` reads the
 * snapshot from the database.
 */

/**
 * The connector, MCP server and user limits of the Cloud plans a workspace can
 * check out. They mirror the licence site (`lib/license.ts` there), which
 * issues them as licence features; the backend needs them here to describe a
 * plan the workspace does not have yet. Keep in step with the site.
 */
export const CLOUD_PLAN_LIMITS = {
  starter: { connectors: 5, mcpServers: 3, users: 1 },
  team: { connectors: 15, mcpServers: 10, users: 3 },
} as const;

export type FitPlan = keyof typeof CLOUD_PLAN_LIMITS;
export const FIT_PLANS = Object.keys(CLOUD_PLAN_LIMITS) as FitPlan[];

export function isFitPlan(p: unknown): p is FitPlan {
  return typeof p === 'string' && (FIT_PLANS as string[]).includes(p);
}

/** A connector or MCP server with its tool calls over the last 30 days. */
export interface FitItem {
  id: string;
  name: string;
  calls30d: number;
  /** For the tie-break: the most recently changed stays first. */
  updatedAt: Date;
}

/** Everything the evaluation needs about a workspace, read once. */
export interface FitSnapshot {
  /** Active connectors that count against the plan (File Search ones excluded). */
  connectors: FitItem[];
  /** Active MCP servers. */
  mcpServers: FitItem[];
  /** Active members. */
  users: number;
  /** File Search source folders (File Share not included). */
  fileSearchConnectors: FitItem[];
  fileSearchFiles: number;
  fileSearchBytes: number;
  codeTools: number;
  /** An active MCP server with `codeMode: inline`. */
  inlineCodeInUse: boolean;
  codeRunsThisMonth: number;
}

export interface FitAxis {
  current: number;
  /** null = unlimited on that plan. */
  max: number | null;
  over: boolean;
}

export interface FitRanked extends FitAxis {
  /** Stay active on that plan, most used first. */
  keep: { id: string; name: string; calls30d: number }[];
  /** Would be paused (never deleted), least used last. */
  pause: { id: string; name: string; calls30d: number }[];
}

export interface PlanFit {
  plan: FitPlan;
  /** Everything the workspace uses today fits the plan. */
  fits: boolean;
  connectors: FitRanked;
  mcpServers: FitRanked;
  users: FitAxis;
  fileSearch: {
    connectors: FitRanked;
    files: FitAxis;
    bytes: FitAxis;
    /** The plan includes File Share links. */
    fileShare: boolean;
  };
  code: {
    tools: FitAxis;
    /** Inline code (`code_execute`) is switched on for a server today. */
    inlineInUse: boolean;
    /** The plan includes inline code. */
    inlineIncluded: boolean;
    /** Runs this calendar month against the plan's monthly cap. */
    runsThisMonth: FitAxis;
  };
}

function axis(current: number, max: number | null): FitAxis {
  return { current, max, over: max != null && current > max };
}

/**
 * Most used first: tool calls in the last 30 days, then the most recently
 * changed, then the id so the order is stable. The first `max` stay active.
 */
export function rankForCap(items: FitItem[], max: number | null): FitRanked {
  const sorted = [...items].sort(
    (a, b) =>
      b.calls30d - a.calls30d ||
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const strip = ({ id, name, calls30d }: FitItem) => ({ id, name, calls30d });
  const cut = max == null ? sorted.length : Math.max(0, max);
  return {
    ...axis(items.length, max),
    keep: sorted.slice(0, cut).map(strip),
    pause: sorted.slice(cut).map(strip),
  };
}

/** What `snapshot` keeps and loses on `plan` (Cloud). */
export function evaluatePlanFit(snapshot: FitSnapshot, plan: FitPlan): PlanFit {
  const limits = CLOUD_PLAN_LIMITS[plan];
  const fs = quotaForPlan(plan, { cloud: true });
  const connectors = rankForCap(snapshot.connectors, limits.connectors);
  const mcpServers = rankForCap(snapshot.mcpServers, limits.mcpServers);
  const users = axis(snapshot.users, limits.users);
  const fsConnectors = rankForCap(snapshot.fileSearchConnectors, fs?.maxConnectors ?? 0);
  const files = axis(snapshot.fileSearchFiles, fs ? fs.maxFiles : 0);
  const bytes = axis(snapshot.fileSearchBytes, fs ? fs.maxSourceBytes : 0);
  const tools = axis(snapshot.codeTools, codeToolCapForPlan(plan));
  const inlineIncluded = inlineCodeAllowedForPlan(plan);
  const runs = axis(snapshot.codeRunsThisMonth, monthlyCodeRunCapForPlan(plan));

  const fits =
    !connectors.over &&
    !mcpServers.over &&
    !users.over &&
    !fsConnectors.over &&
    !files.over &&
    !bytes.over &&
    !tools.over &&
    !(snapshot.inlineCodeInUse && !inlineIncluded);

  return {
    plan,
    fits,
    connectors,
    mcpServers,
    users,
    fileSearch: { connectors: fsConnectors, files, bytes, fileShare: !!fs?.share },
    code: { tools, inlineInUse: snapshot.inlineCodeInUse, inlineIncluded, runsThisMonth: runs },
  };
}

/**
 * The same evaluation without connector, server or folder names, for the
 * reactivation page, which opens without a sign-in: it says how many would be
 * paused, and the dashboard names them.
 */
export function anonymizePlanFit(fit: PlanFit): PlanFit {
  const anon = (r: FitRanked): FitRanked => ({
    ...r,
    keep: r.keep.map((x, i) => ({ id: `keep-${i}`, name: '', calls30d: x.calls30d })),
    pause: r.pause.map((x, i) => ({ id: `pause-${i}`, name: '', calls30d: x.calls30d })),
  });
  return {
    ...fit,
    connectors: anon(fit.connectors),
    mcpServers: anon(fit.mcpServers),
    fileSearch: { ...fit.fileSearch, connectors: anon(fit.fileSearch.connectors) },
  };
}
