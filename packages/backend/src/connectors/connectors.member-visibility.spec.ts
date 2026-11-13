import 'reflect-metadata';
import { ForbiddenException, HttpException, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import { FileSearchController } from '../file-search/file-search.controller';
import { FILE_SEARCH_CONNECTOR_NOT_FOUND, FileSearchService } from '../file-search/file-search.service';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import { ToolsController } from './tools.controller';
import { startConnectorAuthorization } from './connector-authorization';

jest.mock('./connector-authorization', () => ({
  ...jest.requireActual('./connector-authorization'),
  startConnectorAuthorization: jest.fn(async () => ({ authorizationUrl: 'https://idp.example.invalid/authorize' })),
}));

/**
 * Member visibility on the connectors, tools and File Search controllers.
 *
 * 1. Route coverage: every GET route of the three controllers must have a
 *    rule in RULES below, so a new read route cannot ship without one.
 * 2. Matrix: ADMIN / EDITOR / VIEWER x open / restricted x (no whitelist,
 *    role with tools, role without tools) with the caller owning one
 *    connector of each kind. A hidden connector answers exactly the 404 an
 *    unknown id gets; admins and open workspaces never read their roles.
 * 3. Fail closed: a role lookup that throws fails the request; nothing is read.
 *
 * Prisma is an in-memory double that evaluates the `where` shapes these
 * routes send; connectors.member-visibility.integration.spec.ts runs the
 * same rules against PostgreSQL.
 */

const KEY = 'k'.repeat(48);
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? KEY;

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const ME = 'user-me';
const OTHER = 'user-other';

type Rule =
  /** A list narrowed in the query: owned connectors or those with an allowed tool. */
  | 'list'
  /** 404 (unknown-id body) for a hidden connector, then today's code. */
  | 'visible'
  /** 404 for a hidden connector, then today's owner-or-admin check. */
  | 'visible-then-owner'
  /** Restricted members: the connectors they own only. */
  | 'owned-list'
  /** Restricted members: a connector they own only (404 for others). */
  | 'owned'
  /** Instance or workspace settings with no connector data: unchanged. */
  | 'no-connector-data';

/** Every GET route of the three controllers and the rule it follows. */
const RULES: Record<string, Record<string, { path: string; rule: Rule }>> = {
  ConnectorsController: {
    list: { path: '/', rule: 'list' },
    proxyAvailability: { path: 'proxy-availability', rule: 'no-connector-data' },
    healthCheck: { path: 'health-check', rule: 'list' },
    exportAll: { path: 'export-all', rule: 'owned-list' },
    exportOne: { path: ':id/export', rule: 'owned' },
    findOne: { path: ':id', rule: 'visible' },
    webhookUrl: { path: ':id/webhook/url', rule: 'visible-then-owner' },
    webhookEventsList: { path: ':id/webhook/events', rule: 'visible-then-owner' },
    getOAuthConfig: { path: ':id/oauth-config', rule: 'visible' },
    getMyCredential: { path: ':id/my-credential', rule: 'visible' },
    oauthRedirectUri: { path: 'oauth/redirect-uri', rule: 'no-connector-data' },
    catalogDiff: { path: ':id/catalog-diff', rule: 'visible-then-owner' },
  },
  ToolsController: {
    list: { path: '/', rule: 'visible' },
    getAnnotations: { path: ':toolId/annotations', rule: 'visible-then-owner' },
    getResponseMapping: { path: ':toolId/response-mapping', rule: 'visible-then-owner' },
  },
  FileSearchController: {
    capabilities: { path: 'capabilities', rule: 'no-connector-data' },
    getPolicy: { path: 'policy', rule: 'no-connector-data' },
    overview: { path: 'connectors/:id', rule: 'visible' },
    getScan: { path: 'connectors/:id/scans/:scanId', rule: 'visible' },
    tree: { path: 'connectors/:id/tree', rule: 'visible' },
    problems: { path: 'connectors/:id/problems', rule: 'visible' },
    runs: { path: 'connectors/:id/runs', rule: 'visible' },
    getRules: { path: 'connectors/:id/access-rules', rule: 'visible' },
  },
};

const CONTROLLERS = { ConnectorsController, ToolsController, FileSearchController } as const;

// ── Fixtures ──────────────────────────────────────────────────────────────

function connector(
  id: string,
  userId: string,
  toolIds: string[],
  extra: Record<string, unknown> = {},
  age = 0,
) {
  return {
    id,
    userId,
    organizationId: ORG,
    name: id,
    type: 'REST',
    baseUrl: 'https://api.example.invalid',
    authType: 'NONE',
    authConfig: null,
    authStatus: null,
    specUrl: null,
    headers: null,
    envVars: null,
    config: null,
    credentialScope: 'SHARED',
    isActive: true,
    createdAt: new Date(Date.UTC(2026, 0, 1) + age * 60_000),
    tools: toolIds.map((tid) => ({
      id: tid,
      connectorId: id,
      name: `${id}_${tid}`,
      description: 'fixture',
      isEnabled: true,
      parameters: {},
      endpointMapping: { method: 'GET', path: '/x' },
      responseMapping: null,
      annotations: null,
      outputSchema: null,
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    })),
    resources: [],
    prompts: [],
    mcpServers: [] as Array<{ mcpServerId: string }>,
    ...extra,
  };
}

function world() {
  // Per-user sign-in (credentialScope USER) on the REST fixtures, so that
  // POST :id/oauth/authorize takes its member branch (workspace check only).
  const user = { credentialScope: 'USER' };
  const connectors = [
    // Owned by the caller: always visible to them, with all its tools.
    connector('mine', ME, ['m1', 'm2'], user, 1),
    // Another member's, with one tool the "role with tools" allows (s1).
    connector('shared', OTHER, ['s1', 's2'], user, 2),
    // Another member's, no allowed tool.
    connector('hidden', OTHER, ['h1'], user, 3),
    // File Search connectors: caller's own, allowed (f1), not allowed (f2).
    connector('fsMine', ME, ['fm1'], { type: 'FILE_SEARCH' }, 4),
    connector('fs', OTHER, ['f1'], { type: 'FILE_SEARCH' }, 5),
    connector('fsHidden', OTHER, ['f2'], { type: 'FILE_SEARCH' }, 6),
    // Another workspace.
    { ...connector('foreign', OTHER, ['x1'], {}, 7), organizationId: OTHER_ORG },
  ];
  const servers = [
    { id: 'srv-shared', userId: OTHER, organizationId: ORG, connectorIds: ['shared'] },
    { id: 'srv-hidden', userId: OTHER, organizationId: ORG, connectorIds: ['hidden', 'shared'] },
  ];
  connectors.find((c) => c.id === 'shared')!.mcpServers = [{ mcpServerId: 'srv-shared' }, { mcpServerId: 'srv-hidden' }];
  return { connectors, servers };
}

/** Evaluates the Prisma `where` shapes these routes send. */
function matches(row: any, where: any, rel: { connectorsById: Map<string, any> }): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'AND') return value.every((w: any) => matches(row, w, rel));
    if (key === 'OR') return value.some((w: any) => matches(row, w, rel));
    if (key === 'tools') return row.tools.some((t: any) => matches(t, value.some, rel));
    if (key === 'connectors') {
      return row.connectorIds.some((cid: string) => {
        const c = rel.connectorsById.get(cid);
        return c && matches(c, value.some.connector, rel);
      });
    }
    if (value && typeof value === 'object' && Array.isArray(value.in)) return value.in.includes(row[key]);
    if (value && typeof value === 'object') throw new Error(`unsupported where ${key}: ${JSON.stringify(value)}`);
    return row[key] === value;
  });
}

function makePrisma(w: ReturnType<typeof world>) {
  const connectorsById = new Map(w.connectors.map((c) => [c.id, c]));
  const rel = { connectorsById };
  const tools = w.connectors.flatMap((c) => c.tools);
  const reads: string[] = [];
  const page = <T>(rows: T[], args: any) => {
    const from = args?.skip ?? 0;
    return args?.take !== undefined ? rows.slice(from, from + args.take) : rows.slice(from);
  };
  const byNewest = (a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime();
  const prisma = {
    reads,
    connector: {
      findUnique: jest.fn(async ({ where }: any) => {
        reads.push('connector.findUnique');
        return connectorsById.get(where.id) ?? null;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        reads.push('connector.findFirst');
        return w.connectors.find((c) => matches(c, where, rel)) ?? null;
      }),
      findMany: jest.fn(async (args: any) => {
        reads.push('connector.findMany');
        return page(w.connectors.filter((c) => matches(c, args.where, rel)).sort(byNewest), args);
      }),
    },
    mcpTool: {
      findMany: jest.fn(async (args: any) => {
        reads.push('mcpTool.findMany');
        return tools.filter((t) => matches(t, args.where, rel));
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        reads.push('mcpTool.findFirst');
        return tools.find((t) => matches(t, where, rel)) ?? null;
      }),
    },
    mcpServerConfig: {
      findMany: jest.fn(async (args: any) => {
        reads.push('mcpServerConfig.findMany');
        return w.servers.filter((s) => matches(s, args.where, rel)).map((s) => ({ id: s.id }));
      }),
    },
    toolInvocation: { findMany: jest.fn(async () => []) },
  };
  return prisma;
}

function build(opts: { mode: 'open' | 'restricted'; allowed: string[] | null | Error }) {
  const w = world();
  const prisma = makePrisma(w);
  const orgSettings = { get: jest.fn(async () => (opts.mode === 'restricted' ? 'restricted' : null)) };
  const roles = {
    getAllowedToolIds: jest.fn(async () => {
      if (opts.allowed instanceof Error) throw opts.allowed;
      return opts.allowed;
    }),
  };
  const visibility = new MemberVisibilityService(orgSettings as any, roles as any);
  const configService = { get: (k: string) => (k === 'ENCRYPTION_KEY' ? KEY : k === 'SERVER_URL' ? 'https://amcp.example.invalid' : undefined) };
  const connectorsService = new ConnectorsService(prisma as any, configService as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  jest.spyOn(connectorsService, 'testConnection').mockResolvedValue({ ok: true, message: 'ok' } as any);
  const edition = { hasEnterprise: jest.fn(async () => true), assertEnterprise: jest.fn(async () => undefined) };
  const userCredentials = {
    status: jest.fn(async () => ({ connected: true })),
    remove: jest.fn(async () => true),
  };
  const connectors = new ConnectorsController(
    connectorsService,
    {} as any, // openApiParser
    {} as any, // wsdlParser
    {} as any, // graphqlParser
    {} as any, // postmanParser
    {} as any, // curlParser
    {} as any, // harParser
    {} as any, // mcpClientEngine
    {} as any, // mcpOAuthService
    { computeDiff: jest.fn(async () => null) } as any, // catalogResync
    prisma as any,
    {} as any, // mcpServer
    configService as any,
    {} as any, // licenseGuard
    {} as any, // mcpServers
    { isCloud: () => false } as any,
    { recentEvents: jest.fn(async () => []) } as any,
    edition as any,
    userCredentials as any,
    visibility,
  );
  const tools = new ToolsController(prisma as any, {} as any, connectorsService, {} as any, {} as any, {} as any, visibility);

  const fsDeps = [prisma, { isCloud: () => false }, {}, {}, {}, {}, {}, {}] as any[];
  const fileSearch = new (FileSearchService as any)(...fsDeps) as FileSearchService;
  const fsData = {
    overview: jest.spyOn(fileSearch, 'overview').mockResolvedValue({ ok: 'overview' } as any),
    getScan: jest.spyOn(fileSearch, 'getScan').mockResolvedValue({ ok: 'scan' } as any),
    tree: jest.spyOn(fileSearch, 'tree').mockResolvedValue({ ok: 'tree' } as any),
    problems: jest.spyOn(fileSearch, 'problems').mockResolvedValue({ ok: 'problems' } as any),
    runs: jest.spyOn(fileSearch, 'runs').mockResolvedValue([] as any),
    getAccessRules: jest.spyOn(fileSearch, 'getAccessRules').mockResolvedValue({ ok: 'rules' } as any),
    syncNow: jest.spyOn(fileSearch, 'syncNow').mockResolvedValue({ ok: true } as any),
    capabilities: jest.spyOn(fileSearch, 'capabilities').mockResolvedValue({ ok: 'caps' } as any),
    getPolicy: jest.spyOn(fileSearch, 'getPolicy').mockResolvedValue({ ok: 'policy' } as any),
  };
  const fs = new FileSearchController(fileSearch, visibility);

  return { w, prisma, orgSettings, roles, connectorsService, connectors, tools, fs, fsData, userCredentials };
}

type Ctx = ReturnType<typeof build>;

const req = (role: string) => ({ user: { sub: ME, role, organizationId: ORG, email: 'me@example.invalid' } });
const res = () => ({ setHeader: jest.fn() }) as any;

/** How to call each `visible` / `visible-then-owner` / `owned` route for a connector id. */
const BY_ID: Record<string, (c: Ctx, role: string, id: string) => Promise<unknown>> = {
  'ConnectorsController.findOne': (c, role, id) => c.connectors.findOne(req(role), id),
  'ConnectorsController.getOAuthConfig': (c, role, id) => c.connectors.getOAuthConfig(req(role), id),
  'ConnectorsController.getMyCredential': (c, role, id) => c.connectors.getMyCredential(req(role), id),
  'ConnectorsController.webhookUrl': (c, role, id) => c.connectors.webhookUrl(req(role), id),
  'ConnectorsController.webhookEventsList': (c, role, id) => c.connectors.webhookEventsList(req(role), id),
  'ConnectorsController.catalogDiff': (c, role, id) => c.connectors.catalogDiff(req(role), id),
  'ConnectorsController.exportOne': (c, role, id) => c.connectors.exportOne(req(role), id, 'json', res()),
  'ToolsController.list': (c, role, id) => c.tools.list(req(role), id),
  'ToolsController.getAnnotations': (c, role, id) => c.tools.getAnnotations(req(role), firstToolOf(c, id), id),
  'ToolsController.getResponseMapping': (c, role, id) => c.tools.getResponseMapping(req(role), firstToolOf(c, id), id),
  'FileSearchController.overview': (c, role, id) => c.fs.overview(req(role), id),
  'FileSearchController.getScan': (c, role, id) => c.fs.getScan(req(role), id, 'scan-1'),
  'FileSearchController.tree': (c, role, id) => c.fs.tree(req(role), id),
  'FileSearchController.problems': (c, role, id) => c.fs.problems(req(role), id, {} as any),
  'FileSearchController.runs': (c, role, id) => c.fs.runs(req(role), id),
  'FileSearchController.getRules': (c, role, id) => c.fs.getRules(req(role), id),
  // Not GET routes, but a member reaches them with only a workspace check today.
  'ConnectorsController.deleteMyCredential': (c, role, id) => c.connectors.deleteMyCredential(req(role), id),
  'ConnectorsController.initiateOAuth': (c, role, id) => c.connectors.initiateOAuth(req(role), id, {}),
  'FileSearchController.syncNow': (c, role, id) => c.fs.syncNow(req(role), id),
};

const NOT_GET_BY_ID: Record<string, Rule> = {
  'ConnectorsController.deleteMyCredential': 'visible',
  'ConnectorsController.initiateOAuth': 'visible',
  'FileSearchController.syncNow': 'visible',
};

function firstToolOf(c: Ctx, connectorId: string): string {
  return c.w.connectors.find((x) => x.id === connectorId)?.tools[0]?.id ?? 'no-such-tool';
}

const isFileSearch = (route: string) => route.startsWith('FileSearchController.');
const idsFor = (route: string) =>
  isFileSearch(route) ? { owned: 'fsMine', allowed: 'fs', hidden: 'fsHidden' } : { owned: 'mine', allowed: 'shared', hidden: 'hidden' };

/** The 404 body an unknown id gets on this route. */
async function unknownIdBody(c: Ctx, route: string): Promise<unknown> {
  if (isFileSearch(route)) {
    // From the real lookup every File Search route uses (loadConnector).
    const real = new (FileSearchService as any)(c.prisma, { isCloud: () => false }, {}, {}, {}, {}, {}, {});
    const err = await real.tree(req('ADMIN').user, 'no-such-id').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toEqual(new NotFoundException(FILE_SEARCH_CONNECTOR_NOT_FOUND).getResponse());
    return (err as NotFoundException).getResponse();
  }
  // From an admin, who is never restricted: what any caller gets today.
  const err = await BY_ID[route](c, 'ADMIN', 'no-such-id').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NotFoundException);
  return (err as NotFoundException).getResponse();
}

/** Same as unknownIdBody, but with the id of the hidden connector in place of the unknown one. */
async function hiddenIdBody(c: Ctx, route: string, hiddenId: string) {
  const body = (await unknownIdBody(c, route)) as Record<string, unknown>;
  return JSON.parse(JSON.stringify(body).split('no-such-id').join(hiddenId));
}

async function outcome(p: Promise<unknown>): Promise<{ ok: true; value: any } | { ok: false; error: any }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

// ── 1. Route coverage ─────────────────────────────────────────────────────

describe('member visibility route coverage', () => {
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

  it('every route with a connector id is exercised by the matrix below', () => {
    const byId = Object.entries(RULES).flatMap(([ctrl, routes]) =>
      Object.entries(routes)
        .filter(([, r]) => r.rule === 'visible' || r.rule === 'visible-then-owner' || r.rule === 'owned')
        .map(([m]) => `${ctrl}.${m}`),
    );
    expect(Object.keys(BY_ID).sort()).toEqual([...byId, ...Object.keys(NOT_GET_BY_ID)].sort());
  });
});

// ── 2. Matrix ─────────────────────────────────────────────────────────────

const CASES: Array<{ name: string; allowed: string[] | null; visible: string[] }> = [
  { name: 'no whitelist', allowed: null, visible: ['mine', 'shared', 'hidden', 'fsMine', 'fs', 'fsHidden'] },
  { name: 'role with tools', allowed: ['s1', 'f1'], visible: ['mine', 'shared', 'fsMine', 'fs'] },
  { name: 'role without tools', allowed: [], visible: ['mine', 'fsMine'] },
];
const ALL_IN_ORG = ['mine', 'shared', 'hidden', 'fsMine', 'fs', 'fsHidden'];

describe.each(['open', 'restricted'] as const)('%s workspace', (mode) => {
  describe.each(CASES)('$name', ({ allowed, visible: restrictedVisible }) => {
    describe.each(['ADMIN', 'EDITOR', 'VIEWER'])('%s', (role) => {
      const restricted = mode === 'restricted' && role !== 'ADMIN';
      const visible = restricted ? restrictedVisible : ALL_IN_ORG;
      let c: Ctx;
      beforeEach(() => {
        c = build({ mode, allowed });
      });
      afterEach(() => {
        if (!restricted) {
          // Today's path: no role lookup for anyone, no settings read for admins.
          expect(c.roles.getAllowedToolIds).not.toHaveBeenCalled();
          if (role === 'ADMIN') expect(c.orgSettings.get).not.toHaveBeenCalled();
        }
      });

      it('GET /api/connectors lists the visible connectors, with only the visible tools', async () => {
        const rows = (await c.connectors.list(req(role), {} as any)) as any[];
        expect(rows.map((r) => r.id).sort()).toEqual([...visible].sort());
        const shared = rows.find((r) => r.id === 'shared');
        if (shared) {
          const expected = restricted && allowed !== null ? ['s1'] : ['s1', 's2'];
          expect(shared.tools.map((t: any) => t.id)).toEqual(expected);
        }
        const mine = rows.find((r) => r.id === 'mine');
        expect(mine.tools.map((t: any) => t.id)).toEqual(['m1', 'm2']);
        expect(rows.every((r) => r.organizationId === ORG)).toBe(true);
      });

      it('GET /api/connectors pages over visible connectors only', async () => {
        const all = ((await c.connectors.list(req(role), {} as any)) as any[]).map((r) => r.id);
        const pages: string[] = [];
        for (let offset = 0; offset < all.length + 2; offset += 2) {
          const rows = (await c.connectors.list(req(role), { limit: 2, offset } as any)) as any[];
          expect(rows.length).toBeLessThanOrEqual(2);
          pages.push(...rows.map((r) => r.id));
        }
        expect(pages).toEqual(all);
      });

      it('GET /api/connectors/health-check checks the visible active connectors only', async () => {
        const out: any = await c.connectors.healthCheck(req(role));
        expect(out.connectors.map((r: any) => r.id).sort()).toEqual([...visible].sort());
        expect(out.total).toBe(visible.length);
      });

      it('GET /api/connectors/export-all exports owned connectors only for a restricted member', async () => {
        const out: any = await c.connectors.exportAll(req(role));
        const expected = restricted ? ['mine', 'fsMine'] : ALL_IN_ORG;
        expect(out.connectors.map((e: any) => e.name).sort()).toEqual([...expected].sort());
      });

      it('GET /api/connectors/:id names only MCP servers the caller can see', async () => {
        const got = await outcome(c.connectors.findOne(req(role), 'shared'));
        if (!visible.includes('shared')) {
          expect(got.ok).toBe(false);
          return;
        }
        expect(got.ok).toBe(true);
        const value = (got as any).value;
        // srv-hidden holds `shared` too, so the servers rule keeps it.
        expect(value.mcpServers.map((s: any) => s.mcpServerId).sort()).toEqual(['srv-hidden', 'srv-shared']);
        expect(value.tools.map((t: any) => t.id)).toEqual(restricted && allowed !== null ? ['s1'] : ['s1', 's2']);
      });

      it('GET /api/connectors/:connectorId/tools lists only the visible tools', async () => {
        const got = await outcome(c.tools.list(req(role), 'shared'));
        if (!visible.includes('shared')) {
          expect(got.ok).toBe(false);
          return;
        }
        expect(((got as any).value as any[]).map((t) => t.id).sort()).toEqual(
          restricted && allowed !== null ? ['s1'] : ['s1', 's2'],
        );
        const own = (await c.tools.list(req(role), 'mine')) as any[];
        expect(own.map((t) => t.id).sort()).toEqual(['m1', 'm2']);
      });

      describe.each(Object.keys(BY_ID))('%s', (route) => {
        const [ctrl, method] = route.split('.');
        const rule: Rule = RULES[ctrl]?.[method]?.rule ?? NOT_GET_BY_ID[route];
        const ids = idsFor(route);

        it('owned connector: allowed (owner-or-admin routes included)', async () => {
          const got = await outcome(BY_ID[route](c, role, ids.owned));
          if (role === 'VIEWER' && rule === 'visible-then-owner') {
            // Today's rule, unchanged: viewers cannot modify connectors.
            expect((got as any).error).toBeInstanceOf(ForbiddenException);
            return;
          }
          expect(got).toMatchObject({ ok: true });
        });

        /** Another member's connector: 404 when hidden (or not owned, for exports), else today's answer. */
        const expectOthers = async (id: string) => {
          const got = await outcome(BY_ID[route](c, role, id));
          const hidden = restricted && !visible.includes(id);
          if (hidden || (rule === 'owned' && restricted)) {
            expect((got as any).error).toBeInstanceOf(NotFoundException);
            expect((got as any).error.getResponse()).toEqual(await hiddenIdBody(c, route, id));
            return;
          }
          if (rule === 'visible-then-owner' && role !== 'ADMIN') {
            // Visible, so today's owner-or-admin answer: 403.
            expect((got as any).error).toBeInstanceOf(ForbiddenException);
            return;
          }
          expect(got).toMatchObject({ ok: true });
        };

        it('connector of another member with an allowed tool', () => expectOthers(ids.allowed));

        it('connector of another member with no allowed tool', () => expectOthers(ids.hidden));

        it('connector of another workspace: today’s answer, whatever the mode', async () => {
          if (isFileSearch(route)) return; // File Search looks up by workspace: same 404 as unknown.
          const got = await outcome(BY_ID[route](c, role, 'foreign'));
          expect(got.ok).toBe(false);
          const error = (got as any).error as HttpException;
          if (rule === 'owned') {
            expect(error).toBeInstanceOf(NotFoundException);
          } else {
            expect(error).toBeInstanceOf(ForbiddenException);
          }
        });
      });
    });
  });
});

// ── Detail checks that the matrix does not spell out ─────────────────────

describe('restricted member specifics', () => {
  it('a hidden connector answers exactly the unknown-id body, status included', async () => {
    const c = build({ mode: 'restricted', allowed: ['s1'] });
    const unknown = await outcome(c.connectors.findOne(req('ADMIN'), 'zzz'));
    const hidden = await outcome(c.connectors.findOne(req('VIEWER'), 'hidden'));
    const u = (unknown as any).error as NotFoundException;
    const h = (hidden as any).error as NotFoundException;
    expect(h.getStatus()).toBe(u.getStatus());
    expect(h.getResponse()).toEqual({ ...(u.getResponse() as object), message: 'Connector hidden not found' });
    expect((u.getResponse() as any).message).toBe('Connector zzz not found');
  });

  it('per-user sign-in keeps working for a member whose role allows the connector', async () => {
    const c = build({ mode: 'restricted', allowed: ['s1'] });
    const out = await c.connectors.initiateOAuth(req('VIEWER'), 'shared', {}).catch((e) => e);
    // `shared` uses per-user credentials but its auth type is not OAUTH2 in
    // the fixture; switch it to reach the real start of the flow.
    expect(out).toEqual({ error: 'Connector auth type must be OAUTH2' });
    c.w.connectors.find((x) => x.id === 'shared')!.authType = 'OAUTH2';
    await expect(c.connectors.initiateOAuth(req('VIEWER'), 'shared', {})).resolves.toEqual({
      authorizationUrl: 'https://idp.example.invalid/authorize',
    });
    expect(startConnectorAuthorization).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'shared' }),
      expect.objectContaining({ userId: ME, forUser: true }),
    );
    await expect(c.connectors.getMyCredential(req('VIEWER'), 'shared')).resolves.toEqual({ connected: true, available: true });
    await expect(c.connectors.deleteMyCredential(req('VIEWER'), 'shared')).resolves.toEqual({ removed: true });
  });

  it('shared-credential authorization: 404 when hidden, today’s owner-or-admin 403 when visible', async () => {
    const c = build({ mode: 'restricted', allowed: ['s1'] });
    for (const id of ['shared', 'hidden']) c.w.connectors.find((x) => x.id === id)!.credentialScope = 'SHARED';
    await expect(c.connectors.initiateOAuth(req('EDITOR'), 'hidden', {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(c.connectors.initiateOAuth(req('EDITOR'), 'shared', {})).rejects.toThrow(
      'Only the connector owner or an admin can modify this connector',
    );
  });

  it('per-user sign-in to a hidden connector answers 404 and starts nothing', async () => {
    const c = build({ mode: 'restricted', allowed: [] });
    (startConnectorAuthorization as jest.Mock).mockClear();
    await expect(c.connectors.initiateOAuth(req('VIEWER'), 'shared', {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(c.connectors.deleteMyCredential(req('VIEWER'), 'shared')).rejects.toBeInstanceOf(NotFoundException);
    expect(startConnectorAuthorization).not.toHaveBeenCalled();
    expect(c.userCredentials.remove).not.toHaveBeenCalled();
  });

  it('the restricted list asks the database for visible connectors only, inside the workspace', async () => {
    const c = build({ mode: 'restricted', allowed: ['s1'] });
    await c.connectors.list(req('EDITOR'), { limit: 5, offset: 10 } as any);
    expect(c.prisma.connector.findMany).toHaveBeenCalledWith({
      where: {
        AND: [{ organizationId: ORG }, { OR: [{ userId: ME }, { tools: { some: { id: { in: ['s1'] } } } }] }],
      },
      include: { tools: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
      skip: 10,
    });
  });

  it('an open workspace sends exactly today’s query', async () => {
    const c = build({ mode: 'open', allowed: null });
    await c.connectors.list(req('VIEWER'), { limit: 5, offset: 10 } as any);
    expect(c.prisma.connector.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG },
      include: { tools: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
      skip: 10,
    });
  });

  it('File Search data is not read for a hidden connector', async () => {
    const c = build({ mode: 'restricted', allowed: [] });
    for (const route of ['overview', 'getScan', 'tree', 'problems', 'runs', 'getRules', 'syncNow']) {
      await expect(BY_ID[`FileSearchController.${route}`](c, 'EDITOR', 'fs')).rejects.toBeInstanceOf(NotFoundException);
    }
    for (const spy of Object.values(c.fsData)) expect(spy).not.toHaveBeenCalled();
  });

  it('workspace-level File Search reads stay as they are', async () => {
    const c = build({ mode: 'restricted', allowed: [] });
    await expect(c.fs.capabilities(req('VIEWER'))).resolves.toEqual({ ok: 'caps' });
    await expect(c.fs.getPolicy(req('VIEWER'))).resolves.toEqual({ ok: 'policy' });
    expect(c.roles.getAllowedToolIds).not.toHaveBeenCalled();
  });
});

// ── 3. Fail closed ────────────────────────────────────────────────────────

describe('fail closed', () => {
  const ROUTES: Array<[string, (c: Ctx, role: string) => Promise<unknown>]> = [
    ['list', (c, role) => c.connectors.list(req(role), {} as any)],
    ['health-check', (c, role) => c.connectors.healthCheck(req(role))],
    ['export-all', (c, role) => c.connectors.exportAll(req(role))],
    ...Object.entries(BY_ID).map(
      ([name, call]) => [name, (c: Ctx, role: string) => call(c, role, idsFor(name).owned)] as [string, (c: Ctx, role: string) => Promise<unknown>],
    ),
  ];

  it.each(ROUTES)('%s: a failing role lookup fails the request and returns nothing', async (_name, call) => {
    for (const role of ['EDITOR', 'VIEWER']) {
      const c = build({ mode: 'restricted', allowed: new Error('role lookup down') });
      await expect(call(c, role)).rejects.toThrow('role lookup down');
      expect(c.prisma.reads.filter((r) => r !== 'connector.findUnique')).toEqual([]);
      for (const spy of Object.values(c.fsData)) expect(spy).not.toHaveBeenCalled();
    }
  });

  it('an admin is never asked for roles, so a broken role lookup cannot affect admins', async () => {
    const c = build({ mode: 'restricted', allowed: new Error('role lookup down') });
    await expect(c.connectors.list(req('ADMIN'), {} as any)).resolves.toHaveLength(ALL_IN_ORG.length);
  });
});
