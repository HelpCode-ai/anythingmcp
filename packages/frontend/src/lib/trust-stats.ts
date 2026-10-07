'use client';

import { useEffect, useState } from 'react';
import { publicStats, type PublicStats } from './api';

/**
 * The public trust numbers (GET /api/public/stats) and how they are shown.
 * Same rules as the backend's trust-stats.format.ts: always rounded DOWN, and
 * a value below its rounding unit, or unknown, is not shown at all.
 */
export interface TrustStatsDisplay {
  stars: string | null;
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

export function formatStars(n: unknown): string | null {
  if (!usable(n)) return null;
  const whole = Math.floor(n);
  return whole < 1000 ? thousands(whole) : floorPlus(whole, 100);
}

export function formatTrustStats(s: Partial<PublicStats> | null | undefined): TrustStatsDisplay {
  return {
    stars: formatStars(s?.githubStars),
    downloads: floorPlus(s?.dockerPulls, 1000),
    workspaces: floorPlus(s?.workspaces, 100),
    toolCalls: floorPlus(s?.toolCalls30d, 10_000),
  };
}

/** The formatted numbers, or null while loading / when the endpoint is unavailable. */
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
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return stats;
}
