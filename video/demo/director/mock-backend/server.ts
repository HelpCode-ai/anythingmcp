/**
 * Stand-in for the AnythingMCP backend while the web-app scenes are recorded.
 *
 * The production frontend build rewrites /api/* and /health/* here
 * (BACKEND_INTERNAL_URL=http://127.0.0.1:4100). It answers as the Lumen & Clay
 * workspace on AnythingMCP Cloud, keeps state while a scene runs (a connector
 * installed on camera shows up on the next page), and can be reset to the
 * starting point of each scene:
 *
 *   curl -X POST 127.0.0.1:4100/__demo/stage/etsy      (etsy | sap | openapi | all)
 *
 * Tool lists come from tools.snapshot.json / adapters.snapshot.json, written
 * by snapshot-tools.ts from the product's own code.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogRows } from '../../fixtures/sap';
import { COMPANY } from '../../fixtures/products';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_BACKEND_PORT ?? 4100);
const TOOLS = JSON.parse(readFileSync(path.join(HERE, 'tools.snapshot.json'), 'utf8'));
const ADAPTERS = JSON.parse(readFileSync(path.join(HERE, 'adapters.snapshot.json'), 'utf8'));

/** What the demo shows as hosts. The real cloud connectors point at the Worker. */
export const DISPLAY = {
  etsyBase: 'https://openapi.etsy.com/v3/application',
  sapBase: 'https://s4.lumenandclay.com',
  logisticsBase: 'https://api.lumenandclay.com/logistics/v1',
  logisticsSpec: 'https://api.lumenandclay.com/logistics/openapi.json',
};

const ORG = { id: 'org_lumen', name: COMPANY.name, createdAt: '2026-03-02T09:14:00.000Z' };
const USER = {
  id: 'usr_alex',
  email: COMPANY.ownerEmail,
  name: COMPANY.ownerName,
  role: 'ADMIN',
  organizationId: ORG.id,
  emailVerified: true,
  createdAt: '2026-03-02T09:14:00.000Z',
};

type Json = Record<string, any>;

let seq = 1;
const id = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

function toolsFrom(list: Json[], connectorId: string): Json[] {
  return list.map((t, i) => ({
    id: `${connectorId}_t${i}`,
    connectorId,
    name: t.name,
    description: t.description,
    isEnabled: true,
    useProxy: false,
    parameters: t.parameters,
    endpointMapping: t.endpointMapping,
    responseMapping: null,
    deprecatedAt: null,
    createdAt: new Date().toISOString(),
  }));
}

function connector(fields: Json): Json {
  return {
    id: fields.id ?? id('cmc'),
    name: fields.name,
    type: fields.type ?? 'REST',
    baseUrl: fields.baseUrl ?? '',
    healthcheckPath: fields.healthcheckPath ?? null,
    isActive: true,
    authType: fields.authType ?? 'NONE',
    instructions: fields.instructions ?? null,
    icon: fields.icon ?? null,
    specUrl: fields.specUrl ?? null,
    config: fields.config ?? {},
    headers: fields.headers ?? null,
    envVars: fields.envVars ?? {},
    maskedEnvVars: fields.maskedEnvVars ?? [],
    maskedHeaders: [],
    createdAt: fields.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tools: [] as Json[],
  };
}

function etsyConnector(): Json {
  const c = connector({
    id: 'cmc_etsy',
    name: 'Etsy',
    baseUrl: DISPLAY.etsyBase,
    healthcheckPath: '/openapi-ping',
    authType: 'OAUTH2',
    icon: 'etsy',
    instructions: ADAPTERS.etsy.instructions,
    config: { adapterSlug: 'etsy' },
    envVars: { ETSY_CLIENT_ID: '', ETSY_CLIENT_SECRET: '', ETSY_REFRESH_TOKEN: '' },
    maskedEnvVars: ['ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET'],
  });
  c.tools = toolsFrom(TOOLS.etsy.tools, c.id);
  return c;
}

function sapConnector(fields: Json = {}): Json {
  const c = connector({
    id: 'cmc_sap',
    name: 'SAP S/4HANA',
    type: 'ODATA',
    baseUrl: DISPLAY.sapBase,
    authType: 'BASIC',
    icon: null,
    config: { odata: { sap: true, sapClient: '100', sapLanguage: 'EN', toolPrefix: 's4' } },
    ...fields,
  });
  c.tools = toolsFrom(TOOLS.sap.tools, c.id);
  return c;
}

function logisticsConnector(): Json {
  const c = connector({
    id: 'cmc_logistics',
    name: 'Lumen Logistics API',
    baseUrl: DISPLAY.logisticsBase,
    authType: 'API_KEY',
    specUrl: DISPLAY.logisticsSpec,
  });
  c.tools = toolsFrom(TOOLS.logistics.tools, c.id);
  return c;
}

interface State {
  connectors: Json[];
  servers: Json[];
}

let state: State;

function stage(name: string): void {
  const connectors: Json[] = [];
  if (name !== 'etsy') connectors.push(etsyConnector());
  if (name === 'openapi' || name === 'all') connectors.push(sapConnector());
  if (name === 'all') connectors.push(logisticsConnector());
  state = {
    connectors,
    servers: [
      {
        id: 'srv_lumen',
        userId: USER.id,
        organizationId: ORG.id,
        name: 'Lumen & Clay',
        slug: 'lumen-clay',
        description: 'Shop, ERP and shipping for Claude',
        version: '1.0.0',
        isActive: true,
        instructions: null,
        createdAt: '2026-03-02T09:20:00.000Z',
        updatedAt: new Date().toISOString(),
        connectorIds: connectors.map((c) => c.id),
        apiKeys: [],
        usage: { calls30d: name === 'etsy' ? 0 : 214, lastCallAt: name === 'etsy' ? null : new Date(Date.now() - 36e5).toISOString() },
      },
    ],
  };
  console.log(`[mock] stage ${name}: ${connectors.map((c) => c.name).join(', ') || 'no connectors'}`);
}
stage(process.env.DEMO_STAGE ?? 'etsy');

const serverView = (s: Json, full = false) => {
  const conns = state.connectors.filter((c) => s.connectorIds.includes(c.id));
  const base = {
    ...s,
    connectorIds: undefined,
    _count: { connectors: conns.length, apiKeys: s.apiKeys.length },
  };
  return full
    ? {
        ...base,
        connectors: conns.map((c) => ({
          id: `${s.id}_${c.id}`,
          mcpServerId: s.id,
          connectorId: c.id,
          connector: { id: c.id, name: c.name, type: c.type, isActive: true },
        })),
      }
    : { ...base, connectors: conns.map((c) => ({ connector: { name: c.name } })) };
};

const connectorView = (c: Json) => ({
  ...c,
  mcpServers: state.servers.filter((s) => s.connectorIds.includes(c.id)).map((s) => ({ mcpServerId: s.id })),
});

function adapterDetail(slug: string): Json | null {
  if (slug === 'etsy') return { ...ADAPTERS.list.find((a: Json) => a.slug === 'etsy'), ...ADAPTERS.etsy };
  const meta = ADAPTERS.list.find((a: Json) => a.slug === slug);
  return meta ? { ...meta, connector: { name: meta.name, type: 'REST', authType: meta.authType }, tools: [] } : null;
}

async function body(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** Pause like a real backend would, so spinners and "Testing…" states are visible. */
const think = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Handler = (m: RegExpMatchArray, req: http.IncomingMessage, url: URL) => Promise<unknown> | unknown;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`), h]);

/* ---------------- shell ---------------- */
on('GET', '/health/server-info', () => ({
  mcpAuthMode: 'oauth2',
  serverUrl: 'https://cloud.anythingmcp.com',
  mcpEndpoint: '/mcp',
  deploymentMode: 'cloud',
  hasUsers: true,
  registrationEnabled: true,
  ssoProviders: [],
  oauthEndpoints: {
    wellKnown: '/.well-known/oauth-authorization-server',
    authorize: '/authorize',
    token: '/token',
    register: '/register',
  },
}));
on('GET', '/api/users/me', () => USER);
on('GET', '/api/users/me/onboarding-state', () => ({
  id: USER.id,
  emailVerified: true,
  createdAt: USER.createdAt,
  onboardingCompletedAt: '2026-03-02T09:30:00.000Z',
  onboardingLastReminderAt: null,
  onboardingReminderCount: 0,
  emailMarketingOptOut: false,
}));
on('PATCH', '/api/users/me/onboarding-state', () => ({ id: USER.id, onboardingCompletedAt: '2026-03-02T09:30:00.000Z' }));
on('GET', '/api/organizations/current', () => ORG);
on('GET', '/api/organizations/mine', () => [{ ...ORG, role: 'ADMIN', joinedAt: ORG.createdAt }]);
on('GET', '/api/license/status', () => ({
  plan: 'business',
  status: 'active',
  features: {},
  expiresAt: '2027-03-02T00:00:00.000Z',
  lastVerifiedAt: new Date().toISOString(),
  instanceId: 'cloud',
}));
on('GET', '/api/license/usage', () => ({
  plan: 'business',
  connectors: { current: state.connectors.length, max: 50, isOver: false },
  mcpServers: { current: state.servers.length, max: 20, isOver: false },
  users: { current: 3, max: 25, isOver: false },
  isOverAny: false,
}));
on('GET', '/api/license/edition', () => ({}));
on('GET', '/api/auth/attribution/click-ids', () => ({}));
on('GET', '/api/site-settings/footer-links', () => []);
on('POST', '/api/product-events', () => null);
on('GET', '/api/audit/stats', () => ({ invocations24h: 214, errors24h: 0 }));
on('GET', '/api/audit/analytics', () => ({ daily: [], topTools: [], totalInvocations: 214, successRate: 100, avgDuration: 312 }));

/* ---------------- marketplace ---------------- */
on('GET', '/api/adapters', () => ADAPTERS.list);
on('GET', '/api/adapters/:slug', (m) => adapterDetail(m[1]) ?? { __status: 404, message: 'Adapter not found' });
on('POST', '/api/adapters/:slug/import', async (m) => {
  await think(900);
  if (m[1] !== 'etsy') return { __status: 400, message: 'Only Etsy is part of this demo.' };
  const c = etsyConnector();
  state.connectors = state.connectors.filter((x) => x.id !== c.id).concat(c);
  return {
    message: `Adapter "etsy" imported successfully with ${c.tools.length} tools.`,
    connectorId: c.id,
    toolsCreated: c.tools.length,
    attachedToServer: null,
    probe: null,
  };
});

/* ---------------- connectors ---------------- */
on('GET', '/api/connectors', () => state.connectors.map(connectorView));
on('GET', '/api/connectors/proxy-availability', () => ({ available: false }));
on('GET', '/api/connectors/health-check', () => ({
  total: state.connectors.length,
  healthy: state.connectors.length,
  unhealthy: 0,
  connectors: state.connectors.map((c) => ({ id: c.id, name: c.name, type: c.type, status: 'healthy', message: 'OK', latencyMs: 180 })),
}));
on('POST', '/api/connectors', async (_m, req) => {
  const b = await body(req);
  await think(400);
  let c: Json;
  if (b.type === 'ODATA') {
    c = sapConnector({
      id: id('cmc'),
      name: b.name || 'SAP S/4HANA',
      baseUrl: b.baseUrl || DISPLAY.sapBase,
      authType: b.authType ?? 'BASIC',
      config: { odata: { ...(b.config?.odata ?? {}), toolPrefix: 's4' } },
    });
  } else {
    c = connector({ ...b, id: id('cmc') });
  }
  state.connectors.push(c);
  const server = state.servers[0];
  if (server && !b.__temporary) server.connectorIds.push(c.id);
  return { ...connectorView(c), attachedToServer: server ? { id: server.id, name: server.name } : null };
});
on('GET', '/api/connectors/:id', (m) => {
  const c = state.connectors.find((x) => x.id === m[1]);
  return c ? connectorView(c) : { __status: 404, message: 'Connector not found' };
});
on('DELETE', '/api/connectors/:id', (m) => {
  state.connectors = state.connectors.filter((x) => x.id !== m[1]);
  for (const s of state.servers) s.connectorIds = s.connectorIds.filter((x: string) => x !== m[1]);
  return { message: 'Deleted' };
});
on('GET', '/api/connectors/:id/catalog-diff', () => ({ catalogManaged: false }));
on('GET', '/api/connectors/:id/oauth-config', () => ({
  clientId: 'lc8x2q••••',
  authorizationUrl: 'https://www.etsy.com/oauth/connect',
  tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
  scopes: 'email_r shops_r listings_r transactions_r',
  tokenAuthMethod: '',
  hasClientSecret: true,
  hasAccessToken: false,
  hasRefreshToken: false,
}));
on('POST', '/api/connectors/:id/oauth/authorize', (m) => ({
  // The recording skips Etsy's consent screen: the edit shows an
  // "Authorized with Etsy" card instead.
  authorizationUrl: `/connectors/${m[1]}?oauth=success&tools=0`,
}));
on('POST', '/api/connectors/:id/test', async (m) => {
  const c = state.connectors.find((x) => x.id === m[1]);
  await think(1100);
  if (c?.type === 'ODATA') {
    return { ok: true, kind: 'ok', message: `Connection successful — the SAP service catalog lists ${catalogRows('').length} services` };
  }
  return { ok: true, kind: 'ok', message: 'Connection successful' };
});
on('PUT', '/api/connectors/:id/env-vars', () => ({ warnings: [], maskedEnvVars: ['ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET'] }));
on('POST', '/api/connectors/:id/import-spec', async (m) => {
  await think(1400);
  const c = state.connectors.find((x) => x.id === m[1]);
  if (!c) return { error: 'Connector not found' };
  c.tools = toolsFrom(TOOLS.logistics.tools, c.id);
  return {
    message: `Imported tools: created ${c.tools.length}, updated 0`,
    tools: c.tools,
    created: c.tools.length,
    updated: 0,
    deprecated: [],
    skipped: [],
  };
});
on('POST', '/api/connectors/:id/tools/:toolId/test', async () => {
  await think(700);
  return { ok: true, durationMs: 412, result: { ok: true } };
});
on('GET', '/api/connectors/:id/tools/:toolId/annotations', () => ({ derived: {}, override: null, effective: {}, supportedKeys: [] }));

/* ---------------- MCP servers ---------------- */
on('GET', '/api/mcp-servers', () => state.servers.map((s) => serverView(s)));
on('POST', '/api/mcp-servers', async (_m, req) => {
  const b = await body(req);
  const s = {
    ...state.servers[0],
    id: id('srv'),
    name: b.name ?? 'New server',
    slug: String(b.name ?? 'new-server').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    description: b.description ?? null,
    connectorIds: [],
    apiKeys: [],
    usage: { calls30d: 0, lastCallAt: null },
  };
  state.servers.push(s);
  return serverView(s, true);
});
on('GET', '/api/mcp-servers/:id', (m) => {
  const s = state.servers.find((x) => x.id === m[1]);
  return s ? serverView(s, true) : { __status: 404, message: 'Not found' };
});
on('PUT', '/api/mcp-servers/:id/connectors', async (m, req) => {
  const b = await body(req);
  const s = state.servers.find((x) => x.id === m[1]);
  if (s) s.connectorIds = b.connectorIds ?? [];
  return { message: 'Connectors assigned' };
});
on('PUT', '/api/mcp-servers/:id', async (m, req) => {
  const b = await body(req);
  const s = state.servers.find((x) => x.id === m[1]);
  if (s) Object.assign(s, b);
  return s ? serverView(s, true) : null;
});
on('POST', '/api/mcp-keys', async (_m, req) => {
  const b = await body(req);
  return { id: id('key'), key: 'mcp_live_6f1c29a4d8e3b7', name: b.name, mcpServerId: b.mcpServerId };
});

/* ---------------- demo control ---------------- */
on('POST', '/__demo/stage/:name', (m) => {
  stage(m[1]);
  return { ok: true, stage: m[1] };
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = url.pathname.match(re);
    if (!match) continue;
    try {
      const out = (await h(match, req, url)) as Json | null | undefined;
      if (out === null || out === undefined) {
        res.writeHead(204).end();
        return;
      }
      const status = typeof out === 'object' && '__status' in out ? (out.__status as number) : 200;
      if (typeof out === 'object' && '__status' in out) delete out.__status;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (err) {
      console.error(`[mock] ${method} ${url.pathname} failed`, err);
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ message: String(err) }));
    }
    return;
  }
  console.warn(`[mock] UNHANDLED ${method} ${url.pathname}`);
  res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Not mocked' }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] backend on http://127.0.0.1:${PORT}`));
