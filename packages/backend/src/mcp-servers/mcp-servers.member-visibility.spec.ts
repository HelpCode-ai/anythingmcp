import 'reflect-metadata';
import { ForbiddenException, Logger, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import { McpConnectionGrantService } from './mcp-connection-grant.service';
import { McpConnectionsController } from './mcp-connections.controller';
import { McpServersController } from './mcp-servers.controller';
import { McpServersService } from './mcp-servers.service';

/**
 * Member visibility on the MCP servers and MCP connections controllers.
 *
 * 1. Route coverage: every GET route of the two controllers must have a rule
 *    in RULES below, so a new read route cannot ship without one.
 * 2. Matrix: ADMIN / EDITOR / VIEWER x open / restricted x (no whitelist,
 *    role with tools, role without tools), over servers the caller owns,
 *    other members' servers and other members' default servers (D9). A hidden
 *    server answers exactly the 404 an unknown id gets; admins and open
 *    workspaces never read their roles.
 * 3. Server picker and grants: every workspace follows its own mode and the
 *    caller's role there; a hidden server is dropped from a grant like an
 *    unknown id.
 * 4. D10: a VIEWER cannot create a server, in any mode.
 * 5. Fail closed: a role lookup that throws fails the request.
 *
 * Prisma is an in-memory double that evaluates the `where` shapes these
 * routes send; mcp-servers.member-visibility.integration.spec.ts runs the
 * same rules against PostgreSQL.
 */

const ORG = 'org-1';
/** The caller is an ADMIN here; the workspace is restricted. */
const ORG_ADMIN = 'org-2';
/** The caller is an EDITOR here; the workspace is open. */
const ORG_OPEN = 'org-3';
/** The caller is not a member. */
const FOREIGN = 'org-x';
const ME = 'user-me';
const OTHER = 'user-other';
const OTHER2 = 'user-other-2';

type Rule =
  /** A list narrowed in the query: owned servers or those with a visible connector. */
  | 'list'
  /** 404 (unknown-id body) for a hidden server, connectors narrowed. */
  | 'visible'
  /** Per workspace, by that workspace's mode and the caller's role there. */
  | 'per-workspace'
  /** The caller's own grants only: unchanged. */
  | 'own-data';

/** Every GET route of the two controllers and the rule it follows. */
const RULES: Record<string, Record<string, { path: string; rule: Rule }>> = {
  McpServersController: {
    list: { path: '/', rule: 'list' },
    get: { path: ':id', rule: 'visible' },
    activity: { path: ':id/activity', rule: 'visible' },
  },
  McpConnectionsController: {
    list: { path: '/', rule: 'own-data' },
    targets: { path: 'targets', rule: 'per-workspace' },
  },
};

const CONTROLLERS = { McpServersController, McpConnectionsController } as const;

// ── Fixtures ──────────────────────────────────────────────────────────────

interface FxConnector {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  type: string;
  isActive: boolean;
  tools: Array<{ id: string }>;
}
interface FxServer {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: Date;
  connectorIds: string[];
  apiKeys: number;
}

function world() {
  const conn = (id: string, userId: string, toolIds: string[], organizationId = ORG): FxConnector => ({
    id,
    userId,
    organizationId,
    name: id,
    type: 'REST',
    isActive: true,
    tools: toolIds.map((t) => ({ id: t })),
  });
  const connectors = [
    conn('mine', ME, ['m1']),
    conn('shared', OTHER, ['s1', 's2']),
    conn('hidden', OTHER, ['h1']),
    conn('c2', OTHER, ['x2'], ORG_ADMIN),
    conn('c3', OTHER, ['x3'], ORG_OPEN),
    conn('cx', OTHER, ['xx'], FOREIGN),
  ];
  let minute = 0;
  const srv = (
    id: string,
    userId: string,
    connectorIds: string[],
    extra: Partial<FxServer> = {},
  ): FxServer => ({
    id,
    userId,
    organizationId: ORG,
    name: id,
    slug: id,
    isActive: true,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute++)),
    connectorIds,
    apiKeys: 1,
    ...extra,
  });
  const servers = [
    // Owned by the caller: always visible to them.
    srv('srv-mine', ME, ['mine']),
    // Owned by the caller, holding only another member's hidden connector:
    // visible, but that connector is not named.
    srv('srv-mine-hidden', ME, ['hidden']),
    // Another member's, with one connector the "role with tools" reaches.
    srv('srv-shared', OTHER, ['shared', 'hidden']),
    // Another member's, nothing the "role with tools" reaches.
    srv('srv-hidden', OTHER, ['hidden']),
    // D9: another member's default server, empty, and one that holds a visible connector.
    srv('srv-default-empty', OTHER2, [], { name: 'Default (other2)', slug: 'default-other2' }),
    srv('srv-default-with', OTHER, ['shared'], { name: 'Default (other)', slug: 'default-other' }),
    // Switched off: listed on /api/mcp-servers, never offered as a target.
    srv('srv-inactive', OTHER, ['shared'], { isActive: false }),
    srv('srv-o2', OTHER, ['c2'], { organizationId: ORG_ADMIN }),
    srv('srv-o3', OTHER, ['c3'], { organizationId: ORG_OPEN }),
    srv('srv-x', OTHER, ['cx'], { organizationId: FOREIGN }),
  ];
  return { connectors, servers };
}

type World = ReturnType<typeof world>;

/** Evaluates the Prisma `where` shapes these routes send. */
function matches(row: any, where: any, w: World, members: Array<{ userId: string; organizationId: string }>): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'AND') return value.every((x: any) => matches(row, x, w, members));
    if (key === 'OR') return value.some((x: any) => matches(row, x, w, members));
    if (key === 'tools') return row.tools.some((t: any) => matches(t, value.some, w, members));
    if (key === 'connectors') {
      return row.connectorIds.some((cid: string) => {
        const c = w.connectors.find((x) => x.id === cid);
        return !!c && matches(c, value.some.connector, w, members);
      });
    }
    if (key === 'organization') {
      const { userId, deactivatedAt } = value.members.some;
      if (deactivatedAt !== null) throw new Error('membership must exclude deactivated members');
      return members.some((m) => m.userId === userId && m.organizationId === row.organizationId);
    }
    if (value && typeof value === 'object' && Array.isArray(value.in)) return value.in.includes(row[key]);
    if (value && typeof value === 'object') throw new Error(`unsupported where ${key}: ${JSON.stringify(value)}`);
    return row[key] === value;
  });
}

function makePrisma(w: World, myRoles: Record<string, string>) {
  const members = Object.entries(myRoles).map(([organizationId, role]) => ({ userId: ME, organizationId, role }));
  const m = (row: any, where: any) => matches(row, where, w, members);
  const reads: string[] = [];
  const connectorsOf = (s: FxServer, spec: any) =>
    s.connectorIds
      .map((id) => w.connectors.find((c) => c.id === id)!)
      .filter((c) => !spec?.where || m(c, spec.where.connector));

  /** Shapes a server row as Prisma would for `select` / `include`. */
  const project = (s: FxServer, args: any) => {
    const spec = args?.select ?? args?.include ?? {};
    const out: any = args?.select
      ? Object.fromEntries(['id', 'name', 'organizationId'].filter((k) => spec[k]).map((k) => [k, (s as any)[k]]))
      : {
          id: s.id,
          userId: s.userId,
          organizationId: s.organizationId,
          name: s.name,
          slug: s.slug,
          isActive: s.isActive,
          createdAt: s.createdAt,
        };
    const count = spec._count?.select;
    if (count) {
      out._count = {
        connectors: connectorsOf(s, count.connectors === true ? undefined : count.connectors).length,
        ...(count.apiKeys ? { apiKeys: s.apiKeys } : {}),
      };
    }
    if (spec.connectors) {
      out.connectors = connectorsOf(s, spec.connectors).map((c) =>
        spec.connectors.select
          ? { connector: { name: c.name } }
          : {
              mcpServerId: s.id,
              connectorId: c.id,
              connector: { id: c.id, name: c.name, type: c.type, isActive: c.isActive },
            },
      );
    }
    return out;
  };
  const byAge = (a: FxServer, b: FxServer) => a.createdAt.getTime() - b.createdAt.getTime();

  const prisma = {
    reads,
    upserts: [] as any[],
    mcpServerConfig: {
      findUnique: jest.fn(async (args: any) => {
        reads.push('mcpServerConfig.findUnique');
        const s = w.servers.find((x) => x.id === args.where.id);
        return s ? project(s, args) : null;
      }),
      findFirst: jest.fn(async (args: any) => {
        reads.push('mcpServerConfig.findFirst');
        const s = w.servers.find((x) => m(x, args.where));
        return s ? project(s, args) : null;
      }),
      findMany: jest.fn(async (args: any) => {
        reads.push('mcpServerConfig.findMany');
        const rows = w.servers.filter((x) => m(x, args.where)).sort(byAge);
        const from = args.skip ?? 0;
        const paged = args.take !== undefined ? rows.slice(from, from + args.take) : rows.slice(from);
        return paged.map((s) => project(s, args));
      }),
    },
    organizationMember: {
      findMany: jest.fn(async (args: any) => {
        reads.push('organizationMember.findMany');
        const mine = members.filter(
          (x) =>
            x.userId === args.where.userId &&
            (!args.where.organizationId || args.where.organizationId.in.includes(x.organizationId)),
        );
        if (args.select.organization) {
          // listSelectableTargets: today's nested query, active servers, all connectors counted.
          return mine.map((x) => ({
            role: x.role,
            organization: {
              id: x.organizationId,
              name: `name of ${x.organizationId}`,
              mcpServers: w.servers
                .filter((s) => s.organizationId === x.organizationId && s.isActive)
                .sort(byAge)
                .map((s) => ({ id: s.id, name: s.name, _count: { connectors: s.connectorIds.length } })),
            },
          }));
        }
        return mine.map((x) => ({ organizationId: x.organizationId, role: x.role }));
      }),
      count: jest.fn(async (args: any) =>
        members.filter((x) => x.userId === args.where.userId && x.organizationId === args.where.organizationId).length,
      ),
    },
    mcpConnectionGrant: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async (args: any) => {
        prisma.upserts.push(args);
      }),
    },
    mcpApiKey: { findMany: jest.fn(async () => []) },
    toolInvocation: {
      groupBy: jest.fn(async (args: any) =>
        args.where.mcpServerId.in.map((id: string) => ({
          mcpServerId: id,
          _count: { _all: 7 },
          _sum: { repeatCount: null },
          _max: { createdAt: new Date(Date.UTC(2026, 10, 1)) },
        })),
      ),
    },
    oAuthClient: { findUnique: jest.fn(async () => null) },
  };
  return prisma;
}

function build(opts: {
  mode: 'open' | 'restricted';
  role: string;
  allowed: string[] | null | Error;
}) {
  const w = world();
  const myRoles = { [ORG]: opts.role, [ORG_ADMIN]: 'ADMIN', [ORG_OPEN]: 'EDITOR' };
  const prisma = makePrisma(w, myRoles);
  const modes: Record<string, string | null> = {
    [ORG]: opts.mode === 'restricted' ? 'restricted' : null,
    [ORG_ADMIN]: 'restricted',
    [ORG_OPEN]: null,
  };
  const orgSettings = { get: jest.fn(async (orgId: string) => modes[orgId] ?? null) };
  const roles = {
    getAllowedToolIds: jest.fn(async (_userId: string, orgId: string) => {
      if (orgId !== ORG) throw new Error(`no role lookup expected for ${orgId}`);
      if (opts.allowed instanceof Error) throw opts.allowed;
      return opts.allowed;
    }),
  };
  const visibility = new MemberVisibilityService(orgSettings as any, roles as any);
  const service = new McpServersService(prisma as any, {} as any, {} as any);
  const licenseGuard = { checkCanCreateMcpServer: jest.fn(async () => undefined) };
  const servers = new McpServersController(service, licenseGuard as any, prisma as any, visibility);
  const create = jest.spyOn(service, 'create').mockImplementation(async (userId, organizationId, data) => ({ id: 'srv-new', userId, organizationId, ...data }) as any);
  const grants = new McpConnectionGrantService(prisma as any, undefined, visibility);
  const securityEvents = { log: jest.fn(async () => undefined) };
  const connections = new McpConnectionsController(grants, prisma as any, securityEvents as any);
  return { w, prisma, orgSettings, roles, service, servers, licenseGuard, create, grants, connections, securityEvents };
}

type Ctx = ReturnType<typeof build>;

const req = (role: string) => ({ user: { sub: ME, role, organizationId: ORG, email: 'me@example.invalid' } });

async function outcome(p: Promise<unknown>): Promise<{ ok: true; value: any } | { ok: false; error: any }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The 404 an unknown id gets on a server route, from an admin (never restricted). */
async function unknownIdError(c: Ctx, route: 'get' | 'activity') {
  const err = await (c.servers as any)[route](req('ADMIN'), 'no-such-id').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NotFoundException);
  return err as NotFoundException;
}

// Dropped ids are logged at warn level on purpose; keep the test output readable.
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterAll(() => {
  jest.restoreAllMocks();
});

// ── 1. Route coverage ─────────────────────────────────────────────────────

describe('member visibility route coverage (MCP servers, MCP connections)', () => {
  it.each(Object.keys(CONTROLLERS))('%s: every GET route has a declared rule', (name) => {
    const proto = (CONTROLLERS as any)[name].prototype as Record<string, unknown>;
    const getRoutes = Object.getOwnPropertyNames(proto).filter(
      (m) =>
        m !== 'constructor' &&
        typeof proto[m] === 'function' &&
        Reflect.getMetadata(METHOD_METADATA, proto[m] as object) === RequestMethod.GET,
    );
    expect(getRoutes.sort()).toEqual(Object.keys(RULES[name]).sort());
    for (const m of getRoutes) {
      expect(Reflect.getMetadata(PATH_METADATA, proto[m] as object)).toBe(RULES[name][m].path);
    }
  });
});

// ── 2. Matrix ─────────────────────────────────────────────────────────────

const IN_ORG = [
  'srv-mine',
  'srv-mine-hidden',
  'srv-shared',
  'srv-hidden',
  'srv-default-empty',
  'srv-default-with',
  'srv-inactive',
];
const ALL_NAMES: Record<string, string[]> = {
  'srv-mine': ['mine'],
  'srv-mine-hidden': ['hidden'],
  'srv-shared': ['shared', 'hidden'],
  'srv-hidden': ['hidden'],
  'srv-default-empty': [],
  'srv-default-with': ['shared'],
  'srv-inactive': ['shared'],
};

const CASES: Array<{ name: string; allowed: string[] | null; visible: string[]; names: Record<string, string[]> }> = [
  {
    // D4: no whitelist, every connector is visible; D9: an empty server of
    // another member is still hidden.
    name: 'no whitelist',
    allowed: null,
    visible: IN_ORG.filter((s) => s !== 'srv-default-empty'),
    names: ALL_NAMES,
  },
  {
    name: 'role with tools',
    allowed: ['s1'],
    visible: ['srv-mine', 'srv-mine-hidden', 'srv-shared', 'srv-default-with', 'srv-inactive'],
    names: {
      'srv-mine': ['mine'],
      'srv-mine-hidden': [],
      'srv-shared': ['shared'],
      'srv-default-with': ['shared'],
      'srv-inactive': ['shared'],
    },
  },
  {
    name: 'role without tools',
    allowed: ['t-unrelated'],
    visible: ['srv-mine', 'srv-mine-hidden'],
    names: { 'srv-mine': ['mine'], 'srv-mine-hidden': [] },
  },
];

describe.each(['open', 'restricted'] as const)('%s workspace', (mode) => {
  describe.each(CASES)('$name', ({ allowed, visible: restrictedVisible, names: restrictedNames }) => {
    describe.each(['ADMIN', 'EDITOR', 'VIEWER'])('%s', (role) => {
      const restricted = mode === 'restricted' && role !== 'ADMIN';
      const visible = restricted ? restrictedVisible : IN_ORG;
      const names = restricted ? restrictedNames : ALL_NAMES;
      let c: Ctx;
      beforeEach(() => {
        c = build({ mode, role, allowed });
      });
      afterEach(() => {
        if (!restricted) {
          // Today's path: no role lookup for anyone, no settings read for an
          // admin of this workspace (the picker still reads the open workspace
          // where the caller is an EDITOR).
          expect(c.roles.getAllowedToolIds).not.toHaveBeenCalled();
          if (role === 'ADMIN') expect(c.orgSettings.get).not.toHaveBeenCalledWith(ORG, expect.anything());
        }
      });

      it('GET /api/mcp-servers lists the visible servers with only the visible connectors', async () => {
        const rows = (await c.servers.list(req(role), {} as any)) as any[];
        expect(rows.map((r) => r.id)).toEqual(visible);
        for (const r of rows) {
          expect(r.connectors.map((x: any) => x.connector.name)).toEqual(names[r.id]);
          expect(r._count.connectors).toBe(names[r.id].length);
          // Activity numbers stay: no identity in them.
          expect(r.usage).toEqual({ calls30d: 7, lastCallAt: new Date(Date.UTC(2026, 10, 1)) });
        }
      });

      it('GET /api/mcp-servers pages over visible servers only', async () => {
        const rows = (await c.servers.list(req(role), { limit: 2, offset: 1 } as any)) as any[];
        expect(rows.map((r) => r.id)).toEqual(visible.slice(1, 3));
      });

      it.each(IN_ORG)('GET /api/mcp-servers/%s: the server with its visible connectors, or the unknown-id 404', async (id) => {
        const got = await outcome(c.servers.get(req(role), id));
        if (visible.includes(id)) {
          expect(got.ok).toBe(true);
          const value = (got as any).value;
          expect(value.connectors.map((x: any) => x.connector.name)).toEqual(names[id]);
          expect(value._count.connectors).toBe(names[id].length);
          expect(value.apiKeys).toEqual([]);
        } else {
          const unknown = await unknownIdError(c, 'get');
          expect(got.ok).toBe(false);
          expect((got as any).error).toBeInstanceOf(NotFoundException);
          expect((got as any).error.getStatus()).toBe(unknown.getStatus());
          expect((got as any).error.getResponse()).toEqual(unknown.getResponse());
        }
      });

      it.each(IN_ORG)('GET /api/mcp-servers/%s/activity: the numbers, or the unknown-id 404', async (id) => {
        const got = await outcome(c.servers.activity(req(role), id));
        if (visible.includes(id)) {
          expect(got).toEqual({ ok: true, value: { calls30d: 7, lastCallAt: new Date(Date.UTC(2026, 10, 1)) } });
        } else {
          const unknown = await unknownIdError(c, 'activity');
          expect(got.ok).toBe(false);
          expect((got as any).error.getStatus()).toBe(unknown.getStatus());
          expect((got as any).error.getResponse()).toEqual(unknown.getResponse());
        }
      });

      it("another workspace's server stays the unknown-id 404", async () => {
        const unknown = await unknownIdError(c, 'get');
        const err = await c.servers.get(req(role), 'srv-x').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NotFoundException);
        expect((err as NotFoundException).getResponse()).toEqual(unknown.getResponse());
      });

      it('GET /api/mcp-connections/targets: this workspace by its own rule, the others by theirs', async () => {
        const targets = await c.connections.targets(req(role));
        const byOrg = Object.fromEntries(targets.map((t) => [t.organizationId, t.servers]));
        const activeVisible = visible.filter((s) => s !== 'srv-inactive');
        expect(byOrg[ORG].map((s) => s.id)).toEqual(activeVisible);
        for (const s of byOrg[ORG]) expect(s.connectorCount).toBe(names[s.id].length);
        // ADMIN in a restricted workspace, EDITOR in an open one: everything.
        expect(byOrg[ORG_ADMIN]).toEqual([{ id: 'srv-o2', name: 'srv-o2', connectorCount: 1 }]);
        expect(byOrg[ORG_OPEN]).toEqual([{ id: 'srv-o3', name: 'srv-o3', connectorCount: 1 }]);
        expect(byOrg[FOREIGN]).toBeUndefined();
      });

      it('PUT /api/mcp-connections/:clientId grants a visible server, and treats a hidden one like an unknown id', async () => {
        const unknown = await c.connections.update(req(role), 'client-1', { serverIds: ['no-such-id'] });
        expect(unknown).toEqual({ ok: false, reason: 'nothing-granted' });
        for (const id of IN_ORG.filter((s) => s !== 'srv-inactive')) {
          const res = await c.connections.update(req(role), 'client-1', { serverIds: [id] });
          expect(res).toEqual(visible.includes(id) ? { ok: true } : unknown);
        }
        // A mixed selection keeps only what the caller may see, in any workspace.
        c.prisma.upserts.length = 0;
        await c.connections.update(req(role), 'client-1', { serverIds: [...IN_ORG, 'srv-o2', 'srv-o3', 'srv-x'] });
        expect(c.prisma.upserts[0].create.serverIds).toEqual([
          ...visible.filter((s) => s !== 'srv-inactive'),
          'srv-o2',
          'srv-o3',
        ]);
      });

      it('POST /api/mcp-servers: refused for a VIEWER (D10), unchanged for EDITOR and ADMIN', async () => {
        const got = await outcome(c.servers.create(req(role), { name: 'Sales' }));
        if (role === 'VIEWER') {
          expect(got.ok).toBe(false);
          expect((got as any).error).toBeInstanceOf(ForbiddenException);
          expect((got as any).error.getResponse()).toEqual(
            new ForbiddenException('Viewers cannot modify MCP servers').getResponse(),
          );
          expect(c.licenseGuard.checkCanCreateMcpServer).not.toHaveBeenCalled();
          expect(c.create).not.toHaveBeenCalled();
        } else {
          expect(got).toEqual({ ok: true, value: expect.objectContaining({ id: 'srv-new', name: 'Sales' }) });
          expect(c.licenseGuard.checkCanCreateMcpServer).toHaveBeenCalledWith(ME, ORG);
          expect(c.create).toHaveBeenCalledWith(ME, ORG, { name: 'Sales' });
        }
      });
    });
  });
});

// ── 3. Grants across workspaces ───────────────────────────────────────────

describe('grants across workspaces', () => {
  it('a member admin elsewhere grants every server there, and only visible ones here', async () => {
    const c = build({ mode: 'restricted', role: 'VIEWER', allowed: ['s1'] });
    const granted = await c.grants.grantServers('client-1', ME, ['srv-hidden', 'srv-shared', 'srv-o2', 'srv-o3']);
    expect(granted).toEqual(['srv-shared', 'srv-o2', 'srv-o3']);
    // The role lookup ran for the restricted workspace only.
    expect(c.roles.getAllowedToolIds).toHaveBeenCalledTimes(1);
    expect(c.roles.getAllowedToolIds).toHaveBeenCalledWith(ME, ORG);
  });

  it('writes nothing when every requested server is hidden', async () => {
    const c = build({ mode: 'restricted', role: 'EDITOR', allowed: ['s1'] });
    await expect(c.grants.grantServers('client-1', ME, ['srv-hidden', 'srv-default-empty'])).resolves.toEqual([]);
    expect(c.prisma.upserts).toHaveLength(0);
  });

  it('keeps the whole-workspace grant as it is', async () => {
    const c = build({ mode: 'restricted', role: 'VIEWER', allowed: ['s1'] });
    await expect(c.connections.update(req('VIEWER'), 'client-1', { organizationId: ORG })).resolves.toEqual({ ok: true });
  });
});

// ── 4. Fail closed ────────────────────────────────────────────────────────

describe('fail closed', () => {
  const boom = new Error('role lookup failed');

  it.each(['EDITOR', 'VIEWER'])('%s: every read route and the grant fail when the role lookup throws', async (role) => {
    const c = build({ mode: 'restricted', role, allowed: boom });
    await expect(c.servers.list(req(role), {} as any)).rejects.toBe(boom);
    await expect(c.servers.get(req(role), 'srv-shared')).rejects.toBe(boom);
    expect(c.prisma.reads).toEqual([]);
    await expect(c.servers.activity(req(role), 'srv-shared')).rejects.toBe(boom);
    expect(c.prisma.toolInvocation.groupBy).not.toHaveBeenCalled();
    await expect(c.connections.targets(req(role))).rejects.toBe(boom);
    await expect(c.connections.update(req(role), 'client-1', { serverIds: ['srv-shared'] })).rejects.toBe(boom);
    expect(c.prisma.upserts).toHaveLength(0);
    expect(c.securityEvents.log).not.toHaveBeenCalled();
  });

  it('a VIEWER is refused before anything else, even when the role lookup would throw', async () => {
    const c = build({ mode: 'restricted', role: 'VIEWER', allowed: boom });
    await expect(c.servers.create(req('VIEWER'), { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
