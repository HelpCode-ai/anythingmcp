import { randomUUID } from 'node:crypto';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { SecurityEventService } from '../audit/security-event.service';
import { PrismaService } from '../common/prisma.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { RolesService } from '../roles/roles.service';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import { OrgSettingsService } from '../settings/org-settings.service';
import { SiteSettingsService } from '../settings/site-settings.service';
import { McpConnectionGrantService } from './mcp-connection-grant.service';
import { McpConnectionsController } from './mcp-connections.controller';
import { McpServersController } from './mcp-servers.controller';
import { McpServersService } from './mcp-servers.service';

/**
 * Member visibility on the MCP servers and MCP connections routes, end to end:
 * HTTP, controllers, the real McpServersService and McpConnectionGrantService
 * queries, the real RolesService and org_settings rows, against the migrated
 * schema. Also D10 (a VIEWER cannot create a server) with real status codes.
 *
 * Needs a migrated PostgreSQL in AUDIT_TEST_DATABASE_URL (as in CI). Every
 * row it creates belongs to fixture workspaces and users it deletes again.
 */
const url = process.env.AUDIT_TEST_DATABASE_URL;

(url ? describe : describe.skip)('MCP servers and connections with member visibility (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let base: string;
  let roles: RolesService;
  let visibility: MemberVisibilityService;
  let servers: McpServersService;

  const ids: Record<string, string> = {};
  const tools: Record<string, string> = {};
  const users: Record<string, { sub: string; role: string; organizationId: string; email: string }> = {};

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-test-user': who, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const get = (who: string, path: string) => call(who, 'GET', path);

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    await prisma.$connect();
    const tag = randomUUID();
    const prismaService = prisma as unknown as PrismaService;

    const mkUser = async (name: string) =>
      (await prisma.user.create({ data: { email: `mv-srv-${name}-${tag}@example.invalid`, name } })).id;
    ids.org = (await prisma.organization.create({ data: { name: 'member visibility servers test' } })).id;
    ids.org2 = (await prisma.organization.create({ data: { name: 'member visibility servers test, second' } })).id;
    for (const [key, role] of [
      ['ADMIN', 'ADMIN'],
      ['EDITOR', 'EDITOR'],
      ['VIEWER', 'VIEWER'],
      ['OTHER', 'EDITOR'],
      ['OTHER2', 'VIEWER'],
    ] as const) {
      const id = await mkUser(key.toLowerCase());
      ids[key] = id;
      await prisma.user.update({ where: { id }, data: { organizationId: ids.org, role } });
      await prisma.organizationMember.create({ data: { userId: id, organizationId: ids.org, role } });
      users[key] = { sub: id, role, organizationId: ids.org, email: 'member@example.invalid' };
    }
    // Second workspace: the EDITOR is an ADMIN there, the VIEWER a VIEWER.
    await prisma.organizationMember.create({ data: { userId: ids.EDITOR, organizationId: ids.org2, role: 'ADMIN' } });
    await prisma.organizationMember.create({ data: { userId: ids.VIEWER, organizationId: ids.org2, role: 'VIEWER' } });

    const mkConnector = async (name: string, owner: string, toolNames: string[], org = ids.org) => {
      const c = await prisma.connector.create({
        data: { userId: owner, organizationId: org, name, type: 'REST', baseUrl: 'https://api.example.invalid' },
      });
      ids[name] = c.id;
      for (const t of toolNames) {
        tools[t] = (
          await prisma.mcpTool.create({
            data: { connectorId: c.id, name: `${name}_${t}`, description: 'fixture', parameters: {}, endpointMapping: { method: 'GET', path: '/x' } },
          })
        ).id;
      }
    };
    await mkConnector('edMine', ids.EDITOR, ['e1']);
    await mkConnector('vwMine', ids.VIEWER, ['v1']);
    await mkConnector('shared', ids.OTHER, ['s1', 's2']);
    await mkConnector('hidden', ids.OTHER, ['h1']);
    await mkConnector('c2', ids.OTHER, ['x2'], ids.org2);

    servers = new McpServersService(prismaService, {} as any, { notifyToolsChanged: async () => undefined } as any);
    let minute = 0;
    const at = () => new Date(Date.UTC(2026, 0, 1, 0, minute++));
    const mkServer = async (key: string, owner: string, connectorKeys: string[], org = ids.org) => {
      ids[key] = (
        await prisma.mcpServerConfig.create({
          data: { userId: owner, organizationId: org, name: key, slug: `${key.toLowerCase()}-${tag.slice(0, 8)}`, createdAt: at() },
        })
      ).id;
      for (const c of connectorKeys) {
        await prisma.mcpServerConnector.create({ data: { mcpServerId: ids[key], connectorId: ids[c] } });
      }
    };
    /** A default server as sign-up and invite create it: through the service, never the POST route. */
    const mkDefault = async (key: string, owner: string, connectorKeys: string[]) => {
      const s = await servers.createDefaultForUser(owner, ids.org);
      await prisma.mcpServerConfig.update({ where: { id: s.id }, data: { createdAt: at() } });
      ids[key] = s.id;
      for (const c of connectorKeys) {
        await prisma.mcpServerConnector.create({ data: { mcpServerId: s.id, connectorId: ids[c] } });
      }
    };
    await mkServer('srvEditor', ids.EDITOR, ['edMine']);
    await mkDefault('srvViewerDefault', ids.VIEWER, []);
    await mkServer('srvShared', ids.OTHER, ['shared', 'hidden']);
    await mkServer('srvHidden', ids.OTHER, ['hidden']);
    await mkDefault('srvOther2Default', ids.OTHER2, []);
    await mkDefault('srvOtherDefault', ids.OTHER, ['shared']);
    await mkServer('srvO2', ids.OTHER, ['c2'], ids.org2);
    await mkServer('srvO2Empty', ids.OTHER, [], ids.org2);

    ids.roleWithTools = (await prisma.role.create({ data: { name: 'With tools', organizationId: ids.org } })).id;
    ids.roleWithoutTools = (await prisma.role.create({ data: { name: 'Without tools', organizationId: ids.org } })).id;

    roles = new RolesService(prismaService);
    visibility = new MemberVisibilityService(new OrgSettingsService(prismaService, {} as SiteSettingsService), roles);
    // The second workspace is restricted with no whitelist for the whole run.
    await visibility.setMode(ids.org2, 'restricted');
    const grants = new McpConnectionGrantService(prismaService, undefined, visibility);

    const moduleRef = await Test.createTestingModule({
      controllers: [McpServersController, McpConnectionsController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: McpServersService, useValue: servers },
        { provide: McpConnectionGrantService, useValue: grants },
        { provide: MemberVisibilityService, useValue: visibility },
        { provide: LicenseGuardService, useValue: { checkCanCreateMcpServer: async () => undefined } },
        { provide: SecurityEventService, useValue: { log: async () => undefined } },
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
      await prisma.organization.deleteMany({ where: { id: { in: [ids.org, ids.org2].filter(Boolean) } } });
      await prisma.user.deleteMany({
        where: { id: { in: ['ADMIN', 'EDITOR', 'VIEWER', 'OTHER', 'OTHER2'].map((k) => ids[k]).filter(Boolean) } },
      });
      await prisma.$disconnect();
    }
  });

  afterEach(() => jest.restoreAllMocks());

  const setMode = (mode: 'open' | 'restricted') => visibility.setMode(ids.org, mode);

  async function setWhitelist(state: 'none' | 'with tools' | 'without tools') {
    await prisma.toolRoleAccess.deleteMany({ where: { roleId: { in: [ids.roleWithTools, ids.roleWithoutTools] } } });
    await prisma.userRoleAssignment.deleteMany({ where: { organizationId: ids.org } });
    if (state === 'none') return;
    await prisma.toolRoleAccess.create({ data: { roleId: ids.roleWithTools, toolId: tools.s1 } });
    const roleId = state === 'with tools' ? ids.roleWithTools : ids.roleWithoutTools;
    for (const who of ['EDITOR', 'VIEWER']) {
      await prisma.userRoleAssignment.create({ data: { userId: ids[who], roleId, organizationId: ids.org } });
    }
  }

  const IN_ORG = ['srvEditor', 'srvViewerDefault', 'srvShared', 'srvHidden', 'srvOther2Default', 'srvOtherDefault'];
  const visibleFor = (who: string, mode: string, state: string): string[] => {
    if (who === 'ADMIN' || mode === 'open') return IN_ORG;
    const own = who === 'EDITOR' ? 'srvEditor' : 'srvViewerDefault';
    // D4: no whitelist, every server with a connector; D9: other members' empty defaults stay hidden.
    if (state === 'none') return IN_ORG.filter((s) => s === own || !['srvViewerDefault', 'srvOther2Default'].includes(s));
    const viaRole = state === 'with tools' ? ['srvShared', 'srvOtherDefault'] : [];
    return IN_ORG.filter((s) => s === own || viaRole.includes(s));
  };
  const name = (id: string) => Object.keys(ids).find((k) => ids[k] === id);
  const unknownBody = { statusCode: 404, message: 'MCP server not found', error: 'Not Found' };

  describe.each(['open', 'restricted'] as const)('%s workspace', (mode) => {
    describe.each(['none', 'with tools', 'without tools'] as const)('whitelist: %s', (state) => {
      beforeAll(async () => {
        await setMode(mode);
        await setWhitelist(state);
      });

      it.each(['ADMIN', 'EDITOR', 'VIEWER'])('%s: list, detail, activity, targets and grants', async (who) => {
        const expected = visibleFor(who, mode, state);
        const narrowed = mode === 'restricted' && who !== 'ADMIN' && state === 'with tools';

        const list = await get(who, '/api/mcp-servers');
        expect(list.status).toBe(200);
        expect(list.body.map((s: any) => name(s.id))).toEqual(expected);
        const sharedRow = list.body.find((s: any) => s.id === ids.srvShared);
        if (sharedRow) {
          const names = narrowed ? ['shared'] : ['shared', 'hidden'];
          expect(sharedRow.connectors.map((c: any) => c.connector.name)).toEqual(names);
          expect(sharedRow._count.connectors).toBe(names.length);
          expect(sharedRow.usage).toEqual({ calls30d: 0, lastCallAt: null });
        }

        expect(await get(who, '/api/mcp-servers/no-such-server')).toEqual({ status: 404, body: unknownBody });
        expect(await get(who, '/api/mcp-servers/no-such-server/activity')).toEqual({ status: 404, body: unknownBody });
        for (const s of IN_ORG) {
          const detail = await get(who, `/api/mcp-servers/${ids[s]}`);
          const activity = await get(who, `/api/mcp-servers/${ids[s]}/activity`);
          if (!expected.includes(s)) {
            expect(detail).toEqual({ status: 404, body: unknownBody });
            expect(activity).toEqual({ status: 404, body: unknownBody });
            continue;
          }
          expect([detail.status, activity.status]).toEqual([200, 200]);
          expect(activity.body).toEqual({ calls30d: 0, lastCallAt: null });
          if (s === 'srvShared') {
            const names = narrowed ? ['shared'] : ['shared', 'hidden'];
            expect(detail.body.connectors.map((c: any) => c.connector.name).sort()).toEqual([...names].sort());
            expect(detail.body._count.connectors).toBe(names.length);
          }
        }
        // Another workspace's server: the same 404 for everyone, in every mode.
        expect(await get(who, `/api/mcp-servers/${ids.srvO2}`)).toEqual({ status: 404, body: unknownBody });

        // The picker: this workspace by its own rule, the second one by its own.
        const targets = await get(who, '/api/mcp-connections/targets');
        expect(targets.status).toBe(200);
        const here = targets.body.find((t: any) => t.organizationId === ids.org);
        expect(here.servers.map((s: any) => name(s.id))).toEqual(expected);
        const sharedTarget = here.servers.find((s: any) => s.id === ids.srvShared);
        if (sharedTarget) expect(sharedTarget.connectorCount).toBe(narrowed ? 1 : 2);
        const second = targets.body.find((t: any) => t.organizationId === ids.org2);
        if (who === 'ADMIN') expect(second).toBeUndefined();
        if (who === 'EDITOR') expect(second.servers.map((s: any) => name(s.id))).toEqual(['srvO2', 'srvO2Empty']);
        if (who === 'VIEWER') expect(second.servers.map((s: any) => name(s.id))).toEqual(['srvO2']);

        // Grants: a hidden server is refused exactly like an unknown id.
        const clientId = `client-${who}-${mode}-${state}`;
        const unknownGrant = await call(who, 'PUT', `/api/mcp-connections/${clientId}`, { serverIds: ['no-such-server'] });
        expect(unknownGrant).toEqual({ status: 200, body: { ok: false, reason: 'nothing-granted' } });
        for (const s of IN_ORG) {
          const r = await call(who, 'PUT', `/api/mcp-connections/${clientId}`, { serverIds: [ids[s]] });
          expect(r).toEqual(expected.includes(s) ? { status: 200, body: { ok: true } } : unknownGrant);
        }
        await call(who, 'PUT', `/api/mcp-connections/${clientId}`, { serverIds: IN_ORG.map((s) => ids[s]) });
        const stored = await prisma.mcpConnectionGrant.findUnique({
          where: { clientId_userId: { clientId, userId: ids[who] } },
          select: { serverIds: true },
        });
        expect(stored!.serverIds.map(name).sort()).toEqual([...expected].sort());
      });

      it.each(['ADMIN', 'EDITOR', 'VIEWER'])('%s: POST /api/mcp-servers (D10)', async (who) => {
        const r = await call(who, 'POST', '/api/mcp-servers', { name: `created by ${who} ${mode} ${state}` });
        if (who === 'VIEWER') {
          expect(r).toEqual({
            status: 403,
            body: { statusCode: 403, message: 'Viewers cannot modify MCP servers', error: 'Forbidden' },
          });
        } else {
          expect(r.status).toBe(201);
          expect(r.body.userId).toBe(ids[who]);
          await prisma.mcpServerConfig.delete({ where: { id: r.body.id } });
        }
      });
    });
  });

  it('pages over visible servers only: limit and offset are applied after the filter', async () => {
    await setMode('restricted');
    await setWhitelist('with tools');
    const all = (await get('VIEWER', '/api/mcp-servers')).body.map((s: any) => name(s.id));
    expect(all).toEqual(['srvViewerDefault', 'srvShared', 'srvOtherDefault']);
    const page = await get('VIEWER', '/api/mcp-servers?limit=2&offset=1');
    expect(page.body.map((s: any) => name(s.id))).toEqual(['srvShared', 'srvOtherDefault']);
  });

  it('fails closed: a role lookup that throws answers 500, never the unrestricted result', async () => {
    await setMode('restricted');
    await setWhitelist('with tools');
    jest.spyOn(roles, 'getAllowedToolIds').mockRejectedValue(new Error('role lookup down'));
    for (const path of [
      '/api/mcp-servers',
      `/api/mcp-servers/${ids.srvHidden}`,
      `/api/mcp-servers/${ids.srvHidden}/activity`,
      '/api/mcp-connections/targets',
    ]) {
      const r = await get('VIEWER', path);
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toContain(ids.srvHidden);
    }
    const grant = await call('VIEWER', 'PUT', '/api/mcp-connections/client-fail', { serverIds: [ids.srvShared] });
    expect(grant.status).toBe(500);
    expect(await prisma.mcpConnectionGrant.count({ where: { clientId: 'client-fail' } })).toBe(0);
    // Admins never read roles.
    expect((await get('ADMIN', '/api/mcp-servers')).status).toBe(200);
  });
});
