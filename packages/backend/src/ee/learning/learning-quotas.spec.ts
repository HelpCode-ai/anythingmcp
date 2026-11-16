import { learningAllowance } from './learning-quotas';

describe('learningAllowance', () => {
  const cloud = (plan: string | null, active = true, override?: unknown) =>
    learningAllowance({ plan, active, cloud: true, override });
  const selfHosted = (plan: string | null, opts: { evaluation?: boolean; active?: boolean } = {}) =>
    learningAllowance({ plan, active: opts.active ?? true, cloud: false, evaluation: opts.evaluation });

  it('gives Cloud Team, Business and the trial one project without the Enterprise parts', () => {
    for (const plan of ['team', 'business', 'trial']) {
      expect(cloud(plan)).toEqual({ max: 1, full: false, plan });
    }
  });

  it('gives Cloud Starter and a workspace without a licence none', () => {
    expect(cloud('starter')).toEqual({ max: 0, full: false, plan: 'starter' });
    expect(cloud(null)).toEqual({ max: 0, full: false, plan: 'none' });
  });

  it('gives Enterprise everything, on Cloud and self-hosted', () => {
    expect(cloud('enterprise')).toEqual({ max: null, full: true, plan: 'enterprise' });
    expect(selfHosted('enterprise')).toEqual({ max: null, full: true, plan: 'enterprise' });
  });

  it('ignores a licence that is not active', () => {
    expect(cloud('team', false).max).toBe(0);
    expect(selfHosted('enterprise', { active: false })).toEqual({ max: 0, full: false, plan: 'community' });
  });

  it('gives self-hosted Community and the keys below Enterprise none', () => {
    expect(selfHosted(null).max).toBe(0);
    for (const plan of ['starter', 'team', 'business']) expect(selfHosted(plan).max).toBe(0);
  });

  it('includes one project in the self-hosted evaluation, without the Enterprise parts', () => {
    expect(selfHosted(null, { evaluation: true })).toEqual({ max: 1, full: false, plan: 'evaluation' });
    // A key below Enterprise does not take the evaluation's project away.
    expect(selfHosted('team', { evaluation: true }).max).toBe(1);
  });

  it('never opens an evaluation on Cloud', () => {
    expect(learningAllowance({ plan: 'starter', active: true, cloud: true, evaluation: true }).max).toBe(0);
  });

  it('lets a contract change the number, not what the plan includes', () => {
    expect(cloud('team', true, 3)).toEqual({ max: 3, full: false, plan: 'team' });
    expect(cloud('team', true, null)).toEqual({ max: null, full: false, plan: 'team' });
    expect(cloud('enterprise', true, 5)).toEqual({ max: 5, full: true, plan: 'enterprise' });
    expect(cloud('team', true, -1).max).toBe(1);
    expect(cloud('team', true, 'many').max).toBe(1);
    // No plan, no project, whatever the key says.
    expect(cloud('starter', true, 10).max).toBe(0);
  });
});
