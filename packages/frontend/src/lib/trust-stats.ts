'use client';

import { useEffect, useState } from 'react';
import { publicStats, type PublicStats } from './api';

/**
 * The public trust numbers (GET /api/public/stats) and how they are shown.
 * Same rules as the backend's trust-stats.format.ts: downloads and tool calls
 * never below TRUST_FLOORS, live numbers above them rounded DOWN; workspaces
 * live only, left out below their rounding unit or when unknown. GitHub stars
 * are not shown (10 Oct 2026).
 */
export interface TrustStatsDisplay {
  downloads: string | null;
  workspaces: string | null;
  toolCalls: string | null;
}

const usable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const thousands = (n: number) => n.toLocaleString('en-US');

function floorPlus(n: unknown, unit: number): string | null {
  if (!usable(n) || n < unit) return null;
  return `${thousands(Math.floor(n / unit) * unit)}+`;
}

/** Mirrors TRUST_FLOORS in the backend's trust-stats.format.ts. */
export const TRUST_FLOORS = { dockerPulls: 200_000, toolCalls30d: 1_000_000 } as const;

const atLeast = (n: unknown, floor: number) => (usable(n) && n > floor ? n : floor);

/** Below a million: "650,000+"; from a million: whole millions, "1M+". */
function formatToolCalls(n: unknown): string | null {
  if (usable(n) && n >= 1_000_000) return `${Math.floor(n / 1_000_000)}M+`;
  return floorPlus(n, 10_000);
}

export function formatTrustStats(s: Partial<PublicStats> | null | undefined): TrustStatsDisplay {
  return {
    downloads: floorPlus(atLeast(s?.dockerPulls, TRUST_FLOORS.dockerPulls), 1000),
    workspaces: floorPlus(s?.workspaces, 100),
    toolCalls: formatToolCalls(atLeast(s?.toolCalls30d, TRUST_FLOORS.toolCalls30d)),
  };
}

/** The formatted numbers: null while loading, the floors alone when the endpoint is unavailable. */
export function useTrustStats(enabled = true): TrustStatsDisplay | null {
  const [stats, setStats] = useState<TrustStatsDisplay | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    publicStats
      .get()
      .then((s) => {
        if (!cancelled) setStats(formatTrustStats(s));
      })
      .catch(() => {
        if (!cancelled) setStats(formatTrustStats(null));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return stats;
}
