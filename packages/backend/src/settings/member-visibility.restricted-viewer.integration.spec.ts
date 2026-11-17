import { randomUUID } from 'node:crypto';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { AuditController } from '../audit/audit.controller';
import { AuditService } from '../audit/audit.service';
import { SecurityEventService } from '../audit/security-event.service';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { PrismaService } from '../common/prisma.service';
import { CatalogResyncService } from '../connectors/catalog-resync.service';
import { ConnectorsController } from '../connectors/connectors.controller';
import { ConnectorsService } from '../connectors/connectors.service';
import { UserCredentialsService } from '../connectors/user-credentials.service';
import { WebhookEventsService } from '../connectors/webhook-events.service';
import { EditionService } from '../ee/licensing/edition.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { McpConnectionGrantService } from '../mcp-servers/mcp-connection-grant.service';
import { McpConnectionsController } from '../mcp-servers/mcp-connections.controller';
import { McpServersController } from '../mcp-servers/mcp-servers.controller';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { McpApiKeysController } from '../roles/mcp-api-keys.controller';
import { McpApiKeysService } from '../roles/mcp-api-keys.service';
import { RolesService } from '../roles/roles.service';
import { MemberVisibilityInterceptor } from './member-visibility.interceptor';
import { MemberVisibilityService } from './member-visibility.service';
import { OrgSettingsService } from './org-settings.service';
import { SiteSettingsService } from './site-settings.service';

/**
 * The evaluator's scenario, end to end against PostgreSQL: a workspace in
 * restricted mode, six connectors owned by an admin, one role that whitelists
 * the tools of one of them, a VIEWER with that role, and MCP servers owned by
 * the admin, by another member and by the viewer.
 *
 * The viewer must get exactly one connector (in the reduced view), only their
 * own MCP server (holding that connector), the unknown-id 404 on every other
 * server, and no address, no other member's server name, endpoint or usage
 * anywhere in what they read: connectors, servers, the server picker, their
 * keys and connections, and their audit log, analytics and breakdowns.
 *
 * Needs a migrated PostgreSQL in AUDIT_TEST_DATABASE_URL (as in CI). Every
 * row it creates belongs to fixture workspaces and users it deletes again.
 */
const url = process.env.AUDIT_TEST_DATABASE_URL;
const KEY = 'k'.repeat(48);
/** Where the admin's connectors connect; must never reach the viewer. */
const ADDRESS = 'erp-db.internal.example.invalid';

(url ? describe : describe.skip)('restricted VIEWER: one shared connector, only own servers (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let base: string;
  let audit: AuditService;

  const ids: Record<string, string> = {};
  const users: Record<string, { sub: string; role: string; organizationId: string; email: string }> = {};
  /** Everything the viewer read, to scan for leaks at the end. */
  const viewerSaw: string[] = [];

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-test-user': who, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (who === 'VIEWER') viewerSaw.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const get = (who: string, path: string) => call(who, 'GET', path);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? KEY;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    await prisma.$connect();
    const tag = randomUUID();
    const prismaService = prisma as unknown as PrismaService;

    ids.org = (await prisma.organization.create({ data: { name: 'restricted viewer scenario' } })).id;
    for (const [key, role, name] of [
      ['ADMIN', 'ADMIN', 'Alice'],
      ['OTHER', 'EDITOR', 'Bob'],
      ['VIEWER', 'VIEWER', 'Vera'],
    ] as const) {
      const id = (
        await prisma.user.create({
          data: { email: `mv-scenario-${key.toLowerCase()}-${tag}@example.invalid`, name },
        })
      ).id;
      ids[key] = id;
      await prisma.user.update({ where: { id }, data: { organizationId: ids.org, role } });
      await prisma.organizationMember.create({ data: { userId: id, organizationId: ids.org, role } });
      users[key] = { sub: id, role, organizationId: ids.org, email: 'member@example.invalid' };
    }

    // Six connectors of the admin, each with two tools, all pointing at an
    // internal address.
    for (let i = 1; i <= 6; i++) {
      const c = await prisma.connector.create({
        data: {
          userId: ids.ADMIN,
          organizationId: ids.org,
          name: `Connector ${i}`,
          type: 'DATABASE',
          baseUrl: `postgresql://reporting@${ADDRESS}:5432/erp${i}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
        },
      });
      ids[`c${i}`] = c.id;
      for (const t of ['a', 'b']) {
        ids[`c${i}${t}`] = (
          await prisma.mcpTool.create({
            data: {
              connectorId: c.id,
              name: `c${i}_${t}_${tag.slice(0, 6)}`,
              description: 'fixture',
              parameters: {},
              endpointMapping: { method: 'query', sql: `SELECT * FROM ${ADDRESS.split('.')[0]}_t${i}` },
            },
          })
        ).id;
      }
    }

    // One role that whitelists the tools of connector 1, given to the viewer.
    ids.role = (await prisma.role.create({ data: { name: 'Sales', organizationId: ids.org } })).id;
    await prisma.toolRoleAccess.createMany({
      data: [ids.c1a, ids.c1b].map((toolId) => ({ roleId: ids.role, toolId })),
    });
    await prisma.userRoleAssignment.create({ data: { userId: ids.VIEWER, roleId: ids.role, organizationId: ids.org } });

    // Servers: the admin's default (all six), the admin's team server and the
    // other member's default (both holding connector 1), the viewer's default
    // (connector 1).
    const mkServer = async (key: string, owner: string, name: string, connectors: string[], minute: number) => {
      ids[key] = (
        await prisma.mcpServerConfig.create({
          data: {
            userId: owner,
            organizationId: ids.org,
            name,
            slug: `${key.toLowerCase()}-${tag.slice(0, 8)}`,
            createdAt: new Date(Date.UTC(2026, 0, 2, 0, minute)),
          },
        })
      ).id;
      for (const c of connectors) {
        await prisma.mcpServerConnector.create({ data: { mcpServerId: ids[key], connectorId: ids[c] } });
      }
    };
    await mkServer('srvAdmin', ids.ADMIN, 'Default (Alice)', ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], 0);
    await mkServer('srvTeam', ids.ADMIN, 'Finance team', ['c1'], 1);
    await mkServer('srvOther', ids.OTHER, 'Default (Bob)', ['c1'], 2);
    await mkServer('srvViewer', ids.VIEWER, 'Default (Vera)', ['c1'], 3);

    // The viewer's own calls, through their server and through the team
    // server; and calls of the others on the team and Bob's server.
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    const invoke = (userId: string, toolId: string, mcpServerId: string, m: number, status: 'SUCCESS' | 'ERROR' = 'SUCCESS') =>
      prisma.toolInvocation.create({
        data: {
          toolId,
          connectorId: ids.c1,
          userId,
          mcpServerId,
          organizationId: ids.org,
          status,
          durationMs: 100,
          input: { q: 'fixture' },
          error: status === 'ERROR' ? `failed on ${ADDRESS}` : null,
          createdAt: minutesAgo(m),
        },
      });
    await invoke(ids.VIEWER, ids.c1a, ids.srvViewer, 30);
    await invoke(ids.VIEWER, ids.c1a, ids.srvTeam, 20);
    await invoke(ids.ADMIN, ids.c1a, ids.srvTeam, 10, 'ERROR');
    await invoke(ids.OTHER, ids.c1b, ids.srvOther, 5);

    // A grant the viewer made before the workspace was restricted, naming
    // the team server and their own.
    await prisma.mcpConnectionGrant.create({
      data: { clientId: `client-${tag}`, userId: ids.VIEWER, serverIds: [ids.srvTeam, ids.srvViewer] },
    });

    const roles = new RolesService(prismaService);
    const visibility = new MemberVisibilityService(new OrgSettingsService(prismaService, {} as SiteSettingsService), roles);
    await visibility.setMode(ids.org, 'restricted');
    const servers = new McpServersService(prismaService, {} as any, { notifyToolsChanged: async () => undefined } as any);
    const grants = new McpConnectionGrantService(prismaService, undefined, visibility);
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
    audit = new AuditService(prismaService);

    const moduleRef = await Test.createTestingModule({
      controllers: [ConnectorsController, McpServersController, McpConnectionsController, AuditController, McpApiKeysController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: configService },
        { provide: ConnectorsService, useValue: connectorsService },
        { provide: McpServersService, useValue: servers },
        { provide: McpConnectionGrantService, useValue: grants },
        { provide: MemberVisibilityService, useValue: visibility },
        { provide: AuditService, useValue: audit },
        { provide: McpApiKeysService, useValue: new McpApiKeysService(prismaService) },
        { provide: LicenseGuardService, useValue: { checkCanCreateMcpServer: async () => undefined } },
        { provide: SecurityEventService, useValue: { log: async () => undefined } },
        { provide: EditionService, useValue: { hasEnterprise: async () => true, assertEnterprise: async () => undefined } },
        { provide: UserCredentialsService, useValue: { status: async () => ({ connected: false }), remove: async () => false } },
        { provide: WebhookEventsService, useValue: { recentEvents: async () => [] } },
        { provide: CatalogResyncService, useValue: { computeDiff: async () => null } },
        { provide: APP_INTERCEPTOR, useClass: MemberVisibilityInterceptor },
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
    await audit?.onModuleDestroy();
    if (prisma) {
      await prisma.organization.deleteMany({ where: { id: ids.org } });
      await prisma.user.deleteMany({ where: { id: { in: ['ADMIN', 'OTHER', 'VIEWER'].map((k) => ids[k]).filter(Boolean) } } });
      await prisma.$disconnect();
    }
  });

  const unknownServer = { statusCode: 404, message: 'MCP server not found', error: 'Not Found' };

  it('the admin sees the whole workspace (sanity check of the fixture)', async () => {
    expect((await get('ADMIN', '/api/connectors')).body).toHaveLength(6);
    expect((await get('ADMIN', '/api/mcp-servers')).body.map((s: any) => s.name)).toEqual([
      'Default (Alice)',
      'Finance team',
      'Default (Bob)',
      'Default (Vera)',
    ]);
  });

  it('gets exactly the one connector their role reaches, in the reduced view', async () => {
    const list = await get('VIEWER', '/api/connectors');
    expect(list.status).toBe(200);
    expect(list.body.map((c: any) => c.id)).toEqual([ids.c1]);
    expect(list.body[0].memberView).toBe(true);
    expect(list.body[0].tools.map((t: any) => t.id).sort()).toEqual([ids.c1a, ids.c1b].sort());
    expect(list.body[0]).not.toHaveProperty('baseUrl');

    const detail = await get('VIEWER', `/api/connectors/${ids.c1}`);
    expect(detail.status).toBe(200);
    expect(detail.body.memberView).toBe(true);
    expect(detail.body).not.toHaveProperty('mcpServers');

    for (const c of ['c2', 'c3', 'c4', 'c5', 'c6']) {
      const hidden = await get('VIEWER', `/api/connectors/${ids[c]}`);
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual({ statusCode: 404, message: `Connector ${ids[c]} not found`, error: 'Not Found' });
    }
  });

  it('lists only their own MCP server, holding only the connector they can see', async () => {
    const list = await get('VIEWER', '/api/mcp-servers');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: ids.srvViewer, name: 'Default (Vera)', _count: { connectors: 1 } });
    expect(list.body[0].connectors).toEqual([{ connector: { name: 'Connector 1' } }]);
    expect(list.body[0].usage.calls30d).toBe(1);

    const detail = await get('VIEWER', `/api/mcp-servers/${ids.srvViewer}`);
    expect(detail.status).toBe(200);
    expect(detail.body.connectors.map((c: any) => c.connector.id)).toEqual([ids.c1]);
  });

  it.each(['srvAdmin', 'srvTeam', 'srvOther'])('answers %s, with any route, exactly like an unknown id', async (key) => {
    const id = ids[key];
    for (const [method, path, body] of [
      ['GET', `/api/mcp-servers/${id}`, undefined],
      ['GET', `/api/mcp-servers/${id}/activity`, undefined],
      ['PUT', `/api/mcp-servers/${id}`, { name: 'renamed' }],
      ['PUT', `/api/mcp-servers/${id}/connectors`, { connectorIds: [ids.c1] }],
      ['DELETE', `/api/mcp-servers/${id}`, undefined],
    ] as const) {
      const unknown = await call('VIEWER', method, path.replace(id, 'no-such-server'), body);
      expect(await call('VIEWER', method, path, body)).toEqual(unknown);
      expect(unknown).toEqual({ status: 404, body: unknownServer });
    }
    // Nothing was changed.
    expect((await prisma.mcpServerConfig.findUnique({ where: { id } }))?.name).not.toBe('renamed');
  });

  it('offers only their own server in the picker, and grants nothing else', async () => {
    const targets = await get('VIEWER', '/api/mcp-connections/targets');
    expect(targets.body).toEqual([
      {
        organizationId: ids.org,
        organizationName: 'restricted viewer scenario',
        servers: [{ id: ids.srvViewer, name: 'Default (Vera)', connectorCount: 1 }],
      },
    ]);
    const grant = await call('VIEWER', 'PUT', '/api/mcp-connections/client-new', { serverIds: [ids.srvTeam] });
    expect(grant.body).toEqual({ ok: false, reason: 'nothing-granted' });
  });

  it('names in their connections only the servers they own', async () => {
    const list = await get('VIEWER', '/api/mcp-connections');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].servers).toEqual([{ id: ids.srvViewer, name: 'Default (Vera)' }]);
  });

  it('creates a key only for their own server, and names no other server on their keys', async () => {
    const refused = await call('VIEWER', 'POST', '/api/mcp-keys', { name: 'team', mcpServerId: ids.srvTeam });
    const unknown = await call('VIEWER', 'POST', '/api/mcp-keys', { name: 'none', mcpServerId: 'no-such-server' });
    expect(refused).toEqual(unknown);
    expect(refused.status).toBe(404);
    const own = await call('VIEWER', 'POST', '/api/mcp-keys', { name: 'mine', mcpServerId: ids.srvViewer });
    expect(own.status).toBe(201);
    // A key made for the team server earlier (open mode) stays theirs, unnamed.
    await prisma.mcpApiKey.create({
      data: {
        userId: ids.VIEWER,
        organizationId: ids.org,
        key: `mcp_${randomUUID().replace(/-/g, '')}`,
        name: 'older',
        mcpServerId: ids.srvTeam,
      },
    });
    const keys = (await get('VIEWER', '/api/mcp-keys')).body;
    const byName = Object.fromEntries(keys.map((k: any) => [k.name, k]));
    expect(byName.mine.mcpServer).toEqual({ id: ids.srvViewer, name: 'Default (Vera)' });
    expect(byName.older.mcpServer).toBeNull();
  });

  it('sees their own calls, with only their own server named, in every audit view', async () => {
    const inv = await get('VIEWER', '/api/audit/invocations');
    expect(inv.body).toHaveLength(2);
    expect(inv.body.every((r: any) => r.user.id === ids.VIEWER)).toBe(true);
    expect(inv.body.map((r: any) => r.mcpServer?.name ?? null).sort()).toEqual(['Default (Vera)', null].sort());
    expect((await get('VIEWER', `/api/audit/invocations?mcpServerId=${ids.srvTeam}`)).body).toEqual([]);

    const breakdowns = await get('VIEWER', '/api/audit/breakdowns');
    expect(breakdowns.body.byServer.sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)))).toEqual(
      [
        { id: ids.srvViewer, label: 'Default (Vera)', count: 1, errors: 0 },
        { id: null, label: 'Other server or none', count: 1, errors: 0 },
      ].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    );
    expect(breakdowns.body.byUser).toEqual([{ id: ids.VIEWER, label: 'Vera', count: 1 + 1, errors: 0 }]);

    const perf = await get('VIEWER', '/api/audit/tool-performance?hours=24');
    expect(perf.body.items.map((i: any) => [i.mcpServerId, i.mcpServerName, i.calls]).sort()).toEqual(
      [
        [ids.srvViewer, 'Default (Vera)', 1],
        [null, null, 1],
      ].sort(),
    );
    expect(perf.body.items.every((i: any) => i.lastError === null)).toBe(true);
    const filtered = await get('VIEWER', `/api/audit/tool-performance?mcpServerId=${ids.srvTeam}`);
    expect(filtered.body.items).toEqual([]);

    expect((await get('VIEWER', '/api/audit/stats')).body.invocations24h).toBe(2);
  });

  it('never read an address, another member\'s server, its endpoint or a hidden connector', () => {
    const all = viewerSaw.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [
      ADDRESS,
      'Default (Alice)',
      'Finance team',
      'Default (Bob)',
      'Alice',
      'Bob',
      ids.srvAdmin,
      ids.srvOther,
      `/mcp/${ids.srvTeam}`,
      ...['c2', 'c3', 'c4', 'c5', 'c6'].flatMap((c) => [`Connector ${c.slice(1)}`]),
    ]) {
      expect({ secret, found: all.includes(secret) }).toEqual({ secret, found: false });
    }
  });
});
