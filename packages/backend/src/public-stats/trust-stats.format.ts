/**
 * The public trust numbers (GitHub stars, Docker pulls, Cloud workspaces, AI
 * tool calls in the last 30 days) and how they are shown. Every number is
 * real and rounded DOWN, so a displayed value never overstates the measured
 * one. A value below its rounding unit is not shown at all rather than as "0+".
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
  /** "984" below 1,000, then "1,000+", "1,100+". */
  stars: string | null;
  /** "32,000+". */
  downloads: string | null;
  /** "3,800+". */
  workspaces: string | null;
  /** "650,000+". */
  toolCalls: string | null;
}

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

export function formatStars(n: number | null | undefined): string | null {
  if (!usable(n)) return null;
  const whole = Math.floor(n);
  return whole < 1000 ? thousands(whole) : floorPlus(whole, 100);
}

export function formatDownloads(n: number | null | undefined): string | null {
  return floorPlus(n, 1000);
}

export function formatWorkspaces(n: number | null | undefined): string | null {
  return floorPlus(n, 100);
}

export function formatToolCalls(n: number | null | undefined): string | null {
  return floorPlus(n, 10_000);
}

export function formatTrustStats(stats: TrustStats | null | undefined): TrustStatsDisplay {
  return {
    stars: formatStars(stats?.githubStars),
    downloads: formatDownloads(stats?.dockerPulls),
    workspaces: formatWorkspaces(stats?.workspaces),
    toolCalls: formatToolCalls(stats?.toolCalls30d),
  };
}
