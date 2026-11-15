/**
 * Limits for agent file uploads (file_upload_link). Files live a few hours, so
 * the caps protect bandwidth and the bucket, not long-term storage.
 *
 * Cloud: per plan, read from the workspace's active licence.
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

function positiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function uploadTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env.FILE_UPLOADS_TTL_HOURS) ?? 8;
}

export function uploadQuotaFor(
  plan: string | null,
  opts: { cloud: boolean; env?: NodeJS.ProcessEnv },
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
  return { plan, ...q, ttlHours };
}

/** Instance-wide brakes. Defaults only on Cloud; self-hosted sets them if it wants. */
export function globalUploadLimits(cloud: boolean, env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: (env.FILE_UPLOADS_ENABLED ?? 'true').toLowerCase() !== 'false',
    dailyBytes: positiveNumber(env.FILE_UPLOADS_GLOBAL_DAILY_BYTES) ?? (cloud ? 100 * GB : null),
    storedBytes: positiveNumber(env.FILE_UPLOADS_GLOBAL_STORED_BYTES) ?? (cloud ? 200 * GB : null),
  };
}
