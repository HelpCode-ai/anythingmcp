/**
 * Limits for agent file uploads (file_upload_link). Files live a few hours, so
 * the caps protect bandwidth and the bucket, not long-term storage.
 *
 * Cloud: per plan, read from the workspace's active licence. When a workspace
 * has several active licences, the newest one (by creation) decides, as it
 * does for the plan everywhere else (LicenseService.getCurrentLicense); the
 * features of older licences are ignored. That licence can carry its own
 * daily upload count in the feature `uploadsPerDay` (a positive whole number,
 * e.g. a "2,000 uploads/day" add-on): it raises the plan's daily count, never
 * lowers it, is capped at MAX_UPLOADS_PER_DAY, and leaves every other limit
 * to the plan.
 * Self-hosted: every edition, Community included; the operator's own storage,
 * so no daily or stored caps unless the env sets them.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface FileUploadQuota {
  plan: string;
  maxFileBytes: number;
  /** null = no daily limit. */
  uploadsPerDay: number | null;
  /** null = no limit on the bytes stored at once. */
  maxStoredBytes: number | null;
  ttlHours: number;
}

const CLOUD: Record<string, Omit<FileUploadQuota, 'plan' | 'ttlHours'>> = {
  // `trial` is the trial without a card; a card trial carries its plan name.
  trial: { maxFileBytes: 25 * MB, uploadsPerDay: 50, maxStoredBytes: 500 * MB },
  starter: { maxFileBytes: 50 * MB, uploadsPerDay: 150, maxStoredBytes: 2 * GB },
  team: { maxFileBytes: 100 * MB, uploadsPerDay: 500, maxStoredBytes: 10 * GB },
  business: { maxFileBytes: 100 * MB, uploadsPerDay: 500, maxStoredBytes: 10 * GB },
  enterprise: { maxFileBytes: 200 * MB, uploadsPerDay: 5_000, maxStoredBytes: 50 * GB },
};

/**
 * Upper bound for the licence feature `uploadsPerDay`: twice the Enterprise
 * daily count. A larger value (e.g. a typo in Stripe price metadata) is
 * clamped to it, so a single workspace never loses its daily cap.
 */
export const MAX_UPLOADS_PER_DAY = 10_000;

function positiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The licence feature `uploadsPerDay` as a daily count, or null when it is
 * missing or not a positive whole number (the plan default then applies).
 * A digit-only string is accepted too: a value typed by hand into the licence
 * record may arrive as one. Values above MAX_UPLOADS_PER_DAY are clamped.
 */
export function uploadsPerDayOverride(features: unknown): number | null {
  if (!features || typeof features !== 'object') return null;
  const raw = (features as Record<string, unknown>).uploadsPerDay;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_UPLOADS_PER_DAY) : null;
}

export function uploadTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env.FILE_UPLOADS_TTL_HOURS) ?? 8;
}

export function uploadQuotaFor(
  plan: string | null,
  opts: { cloud: boolean; env?: NodeJS.ProcessEnv; features?: unknown },
): FileUploadQuota | null {
  const env = opts.env ?? process.env;
  const ttlHours = uploadTtlHours(env);
  if (!opts.cloud) {
    return {
      plan: plan ?? 'self-hosted',
      maxFileBytes: positiveNumber(env.FILE_UPLOADS_MAX_FILE_BYTES) ?? 100 * MB,
      uploadsPerDay: positiveNumber(env.FILE_UPLOADS_PER_DAY),
      maxStoredBytes: positiveNumber(env.FILE_UPLOADS_MAX_STORED_BYTES),
      ttlHours,
    };
  }
  if (!plan) return null;
  const q = CLOUD[plan] ?? CLOUD.starter;
  const override = uploadsPerDayOverride(opts.features);
  const uploadsPerDay =
    override != null && q.uploadsPerDay != null ? Math.max(override, q.uploadsPerDay) : q.uploadsPerDay;
  return { plan, ...q, uploadsPerDay, ttlHours };
}

/** Instance-wide brakes. Defaults only on Cloud; self-hosted sets them if it wants. */
export function globalUploadLimits(cloud: boolean, env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: (env.FILE_UPLOADS_ENABLED ?? 'true').toLowerCase() !== 'false',
    dailyBytes: positiveNumber(env.FILE_UPLOADS_GLOBAL_DAILY_BYTES) ?? (cloud ? 100 * GB : null),
    storedBytes: positiveNumber(env.FILE_UPLOADS_GLOBAL_STORED_BYTES) ?? (cloud ? 200 * GB : null),
  };
}
