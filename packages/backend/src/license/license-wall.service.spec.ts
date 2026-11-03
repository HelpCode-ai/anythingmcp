import { CONTROL_PERCENT, LicenseWallService, knownClientName, wallVariant } from './license-wall.service';
import { ProductEvents } from '../audit/product-event.service';
import { LicenseController } from './license.controller';

function prismaMock(opts: {
  calls?: number;
  byConnector?: { connectorId: string | null; _sum: { repeatCount: number } }[];
  connectors?: { id: string; name: string }[];
  clients?: unknown[];
  blocked?: boolean;
  viewedToday?: boolean;
}) {
  return {
    toolInvocation: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { repeatCount: opts.calls ?? 0 } }),
      groupBy: jest.fn().mockResolvedValue(opts.byConnector ?? []),
    },
    connector: { findMany: jest.fn().mockResolvedValue(opts.connectors ?? []) },
    productEvent: {
      findMany: jest.fn().mockResolvedValue((opts.clients ?? []).map((client) => ({ metadata: { client } }))),
      findFirst: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.event === ProductEvents.TRIAL_EXPIRED_CALL_BLOCKED
            ? opts.blocked ? { id: 'b' } : null
            : opts.viewedToday ? { id: 'v' } : null,
        ),
      ),
    },
  };
}

describe('wallVariant', () => {
  it('is fixed per workspace and keeps about CONTROL_PERCENT% on the earlier wall', () => {
    expect(wallVariant('org_a')).toBe(wallVariant('org_a'));
    const ids = Array.from({ length: 5000 }, (_, i) => `cm${i.toString(36)}xyz`);
    const control = ids.filter((id) => wallVariant(id) === 'control').length / ids.length;
    expect(control).toBeGreaterThan(CONTROL_PERCENT / 100 - 0.02);
    expect(control).toBeLessThan(CONTROL_PERCENT / 100 + 0.02);
  });
});

describe('knownClientName', () => {
  it('names the clients we know and nothing else', () => {
    expect(knownClientName('Claude')).toBe('Claude');
    expect(knownClientName('claude-code')).toBe('Claude');
    expect(knownClientName('ChatGPT')).toBe('ChatGPT');
    expect(knownClientName('My internal bot')).toBeNull();
    expect(knownClientName(undefined)).toBeNull();
  });
});

describe('LicenseWallService', () => {
  const events = () => ({ log: jest.fn().mockResolvedValue(undefined) });

  it('shows no numbers for a workspace that never made a successful call', async () => {
    const prisma = prismaMock({ calls: 0 });
    const svc = new LicenseWallService(prisma as any, events() as any);
    expect(await svc.recap('org_a')).toBeNull();
    expect(prisma.toolInvocation.groupBy).not.toHaveBeenCalled();
  });

  it('counts successful calls, names its own connectors only, and the known client', async () => {
    const prisma = prismaMock({
      calls: 214,
      byConnector: [
        { connectorId: 'c1', _sum: { repeatCount: 150 } },
        { connectorId: 'gone', _sum: { repeatCount: 40 } },
        { connectorId: 'c2', _sum: { repeatCount: 24 } },
      ],
      connectors: [
        { id: 'c2', name: 'Telegram' },
        { id: 'c1', name: 'Etsy' },
      ],
      clients: ['Custom bot', 'Claude'],
      blocked: true,
    });
    const svc = new LicenseWallService(prisma as any, events() as any);
    expect(await svc.recap('org_a')).toEqual({
      successfulCalls: 214,
      connectors: ['Etsy', 'Telegram'],
      client: 'Claude',
      blockedSinceEnd: true,
    });
    // Every query stays in the workspace.
    expect(prisma.toolInvocation.aggregate.mock.calls[0][0].where).toMatchObject({ organizationId: 'org_a', status: 'SUCCESS' });
    expect(prisma.toolInvocation.groupBy.mock.calls[0][0].where).toMatchObject({ organizationId: 'org_a', status: 'SUCCESS' });
    expect(prisma.connector.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: 'org_a' });
    expect(prisma.productEvent.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: 'org_a' });
  });

  it('records one view a day with the variant and the calls shown', async () => {
    const log = events();
    const svc = new LicenseWallService(prismaMock({ calls: 3 }) as any, log as any);
    const view = await svc.view('org_a', 'u1');
    expect(view.variant).toBe(wallVariant('org_a'));
    expect(log.log).toHaveBeenCalledWith({
      event: ProductEvents.LICENSE_WALL_VIEWED,
      organizationId: 'org_a',
      userId: 'u1',
      metadata: { variant: wallVariant('org_a'), calls: 3 },
    });

    const again = events();
    await new LicenseWallService(prismaMock({ calls: 3, viewedToday: true }) as any, again as any).view('org_a', 'u1');
    expect(again.log).not.toHaveBeenCalled();
  });

  it('still answers with the variant when the numbers cannot be read', async () => {
    const prisma = prismaMock({});
    prisma.toolInvocation.aggregate.mockRejectedValue(new Error('db down'));
    const view = await new LicenseWallService(prisma as any, events() as any).view('org_a', null);
    expect(view).toEqual({ variant: wallVariant('org_a'), recap: null });
  });
});

describe('GET /api/license/wall', () => {
  const build = (opts: { cloud?: boolean; trial?: { active: boolean } | null }) => {
    const wall = { view: jest.fn().mockResolvedValue({ variant: 'trust', recap: null }) };
    const guard = { getTrialState: jest.fn().mockResolvedValue(opts.trial === undefined ? { active: false } : opts.trial) };
    const controller = new LicenseController(
      {} as any,
      guard as any,
      {} as any,
      {} as any,
      { isCloud: () => opts.cloud ?? true } as any,
      {} as any,
      {} as any,
      {} as any,
      wall as any,
    );
    return { controller, wall };
  };
  const admin = { user: { organizationId: 'org_a', role: 'ADMIN', sub: 'u1' } };

  it('answers an admin of a Cloud workspace whose trial ended', async () => {
    const { controller, wall } = build({});
    expect(await controller.wallForUser(admin)).toEqual({ wall: { variant: 'trust', recap: null } });
    expect(wall.view).toHaveBeenCalledWith('org_a', 'u1');
  });

  it('is null, and records nothing, for members, running trials, paid plans and self-hosted', async () => {
    for (const [opts, req] of [
      [{}, { user: { organizationId: 'org_a', role: 'MEMBER' } }],
      [{ trial: { active: true } }, admin],
      [{ trial: null }, admin],
      [{ cloud: false }, admin],
    ] as const) {
      const { controller, wall } = build(opts as any);
      expect(await controller.wallForUser(req as any)).toEqual({ wall: null });
      expect(wall.view).not.toHaveBeenCalled();
    }
  });
});
