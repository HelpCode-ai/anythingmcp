/**
 * Cloud code-run quotas. Separate from the saved-code-tool caps in
 * `code-mode-quotas.ts`: those cap how many code tools a workspace may create,
 * these cap how often code actually runs. Two limits per plan:
 *
 *  - a **monthly run cap** (abuse + monetization), counted authoritatively from
 *    the `code_runs` table so it holds with or without Redis, and
 *  - a **concurrency cap** (noisy-neighbour protection for the shared runner),
 *    enforced best-effort with Redis counters.
 *
 * Cloud only: self-hosted is single-tenant and not metered by runs, so the
 * guard returns no cap there. The numbers live here in the backend, like the
 * other code-mode and file-search quotas, so existing licence keys need no
 * reissue. An Enterprise contract can override the monthly cap per key with the
 * licence feature `maxCodeRunsPerMonth` (a number caps, `null` = unlimited).
 *
 * A card-backed trial gets the Team quotas during the trial; a trial without
 * a card keeps the `trial` entry, a small budget that protects the shared
 * runner from throwaway sign-ups (see `codeRunQuotaPlan`).
 */

/** Code runs allowed per calendar month per plan. `null` = unlimited. */
export const MONTHLY_CODE_RUN_CAPS: Record<string, number | null> = {
  community: null, // self-hosted default; Cloud-only enforcement, so never hit
  trial: 500,
  starter: 500,
  team: 5000,
  business: 5000,
  enterprise: null,
};

/** Simultaneous code runs allowed per plan. `null` = unlimited. */
export const CONCURRENT_CODE_RUN_CAPS: Record<string, number | null> = {
  community: null,
  trial: 1,
  starter: 1,
  team: 3,
  business: 3,
  enterprise: 10,
};

/**
 * The monthly run cap for a plan, or `null` for unlimited. An explicit
 * `features.maxCodeRunsPerMonth` override wins: a non-negative number caps,
 * `null` means unlimited. An unknown plan falls back to the Community entry.
 */
export function monthlyCodeRunCapForPlan(
  plan: string | null | undefined,
  override?: unknown,
): number | null {
  if (override === null) return null;
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const cap = plan ? MONTHLY_CODE_RUN_CAPS[plan] : undefined;
  return cap === undefined ? MONTHLY_CODE_RUN_CAPS.community : cap;
}

/** The concurrency cap for a plan, or `null` for unlimited. */
export function concurrentCodeRunCapForPlan(plan: string | null | undefined): number | null {
  const cap = plan ? CONCURRENT_CODE_RUN_CAPS[plan] : undefined;
  return cap === undefined ? CONCURRENT_CODE_RUN_CAPS.community : cap;
}

/** Start of the current calendar month in UTC — the window the monthly cap counts over. */
export function startOfUtcMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The plan whose run quotas apply. A trial with a card on file runs on the
 * Team quotas; a trial without one keeps the `trial` quotas even though its
 * code-mode features are Team's; every other plan is its own.
 */
export function codeRunQuotaPlan(plan: string | null | undefined, cardTrial: boolean): string {
  if (plan === 'trial') return cardTrial ? 'team' : 'trial';
  return plan ?? 'community';
}
