import { PlanCapsService } from './plan-caps.service';
import { evaluatePlanFit, type FitItem, type FitSnapshot } from '../license/plan-fit';
import { PAUSED_BY_PLAN_KEY, planCapsMode, parsePausedByPlan, planRank } from '../license/plan-caps';

const at = new Date('2026-11-01T00:00:00Z');
const item = (id: string, calls30d: number): FitItem => ({ id, name: `Name ${id}`, calls30d, updatedAt: at });

function snapshot(over: Partial<FitSnapshot> = {}): FitSnapshot {
  return {
    connectors: [],
    mcpServers: [],
    users: 1,
    fileSearchConnectors: [],
    fileSearchFiles: 0,
    fileSearchBytes: 0,
    codeTools: 0,
    inlineCodeInUse: false,
    codeRunsThisMonth: 0,
    ...over,
  };
}

function make(snap: FitSnapshot, opts: { stored?: unknown; inactive?: string[]; cloud?: boolean } = {}) {
  const settings = new Map<string, string>();
  if (opts.stored) settings.set(PAUSED_BY_PLAN_KEY, JSON.stringify(opts.stored));
  const inactive = new Set(opts.inactive ?? []);
  const prisma = {
    connector: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(async ({ where }: any) => (where.id.in as string[]).filter((id) => inactive.has(id)).map((id) => ({ id }))),
    },
    mcpServerConfig: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(async ({ where }: any) => (where.id.in as string[]).filter((id) => inactive.has(id)).map((id) => ({ id }))),
    },
    organizationMember: {
      findMany: jest.fn(async () => [{ user: { email: 'admin@example.test', name: 'Ada' } }]),
    },
    organization: { findUnique: jest.fn(async () => ({ name: 'Acme' })) },
  };
  const planFit = {
    fit: jest.fn(async (_org: string, plan: 'starter' | 'team') => evaluatePlanFit(snap, plan)),
    snapshot: jest.fn(async () => snap),
  };
  const licenses = { onPlanChange: jest.fn() };
  const mcpServer = { reloadConnectorTools: jest.fn(async () => {}) };
  const orgSettings = {
    get: jest.fn(async (_org: string, key: string) => settings.get(key) ?? null),
    setJson: jest.fn(async (_org: string, key: string, v: unknown) => void settings.set(key, JSON.stringify(v))),
    delete: jest.fn(async (_org: string, key: string) => void settings.delete(key)),
  };
  const email = { sendPlanCapsAppliedEmail: jest.fn(async () => true) };
  const productEvents = { log: jest.fn(async () => {}) };
  const svc = new PlanCapsService(
    prisma as any,
    { isCloud: () => opts.cloud ?? true } as any,
    licenses as any,
    planFit as any,
    mcpServer as any,
    orgSettings as any,
    email as any,
    productEvents as any,
  );
  return { svc, prisma, planFit, licenses, mcpServer, orgSettings, settings, email, productEvents };
}

const nine = Array.from({ length: 9 }, (_, i) => item(`c${i}`, 9 - i));

describe('plan-caps helpers', () => {
  it('defaults to dry-run', () => {
    expect(planCapsMode({})).toBe('dry-run');
    expect(planCapsMode({ PLAN_CAPS_ENFORCE: 'ON' })).toBe('on');
    expect(planCapsMode({ PLAN_CAPS_ENFORCE: 'off' })).toBe('off');
    expect(planCapsMode({ PLAN_CAPS_ENFORCE: 'yes' })).toBe('dry-run');
  });

  it('ranks the trial with Team, and no licence below everything', () => {
    expect(planRank('starter')).toBeLessThan(planRank('trial')!);
    expect(planRank('trial')).toBe(planRank('team'));
    expect(planRank(null)).toBe(0);
    expect(planRank('mystery')).toBeNull();
  });

  it('reads a stored record defensively', () => {
    expect(parsePausedByPlan('not json')).toBeNull();
    expect(parsePausedByPlan(JSON.stringify({ connectors: ['a', 3], mcpServers: 'x' }))).toMatchObject({
      connectors: ['a'],
      mcpServers: [],
      fileSearch: [],
    });
  });
});

describe('PlanCapsService', () => {
  const saved = process.env.PLAN_CAPS_ENFORCE;
  afterEach(() => {
    if (saved === undefined) delete process.env.PLAN_CAPS_ENFORCE;
    else process.env.PLAN_CAPS_ENFORCE = saved;
  });

  it('listens to plan changes on Cloud only', () => {
    const cloud = make(snapshot());
    cloud.svc.onModuleInit();
    expect(cloud.licenses.onPlanChange).toHaveBeenCalledTimes(1);
    const self = make(snapshot(), { cloud: false });
    self.svc.onModuleInit();
    expect(self.licenses.onPlanChange).not.toHaveBeenCalled();
  });

  it('trial → Starter pauses the least used above the caps, in the org only, and tells the admins', async () => {
    process.env.PLAN_CAPS_ENFORCE = 'on';
    const snap = snapshot({ connectors: nine, mcpServers: [item('s1', 5), item('s2', 4), item('s3', 3), item('s4', 0)] });
    const { svc, prisma, mcpServer, settings, email, productEvents } = make(snap);
    await svc.reconcile({ organizationId: 'org-1', from: 'trial', to: 'starter' });

    expect(prisma.connector.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', id: { in: ['c5', 'c6', 'c7', 'c8'] } },
      data: { isActive: false },
    });
    expect(prisma.mcpServerConfig.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', id: { in: ['s4'] } },
      data: { isActive: false },
    });
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledTimes(4);
    expect(JSON.parse(settings.get(PAUSED_BY_PLAN_KEY)!)).toMatchObject({
      plan: 'starter',
      connectors: ['c5', 'c6', 'c7', 'c8'],
      mcpServers: ['s4'],
    });
    expect(email.sendPlanCapsAppliedEmail).toHaveBeenCalledWith(
      'admin@example.test',
      expect.objectContaining({
        planName: 'Starter',
        paused: { connectors: ['Name c5', 'Name c6', 'Name c7', 'Name c8'], mcpServers: ['Name s4'], fileSearch: [] },
      }),
      'org-1',
    );
    expect(productEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'plan_caps_applied', metadata: expect.objectContaining({ kind: 'downgrade', status: 'on', calls: 5 }) }),
    );
  });

  it('only logs in dry-run (the default)', async () => {
    delete process.env.PLAN_CAPS_ENFORCE;
    const { svc, prisma, email, settings, productEvents } = make(snapshot({ connectors: nine }));
    await svc.reconcile({ organizationId: 'org-1', from: 'trial', to: 'starter' });
    expect(prisma.connector.updateMany).not.toHaveBeenCalled();
    expect(email.sendPlanCapsAppliedEmail).not.toHaveBeenCalled();
    expect(settings.has(PAUSED_BY_PLAN_KEY)).toBe(false);
    expect(productEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ status: 'dry-run' }) }),
    );
  });

  it('does nothing when the workspace fits, when it is off, or when the licence ends', async () => {
    process.env.PLAN_CAPS_ENFORCE = 'on';
    const fits = make(snapshot({ connectors: [item('a', 1)] }));
    await fits.svc.reconcile({ organizationId: 'org-1', from: 'trial', to: 'starter' });
    expect(fits.prisma.connector.updateMany).not.toHaveBeenCalled();

    process.env.PLAN_CAPS_ENFORCE = 'off';
    const off = make(snapshot({ connectors: nine }));
    await off.svc.reconcile({ organizationId: 'org-1', from: 'trial', to: 'starter' });
    expect(off.planFit.fit).not.toHaveBeenCalled();

    process.env.PLAN_CAPS_ENFORCE = 'on';
    const ended = make(snapshot({ connectors: nine }));
    await ended.svc.reconcile({ organizationId: 'org-1', from: 'starter', to: null });
    expect(ended.planFit.fit).not.toHaveBeenCalled();
  });

  it('Starter → Team brings back what was paused, up to the Team caps', async () => {
    process.env.PLAN_CAPS_ENFORCE = 'on';
    const snap = snapshot({ connectors: nine.slice(0, 5) });
    const stored = { plan: 'starter', at: '', connectors: ['c5', 'c6', 'gone'], mcpServers: ['s4'], fileSearch: [] };
    const { svc, prisma, settings, mcpServer } = make(snap, { stored, inactive: ['c5', 'c6', 's4'] });
    await svc.reconcile({ organizationId: 'org-1', from: 'starter', to: 'team' });
    expect(prisma.connector.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', id: { in: ['c5', 'c6'] } },
      data: { isActive: true },
    });
    expect(prisma.mcpServerConfig.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', id: { in: ['s4'] } },
      data: { isActive: true },
    });
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledTimes(2);
    // "gone" no longer exists (or was switched on by hand), so it is dropped too.
    expect(JSON.parse(settings.get(PAUSED_BY_PLAN_KEY)!).connectors).toEqual(['gone']);
  });

  it('restores only as many as the new plan has room for', async () => {
    process.env.PLAN_CAPS_ENFORCE = 'on';
    const snap = snapshot({ connectors: Array.from({ length: 14 }, (_, i) => item(`a${i}`, 1)) });
    const stored = { plan: 'starter', at: '', connectors: ['p1', 'p2', 'p3'], mcpServers: [], fileSearch: [] };
    const { svc, prisma } = make(snap, { stored, inactive: ['p1', 'p2', 'p3'] });
    await svc.reconcile({ organizationId: 'org-1', from: 'starter', to: 'team' });
    expect(prisma.connector.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', id: { in: ['p1'] } },
      data: { isActive: true },
    });
  });

  it('runs one change per workspace at a time', async () => {
    process.env.PLAN_CAPS_ENFORCE = 'on';
    const { svc, planFit } = make(snapshot({ connectors: nine }));
    const order: string[] = [];
    planFit.fit.mockImplementation(async (_o: string, plan: any) => {
      order.push(`start ${plan}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${plan}`);
      return evaluatePlanFit(snapshot(), plan);
    });
    await Promise.all([
      svc.reconcile({ organizationId: 'org-1', from: 'trial', to: 'starter' }),
      svc.reconcile({ organizationId: 'org-1', from: 'starter', to: 'team' }),
    ]);
    expect(order.slice(0, 2)).toEqual(['start starter', 'end starter']);
  });
});
