/**
 * The public trust numbers (GitHub stars, Docker pulls, Cloud workspaces, AI
 * tool calls in the last 30 days) and how they are shown. Downloads and tool
 * calls are never shown below TRUST_FLOORS; above a floor the live number is
 * shown, rounded DOWN. Workspaces are live only: a value below its rounding
 * unit is not shown at all rather than as "0+".
 *
 * GitHub stars are still collected and served by /api/public/stats, but shown
 * nowhere: Matteo took them off the website, the emails and the sign-in pages
 * on 10 Oct 2026.
 */
export interface TrustStats {
  githubStars: number | null;
  dockerPulls: number | null;
  workspaces: number | null;
  toolCalls30d: number | null;
  /** ISO timestamp of the last successful refresh of any value. */
  updatedAt: string | null;
}

export interface TrustStatsDisplay {
  /** "32,000+". */
  downloads: string | null;
  /** "3,800+". */
  workspaces: string | null;
  /** "1M+", "2M+". */
  toolCalls: string | null;
}

/**
 * The least each figure is shown as (Matteo, 8 Oct 2026): 200,000+ downloads
 * across all distribution channels, 1M+ AI tool calls last month. Docker Hub alone undercounts downloads, so the floor applies even
 * when a live number is missing or lower.
 */
export const TRUST_FLOORS = { dockerPulls: 200_000, toolCalls30d: 1_000_000 } as const;

const atLeast = (n: number | null | undefined, floor: number) => (usable(n) && n > floor ? n : floor);

export const EMPTY_TRUST_STATS: TrustStats = {
  githubStars: null,
  dockerPulls: null,
  workspaces: null,
  toolCalls30d: null,
  updatedAt: null,
};

const usable = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

const thousands = (n: number) => n.toLocaleString('en-US');

/** Round down to `unit` and add "+"; null when below one unit. */
function floorPlus(n: number | null | undefined, unit: number): string | null {
  if (!usable(n) || n < unit) return null;
  return `${thousands(Math.floor(n / unit) * unit)}+`;
}

export function formatDownloads(n: number | null | undefined): string | null {
  return floorPlus(n, 1000);
}

export function formatWorkspaces(n: number | null | undefined): string | null {
  return floorPlus(n, 100);
}

/** Below a million: "650,000+"; from a million: whole millions, "1M+". */
export function formatToolCalls(n: number | null | undefined): string | null {
  if (usable(n) && n >= 1_000_000) return `${Math.floor(n / 1_000_000)}M+`;
  return floorPlus(n, 10_000);
}

export function formatTrustStats(stats: TrustStats | null | undefined): TrustStatsDisplay {
  return {
    downloads: formatDownloads(atLeast(stats?.dockerPulls, TRUST_FLOORS.dockerPulls)),
    workspaces: formatWorkspaces(stats?.workspaces),
    toolCalls: formatToolCalls(atLeast(stats?.toolCalls30d, TRUST_FLOORS.toolCalls30d)),
  };
}
