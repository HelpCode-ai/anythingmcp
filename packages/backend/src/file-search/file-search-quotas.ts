import type { FileSearchQuota, FileShareQuota } from './file-search.types';

/**
 * File Search limits per plan (#1386). Storage limits are hard: reaching one
 * pauses the sync, it never deletes anything. Numbers live here, not on the
 * licence site, so existing keys need no reissue; an Enterprise contract can
 * override any of them through the licence feature `fileSearch` (a partial
 * FileSearchQuota).
 *
 * Self-hosted Community has no File Search outside the 30-day trial: the
 * resolver returns null and the feature is locked.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY_MIN = 24 * 60;

const CLOUD_SHARE_STARTER: FileShareQuota = {
  maxTtlHours: 24,
  maxStoredBytes: 100 * MB,
  maxFileBytes: 10 * MB,
  maxLinksPerDay: 20,
  publicLinks: true,
  internalWithoutExpiry: false,
};
const CLOUD_SHARE_TEAM: FileShareQuota = {
  maxTtlHours: 7 * 24,
  maxStoredBytes: 2 * GB,
  maxFileBytes: 50 * MB,
  maxLinksPerDay: 200,
  publicLinks: true,
  internalWithoutExpiry: false,
};
const CLOUD_SHARE_ENTERPRISE: FileShareQuota = {
  maxTtlHours: 90 * 24,
  maxStoredBytes: 50 * GB,
  maxFileBytes: 500 * MB,
  maxLinksPerDay: null,
  publicLinks: true,
  internalWithoutExpiry: false,
};

const CLOUD: Record<string, FileSearchQuota> = {
  starter: {
    plan: 'starter',
    maxConnectors: 1,
    maxFiles: 500,
    maxSourceBytes: 500 * MB,
    maxTextChars: 25_000_000,
    maxFileBytes: 25 * MB,
    minIntervalMinutes: DAY_MIN,
    manualSyncsPerDay: 1,
    share: CLOUD_SHARE_STARTER,
    ocr: false,
    folderRules: false,
    policy: false,
  },
  team: {
    plan: 'team',
    maxConnectors: 3,
    maxFiles: 2_000,
    maxSourceBytes: 2 * GB,
    maxTextChars: 100_000_000,
    maxFileBytes: 50 * MB,
    minIntervalMinutes: DAY_MIN,
    manualSyncsPerDay: 3,
    share: CLOUD_SHARE_TEAM,
    ocr: false,
    folderRules: false,
    policy: false,
  },
  enterprise: {
    plan: 'enterprise',
    maxConnectors: 10,
    maxFiles: 50_000,
    maxSourceBytes: 50 * GB,
    maxTextChars: 2_000_000_000,
    maxFileBytes: 200 * MB,
    minIntervalMinutes: 15,
    manualSyncsPerDay: null,
    share: CLOUD_SHARE_ENTERPRISE,
    ocr: true,
    folderRules: true,
    policy: true,
  },
};
CLOUD.business = { ...CLOUD.team, plan: 'business' };
// The Cloud trial has the Team limits, so a new workspace can try everything
// before it picks a plan (decided 2026-11-09). Before checkout, the paywall
// tells a workspace above Starter what Starter would not include.
CLOUD.trial = { ...CLOUD.team, share: { ...CLOUD_SHARE_TEAM }, plan: 'trial' };

function selfHosted(maxFileBytes: number): Record<string, FileSearchQuota> {
  const share = (ttl: number | null, internalWithoutExpiry = false): FileShareQuota => ({
    maxTtlHours: ttl,
    maxStoredBytes: null,
    maxFileBytes: Math.max(maxFileBytes, 10 * MB),
    maxLinksPerDay: null,
    publicLinks: true,
    internalWithoutExpiry,
  });
  const base = {
    maxSourceBytes: null,
    maxTextChars: null,
    maxFileBytes,
    ocr: false,
    folderRules: false,
    policy: false,
  };
  const t: Record<string, FileSearchQuota> = {
    // The 30-day evaluation of a Community instance: Team limits, no File Share.
    trial: { ...base, plan: 'trial', maxConnectors: 3, maxFiles: 2_000, minIntervalMinutes: DAY_MIN, manualSyncsPerDay: 3, share: null },
    starter: { ...base, plan: 'starter', maxConnectors: 1, maxFiles: 500, minIntervalMinutes: DAY_MIN, manualSyncsPerDay: 1, share: share(24) },
    team: { ...base, plan: 'team', maxConnectors: 3, maxFiles: 2_000, minIntervalMinutes: DAY_MIN, manualSyncsPerDay: 3, share: share(7 * 24) },
    enterprise: {
      ...base,
      plan: 'enterprise',
      maxConnectors: null,
      maxFiles: null,
      minIntervalMinutes: 5,
      manualSyncsPerDay: null,
      share: share(null, true),
      ocr: true,
      folderRules: true,
      policy: true,
    },
  };
  t.business = { ...t.team, plan: 'business' };
  return t;
}

export function defaultMaxFileBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FILES_MAX_FILE_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100 * MB;
}

/**
 * The quota for a plan, or null when the plan has no File Search.
 * `plan` is the licence plan; on a self-hosted instance without a paid key but
 * with the evaluation running, pass 'trial'.
 */
export function quotaForPlan(
  plan: string | null | undefined,
  opts: { cloud: boolean; overrides?: unknown; env?: NodeJS.ProcessEnv },
): FileSearchQuota | null {
  if (!plan) return null;
  const table = opts.cloud ? CLOUD : selfHosted(defaultMaxFileBytes(opts.env));
  const base = table[plan];
  if (!base) return null;
  return applyOverrides(base, opts.overrides);
}

const NUM_KEYS = ['maxConnectors', 'maxFiles', 'maxSourceBytes', 'maxTextChars', 'maxFileBytes', 'minIntervalMinutes', 'manualSyncsPerDay'] as const;

function applyOverrides(base: FileSearchQuota, overrides: unknown): FileSearchQuota {
  if (!overrides || typeof overrides !== 'object') return { ...base, share: base.share ? { ...base.share } : null };
  const o = overrides as Record<string, unknown>;
  const out: FileSearchQuota = { ...base, share: base.share ? { ...base.share } : null };
  for (const k of NUM_KEYS) {
    const v = o[k];
    if (v === null && k !== 'maxFileBytes' && k !== 'minIntervalMinutes') (out as any)[k] = null;
    else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) (out as any)[k] = Math.floor(v);
  }
  for (const k of ['ocr', 'folderRules', 'policy'] as const) {
    if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  }
  if (o.share && typeof o.share === 'object' && out.share) {
    const s = o.share as Record<string, unknown>;
    for (const k of ['maxTtlHours', 'maxStoredBytes', 'maxFileBytes', 'maxLinksPerDay'] as const) {
      const v = s[k];
      if (v === null && k !== 'maxFileBytes') (out.share as any)[k] = null;
      else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) (out.share as any)[k] = Math.floor(v);
    }
    if (typeof s.publicLinks === 'boolean') out.share.publicLinks = s.publicLinks;
  }
  return out;
}

/**
 * The plan to suggest when a limit is reached (wizard and pause banner): the
 * first plan after the current one that really includes more connectors or
 * files. A Cloud trial and a self-hosted evaluation (both with Team limits)
 * are pointed at Enterprise.
 */
export function nextPlan(plan: string, cloud: boolean): { plan: string; quota: FileSearchQuota } | null {
  const order = ['trial', 'starter', 'team', 'enterprise'];
  const current = quotaForPlan(plan, { cloud });
  const i = order.indexOf(plan === 'business' ? 'team' : plan);
  if (i < 0 || !current) return null;
  const more = (a: number | null, b: number | null) => (b === null ? a !== null : a !== null && b > a);
  for (const next of order.slice(i + 1)) {
    const quota = quotaForPlan(next, { cloud });
    if (quota && (more(current.maxConnectors, quota.maxConnectors) || more(current.maxFiles, quota.maxFiles))) return { plan: next, quota };
  }
  return null;
}

/** Allowed sync intervals (minutes) for the wizard, given the plan minimum. */
export const SYNC_INTERVALS = [5, 15, 60, 6 * 60, 24 * 60, 7 * 24 * 60];

export function clampInterval(requested: number | undefined, quota: FileSearchQuota): number {
  const n = Number.isFinite(requested) && (requested as number) > 0 ? Math.floor(requested as number) : 24 * 60;
  return Math.max(n, quota.minIntervalMinutes);
}
