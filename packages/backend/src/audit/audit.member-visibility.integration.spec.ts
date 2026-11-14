import { randomUUID } from 'node:crypto';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { PrismaService } from '../common/prisma.service';
import { RolesService } from '../roles/roles.service';
import { OrgSettingsService } from '../settings/org-settings.service';
import { SiteSettingsService } from '../settings/site-settings.service';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Member visibility on every audit read route, end to end: HTTP, controller,
 * AuditService, the raw SQL of analytics and tool performance, and the Prisma
 * queries of invocations, stats and breakdowns, against the migrated schema.
 * The mode and the memberships are real rows; RolesService is the real one.
 *
 * Needs a migrated PostgreSQL in AUDIT_TEST_DATABASE_URL (as in CI). Every
 * row it creates belongs to fixture workspaces and users it deletes again.
 */
const url = process.env.AUDIT_TEST_DATABASE_URL;

(url ? describe : describe.skip)('audit routes with member visibility (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let base: string;
  let roles: RolesService;
  let visibility: MemberVisibilityService;

  const ids = {
    org: '',
    otherOrg: '',
    admin: '',
    viewer: '',
    editor: '',
    other: '',
    outsider: '',
    connector: '',
    otherConnector: '',
    toolMine: '',
    toolTheirs: '',
    server: '',
  };
  const users: Record<string, { sub: string; role: string; organizationId: string }> = {};
  let viewerRows: string[] = [];

  const get = async (who: string, path: string) => {
    const res = await fetch(`${base}/api/audit/${path}`, { headers: { 'x-test-user': who } });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    await prisma.$connect();
    const tag = randomUUID();

    const mkUser = async (name: string) =>
      (await prisma.user.create({ data: { email: `mv-audit-${name}-${tag}@example.invalid`, name } })).id;
    ids.admin = await mkUser('admin');
    ids.viewer = await mkUser('viewer');
    ids.editor = await mkUser('editor');
    ids.other = await mkUser('other');
    ids.outsider = await mkUser('outsider');

    ids.org = (await prisma.organization.create({ data: { name: 'member visibility audit test' } })).id;
    ids.otherOrg = (await prisma.organization.create({ data: { name: 'member visibility audit test, other' } })).id;
    for (const [userId, role] of [
      [ids.admin, 'ADMIN'],
      [ids.viewer, 'VIEWER'],
      [ids.editor, 'EDITOR'],
      [ids.other, 'EDITOR'],
    ] as const) {
      await prisma.organizationMember.create({ data: { userId, organizationId: ids.org, role } });
      users[role === 'EDITOR' && userId === ids.other ? 'OTHER' : role] = {
        sub: userId,
        role,
        organizationId: ids.org,
      };
    }
    await prisma.organizationMember.create({
      data: { userId: ids.outsider, organizationId: ids.otherOrg, role: 'ADMIN' },
    });

    const connector = await prisma.connector.create({
      data: { userId: ids.admin, organizationId: ids.org, name: 'CRM', type: 'REST', baseUrl: 'https://example.invalid' },
    });
    ids.connector = connector.id;
    const tool = (name: string, connectorId: string) =>
      prisma.mcpTool.create({
        data: { connectorId, name, description: 'fixture', parameters: {}, endpointMapping: {} },
      });
    ids.toolMine = (await tool('crm_search', connector.id)).id;
    ids.toolTheirs = (await tool('crm_export', connector.id)).id;
    ids.server = (
      await prisma.mcpServerConfig.create({
        data: { userId: ids.admin, organizationId: ids.org, name: 'Sales', slug: `sales-${tag.slice(0, 8)}` },
      })
    ).id;
    const otherConnector = await prisma.connector.create({
      data: { userId: ids.outsider, organizationId: ids.otherOrg, name: 'Other', type: 'REST', baseUrl: 'https://example.invalid' },
    });
    ids.otherConnector = otherConnector.id;
    const otherTool = (await tool('crm_search', otherConnector.id)).id;

    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    const call = async (data: {
      toolId: string;
      userId: string | null;
      status: 'SUCCESS' | 'ERROR' | 'TIMEOUT';
      at: Date;
      error?: string;
      repeatCount?: number;
      mcpServerId?: string;
      organizationId?: string;
      connectorId?: string;
    }) =>
      (
        await prisma.toolInvocation.create({
          data: {
            toolId: data.toolId,
            userId: data.userId,
            status: data.status,
            createdAt: data.at,
            error: data.error,
            repeatCount: data.repeatCount ?? 1,
            mcpServerId: data.mcpServerId,
            organizationId: data.organizationId ?? ids.org,
            connectorId: data.connectorId ?? ids.connector,
            durationMs: 100,
            input: { q: 'fixture' },
          },
        })
      ).id;

    viewerRows = [
      await call({ toolId: ids.toolMine, userId: ids.viewer, status: 'SUCCESS', at: minutesAgo(50), mcpServerId: ids.server }),
      await call({ toolId: ids.toolMine, userId: ids.viewer, status: 'ERROR', at: minutesAgo(40), error: 'viewer error', repeatCount: 2 }),
    ];
    // Another member's calls: same tool (newer failure, must not become the
    // viewer's lastError), another tool, the same server.
    await call({ toolId: ids.toolMine, userId: ids.other, status: 'TIMEOUT', at: minutesAgo(10), error: 'other member error', mcpServerId: ids.server });
    await call({ toolId: ids.toolTheirs, userId: ids.other, status: 'ERROR', at: minutesAgo(20), error: 'other member export error', repeatCount: 5 });
    await call({ toolId: ids.toolMine, userId: ids.editor, status: 'SUCCESS', at: minutesAgo(30) });
    // A call without a user (e.g. a key whose owner was deleted).
    await call({ toolId: ids.toolMine, userId: null, status: 'SUCCESS', at: minutesAgo(5), mcpServerId: ids.server });
    // Another workspace.
    await call({
      toolId: otherTool,
      userId: ids.outsider,
      status: 'ERROR',
      at: minutesAgo(15),
      error: 'other workspace error',
      organizationId: ids.otherOrg,
      connectorId: otherConnector.id,
    });

    const prismaService = prisma as unknown as PrismaService;
    roles = new RolesService(prismaService);
    const orgSettings = new OrgSettingsService(prismaService, {} as SiteSettingsService);
    visibility = new MemberVisibilityService(orgSettings, roles);

    const moduleRef = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: MemberVisibilityService, useValue: visibility },
      ],
    })
      .overrideGuard(JwtOrManagementKeyGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          req.user = users[req.headers['x-test-user']];
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    if (prisma) {
      await prisma.organization.deleteMany({ where: { id: { in: [ids.org, ids.otherOrg].filter(Boolean) } } });
      await prisma.user.deleteMany({
        where: { id: { in: [ids.admin, ids.viewer, ids.editor, ids.other, ids.outsider].filter(Boolean) } },
      });
      await prisma.$disconnect();
    }
  });

  afterEach(() => jest.restoreAllMocks());

  const setMode = (mode: 'open' | 'restricted') => visibility.setMode(ids.org, mode);

  describe('open workspace', () => {
    beforeAll(() => setMode('open'));

    it.each(['ADMIN', 'EDITOR', 'VIEWER'])('%s sees every call of the workspace', async (who) => {
      const inv = await get(who, 'invocations');
      expect(inv.status).toBe(200);
      expect(inv.body).toHaveLength(6);
      expect(new Set(inv.body.map((r: any) => r.user?.id ?? null))).toEqual(
        new Set([ids.viewer, ids.other, ids.editor, null]),
      );

      expect((await get(who, 'stats')).body).toMatchObject({ invocations24h: 11, errors24h: 7 });
      expect((await get(who, 'analytics')).body.totalInvocations).toBe(11);
      const perf = await get(who, 'tool-performance');
      expect(perf.body.items.map((i: any) => i.toolName).sort()).toEqual(['crm_export', 'crm_search', 'crm_search']);
      const breakdowns = await get(who, 'breakdowns');
      expect(breakdowns.body.total).toBe(11);
      expect(breakdowns.body.byUser).toHaveLength(4);
    });
  });

  describe('restricted workspace', () => {
    beforeAll(() => setMode('restricted'));

    it('an admin still sees every call', async () => {
      expect((await get('ADMIN', 'invocations')).body).toHaveLength(6);
      expect((await get('ADMIN', 'stats')).body.invocations24h).toBe(11);
      expect((await get('ADMIN', 'breakdowns')).body.byUser).toHaveLength(4);
    });

    it('a viewer gets only their own rows, hiding calls without a user', async () => {
      const inv = await get('VIEWER', 'invocations');
      expect(inv.status).toBe(200);
      expect(inv.body.map((r: any) => r.id).sort()).toEqual([...viewerRows].sort());
      expect(inv.body.every((r: any) => r.user.id === ids.viewer)).toBe(true);
      // Same shape as the open path.
      expect(Object.keys(inv.body[0]).sort()).toEqual(
        Object.keys((await get('ADMIN', 'invocations')).body[0]).sort(),
      );
    });

    it('an editor gets only their own rows', async () => {
      const inv = await get('EDITOR', 'invocations');
      expect(inv.body).toHaveLength(1);
      expect(inv.body[0].user.id).toBe(ids.editor);
    });

    it("no filter parameter reaches another member's rows", async () => {
      const own = (rows: any[]) => rows.every((r) => r.user?.id === ids.viewer);
      const cases: Array<[string, number]> = [
        [`toolId=${ids.toolTheirs}`, 0],
        [`toolId=${ids.toolMine}`, 2],
        [`connectorId=${ids.connector}`, 2],
        [`connectorId=${ids.otherConnector}`, 0],
        [`mcpServerId=${ids.server}`, 1],
        ['search=export', 0],
        ['search=crm', 2],
        ['status=TIMEOUT', 0],
        ['status=ERROR', 1],
        ['limit=1&offset=1', 1],
        [`userId=${ids.other}`, 2],
      ];
      for (const [query, count] of cases) {
        const res = await get('VIEWER', `invocations?${query}`);
        expect({ query, count: res.body.length, own: own(res.body) }).toEqual({ query, count, own: true });
      }
    });

    it('stats count only the caller’s calls', async () => {
      expect((await get('VIEWER', 'stats')).body).toEqual({
        invocations24h: 3,
        errors24h: 2,
        invocations7d: 3,
        totalInvocations: 3,
      });
    });

    it('analytics count only the caller’s calls', async () => {
      const { body } = await get('VIEWER', 'analytics?days=7');
      expect(body.totalInvocations).toBe(3);
      expect(body.topTools).toEqual([{ name: 'crm_search', count: 3, errors: 2, avgDuration: expect.any(Number) }]);
    });

    it('tool performance holds only the caller’s calls, and their own last error', async () => {
      const { body } = await get('VIEWER', 'tool-performance?hours=24');
      expect(body.items).toHaveLength(2);
      expect(body.items.every((i: any) => i.toolName === 'crm_search')).toBe(true);
      const direct = body.items.find((i: any) => i.mcpServerId === null);
      expect(direct).toMatchObject({ calls: 2, errors: 2, lastError: 'viewer error' });
      const viaServer = body.items.find((i: any) => i.mcpServerId === ids.server);
      // The other member's newer TIMEOUT on the same tool and server stays hidden.
      expect(viaServer).toMatchObject({ calls: 1, errors: 0, lastError: null });

      const filtered = await get('VIEWER', `tool-performance?connectorId=${ids.connector}&mcpServerId=${ids.server}`);
      expect(filtered.body.items).toHaveLength(1);
      expect(filtered.body.items[0]).toMatchObject({ calls: 1, lastError: null });
    });

    it('breakdowns hold only the caller’s calls, byUser only their own row', async () => {
      const { body } = await get('VIEWER', 'breakdowns');
      expect(body).toMatchObject({ total: 3, errors: 2 });
      expect(body.byUser).toEqual([{ id: ids.viewer, label: 'viewer', count: 3, errors: 2 }]);
      expect(body.byConnector).toEqual([{ id: ids.connector, label: 'CRM', count: 3, errors: 2 }]);
    });

    it.each(['invocations', 'stats', 'analytics', 'tool-performance', 'breakdowns'])(
      'fails closed on %s when the role lookup throws',
      async (route) => {
        jest.spyOn(roles, 'getAllowedToolIds').mockRejectedValueOnce(new Error('database down'));
        const res = await get('VIEWER', route);
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain('crm_');
      },
    );
  });
});
