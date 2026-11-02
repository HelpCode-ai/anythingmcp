/**
 * Watching for a provider to approve a user's own app (Etsy).
 *
 * WHY. A new Etsy app stays Pending until Etsy reviews it, and until then
 * Etsy refuses its keys: the guided setup says so before sending the user to
 * Etsy's sign-in (checkBeforeAuthorization, #936). In 30 days 449 Cloud
 * workspaces got that answer and only a third ever made an Etsy call: the
 * approval email comes from Etsy days later and nothing brings the user back.
 * So the keys are kept on the connector (the setup page saves them as a
 * draft), checked again with the same cheap call, and the owner is emailed
 * once when Etsy accepts them.
 *
 * Pure functions only (state, schedule, email text), so the schedule and the
 * once-only rule can be tested without a database; the job itself is
 * AppApprovalWatcherService.
 */

/** Catalog adapters whose app approval is watched. The keys are checked with their `checkBeforeAuthorization`. */
export const APP_APPROVAL_ADAPTERS: ReadonlySet<string> = new Set(['etsy']);

/** What the email suggests asking the AI client once the sign-in is done, per adapter. */
export const FIRST_PROMPT: Readonly<Record<string, string>> = {
  etsy: 'Show my last 10 Etsy orders',
};

/** Connectors are watched this long after they were created, then left alone. */
export const WATCH_FOR_MS = 14 * 24 * 60 * 60 * 1000;
/** The first day after the keys were first refused: checked every hour. */
export const FIRST_DAY_MS = 24 * 60 * 60 * 1000;
export const FIRST_DAY_EVERY_MS = 60 * 60 * 1000;
/** After the first day: every 6 hours. */
export const LATER_EVERY_MS = 6 * 60 * 60 * 1000;
/**
 * The sweep runs every 15 minutes; a check that falls due a few minutes after
 * a sweep is taken by that sweep rather than 15 minutes late, so the cadence
 * stays hourly, not every 75 minutes.
 */
export const DUE_SLACK_MS = 5 * 60 * 1000;

/** Key in `connectors.config` that holds the watch; no schema change. */
export const WATCH_CONFIG_KEY = 'appApprovalWatch';

/**
 * The watch, as kept in the connector's config (ISO dates).
 *
 * - pendingSince: when the provider was first seen refusing the keys
 *   (the setup check, or this job's own first check)
 * - lastCheckedAt: the last check by this job
 * - notPending: the keys were accepted at the first check and were never seen
 *   refused: the user simply has not signed in yet, nothing to tell them
 * - approvedAt: the provider accepted the keys after refusing them
 * - notifiedAt: the email was claimed (sent, or tried once); never again
 * - doneAt: the connector got its sign-in while watched; nothing to tell
 */
export interface AppApprovalWatch {
  pendingSince?: string;
  lastCheckedAt?: string;
  notPending?: string;
  approvedAt?: string;
  notifiedAt?: string;
  doneAt?: string;
}

export function readWatch(config: unknown): AppApprovalWatch {
  const raw = (config as Record<string, unknown> | null | undefined)?.[WATCH_CONFIG_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: AppApprovalWatch = {};
  for (const key of ['pendingSince', 'lastCheckedAt', 'notPending', 'approvedAt', 'notifiedAt', 'doneAt'] as const) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) out[key] = v;
  }
  return out;
}

/** Whether the watch has ended for good: nothing more to check or send. */
export function watchFinished(watch: AppApprovalWatch): boolean {
  return !!(watch.notifiedAt || watch.approvedAt || watch.notPending || watch.doneAt);
}

/**
 * The time between checks: hourly during the first day after the keys were
 * first refused, then every 6 hours. Before anything was refused (a connector
 * found by the job before any check), hourly.
 */
export function checkInterval(watch: AppApprovalWatch, now: Date): number {
  if (!watch.pendingSince) return FIRST_DAY_EVERY_MS;
  const age = now.getTime() - Date.parse(watch.pendingSince);
  return age < FIRST_DAY_MS ? FIRST_DAY_EVERY_MS : LATER_EVERY_MS;
}

/**
 * Whether a connector is checked on this sweep: watched (created under 14
 * days ago and the watch not ended) and its interval since the last check
 * has passed. A watch never checked is due at once.
 */
export function isCheckDue(
  watch: AppApprovalWatch,
  connectorCreatedAt: Date,
  now: Date,
): boolean {
  if (watchFinished(watch)) return false;
  if (now.getTime() - connectorCreatedAt.getTime() > WATCH_FOR_MS) return false;
  if (watch.pendingSince && now.getTime() - Date.parse(watch.pendingSince) > WATCH_FOR_MS) return false;
  if (!watch.lastCheckedAt) return true;
  const since = now.getTime() - Date.parse(watch.lastCheckedAt);
  return since >= checkInterval(watch, now) - DUE_SLACK_MS;
}

/**
 * Evidence, from product events, that the provider refused this connector's
 * keys before the job first looked at it. The setup page checks the keys
 * before the connector exists (a new install) or before they are stored (a
 * connector installed from a chat), so the refusal is recorded against the
 * workspace, not always against the connector. An event counts when it is
 * about the same adapter, from the same workspace, at most a day before the
 * connector was created, and either names this connector or none.
 *
 * Events: `etsy_app_pending_seen` (from the setup check), and, for setups
 * before that event existed, `setup_verify_failed` with HTTP status 403.
 * Returns the earliest such time, or undefined.
 */
export function pendingEvidence(
  connector: { id: string; organizationId: string; createdAt: Date; adapterSlug: string },
  events: Array<{ event: string; organizationId: string | null; createdAt: Date; metadata: unknown }>,
  pendingEvent: string,
): Date | undefined {
  const from = connector.createdAt.getTime() - FIRST_DAY_MS;
  let earliest: Date | undefined;
  for (const e of events) {
    if (e.organizationId !== connector.organizationId) continue;
    if (e.createdAt.getTime() < from) continue;
    const m = (e.metadata ?? {}) as Record<string, unknown>;
    if (m.adapterSlug !== connector.adapterSlug) continue;
    if (typeof m.connectorId === 'string' && m.connectorId !== connector.id) continue;
    const counts = e.event === pendingEvent || (e.event === 'setup_verify_failed' && Number(m.status) === 403);
    if (!counts) continue;
    if (!earliest || e.createdAt < earliest) earliest = e.createdAt;
  }
  return earliest;
}

/** A claude.ai link that opens a new chat with this request typed in. */
export function claudePromptUrl(prompt: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
}
