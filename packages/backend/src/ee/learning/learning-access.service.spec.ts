import { LearningAccessService } from './learning-access.service';

function make(opts: {
  cloud?: boolean;
  license?: any;
  source?: string | null;
  open?: number;
}) {
  const prisma = { learningProject: { count: jest.fn(async () => opts.open ?? 0) } };
  const deployment = { isCloud: () => !!opts.cloud };
  const licenses = { getCurrentLicense: jest.fn(async () => opts.license ?? null) };
  const edition = { getState: jest.fn(async () => ({ source: opts.source ?? null })) };
  const svc = new LearningAccessService(prisma as any, deployment as any, licenses as any, edition as any);
  return { svc, prisma, licenses, edition };
}

const active = (plan: string, features: any = null) => ({ plan, status: 'active', expiresAt: null, features });

describe('LearningAccessService', () => {
  const ORG = 'org-A';

  it('counts only this workspace\'s open projects', async () => {
    const { svc, prisma } = make({ cloud: true, license: active('team'), open: 1 });
    expect(await svc.usage(ORG)).toEqual({ max: 1, full: false, plan: 'team', used: 1 });
    expect(prisma.learningProject.count).toHaveBeenCalledWith({
      where: { organizationId: ORG, status: { in: ['draft', 'active'] } },
    });
  });

  it('lets Cloud Team open its one project and refuses the second with the plan limit', async () => {
    await expect(make({ cloud: true, license: active('team'), open: 0 }).svc.assertCanOpen(ORG)).resolves.toBeUndefined();
    await expect(make({ cloud: true, license: active('team'), open: 1 }).svc.assertCanOpen(ORG)).rejects.toMatchObject({
      response: { code: 'PLAN_LIMIT', axis: 'learningProjects', max: 1, current: 1 },
    });
  });

  it('answers a plan without learning projects with the edition offer', async () => {
    await expect(make({ cloud: true, license: active('starter') }).svc.assertCanOpen(ORG)).rejects.toMatchObject({
      response: { code: 'edition_required', message: expect.stringContaining('Team and Enterprise') },
    });
    await expect(make({ cloud: false }).svc.assertCanOpen(ORG)).rejects.toMatchObject({
      response: { code: 'edition_required', message: expect.stringContaining('AnythingMCP Enterprise') },
    });
  });

  it('never limits Enterprise', async () => {
    await expect(make({ license: active('enterprise'), open: 40 }).svc.assertCanOpen(ORG)).resolves.toBeUndefined();
  });

  it('treats an expired licence as no licence', async () => {
    const expired = { plan: 'enterprise', status: 'active', expiresAt: new Date(Date.now() - 1000), features: null };
    expect((await make({ license: expired }).svc.allowance(ORG)).max).toBe(0);
  });

  it('includes one project in the self-hosted evaluation and asks the edition only there', async () => {
    const evaluating = make({ cloud: false, source: 'trial' });
    expect(await evaluating.svc.allowance(ORG)).toEqual({ max: 1, full: false, plan: 'evaluation' });

    const cloud = make({ cloud: true, license: active('starter'), source: 'trial' });
    expect((await cloud.svc.allowance(ORG)).max).toBe(0);
    expect(cloud.edition.getState).not.toHaveBeenCalled();

    const enterprise = make({ cloud: false, license: active('enterprise') });
    await enterprise.svc.allowance(ORG);
    expect(enterprise.edition.getState).not.toHaveBeenCalled();
  });

  it('reads the number a contract sets on the key', async () => {
    const { svc } = make({ cloud: true, license: active('team', { maxLearningProjects: 4 }) });
    expect((await svc.allowance(ORG)).max).toBe(4);
  });

  it('caches the plan for a minute and forgets it on request', async () => {
    const { svc, licenses } = make({ cloud: true, license: active('team') });
    await svc.allowance(ORG);
    await svc.allowance(ORG);
    expect(licenses.getCurrentLicense).toHaveBeenCalledTimes(1);
    svc.forget(ORG);
    await svc.allowance(ORG);
    expect(licenses.getCurrentLicense).toHaveBeenCalledTimes(2);
  });

  it('gives nothing without a workspace', async () => {
    expect((await make({ cloud: true, license: active('enterprise') }).svc.allowance('')).max).toBe(0);
  });
});
