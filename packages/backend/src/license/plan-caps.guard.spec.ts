import { LicenseGuardService } from './license-guard.service';
import { PlanLimitException, PAUSED_BY_PLAN_KEY, webhookConnectorCap } from './plan-caps';

function make(license: any, counts: { connectors?: number; servers?: number; members?: number; fsActive?: number; webhooks?: number } = {}, cloud = true) {
  const prisma = {
    connector: {
      count: jest.fn(async ({ where }: any) => (where.webhookEnabled ? counts.webhooks ?? 0 : counts.connectors ?? 0)),
      findMany: jest.fn(async ({ where }: any) =>
        where.type === 'FILE_SEARCH'
          ? Array.from({ length: counts.fsActive ?? 0 }, () => ({ config: {} }))
          : (where.id?.in ?? []).map((id: string) => ({ id, name: `Name ${id}` })),
      ),
    },
    mcpServerConfig: {
      count: jest.fn().mockResolvedValue(counts.servers ?? 0),
      findMany: jest.fn(async ({ where }: any) => (where.id?.in ?? []).map((id: string) => ({ id }))),
    },
    organizationMember: { count: jest.fn().mockResolvedValue(counts.members ?? 1) },
    orgSettings: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const licenseService = {
    getCurrentLicense: jest.fn().mockResolvedValue(license),
    getLatestInactiveLicense: jest.fn().mockResolvedValue(null),
  };
  return { guard: new LicenseGuardService(prisma as any, licenseService as any, { isCloud: () => cloud } as any), prisma };
}

const starter = { plan: 'starter', status: 'active', features: { maxConnectors: 5, maxMcpServers: 3, maxUsers: 1 } };
const trial = { plan: 'trial', status: 'active', expiresAt: new Date(Date.now() + 86_400_000), features: { maxConnectors: 15, maxMcpServers: 10, maxUsers: 3 } };

describe('LicenseGuardService — plan caps', () => {
  const saved = process.env.PLAN_CAPS_ENFORCE;
  afterEach(() => {
    if (saved === undefined) delete process.env.PLAN_CAPS_ENFORCE;
    else process.env.PLAN_CAPS_ENFORCE = saved;
  });

  it('keeps the trial cap on creation hard, with the PLAN_LIMIT code', async () => {
    delete process.env.PLAN_CAPS_ENFORCE;
    const { guard, prisma } = make(trial, { connectors: 15 });
    const err = await guard.checkCanCreateConnector('u1', 'org-1').catch((e) => e);
    expect(err).toBeInstanceOf(PlanLimitException);
    expect(err.getResponse()).toMatchObject({ code: 'PLAN_LIMIT', axis: 'connectors', max: 15, current: 15 });
    expect(err.message).toMatch(/Trial limit reached \(15 connectors\)/);
    expect(prisma.connector.count).toHaveBeenCalledWith({ where: { organizationId: 'org-1', isActive: true, type: { not: 'FILE_SEARCH' } } });
  });

  it('a paid plan at its cap only logs in dry-run and refuses when on', async () => {
    delete process.env.PLAN_CAPS_ENFORCE;
    await expect(make(starter, { connectors: 5 }).guard.checkCanCreateConnector('u1', 'org-1')).resolves.toBeUndefined();
    await expect(make(starter, { servers: 3 }).guard.checkCanCreateMcpServer('u1', 'org-1')).resolves.toBeUndefined();
    process.env.PLAN_CAPS_ENFORCE = 'on';
    await expect(make(starter, { connectors: 5 }).guard.checkCanCreateConnector('u1', 'org-1')).rejects.toThrow(/includes 5 active connectors/);
    await expect(make(starter, { servers: 3 }).guard.checkCanCreateMcpServer('u1', 'org-1')).rejects.toThrow(PlanLimitException);
    await expect(make(starter, { connectors: 4 }).guard.checkCanCreateConnector('u1', 'org-1')).resolves.toBeUndefined();
  });

  it('never caps an unlimited plan or self-hosted', async () => {
    process.env.PLAN_CAPS_ENFORCE = 'on';
    const enterprise = { plan: 'enterprise', status: 'active', features: { maxConnectors: null } };
    await expect(make(enterprise, { connectors: 500 }).guard.checkCanCreateConnector('u1', 'org-1')).resolves.toBeUndefined();
    await expect(make(starter, { connectors: 50 }, false).guard.checkCanCreateConnector('u1', 'org-1')).resolves.toBeUndefined();
    await expect(make(starter, { connectors: 50 }, false).guard.checkCanActivateConnector('org-1', 'REST')).resolves.toBeUndefined();
  });

  it('refuses switching a paused connector or server back on at the cap', async () => {
    process.env.PLAN_CAPS_ENFORCE = 'on';
    const err = await make(starter, { connectors: 5 }).guard.checkCanActivateConnector('org-1', 'REST').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'PLAN_LIMIT', axis: 'connectors', max: 5 });
    await expect(make(starter, { connectors: 4 }).guard.checkCanActivateConnector('org-1', 'REST')).resolves.toBeUndefined();
    await expect(make(starter, { servers: 3 }).guard.checkCanActivateMcpServer('org-1')).rejects.toThrow(/Pause one/);
    // The trial is hard in every mode.
    delete process.env.PLAN_CAPS_ENFORCE;
    await expect(make(trial, { connectors: 15 }).guard.checkCanActivateConnector('org-1', 'REST')).rejects.toThrow(PlanLimitException);
  });

  it('counts a File Search folder against the File Search folders of the plan', async () => {
    process.env.PLAN_CAPS_ENFORCE = 'on';
    const err = await make(starter, { fsActive: 1 }).guard.checkCanActivateConnector('org-1', 'FILE_SEARCH').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ axis: 'fileSearchConnectors', max: 1 });
    await expect(make(starter, { fsActive: 0 }).guard.checkCanActivateConnector('org-1', 'FILE_SEARCH')).resolves.toBeUndefined();
  });

  it('refuses a new member above the user cap when on', async () => {
    process.env.PLAN_CAPS_ENFORCE = 'on';
    await expect(make(starter, { members: 1 }).guard.checkCanAddMember('org-1')).rejects.toThrow(/includes 1 user/);
    await expect(make(trial, { members: 2 }).guard.checkCanAddMember('org-1')).resolves.toBeUndefined();
    delete process.env.PLAN_CAPS_ENFORCE;
    await expect(make(starter, { members: 1 }).guard.checkCanAddMember('org-1')).resolves.toBeUndefined();
  });

  it('reports what a downgrade paused and is still paused', async () => {
    const { guard, prisma } = make(starter, { connectors: 5 });
    prisma.orgSettings.findUnique.mockResolvedValue({
      value: JSON.stringify({ plan: 'starter', at: '', connectors: ['c1'], mcpServers: ['s1'], fileSearch: ['f1'] }),
    });
    const usage = await guard.getUsage('u1', 'org-1');
    expect(usage.pausedByPlan).toEqual({ connectors: ['c1', 'f1'], mcpServers: ['s1'] });
    expect(prisma.orgSettings.findUnique).toHaveBeenCalledWith({
      where: { organizationId_key: { organizationId: 'org-1', key: PAUSED_BY_PLAN_KEY } },
      select: { value: true },
    });
    await expect(guard.pausedByPlanConnectorNames('org-1')).resolves.toEqual(['Name c1', 'Name f1']);
  });

  describe('inbound webhooks (#1393)', () => {
    const team = { plan: 'team', status: 'active', features: { maxConnectors: 15 } };
    const business = { plan: 'business', status: 'active', features: { maxConnectors: null } };

    it('caps Starter at 1, Team and the trial at 5, Business and Enterprise not at all', () => {
      expect(webhookConnectorCap('starter')).toBe(1);
      expect(webhookConnectorCap('team')).toBe(5);
      expect(webhookConnectorCap('trial')).toBe(5);
      expect(webhookConnectorCap('business')).toBeNull();
      expect(webhookConnectorCap('enterprise')).toBeNull();
      expect(webhookConnectorCap('something-new')).toBeNull();
      expect(webhookConnectorCap(null)).toBeNull();
      // A licence feature overrides the plan (more by arrangement).
      expect(webhookConnectorCap('starter', 3)).toBe(3);
      expect(webhookConnectorCap('starter', 'x')).toBe(1);
    });

    it('only logs at the cap in dry-run', async () => {
      delete process.env.PLAN_CAPS_ENFORCE;
      const { guard, prisma } = make(starter, { webhooks: 1 });
      const log = jest.spyOn((guard as any).logger, 'log').mockImplementation(() => undefined);
      await expect(guard.checkCanEnableWebhook('org-1')).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith('[plan caps dry-run] would refuse webhooks for org org-1: 1/1');
      expect(prisma.connector.count).toHaveBeenCalledWith({ where: { organizationId: 'org-1', isActive: true, webhookEnabled: true } });
    });

    it('refuses at the cap with PLAN_LIMIT when on, and allows below it', async () => {
      process.env.PLAN_CAPS_ENFORCE = 'on';
      const err = await make(starter, { webhooks: 1 }).guard.checkCanEnableWebhook('org-1').catch((e) => e);
      expect(err).toBeInstanceOf(PlanLimitException);
      expect(err.getResponse()).toMatchObject({ code: 'PLAN_LIMIT', axis: 'webhooks', max: 1, current: 1 });
      expect(err.message).toMatch(/inbound webhooks on 1 connector\./);
      await expect(make(starter, { webhooks: 0 }).guard.checkCanEnableWebhook('org-1')).resolves.toBeUndefined();
      await expect(make(team, { webhooks: 4 }).guard.checkCanEnableWebhook('org-1')).resolves.toBeUndefined();
      await expect(make(team, { webhooks: 5 }).guard.checkCanEnableWebhook('org-1')).rejects.toThrow(/on 5 connectors/);
      // The trial follows Team and is soft like the paid plans.
      await expect(make(trial, { webhooks: 5 }).guard.checkCanEnableWebhook('org-1')).rejects.toThrow(PlanLimitException);
      delete process.env.PLAN_CAPS_ENFORCE;
      await expect(make(trial, { webhooks: 5 }).guard.checkCanEnableWebhook('org-1')).resolves.toBeUndefined();
    });

    it('never caps Business, a workspace without a licence, or self-hosted', async () => {
      process.env.PLAN_CAPS_ENFORCE = 'on';
      await expect(make(business, { webhooks: 40 }).guard.checkCanEnableWebhook('org-1')).resolves.toBeUndefined();
      await expect(make(null, { webhooks: 40 }).guard.checkCanEnableWebhook('org-1')).resolves.toBeUndefined();
      const selfHosted = make(starter, { webhooks: 40 }, false);
      await expect(selfHosted.guard.checkCanEnableWebhook('org-1')).resolves.toBeUndefined();
      expect(selfHosted.prisma.connector.count).not.toHaveBeenCalled();
    });
  });
});
