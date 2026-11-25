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
import { MEMBER_CONNECTOR_FIELDS, MEMBER_TOOL_FIELDS } from './connector-member-view.util';

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
 * 4. Reduced view: a restricted member reads a connector they do not own as
 *    an allowlist of fields; owners, admins and open workspaces read exactly
 *    what they read before the reduced view existed.
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
  /**
   * The answer is the connector's settings. Restricted members: 404 unless
   * they own it, visible or not; another workspace stays today's 403.
   */
  | 'full-view'
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
    getOAuthConfig: { path: ':id/oauth-config', rule: 'full-view' },
    getLoginTokenConfig: { path: ':id/login-token-config', rule: 'full-view' },
    getMyCredential: { path: ':id/my-credential', rule: 'visible' },
    oauthRedirectUri: { path: 'oauth/redirect-uri', rule: 'no-connector-data' },
    catalogDiff: { path: ':id/catalog-diff', rule: 'visible-then-owner' },
  },
  ToolsController: {
    list: { path: '/', rule: 'visible' },
    getAnnotations: { path: ':toolId/annotations', rule: 'visible-then-owner' },
    getResponseMapping: { path: ':toolId/response-mapping', rule: 'visible-then-owner' },
  },
  // File Search detail describes the source beyond what the tools return
  // (address, every folder and file, role rules): restricted members reach
  // it only for a connector they own, even one shared with them.
  FileSearchController: {
    capabilities: { path: 'capabilities', rule: 'no-connector-data' },
    getPolicy: { path: 'policy', rule: 'no-connector-data' },
    overview: { path: 'connectors/:id', rule: 'owned' },
    getScan: { path: 'connectors/:id/scans/:scanId', rule: 'owned' },
    tree: { path: 'connectors/:id/tree', rule: 'owned' },
    problems: { path: 'connectors/:id/problems', rule: 'owned' },
    runs: { path: 'connectors/:id/runs', rule: 'owned' },
    getRules: { path: 'connectors/:id/access-rules', rule: 'owned' },
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
    { id: 'srv-mine', userId: ME, organizationId: ORG, connectorIds: ['mine'] },
    // Another member's server holding the caller's own connector.
    { id: 'srv-team', userId: OTHER, organizationId: ORG, connectorIds: ['mine'] },
  ];
  connectors.find((c) => c.id === 'shared')!.mcpServers = [{ mcpServerId: 'srv-shared' }, { mcpServerId: 'srv-hidden' }];
  connectors.find((c) => c.id === 'mine')!.mcpServers = [{ mcpServerId: 'srv-mine' }, { mcpServerId: 'srv-team' }];
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
  'ConnectorsController.getLoginTokenConfig': (c, role, id) => c.connectors.getLoginTokenConfig(req(role), id),
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
  // POST :id/test is owner-or-admin: a hidden connector must answer the 404
  // of an unknown id, not the 403 that says "it exists, but it is not yours".
  'ConnectorsController.test': (c, role, id) => c.connectors.test(req(role), id),
  'FileSearchController.syncNow': (c, role, id) => c.fs.syncNow(req(role), id),
};

const NOT_GET_BY_ID: Record<string, Rule> = {
  'ConnectorsController.deleteMyCredential': 'visible',
  'ConnectorsController.initiateOAuth': 'visible',
  'ConnectorsController.test': 'visible-then-owner',
  'FileSearchController.syncNow': 'owned',
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
        .filter(([, r]) => ['visible', 'visible-then-owner', 'owned', 'full-view'].includes(r.rule))
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
const OWNED = ['mine', 'fsMine'];

describe.each(['open', 'restricted'] as const)('%s workspace', (mode) => {
  describe.each(CASES)('$name', ({ allowed, visible: restrictedVisible }) => {
    describe.each(['ADMIN', 'EDITOR', 'VIEWER'])('%s', (role) => {
      const restricted = mode === 'restricted' && role !== 'ADMIN';
      // A restricted VIEWER owns 'mine' and 'fsMine' only from an earlier
      // role: owning shows nothing more than their roles allow (and neither
      // holds an allowed tool).
      const ownerSees = !(restricted && role === 'VIEWER');
      const owned = ownerSees ? OWNED : [];
      const visible = !restricted
        ? ALL_IN_ORG
        : ownerSees || allowed === null
          ? restrictedVisible
          : restrictedVisible.filter((id) => !OWNED.includes(id));
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
        if (mine) expect(mine.tools.map((t: any) => t.id)).toEqual(['m1', 'm2']);
        // The reduced view of a connector the member does not own carries no workspace id.
        const reduced = rows.filter((r) => r.memberView);
        expect(reduced.map((r) => r.id).sort()).toEqual(restricted ? visible.filter((id) => !owned.includes(id)).sort() : []);
        expect(rows.filter((r) => !r.memberView).every((r) => r.organizationId === ORG)).toBe(true);
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
        // The fixture's test answers "ok"; a member who does not own the
        // connector gets the fixed sentence instead.
        for (const row of out.connectors) {
          expect(row.message).toBe(restricted && !owned.includes(row.id) ? 'Connection successful' : 'ok');
        }
      });

      it('GET /api/connectors/export-all exports owned connectors only for a restricted member', async () => {
        const out: any = await c.connectors.exportAll(req(role));
        const expected = restricted ? owned : ALL_IN_ORG;
        expect(out.connectors.map((e: any) => e.name).sort()).toEqual([...expected].sort());
      });

      it('GET /api/connectors/:id names only MCP servers the caller can see', async () => {
        // The caller's own connector: restricted, only the servers they own
        // hold it as far as they can tell; otherwise every server that does.
        const ownGot = await outcome(c.connectors.findOne(req(role), 'mine'));
        if (!visible.includes('mine')) {
          expect(ownGot.ok).toBe(false);
        } else if (!ownerSees) {
          // A viewer's own connector: the reduced view, naming no server.
          expect((ownGot as any).value.memberView).toBe(true);
          expect((ownGot as any).value).not.toHaveProperty('mcpServers');
        } else {
          expect((ownGot as any).value.mcpServers).toEqual(
            restricted ? [{ mcpServerId: 'srv-mine' }] : [{ mcpServerId: 'srv-mine' }, { mcpServerId: 'srv-team' }],
          );
        }
        const got = await outcome(c.connectors.findOne(req(role), 'shared'));
        if (!visible.includes('shared')) {
          expect(got.ok).toBe(false);
          return;
        }
        expect(got.ok).toBe(true);
        const value = (got as any).value;
        expect(value.tools.map((t: any) => t.id)).toEqual(restricted && allowed !== null ? ['s1'] : ['s1', 's2']);
        if (restricted) {
          // Not the caller's connector: the reduced view names no server.
          expect(value.memberView).toBe(true);
          expect(value).not.toHaveProperty('mcpServers');
          return;
        }
        // srv-hidden holds `shared` too, so the servers rule keeps it.
        expect(value.mcpServers.map((s: any) => s.mcpServerId).sort()).toEqual(['srv-hidden', 'srv-shared']);
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
        const ownGot = await outcome(c.tools.list(req(role), 'mine'));
        if (visible.includes('mine')) {
          expect(((ownGot as any).value as any[]).map((t) => t.id).sort()).toEqual(['m1', 'm2']);
        } else {
          expect((ownGot as any).error).toBeInstanceOf(NotFoundException);
        }
      });

      describe.each(Object.keys(BY_ID))('%s', (route) => {
        const [ctrl, method] = route.split('.');
        const rule: Rule = RULES[ctrl]?.[method]?.rule ?? NOT_GET_BY_ID[route];
        const ids = idsFor(route);

        it('owned connector: allowed (owner-or-admin routes included)', async () => {
          if (!ownerSees) {
            // A restricted VIEWER: their own connector is like another
            // member's (see the two cases below).
            return expectOthers(ids.owned);
          }
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
          if (hidden || ((rule === 'owned' || rule === 'full-view') && restricted)) {
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

// ── 4. Reduced view ───────────────────────────────────────────────────────

/** Values that must never reach a restricted member who does not own the connector. */
const INTERNALS = {
  baseUrl: 'postgresql://report_user@db.internal.example.invalid:5432/ledger',
  specUrl: 'https://specs.internal.example.invalid/openapi.json',
  healthcheckPath: '/internal-health',
  headers: { 'X-Tenant': 'tenant-4711' },
  envVars: { REGION: 'eu-private-1', LEDGER_API_KEY: 'sk_live_abcdefgh12345678' },
  config: { readOnly: true, deniedTables: ['salaries'] },
  instructions: 'Ledger of the finance team. Never post to closed periods.',
  authStatus: 'needs_reauth',
  authStatusCode: 'refresh_refused',
  authStatusMessage: 'idp.internal.example.invalid refused the refresh token of report_user',
  authStatusAt: new Date(Date.UTC(2026, 0, 2)),
  authStatusRef: 'ref-hash',
  tokenExpiresAt: new Date(Date.UTC(2026, 5, 1)),
  webhookEnabled: true,
  webhookProvider: 'stripe',
  webhookSecret: 'whsec_fixture',
  updatedAt: new Date(Date.UTC(2026, 0, 3)),
};
const TOOL_INTERNALS = {
  parameters: { type: 'object', properties: { period: { type: 'string', default: '2026-01' } } },
  endpointMapping: { method: 'QUERY', path: 'SELECT account, amount FROM ledger_entries WHERE period = $period' },
  responseMapping: { transform: { pick: ['account'] } },
  annotations: { readOnlyHint: true },
  outputSchema: { type: 'object' },
  useProxy: true,
  operationId: 'listLedger',
  origin: 'user',
};
/** Strings of INTERNALS and TOOL_INTERNALS: none may appear anywhere in a reduced answer. */
const LEAKS = [
  'db.internal.example.invalid',
  'report_user',
  'ledger_entries',
  'specs.internal',
  'internal-health',
  'tenant-4711',
  'eu-private-1',
  'LEDGER_API_KEY',
  'sk_live',
  'salaries',
  'finance team',
  'idp.internal',
  'whsec',
  'listLedger',
  '2026-01"',
];

/** `shared` (another member's, tool s1 allowed) as a database connector full of settings. */
function buildRich(opts: Parameters<typeof build>[0]) {
  const c = build(opts);
  const shared = c.w.connectors.find((x) => x.id === 'shared')!;
  Object.assign(shared, { type: 'DATABASE', ...INTERNALS });
  for (const tool of shared.tools) Object.assign(tool, TOOL_INTERNALS);
  return c;
}

const CONNECTOR_KEYS = [...MEMBER_CONNECTOR_FIELDS, 'memberView', 'tools'].sort();
const TOOL_KEYS = [...MEMBER_TOOL_FIELDS].sort();
/** What the member reads of `shared`, whole. */
const reducedShared = (toolIds: string[]) => ({
  id: 'shared',
  name: 'shared',
  type: 'DATABASE',
  icon: null,
  isActive: true,
  credentialScope: 'USER',
  setupStatus: 'ready',
  authStatus: 'needs_reauth',
  authStatusCode: 'refresh_refused',
  memberView: true,
  tools: toolIds.map((id) => ({ id, name: `shared_${id}`, description: 'fixture', isEnabled: true })),
});

function expectNoLeak(body: unknown) {
  const text = JSON.stringify(body);
  for (const leak of LEAKS) expect(text).not.toContain(leak);
}

describe('reduced view of a connector the restricted member does not own', () => {
  it('the allowlist is what this spec expects (a new field must be added here on purpose)', () => {
    expect([...MEMBER_CONNECTOR_FIELDS]).toEqual([
      'id',
      'name',
      'type',
      'icon',
      'isActive',
      'credentialScope',
      'setupStatus',
      'authStatus',
      'authStatusCode',
    ]);
    expect([...MEMBER_TOOL_FIELDS]).toEqual(['id', 'name', 'description', 'isEnabled']);
  });

  describe.each(['EDITOR', 'VIEWER'])('%s', (role) => {
    it('GET /api/connectors: exactly the allowlisted keys, with the allowed tools only', async () => {
      const c = buildRich({ mode: 'restricted', allowed: ['s1'] });
      const rows = (await c.connectors.list(req(role), {} as any)) as any[];
      const shared = rows.find((r) => r.id === 'shared');
      expect(Object.keys(shared).sort()).toEqual(CONNECTOR_KEYS);
      expect(shared.tools.map((t: any) => Object.keys(t).sort())).toEqual([TOOL_KEYS]);
      expect(shared).toEqual(reducedShared(['s1']));
      for (const key of ['baseUrl', 'config', 'envVars', 'maskedEnvVars', 'headers', 'maskedHeaders', 'instructions', 'specUrl', 'authType', 'missingVariables', 'authStatusMessage', 'webhookEnabled', 'webhookProvider', 'userId', 'organizationId']) {
        expect(shared).not.toHaveProperty(key);
      }
      for (const key of ['endpointMapping', 'parameters', 'responseMapping', 'annotations', 'outputSchema']) {
        expect(shared.tools[0]).not.toHaveProperty(key);
      }
      expectNoLeak(rows);
    });

    it('GET /api/connectors/:id: the same reduced view, without the MCP servers', async () => {
      const c = buildRich({ mode: 'restricted', allowed: ['s1'] });
      const detail: any = await c.connectors.findOne(req(role), 'shared');
      expect(Object.keys(detail).sort()).toEqual(CONNECTOR_KEYS);
      expect(detail).toEqual(reducedShared(['s1']));
      for (const key of ['baseUrl', 'config', 'envVars', 'headers', 'instructions', 'mcpServers', 'resources', 'prompts']) {
        expect(detail).not.toHaveProperty(key);
      }
      expect(detail.tools[0]).not.toHaveProperty('endpointMapping');
      expectNoLeak(detail);
      // No server lookup is needed for a view that names no server.
      expect(c.prisma.mcpServerConfig.findMany).not.toHaveBeenCalled();
    });

    it('GET /api/connectors/:connectorId/tools: id, name, description and isEnabled of the allowed tools', async () => {
      const c = buildRich({ mode: 'restricted', allowed: ['s1'] });
      const tools = (await c.tools.list(req(role), 'shared')) as any[];
      expect(tools).toEqual([{ id: 's1', name: 'shared_s1', description: 'fixture', isEnabled: true }]);
      expect(Object.keys(tools[0]).sort()).toEqual(TOOL_KEYS);
      expect(tools[0]).not.toHaveProperty('endpointMapping');
      expectNoLeak(tools);
    });

    it('without a tool whitelist the member sees every tool, still reduced', async () => {
      const c = buildRich({ mode: 'restricted', allowed: null });
      const rows = (await c.connectors.list(req(role), {} as any)) as any[];
      expect(rows.find((r) => r.id === 'shared')).toEqual(reducedShared(['s1', 's2']));
      expect(await c.connectors.findOne(req(role), 'shared')).toEqual(reducedShared(['s1', 's2']));
      const tools = (await c.tools.list(req(role), 'shared')) as any[];
      expect(tools.map((t) => Object.keys(t).sort())).toEqual([TOOL_KEYS, TOOL_KEYS]);
      expectNoLeak([rows, tools]);
    });

    it('GET /api/connectors/health-check: the status, not the provider’s words', async () => {
      const c = buildRich({ mode: 'restricted', allowed: ['s1', 'f1'] });
      (c.connectorsService.testConnection as jest.Mock).mockResolvedValue({
        ok: false,
        message: 'connect ECONNREFUSED db.internal.example.invalid:5432',
      });
      const out: any = await c.connectors.healthCheck(req(role));
      const byId = Object.fromEntries(out.connectors.map((r: any) => [r.id, r]));
      // `shared` carries a refused credential: reported without a call.
      expect(byId.shared).toEqual({
        id: 'shared',
        name: 'shared',
        type: 'DATABASE',
        status: 'needs_reauth',
        message: 'The provider refused the credential. The connector owner or a workspace admin has to authorize again.',
        latencyMs: 0,
      });
      expect(byId.fs.status).toBe('unhealthy');
      expect(byId.fs.message).toBe('Connection failed. The connector owner or a workspace admin can see why.');
      // Their own connector: the real message, for an editor. A viewer's own
      // connector holds no allowed tool, so it is not checked at all.
      if (role === 'EDITOR') expect(byId.mine.message).toBe('connect ECONNREFUSED db.internal.example.invalid:5432');
      else expect(byId.mine).toBeUndefined();
      expectNoLeak([byId.shared, byId.fs]);
    });

    it('GET /api/connectors/:id/oauth-config: 404 like a hidden connector, although it is in the list', async () => {
      const c = buildRich({ mode: 'restricted', allowed: ['s1'] });
      const got = await outcome(c.connectors.getOAuthConfig(req(role), 'shared'));
      expect((got as any).error).toBeInstanceOf(NotFoundException);
      expect((got as any).error.getResponse()).toEqual(await hiddenIdBody(c, 'ConnectorsController.getOAuthConfig', 'shared'));
      if (role === 'EDITOR') {
        await expect(c.connectors.getOAuthConfig(req(role), 'mine')).resolves.toMatchObject({ grant: 'authorization_code' });
      } else {
        await expect(c.connectors.getOAuthConfig(req(role), 'mine')).rejects.toBeInstanceOf(NotFoundException);
      }
    });

    it('per-user sign-in still works on a connector read in the reduced view', async () => {
      const c = buildRich({ mode: 'restricted', allowed: ['s1'] });
      const detail: any = await c.connectors.findOne(req(role), 'shared');
      expect(detail.credentialScope).toBe('USER');
      await expect(c.connectors.getMyCredential(req(role), 'shared')).resolves.toEqual({ connected: true, available: true });
      c.w.connectors.find((x) => x.id === 'shared')!.authType = 'OAUTH2';
      await expect(c.connectors.initiateOAuth(req(role), 'shared', {})).resolves.toEqual({
        authorizationUrl: 'https://idp.example.invalid/authorize',
      });
    });

    it('their own connector comes back in full, exactly as an admin reads it', async () => {
      if (role === 'VIEWER') return; // see the VIEWER case below
      const member = buildRich({ mode: 'restricted', allowed: ['s1'] });
      const admin = buildRich({ mode: 'restricted', allowed: ['s1'] });
      const text = async (c: Ctx, r: string) =>
        JSON.stringify([
          ((await c.connectors.list(req(r), {} as any)) as any[]).find((x) => x.id === 'mine'),
          await c.tools.list(req(r), 'mine'),
        ]);
      const own = await text(member, role);
      expect(own).toBe(await text(admin, 'ADMIN'));
      // The detail too, except for the MCP servers holding it: another
      // member's server is not named to a restricted member.
      const memberDetail: any = await member.connectors.findOne(req(role), 'mine');
      const adminDetail: any = await admin.connectors.findOne(req('ADMIN'), 'mine');
      expect(adminDetail.mcpServers).toEqual([{ mcpServerId: 'srv-mine' }, { mcpServerId: 'srv-team' }]);
      expect(memberDetail).toEqual({ ...adminDetail, mcpServers: [{ mcpServerId: 'srv-mine' }] });
      expect(own).toContain('"baseUrl":"https://api.example.invalid"');
      expect(own).toContain('"endpointMapping"');
      expect(own).not.toContain('memberView');
    });
  });

  describe('a VIEWER who owns connectors from an earlier role', () => {
    it('sees their own connector only through their roles, and then in the reduced view', async () => {
      const hidden = buildRich({ mode: 'restricted', allowed: ['s1'] });
      expect(((await hidden.connectors.list(req('VIEWER'), {} as any)) as any[]).map((r) => r.id)).not.toContain('mine');
      await expect(hidden.connectors.findOne(req('VIEWER'), 'mine')).rejects.toBeInstanceOf(NotFoundException);
      await expect(hidden.connectors.exportOne(req('VIEWER'), 'mine', 'json', res())).rejects.toBeInstanceOf(NotFoundException);
      expect(((await hidden.connectors.exportAll(req('VIEWER'))) as any).connectors).toEqual([]);

      const shared = buildRich({ mode: 'restricted', allowed: ['m1'] });
      const row = ((await shared.connectors.list(req('VIEWER'), {} as any)) as any[]).find((r) => r.id === 'mine');
      expect(row.memberView).toBe(true);
      expect(row.tools.map((t: any) => t.id)).toEqual(['m1']);
      for (const key of Object.keys(row)) expect([...CONNECTOR_KEYS]).toContain(key);
      expect(row).not.toHaveProperty('baseUrl');
      await expect(shared.connectors.getOAuthConfig(req('VIEWER'), 'mine')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('annotations and response mapping of a tool outside the member’s roles', () => {
    const ROUTES: Array<[string, (c: Ctx, role: string, toolId: string, connectorId?: string) => Promise<unknown>]> = [
      ['ToolsController.getAnnotations', (c, role, toolId, connectorId = 'shared') => c.tools.getAnnotations(req(role), toolId, connectorId)],
      ['ToolsController.getResponseMapping', (c, role, toolId, connectorId = 'shared') => c.tools.getResponseMapping(req(role), toolId, connectorId)],
    ];

    it.each(ROUTES)('%s: the 404 of a hidden connector, before any tool is read', async (route, call) => {
      for (const role of ['EDITOR', 'VIEWER']) {
        const c = buildRich({ mode: 'restricted', allowed: ['s1'] });
        // s2 exists on the visible connector but is outside the role; the last id does not exist at all.
        for (const toolId of ['s2', 'no-such-tool']) {
          const got = await outcome(call(c, role, toolId));
          expect((got as any).error).toBeInstanceOf(NotFoundException);
          expect((got as any).error.getResponse()).toEqual(await hiddenIdBody(c, route, 'shared'));
        }
        expect(c.prisma.reads).not.toContain('mcpTool.findFirst');
        // A tool inside the role: today's owner-or-admin answer, as before.
        const allowedTool = await outcome(call(c, role, 's1'));
        expect((allowedTool as any).error).toBeInstanceOf(ForbiddenException);
      }
    });

    it.each(ROUTES)('%s: owners, admins, open workspaces and workspaces without a whitelist are not affected', async (_route, call) => {
      // The owner reads every tool of their connector, whatever their roles allow.
      const owner = buildRich({ mode: 'restricted', allowed: ['s1'] });
      await expect(call(owner, 'EDITOR', 'm2', 'mine')).resolves.toBeDefined();
      // An admin is never restricted.
      await expect(call(buildRich({ mode: 'restricted', allowed: ['s1'] }), 'ADMIN', 's2')).resolves.toBeDefined();
      // Open workspace, and restricted without a whitelist: today's 403 for a member who is not the owner.
      for (const opts of [{ mode: 'open' as const, allowed: ['s1'] }, { mode: 'restricted' as const, allowed: null }]) {
        const got = await outcome(call(buildRich(opts), 'EDITOR', 's2'));
        expect((got as any).error).toBeInstanceOf(ForbiddenException);
      }
    });
  });
});

/**
 * `shared` as every caller read it before the reduced view existed, key order
 * included: the stored row without authConfig, authStatusRef and
 * webhookSecret, its secret variable emptied and named in `maskedEnvVars`,
 * then the adapter icon and the setup state.
 */
const fullTool = (id: string) => ({
  id,
  connectorId: 'shared',
  name: `shared_${id}`,
  description: 'fixture',
  isEnabled: true,
  parameters: TOOL_INTERNALS.parameters,
  endpointMapping: TOOL_INTERNALS.endpointMapping,
  responseMapping: TOOL_INTERNALS.responseMapping,
  annotations: TOOL_INTERNALS.annotations,
  outputSchema: TOOL_INTERNALS.outputSchema,
  createdAt: '2026-01-01T00:00:00.000Z',
  useProxy: true,
  operationId: 'listLedger',
  origin: 'user',
});
const fullShared = () => ({
  id: 'shared',
  userId: OTHER,
  organizationId: ORG,
  name: 'shared',
  type: 'DATABASE',
  baseUrl: INTERNALS.baseUrl,
  authType: 'NONE',
  authStatus: 'needs_reauth',
  specUrl: INTERNALS.specUrl,
  headers: INTERNALS.headers,
  envVars: { REGION: 'eu-private-1', LEDGER_API_KEY: '' },
  config: INTERNALS.config,
  credentialScope: 'USER',
  isActive: true,
  createdAt: '2026-01-01T00:02:00.000Z',
  tools: ['s1', 's2'].map(fullTool),
  resources: [],
  prompts: [],
  mcpServers: [{ mcpServerId: 'srv-shared' }, { mcpServerId: 'srv-hidden' }],
  healthcheckPath: INTERNALS.healthcheckPath,
  instructions: INTERNALS.instructions,
  authStatusCode: 'refresh_refused',
  authStatusMessage: INTERNALS.authStatusMessage,
  authStatusAt: '2026-01-02T00:00:00.000Z',
  tokenExpiresAt: '2026-06-01T00:00:00.000Z',
  webhookEnabled: true,
  webhookProvider: 'stripe',
  updatedAt: '2026-01-03T00:00:00.000Z',
  icon: null,
  maskedEnvVars: ['LEDGER_API_KEY'],
  maskedHeaders: [],
  setupStatus: 'ready',
  missingVariables: [],
});

describe('callers who keep the full view read byte for byte what they read before', () => {
  const CALLERS: Array<[string, 'open' | 'restricted', string]> = [
    ['open workspace, ADMIN', 'open', 'ADMIN'],
    ['open workspace, EDITOR', 'open', 'EDITOR'],
    ['open workspace, VIEWER', 'open', 'VIEWER'],
    ['restricted workspace, ADMIN', 'restricted', 'ADMIN'],
  ];

  describe.each(CALLERS)('%s', (_name, mode, role) => {
    it.each(CASES)('$name: list, detail and tools of another member’s connector', async ({ allowed }) => {
      const c = buildRich({ mode, allowed });
      const rows = (await c.connectors.list(req(role), {} as any)) as any[];
      const full = JSON.stringify(fullShared());
      expect(JSON.stringify(rows.find((r) => r.id === 'shared'))).toBe(full);
      expect(JSON.stringify(await c.connectors.findOne(req(role), 'shared'))).toBe(full);
      expect(JSON.stringify(await c.tools.list(req(role), 'shared'))).toBe(JSON.stringify(['s1', 's2'].map(fullTool)));
      expect(rows.some((r) => 'memberView' in r)).toBe(false);
    });

    it('health check: the provider’s own message', async () => {
      const c = buildRich({ mode, allowed: ['s1'] });
      const out: any = await c.connectors.healthCheck(req(role));
      expect(out.connectors.find((r: any) => r.id === 'shared')).toEqual({
        id: 'shared',
        name: 'shared',
        type: 'DATABASE',
        status: 'needs_reauth',
        message: INTERNALS.authStatusMessage,
        latencyMs: 0,
      });
      expect(out.connectors.find((r: any) => r.id === 'hidden').message).toBe('ok');
    });

    it('OAuth settings of another member’s connector: readable, as before', async () => {
      const c = buildRich({ mode, allowed: ['s1'] });
      await expect(c.connectors.getOAuthConfig(req(role), 'shared')).resolves.toEqual({
        clientId: '',
        grant: 'authorization_code',
        authorizationUrl: '',
        tokenUrl: '',
        scopes: '',
        tokenAuthMethod: 'client_secret_post',
        pkce: true,
        hasClientSecret: false,
        hasUsername: false,
        hasPassword: false,
        hasAccessToken: false,
        hasRefreshToken: false,
      });
    });
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

describe('restricted member: a DATABASE password stays masked (#1245)', () => {
  const STORED = 'postgresql://app:s3cret@db.example.invalid:5432/shop';
  const restrictedDb = () => {
    const c = build({ mode: 'restricted', allowed: ['s1'] });
    Object.assign(c.w.connectors.find((x) => x.id === 'mine')!, { type: 'DATABASE', baseUrl: STORED });
    return c;
  };

  it.each([
    ['GET /api/connectors', (c: Ctx) => c.connectors.list(req('EDITOR'), {} as any)],
    ['GET /api/connectors/:id', (c: Ctx) => c.connectors.findOne(req('EDITOR'), 'mine')],
    ['GET /api/connectors/export-all', (c: Ctx) => c.connectors.exportAll(req('EDITOR'))],
    ['GET /api/connectors/:id/export', (c: Ctx) => c.connectors.exportOne(req('EDITOR'), 'mine', 'json', res())],
  ])('%s', async (_route, call) => {
    const body = JSON.stringify(await call(restrictedDb()));
    expect(body).toContain('app:********@db.example.invalid');
    expect(body).not.toContain('s3cret');
  });
});
