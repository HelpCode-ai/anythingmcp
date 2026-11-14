import { randomUUID } from 'node:crypto';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { PrismaService } from '../common/prisma.service';
import { EditionService } from '../ee/licensing/edition.service';
import { FileSearchController } from '../file-search/file-search.controller';
import { FileSearchQueryService } from '../file-search/file-search-query.service';
import { FileSearchRepository } from '../file-search/file-search.repository';
import { FileSearchService } from '../file-search/file-search.service';
import { RolesService } from '../roles/roles.service';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import { OrgSettingsService } from '../settings/org-settings.service';
import { SiteSettingsService } from '../settings/site-settings.service';
import { CatalogResyncService } from './catalog-resync.service';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import { ToolsController } from './tools.controller';
import { UserCredentialsService } from './user-credentials.service';
import { WebhookEventsService } from './webhook-events.service';

/**
 * Member visibility on the connectors, tools and File Search read routes,
 * end to end: HTTP, controllers, the real ConnectorsService queries, the real
 * RolesService and org_settings rows, against the migrated schema.
 *
 * Needs a migrated PostgreSQL in AUDIT_TEST_DATABASE_URL (as in CI). Every
 * row it creates belongs to fixture workspaces and users it deletes again.
 */
const url = process.env.AUDIT_TEST_DATABASE_URL;
const KEY = 'k'.repeat(48);

(url ? describe : describe.skip)('connectors, tools and File Search with member visibility (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let base: string;
  let roles: RolesService;
  let visibility: MemberVisibilityService;

  const ids: Record<string, string> = {};
  const tools: Record<string, string> = {};
  const users: Record<string, { sub: string; role: string; organizationId: string; email: string }> = {};
  /** Connectors in creation order (oldest first), by fixture name. */
  const order: string[] = [];

  const get = async (who: string, path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { 'x-test-user': who } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? KEY;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    await prisma.$connect();
    const tag = randomUUID();

    const mkUser = async (name: string) =>
      (await prisma.user.create({ data: { email: `mv-conn-${name}-${tag}@example.invalid`, name } })).id;
    ids.org = (await prisma.organization.create({ data: { name: 'member visibility connectors test' } })).id;
    ids.otherOrg = (await prisma.organization.create({ data: { name: 'member visibility connectors test, other' } })).id;
    for (const [key, role] of [
      ['ADMIN', 'ADMIN'],
      ['EDITOR', 'EDITOR'],
      ['VIEWER', 'VIEWER'],
      ['OTHER', 'EDITOR'],
    ] as const) {
      const id = await mkUser(key.toLowerCase());
      ids[key] = id;
      await prisma.user.update({ where: { id }, data: { organizationId: ids.org, role } });
      await prisma.organizationMember.create({ data: { userId: id, organizationId: ids.org, role } });
      users[key] = { sub: id, role, organizationId: ids.org, email: 'member@example.invalid' };
    }
    ids.OUTSIDER = await mkUser('outsider');
    await prisma.organizationMember.create({ data: { userId: ids.OUTSIDER, organizationId: ids.otherOrg, role: 'ADMIN' } });

    let minute = 0;
    const mk = async (name: string, owner: string, toolNames: string[], type = 'REST', org = ids.org) => {
      const c = await prisma.connector.create({
        data: {
          userId: owner,
          organizationId: org,
          name,
          type: type as any,
          baseUrl: 'https://api.example.invalid',
          ...(type === 'FILE_SEARCH' ? { config: { fileSearch: { toolPrefix: name.toLowerCase() } } } : {}),
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute++)),
        },
      });
      ids[name] = c.id;
      if (org === ids.org) order.push(name);
      for (const t of toolNames) {
        tools[t] = (
          await prisma.mcpTool.create({
            data: { connectorId: c.id, name: `${name}_${t}`, description: 'fixture', parameters: {}, endpointMapping: { method: 'GET', path: '/x' } },
          })
        ).id;
      }
    };
    await mk('edMine', ids.EDITOR, ['e1']);
    await mk('vwMine', ids.VIEWER, ['v1']);
    await mk('shared', ids.OTHER, ['s1', 's2']);
    await mk('hidden', ids.OTHER, ['h1']);
    await mk('fs', ids.OTHER, ['f1'], 'FILE_SEARCH');
    await mk('fsHidden', ids.OTHER, ['f2'], 'FILE_SEARCH');
    // Interleaved allowed / hidden connectors, for paging over a filtered list.
    for (let i = 0; i < 6; i++) await mk(`page${i}`, ids.OTHER, [`p${i}`]);
    await mk('foreign', ids.OUTSIDER, ['x1'], 'REST', ids.otherOrg);

    ids.server = (
      await prisma.mcpServerConfig.create({
        data: { userId: ids.OTHER, organizationId: ids.org, name: 'Sales', slug: `sales-${tag.slice(0, 8)}` },
      })
    ).id;
    for (const c of ['shared', 'hidden']) {
      await prisma.mcpServerConnector.create({ data: { mcpServerId: ids.server, connectorId: ids[c] } });
    }

    // Two roles: one allows s1, f1 and every even page connector; one allows nothing.
    ids.roleWithTools = (await prisma.role.create({ data: { name: 'With tools', organizationId: ids.org } })).id;
    ids.roleWithoutTools = (await prisma.role.create({ data: { name: 'Without tools', organizationId: ids.org } })).id;

    const prismaService = prisma as unknown as PrismaService;
    roles = new RolesService(prismaService);
    visibility = new MemberVisibilityService(new OrgSettingsService(prismaService, {} as SiteSettingsService), roles);
    const configService = { get: (k: string) => (k === 'ENCRYPTION_KEY' ? KEY : undefined) };
    const connectorsService = new ConnectorsService(
      prismaService,
      configService as unknown as ConfigService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(connectorsService, 'testConnection').mockResolvedValue({ ok: true, message: 'ok' } as any);
    const repo = new FileSearchRepository(prismaService);
    const fileSearch = new FileSearchService(
      prismaService,
      { isCloud: () => false } as any,
      repo,
      { resolve: async () => ({ allowed: false, reason: 'fixture', message: 'fixture' }) } as any,
      { get: async () => ({}) } as any,
      new FileSearchQueryService(repo),
      {} as any,
      {} as any,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [ConnectorsController, ToolsController, FileSearchController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: configService },
        { provide: ConnectorsService, useValue: connectorsService },
        { provide: FileSearchService, useValue: fileSearch },
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
      await prisma.user.deleteMany({
        where: { id: { in: ['ADMIN', 'EDITOR', 'VIEWER', 'OTHER', 'OUTSIDER'].map((k) => ids[k]).filter(Boolean) } },
      });
      await prisma.$disconnect();
    }
  });

  afterEach(() => jest.restoreAllMocks());

  const setMode = (mode: 'open' | 'restricted') => visibility.setMode(ids.org, mode);

  /** The workspace's tool whitelist and the members' roles. */
  async function setWhitelist(state: 'none' | 'with tools' | 'without tools') {
    await prisma.toolRoleAccess.deleteMany({ where: { roleId: { in: [ids.roleWithTools, ids.roleWithoutTools] } } });
    await prisma.userRoleAssignment.deleteMany({ where: { organizationId: ids.org } });
    if (state === 'none') return;
    const allowed = ['s1', 'f1', 'p0', 'p2', 'p4'];
    await prisma.toolRoleAccess.createMany({ data: allowed.map((t) => ({ roleId: ids.roleWithTools, toolId: tools[t] })) });
    const roleId = state === 'with tools' ? ids.roleWithTools : ids.roleWithoutTools;
    for (const who of ['EDITOR', 'VIEWER']) {
      await prisma.userRoleAssignment.create({ data: { userId: ids[who], roleId, organizationId: ids.org } });
    }
  }

  const ALL = () => [...order].reverse(); // newest first, as the list returns them
  const visibleFor = (who: string, mode: string, state: string): string[] => {
    if (who === 'ADMIN' || mode === 'open' || state === 'none') return ALL();
    const own = who === 'EDITOR' ? 'edMine' : 'vwMine';
    const allowed = state === 'with tools' ? ['shared', 'fs', 'page0', 'page2', 'page4'] : [];
    return ALL().filter((n) => n === own || allowed.includes(n));
  };
  const name = (id: string) => Object.keys(ids).find((k) => ids[k] === id);
  const unknownBody = (id: string) => ({ statusCode: 404, message: `Connector ${id} not found`, error: 'Not Found' });
  const unknownFsBody = { statusCode: 404, message: 'File Search connector not found.', error: 'Not Found' };

  describe.each(['open', 'restricted'] as const)('%s workspace', (mode) => {
    describe.each(['none', 'with tools', 'without tools'] as const)('whitelist: %s', (state) => {
      beforeAll(async () => {
        await setMode(mode);
        await setWhitelist(state);
      });

      it.each(['ADMIN', 'EDITOR', 'VIEWER'])('%s: lists, details, tools, health check and exports', async (who) => {
        const expected = visibleFor(who, mode, state);
        const restricted = mode === 'restricted' && who !== 'ADMIN';
        const narrowed = restricted && state !== 'none';

        const list = await get(who, '/api/connectors');
        expect(list.status).toBe(200);
        expect(list.body.map((c: any) => name(c.id))).toEqual(expected);
        const sharedRow = list.body.find((c: any) => c.id === ids.shared);
        if (sharedRow) expect(sharedRow.tools.map((t: any) => t.name).sort()).toEqual(narrowed ? ['shared_s1'] : ['shared_s1', 'shared_s2']);

        const health = await get(who, '/api/connectors/health-check');
        expect(health.body.connectors.map((c: any) => name(c.id))).toEqual(expected);

        // Unknown and hidden ids answer the same 404.
        const unknown = await get(who, '/api/connectors/no-such-connector');
        expect(unknown).toEqual({ status: 404, body: unknownBody('no-such-connector') });
        for (const c of ['shared', 'hidden', 'edMine', 'vwMine']) {
          const detail = await get(who, `/api/connectors/${ids[c]}`);
          const toolList = await get(who, `/api/connectors/${ids[c]}/tools`);
          const oauth = await get(who, `/api/connectors/${ids[c]}/oauth-config`);
          const cred = await get(who, `/api/connectors/${ids[c]}/my-credential`);
          if (!expected.includes(c)) {
            for (const r of [detail, toolList, oauth, cred]) expect(r).toEqual({ status: 404, body: unknownBody(ids[c]) });
            continue;
          }
          expect([detail.status, toolList.status, oauth.status, cred.status]).toEqual([200, 200, 200, 200]);
          if (c === 'shared') {
            const names = narrowed ? ['shared_s1'] : ['shared_s1', 'shared_s2'];
            expect(detail.body.tools.map((t: any) => t.name).sort()).toEqual(names);
            expect(toolList.body.map((t: any) => t.name).sort()).toEqual(names);
            expect(detail.body.mcpServers).toEqual([{ mcpServerId: ids.server }]);
          }
        }

        // Another workspace: today's 403, in every mode.
        expect((await get(who, `/api/connectors/${ids.foreign}`)).status).toBe(403);

        const exportAll = await get(who, '/api/connectors/export-all');
        const exported = exportAll.body.connectors.map((c: any) => c.name);
        expect(exported.sort()).toEqual(
          restricted ? [who === 'EDITOR' ? 'edMine' : 'vwMine'] : [...order].sort(),
        );
        const exportShared = await get(who, `/api/connectors/${ids.shared}/export`);
        expect(exportShared.status).toBe(restricted ? 404 : 200);
        if (restricted) {
          expect(exportShared.body).toEqual((await get(who, '/api/connectors/no-such-connector/export')).body);
        }
      });

      it.each(['ADMIN', 'EDITOR', 'VIEWER'])('%s: File Search read routes', async (who) => {
        const expected = visibleFor(who, mode, state);
        expect(await get(who, '/api/file-search/connectors/no-such-connector/tree')).toEqual({ status: 404, body: unknownFsBody });
        for (const c of ['fs', 'fsHidden']) {
          for (const path of ['', '/tree', '/problems', '/runs', '/access-rules', '/scans/no-such-scan']) {
            const r = await get(who, `/api/file-search/connectors/${ids[c]}${path}`);
            if (!expected.includes(c)) {
              expect(r).toEqual({ status: 404, body: unknownFsBody });
            } else if (path === '/scans/no-such-scan') {
              expect(r.body.message).toBe('Scan not found.');
            } else {
              expect(r.status).toBe(200);
            }
          }
        }
      });
    });
  });

  it('pages over visible connectors only: limit and offset are applied after the filter', async () => {
    await setMode('restricted');
    await setWhitelist('with tools');
    const all = (await get('VIEWER', '/api/connectors')).body.map((c: any) => name(c.id));
    expect(all).toEqual(['page4', 'page2', 'page0', 'fs', 'shared', 'vwMine']);
    const pages: string[] = [];
    for (let offset = 0; offset < all.length; offset += 2) {
      const page = await get('VIEWER', `/api/connectors?limit=2&offset=${offset}`);
      expect(page.body).toHaveLength(2);
      pages.push(...page.body.map((c: any) => name(c.id)));
    }
    expect(pages).toEqual(all);
    expect((await get('VIEWER', '/api/connectors?limit=2&offset=6')).body).toEqual([]);
  });

  it('fails closed: a role lookup that throws answers 500, never the unrestricted list', async () => {
    await setMode('restricted');
    await setWhitelist('with tools');
    jest.spyOn(roles, 'getAllowedToolIds').mockRejectedValue(new Error('role lookup down'));
    for (const path of ['/api/connectors', `/api/connectors/${ids.shared}`, `/api/connectors/${ids.shared}/tools`, `/api/file-search/connectors/${ids.fs}/tree`]) {
      const r = await get('VIEWER', path);
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toContain(ids.shared);
    }
    // Admins never read roles.
    expect((await get('ADMIN', '/api/connectors')).status).toBe(200);
  });
});
