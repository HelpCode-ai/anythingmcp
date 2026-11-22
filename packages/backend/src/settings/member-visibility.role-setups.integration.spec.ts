import { randomUUID } from 'node:crypto';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { PrismaService } from '../common/prisma.service';
import { CatalogResyncService } from '../connectors/catalog-resync.service';
import { ConnectorsController } from '../connectors/connectors.controller';
import { ConnectorsService } from '../connectors/connectors.service';
import { UserCredentialsService } from '../connectors/user-credentials.service';
import { WebhookEventsService } from '../connectors/webhook-events.service';
import { EditionService } from '../ee/licensing/edition.service';
import { RolesService } from '../roles/roles.service';
import { MemberVisibilityService } from './member-visibility.service';
import { OrgSettingsService } from './org-settings.service';
import { SiteSettingsService } from './site-settings.service';

/**
 * Restricted member visibility for the ways a role really reaches a member,
 * against PostgreSQL: roles set by hand, roles from single sign-on group
 * sync, grants valid in every workspace, several roles, no role, a role
 * without tools, and connectors the member owns from an earlier role.
 *
 * The workspace: an admin owns six connectors; "Rivile only" whitelists the
 * tools of connector 1, "Everything" the tools of all six. The member under
 * test, Rita, is reset before each case.
 *
 * Two promises are checked in every case:
 *  - a VIEWER sees in the dashboard exactly the connectors whose tools their
 *    roles allow, the same set their AI client can call;
 *  - that set is what the Roles page reports for them (GET /api/roles/members,
 *    `RolesService.getMemberAssignments`), so an admin can see why.
 *
 * Needs a migrated PostgreSQL in AUDIT_TEST_DATABASE_URL (as in CI). Every
 * row it creates belongs to fixture workspaces and users it deletes again.
 */
const url = process.env.AUDIT_TEST_DATABASE_URL;
const KEY = 'k'.repeat(48);
const ADDRESS = 'rivile-db.internal.example.invalid';

(url ? describe : describe.skip)('restricted member visibility: how roles reach a member (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let base: string;
  let roles: RolesService;

  const ids: Record<string, string> = {};
  const toolsOf: Record<string, string[]> = {};
  const users: Record<string, { sub: string; role: string; organizationId: string; email: string }> = {};
  const CONNECTORS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];

  const get = async (who: string, path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { 'x-test-user': who } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const nameOf = (id: string) => Object.keys(ids).find((k) => ids[k] === id);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? KEY;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    await prisma.$connect();
    const tag = randomUUID();
    const prismaService = prisma as unknown as PrismaService;

    ids.org = (await prisma.organization.create({ data: { name: 'role setups scenario' } })).id;
    ids.otherOrg = (await prisma.organization.create({ data: { name: 'role setups scenario, other' } })).id;
    for (const [key, role] of [
      ['ADMIN', 'ADMIN'],
      ['RITA', 'VIEWER'],
    ] as const) {
      const id = (
        await prisma.user.create({ data: { email: `mv-setups-${key.toLowerCase()}-${tag}@example.invalid`, name: key } })
      ).id;
      ids[key] = id;
      await prisma.user.update({ where: { id }, data: { organizationId: ids.org, role } });
      await prisma.organizationMember.create({ data: { userId: id, organizationId: ids.org, role } });
      users[key] = { sub: id, role, organizationId: ids.org, email: 'member@example.invalid' };
    }

    for (const [i, c] of CONNECTORS.entries()) {
      ids[c] = (
        await prisma.connector.create({
          data: {
            userId: ids.ADMIN,
            organizationId: ids.org,
            name: `Connector ${i + 1}`,
            type: 'DATABASE',
            baseUrl: `mssql://reporting@${ADDRESS}:1433/db${i + 1}`,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
          },
        })
      ).id;
      toolsOf[c] = [];
      for (const t of ['a', 'b', 'c']) {
        toolsOf[c].push(
          (
            await prisma.mcpTool.create({
              data: {
                connectorId: ids[c],
                name: `${c}_${t}_${tag.slice(0, 6)}`,
                description: 'fixture',
                parameters: {},
                endpointMapping: { method: 'query', sql: 'SELECT 1' },
              },
            })
          ).id,
        );
      }
    }

    const mkRole = async (key: string, name: string, connectors: string[]) => {
      ids[key] = (await prisma.role.create({ data: { name, organizationId: ids.org } })).id;
      const toolIds = connectors.flatMap((c) => toolsOf[c]);
      if (toolIds.length) await prisma.toolRoleAccess.createMany({ data: toolIds.map((toolId) => ({ roleId: ids[key], toolId })) });
    };
    await mkRole('rivile', 'Rivile only', ['c1']);
    await mkRole('everything', 'Everything', CONNECTORS);
    await mkRole('empty', 'No tools yet', []);

    roles = new RolesService(prismaService);
    const visibility = new MemberVisibilityService(new OrgSettingsService(prismaService, {} as SiteSettingsService), roles);
    await visibility.setMode(ids.org, 'restricted');
    const configService = { get: (k: string) => (k === 'ENCRYPTION_KEY' ? KEY : undefined) };
    const connectorsService = new ConnectorsService(
      prismaService,
      configService as unknown as ConfigService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(connectorsService, 'testConnection').mockResolvedValue({ ok: true, message: 'ok' } as any);

    const moduleRef = await Test.createTestingModule({
      controllers: [ConnectorsController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: configService },
        { provide: ConnectorsService, useValue: connectorsService },
        { provide: MemberVisibilityService, useValue: visibility },
        { provide: EditionService, useValue: { hasEnterprise: async () => true, assertEnterprise: async () => undefined } },
        { provide: UserCredentialsService, useValue: { status: async () => ({ connected: false }), remove: async () => false } },
        { provide: WebhookEventsService, useValue: { recentEvents: async () => [] } },
        { provide: CatalogResyncService, useValue: { computeDiff: async () => null } },
      ],
    })
      .useMocker(() => ({}))
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
      await prisma.user.deleteMany({ where: { id: { in: ['ADMIN', 'RITA'].map((k) => ids[k]).filter(Boolean) } } });
      await prisma.$disconnect();
    }
  });

  /** Rita back to a VIEWER with no role who owns nothing. */
  beforeEach(async () => {
    await prisma.userRoleAssignment.deleteMany({ where: { userId: ids.RITA } });
    await prisma.connector.updateMany({ where: { organizationId: ids.org }, data: { userId: ids.ADMIN } });
    await setRitaRole('VIEWER');
  });

  async function setRitaRole(role: 'VIEWER' | 'EDITOR' | 'ADMIN') {
    await prisma.organizationMember.update({
      where: { userId_organizationId: { userId: ids.RITA, organizationId: ids.org } },
      data: { role },
    });
    await prisma.user.update({ where: { id: ids.RITA }, data: { role } });
    users.RITA = { ...users.RITA, role };
  }
  const assign = (roleKey: string, opts: { source?: string; organizationId?: string | null } = {}) =>
    prisma.userRoleAssignment.create({
      data: {
        userId: ids.RITA,
        roleId: ids[roleKey],
        organizationId: opts.organizationId === undefined ? ids.org : opts.organizationId,
        source: opts.source ?? 'manual',
      },
    });

  /** What Rita reads: connector names in the list, and which are reduced. */
  async function ritaSees() {
    const list = await get('RITA', '/api/connectors');
    expect(list.status).toBe(200);
    const names = list.body.map((c: any) => nameOf(c.id)!).sort();
    const full = list.body.filter((c: any) => !c.memberView).map((c: any) => nameOf(c.id)!).sort();
    expect(JSON.stringify(list.body.filter((c: any) => c.memberView))).not.toContain(ADDRESS);
    return { names, full };
  }
  /** The connectors whose tools Rita's AI client may call. */
  async function ritaCanCall(): Promise<string[] | 'all'> {
    const allowed = await roles.getAllowedToolIds(ids.RITA, ids.org);
    if (allowed === null) return 'all';
    return CONNECTORS.filter((c) => toolsOf[c].some((t) => allowed.includes(t)));
  }
  /** What the Roles page reports Rita's roles reach. */
  async function rolesPageSays(): Promise<string[] | 'all'> {
    const row = (await roles.getMemberAssignments(ids.org)).find((m) => m.id === ids.RITA)!;
    return row.connectors === null ? 'all' : row.connectors.map((c) => nameOf(c.id)!).sort();
  }
  async function expectHidden(c: string) {
    expect((await get('RITA', `/api/connectors/${ids[c]}`)).status).toBe(404);
    expect((await get('RITA', `/api/connectors/${ids[c]}/export`)).status).toBe(404);
  }

  it('a role set by hand: one connector, reduced, the same on the Roles page and for the AI client', async () => {
    await assign('rivile');
    expect(await ritaSees()).toEqual({ names: ['c1'], full: [] });
    expect(await ritaCanCall()).toEqual(['c1']);
    expect(await rolesPageSays()).toEqual(['c1']);
    await expectHidden('c2');
  });

  it('a role from single sign-on group sync: the same as by hand', async () => {
    await assign('rivile', { source: 'entra' });
    expect(await ritaSees()).toEqual({ names: ['c1'], full: [] });
    expect(await ritaCanCall()).toEqual(['c1']);
    expect(await rolesPageSays()).toEqual(['c1']);
  });

  it('a grant valid in every workspace: the same as one in this workspace', async () => {
    await assign('rivile', { organizationId: null });
    expect(await ritaSees()).toEqual({ names: ['c1'], full: [] });
    expect(await ritaCanCall()).toEqual(['c1']);
    expect(await rolesPageSays()).toEqual(['c1']);
  });

  it('a grant made in another workspace does not apply here', async () => {
    await prisma.organizationMember.create({ data: { userId: ids.RITA, organizationId: ids.otherOrg, role: 'VIEWER' } });
    try {
      await assign('everything', { organizationId: ids.otherOrg });
      await assign('rivile');
      expect(await ritaSees()).toEqual({ names: ['c1'], full: [] });
      expect(await rolesPageSays()).toEqual(['c1']);
    } finally {
      await prisma.organizationMember.deleteMany({ where: { userId: ids.RITA, organizationId: ids.otherOrg } });
    }
  });

  it('a second role from group sync widens access, and the Roles page shows it', async () => {
    await assign('rivile');
    await assign('everything', { source: 'entra' });
    expect((await ritaSees()).names).toEqual(CONNECTORS);
    expect(await ritaCanCall()).toEqual(CONNECTORS);
    expect(await rolesPageSays()).toEqual(CONNECTORS);
  });

  it('no role, in a workspace that has tool lists: nothing', async () => {
    expect(await ritaSees()).toEqual({ names: [], full: [] });
    expect(await ritaCanCall()).toEqual([]);
    expect(await rolesPageSays()).toEqual([]);
  });

  it('a role with no tools: nothing, never "everything"', async () => {
    await assign('empty');
    expect(await ritaSees()).toEqual({ names: [], full: [] });
    expect(await ritaCanCall()).toEqual([]);
    expect(await rolesPageSays()).toEqual([]);
  });

  it('a VIEWER who owns the connectors from an earlier role sees only what the role allows', async () => {
    // Rita set the workspace up as an admin, or created connectors as an
    // editor, and was then made a viewer. A viewer can change no connector,
    // and her AI client can call only the role's tools.
    await prisma.connector.updateMany({ where: { organizationId: ids.org }, data: { userId: ids.RITA } });
    await assign('rivile');
    expect(await ritaCanCall()).toEqual(['c1']);
    expect(await rolesPageSays()).toEqual(['c1']);
    expect(await ritaSees()).toEqual({ names: ['c1'], full: [] });
    for (const c of ['c2', 'c3', 'c4', 'c5', 'c6']) await expectHidden(c);
    const exported = await get('RITA', '/api/connectors/export-all');
    expect(exported.body.connectors).toEqual([]);
  });

  it('an EDITOR keeps the full view of the connectors they own, to manage them', async () => {
    await setRitaRole('EDITOR');
    await prisma.connector.update({ where: { id: ids.c2 }, data: { userId: ids.RITA } });
    await assign('rivile');
    expect(await ritaSees()).toEqual({ names: ['c1', 'c2'], full: ['c2'] });
    expect((await get('RITA', `/api/connectors/${ids.c2}/export`)).status).toBe(200);
  });

  it('an ADMIN is never restricted', async () => {
    await setRitaRole('ADMIN');
    await assign('rivile');
    expect(await ritaSees()).toEqual({ names: CONNECTORS, full: CONNECTORS });
  });
});
