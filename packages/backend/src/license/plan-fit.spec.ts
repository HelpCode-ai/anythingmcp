import { anonymizePlanFit, evaluatePlanFit, isFitPlan, rankForCap, type FitItem, type FitSnapshot } from './plan-fit';
import { PlanFitService } from './plan-fit.service';

const t0 = new Date('2026-11-01T00:00:00Z');
const item = (id: string, calls30d: number, updatedAt = t0): FitItem => ({ id, name: `name-${id}`, calls30d, updatedAt });

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

describe('rankForCap', () => {
  it('keeps the most used, then the most recently changed, and pauses the rest', () => {
    const r = rankForCap(
      [item('a', 1), item('b', 50), item('c', 0, new Date('2026-11-05')), item('d', 0, new Date('2026-10-01')), item('e', 9)],
      3,
    );
    expect(r.keep.map((x) => x.id)).toEqual(['b', 'e', 'a']);
    expect(r.pause.map((x) => x.id)).toEqual(['c', 'd']);
    expect(r).toMatchObject({ current: 5, max: 3, over: true });
  });

  it('keeps everything when unlimited or under the cap', () => {
    expect(rankForCap([item('a', 0), item('b', 0)], null)).toMatchObject({ over: false, pause: [] });
    expect(rankForCap([item('a', 0)], 5)).toMatchObject({ current: 1, over: false, pause: [] });
  });

  it('is stable on full ties', () => {
    const r = rankForCap([item('z', 0), item('a', 0)], 1);
    expect(r.keep[0].id).toBe('a');
  });
});

describe('evaluatePlanFit', () => {
  it('a workspace inside Starter fits Starter', () => {
    const fit = evaluatePlanFit(snapshot({ connectors: [item('a', 3)], mcpServers: [item('s', 3)] }), 'starter');
    expect(fit.fits).toBe(true);
    expect(fit.connectors).toMatchObject({ current: 1, max: 5, over: false });
  });

  it('names what goes past Starter and fits Team', () => {
    const connectors = Array.from({ length: 9 }, (_, i) => item(`c${i}`, 9 - i));
    const snap = snapshot({
      connectors,
      mcpServers: [item('s1', 1), item('s2', 2), item('s3', 3), item('s4', 0)],
      users: 2,
      fileSearchConnectors: [item('f1', 4), item('f2', 1)],
      fileSearchFiles: 1200,
      fileSearchBytes: 600 * 1024 * 1024,
      codeTools: 7,
      inlineCodeInUse: true,
      codeRunsThisMonth: 40,
    });
    const starter = evaluatePlanFit(snap, 'starter');
    expect(starter.fits).toBe(false);
    expect(starter.connectors.pause.map((x) => x.id)).toEqual(['c5', 'c6', 'c7', 'c8']);
    expect(starter.mcpServers.pause.map((x) => x.id)).toEqual(['s4']);
    expect(starter.users).toMatchObject({ current: 2, max: 1, over: true });
    expect(starter.fileSearch.connectors.pause.map((x) => x.id)).toEqual(['f2']);
    expect(starter.fileSearch.files).toMatchObject({ max: 500, over: true });
    expect(starter.fileSearch.bytes.over).toBe(true);
    expect(starter.code).toMatchObject({ inlineInUse: true, inlineIncluded: false, tools: { max: 5, over: true } });
    expect(starter.code.runsThisMonth).toMatchObject({ current: 40, max: 500, over: false });

    const team = evaluatePlanFit(snap, 'team');
    expect(team.fits).toBe(true);
    expect(team.connectors.pause).toEqual([]);
    expect(team.code.inlineIncluded).toBe(true);
    expect(team.fileSearch.fileShare).toBe(true);
  });

  it('inline code in use alone makes Starter not fit', () => {
    expect(evaluatePlanFit(snapshot({ inlineCodeInUse: true }), 'starter').fits).toBe(false);
  });

  it('anonymizes names for the page without a sign-in', () => {
    const fit = evaluatePlanFit(snapshot({ connectors: Array.from({ length: 6 }, (_, i) => item(`c${i}`, i)) }), 'starter');
    const anon = anonymizePlanFit(fit);
    expect(anon.connectors.pause).toEqual([{ id: 'pause-0', name: '', calls30d: 0 }]);
    expect(JSON.stringify(anon)).not.toContain('name-c');
    expect(anon.connectors.current).toBe(6);
  });

  it('accepts only the checkout plans', () => {
    expect(isFitPlan('starter')).toBe(true);
    expect(isFitPlan('team')).toBe(true);
    expect(isFitPlan('enterprise')).toBe(false);
    expect(isFitPlan(undefined)).toBe(false);
  });
});

describe('PlanFitService.snapshot', () => {
  function make() {
    const prisma = {
      connector: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'c1', name: 'Shopify', type: 'REST', config: {}, updatedAt: t0 },
          { id: 'fs1', name: 'NAS', type: 'FILE_SEARCH', config: {}, updatedAt: t0 },
          { id: 'share', name: 'File Share', type: 'FILE_SEARCH', config: { fileShare: true }, updatedAt: t0 },
        ]),
      },
      mcpServerConfig: {
        findMany: jest.fn().mockResolvedValue([{ id: 's1', name: 'Default', codeMode: 'inline', updatedAt: t0 }]),
      },
      organizationMember: { count: jest.fn().mockResolvedValue(2) },
      toolInvocation: {
        groupBy: jest
          .fn()
          .mockResolvedValueOnce([{ connectorId: 'c1', _count: { _all: 12 } }])
          .mockResolvedValueOnce([{ mcpServerId: 's1', _count: { _all: 30 } }]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ count: 4 }]),
      codeRun: { count: jest.fn().mockResolvedValue(17) },
    };
    const fileRepo = {
      withTenant: jest.fn((_org: string, fn: any) =>
        fn({ fileEntry: { aggregate: jest.fn().mockResolvedValue({ _count: 321, _sum: { size: 1024n } }) } }),
      ),
    };
    return { prisma, fileRepo, svc: new PlanFitService(prisma as any, fileRepo as any) };
  }

  it('reads one workspace: active items, File Search apart, File Share left out', async () => {
    const { prisma, fileRepo, svc } = make();
    const snap = await svc.snapshot('org1', new Date('2026-11-09T10:00:00Z'));
    expect(snap.connectors.map((c) => [c.id, c.calls30d])).toEqual([['c1', 12]]);
    expect(snap.fileSearchConnectors.map((c) => c.id)).toEqual(['fs1']);
    expect(snap.mcpServers[0]).toMatchObject({ id: 's1', calls30d: 30 });
    expect(snap).toMatchObject({ users: 2, codeTools: 4, inlineCodeInUse: true, codeRunsThisMonth: 17, fileSearchFiles: 321, fileSearchBytes: 1024 });

    // Every query is scoped to the organization, and only active items count.
    expect(prisma.connector.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org1', isActive: true });
    expect(prisma.mcpServerConfig.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org1', isActive: true });
    for (const [args] of prisma.toolInvocation.groupBy.mock.calls) {
      expect(args.where.organizationId).toBe('org1');
      expect(args.where.createdAt.gte.toISOString()).toBe('2026-10-10T10:00:00.000Z');
    }
    expect(prisma.codeRun.count.mock.calls[0][0].where.organizationId).toBe('org1');
    expect(fileRepo.withTenant.mock.calls[0][0]).toBe('org1');
  });

  it('evaluates both plans from one read', async () => {
    const { prisma, svc } = make();
    const all = await svc.fitAll('org1');
    expect(Object.keys(all)).toEqual(['starter', 'team']);
    expect(all.starter.code.inlineIncluded).toBe(false);
    expect(prisma.connector.findMany).toHaveBeenCalledTimes(1);
  });
});
