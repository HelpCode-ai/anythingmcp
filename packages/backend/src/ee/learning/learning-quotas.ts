/**
 * Learning projects per plan (#1695). A learning project turns learning on
 * for one member on one MCP server.
 *
 *  - AnythingMCP Cloud: Team and Business include one active project, and so
 *    does the trial (it has the Team features). Enterprise has no limit.
 *    Starter has none.
 *  - Self-hosted: Enterprise only. The 30-day evaluation includes one project.
 *
 * `full` opens what only Enterprise has: observed differences, the knowledge
 * connector, the export, the guided interview and facts in company memory.
 *
 * The numbers live here, not on the licence site, so existing keys need no
 * reissue (the reasoning of `license/code-mode-quotas.ts`). A contract can
 * still set the number per key with the licence feature
 * `maxLearningProjects`: a number caps, `null` means unlimited.
 */

export interface LearningAllowance {
  /** Projects that may be open (waiting for consent or active). `null` = no limit. */
  max: number | null;
  /** The Enterprise parts are included. */
  full: boolean;
  /** The plan the answer is based on, for messages. */
  plan: string;
}

/** Cloud plans that include one project. */
const CLOUD_ONE_PROJECT = new Set(['trial', 'team', 'business']);

export interface LearningPlanInput {
  /** Plan of the workspace's licence, if any. */
  plan: string | null | undefined;
  /** The licence is active and not expired. */
  active: boolean;
  /** AnythingMCP Cloud (`DEPLOYMENT_MODE=cloud`). */
  cloud: boolean;
  /** Self-hosted: the 30-day evaluation is running. */
  evaluation?: boolean;
  /** Licence feature `maxLearningProjects`. */
  override?: unknown;
}

const NONE = (plan: string): LearningAllowance => ({ max: 0, full: false, plan });

export function learningAllowance(input: LearningPlanInput): LearningAllowance {
  const plan = input.active && input.plan ? input.plan : null;

  let base: LearningAllowance;
  if (plan === 'enterprise') {
    base = { max: null, full: true, plan };
  } else if (input.cloud && plan && CLOUD_ONE_PROJECT.has(plan)) {
    base = { max: 1, full: false, plan };
  } else if (!input.cloud && input.evaluation) {
    base = { max: 1, full: false, plan: 'evaluation' };
  } else {
    return NONE(plan ?? (input.cloud ? 'none' : 'community'));
  }

  // A contract may change the number, never what the plan includes.
  if (input.override === null) return { ...base, max: null };
  if (typeof input.override === 'number' && Number.isFinite(input.override) && input.override >= 0) {
    return { ...base, max: Math.floor(input.override) };
  }
  return base;
}

/** Project states that take a place in the plan's number. */
export const LEARNING_OPEN_STATUSES = ['draft', 'active'] as const;
