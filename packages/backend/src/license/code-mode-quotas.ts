/**
 * Code mode limits per plan. The numbers live here in the backend, not on the
 * licence site, so existing keys need no reissue (the same reasoning as
 * `file-search-quotas.ts`): adding them to the issued `features` would only
 * reach new keys and need a Mongo + Cloud-SQL backfill, and paid keys only
 * re-verify every ~20 h. An Enterprise contract can still override the cap per
 * key through the licence feature `maxCodeTools` (a number caps, `null` means
 * unlimited).
 *
 * The same caps apply on Cloud and self-hosted. A workspace with no resolvable
 * plan (self-hosted Community without a paid key, or during the evaluation) is
 * treated as `community`.
 */

/** Saved code tools allowed per plan. `null` = unlimited. */
export const CODE_TOOL_CAPS: Record<string, number | null> = {
  community: 3,
  trial: 3,
  starter: 5,
  team: 20,
  business: 20,
  enterprise: null,
};

/**
 * Plans that include inline code — the generic `code_execute` and
 * `code_propose_tool` tools. Saved code tools follow the per-plan cap above and
 * the normal tool allow-list; inline code is Team and above only.
 */
const INLINE_PLANS = new Set(['team', 'business', 'enterprise']);

/**
 * The cap on saved code tools for a plan, or `null` for unlimited. An explicit
 * `features.maxCodeTools` override wins: a non-negative number caps, `null`
 * means unlimited. An unknown plan falls back to the Community cap.
 */
export function codeToolCapForPlan(
  plan: string | null | undefined,
  override?: unknown,
): number | null {
  if (override === null) return null;
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const cap = plan ? CODE_TOOL_CAPS[plan] : undefined;
  return cap === undefined ? CODE_TOOL_CAPS.community : cap;
}

/** Whether a plan includes inline code (`code_execute` / `code_propose_tool`). */
export function inlineCodeAllowedForPlan(plan: string | null | undefined): boolean {
  return !!plan && INLINE_PLANS.has(plan);
}
