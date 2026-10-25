import axios from 'axios';
import * as adapter from './browserbase.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Browserbase adapter:
 *
 *   1. Static: always runs. Pins the X-BB-API-Key header on
 *      api.browserbase.com/v1 and every tool's method, URL and body through
 *      the real RestEngine, checked on 15 Oct 2026 against the official
 *      Stainless SDK (browserbase/sdk-node src/resources: sessions,
 *      sessions/logs, sessions/replays, sessions/recording/downloads,
 *      contexts, extensions, projects, fetch-api, search; the SDK sends
 *      api_timeout as the body field `timeout`) and the API reference at
 *      docs.browserbase.com. The response shaping runs on fixtures built
 *      from the SDK's response types.
 *
 *   2. Live: skipped unless RUN_BROWSERBASE_LIVE=1. Without a key it checks
 *      that Browserbase refuses a wrong one with 401 on every route (an
 *      unknown route answers 404, so a 401 proves the path exists). With
 *      BROWSERBASE_API_KEY it reads projects, usage and sessions (free).
 *      BROWSERBASE_LIVE_WRITE=1 also starts a 60-second session and releases
 *      it at once (one browser minute), and runs one Fetch and one Search
 *      (one call each from the plan's monthly allowance):
 *
 *        RUN_BROWSERBASE_LIVE=1 BROWSERBASE_API_KEY=bb_live_... npx jest src/adapters/intl/browserbase.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[]; minimum?: number; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; headers?: Record<string, string>; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  unlisted?: boolean;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.browserbase.com/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['bb', '_live_', 'A'.repeat(14), 'z'.repeat(13)].join('');
const ENV: Record<string, string> = { BROWSERBASE_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = ['browserbase_create_context', 'browserbase_create_session', 'browserbase_release_session', 'browserbase_request_recording_downloads'];
const READ_ONLY = [
  'browserbase_fetch_page',
  'browserbase_get_context',
  'browserbase_get_extension',
  'browserbase_get_live_urls',
  'browserbase_get_project',
  'browserbase_get_project_usage',
  'browserbase_get_session',
  'browserbase_get_session_logs',
  'browserbase_get_session_replay',
  'browserbase_list_projects',
  'browserbase_list_recording_downloads',
  'browserbase_list_sessions',
  'browserbase_search_web',
];

describe('browserbase adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the key as X-BB-API-Key on api.browserbase.com/v1 and checks it on /projects', () => {
    expect(a.icon).toBe('browserbase');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-BB-API-Key', apiKey: '{{BROWSERBASE_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/projects');
    expect(a.requiredEnvVars).toEqual(['BROWSERBASE_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'BROWSERBASE_API_KEY', kind: 'credential', secret: true, required: true });
  });

  it('accepts a bb_live_ key and refuses pasted headers or spaces', () => {
    const re = new RegExp(a.envVarMeta.BROWSERBASE_API_KEY.pattern!);
    expect(re.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `X-BB-API-Key: ${FAKE_KEY}`, `${FAKE_KEY} `, 'bb_live_', 'hf_abcdefghijklmnopqrstuvwxyz0123']) expect(re.test(bad)).toBe(false);
  });

  it('probes with the free project list and explains the error codes', () => {
    expect(a.probe).toEqual({ tool: 'browserbase_list_projects' });
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with browserbase_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^browserbase_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads (and the POST-based Fetch and Search) read-only, writes additive, the delete destructive and off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    for (const name of WRITES) expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
    const del = tool('browserbase_delete_context');
    expect(del.enabled).toBe(false);
    expect(annotationsOf(del)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['browserbase_delete_context']);
  });

  it('asks the model to confirm writes and spending, and says what the connector cannot do', () => {
    for (const name of [...WRITES, 'browserbase_delete_context']) expect(tool(name).description).toMatch(/[Cc]onfirm/);
    expect(tool('browserbase_create_session').description).toMatch(/COSTS MONEY/);
    expect(tool('browserbase_create_session').description).toMatch(/browserbase_release_session/);
    for (const name of ['browserbase_fetch_page', 'browserbase_search_web']) expect(tool(name).description).toMatch(/ask the user/);
    expect(a.instructions).toMatch(/does \*\*not\*\* click, type or navigate/);
    expect(a.instructions).toMatch(/Playwright/);
    expect(a.instructions).toMatch(/release every session you create/);
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bbrowserbase_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbrowserbase_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://www.browserbase.com/settings');
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings that do real work (never maxBytes alone)', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(tr).toBeDefined();
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.expression ?? tr.exclude ?? tr.include).toBeDefined();
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
  });

  const S = 'f6b3a4c2-1d2e-4c5b-9a8b-7c6d5e4f3a2b';
  const P = '0b9a8c7d-6e5f-4a3b-2c1d-0e9f8a7b6c5d';
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['browserbase_list_projects', {}, 'GET', `${BASE}/projects`],
    ['browserbase_get_project', { project_id: P }, 'GET', `${BASE}/projects/${P}`],
    ['browserbase_get_project_usage', { project_id: P }, 'GET', `${BASE}/projects/${P}/usage`],
    ['browserbase_list_sessions', {}, 'GET', `${BASE}/sessions`],
    ['browserbase_get_session', { session_id: S }, 'GET', `${BASE}/sessions/${S}`],
    ['browserbase_create_session', {}, 'POST', `${BASE}/sessions`],
    ['browserbase_release_session', { session_id: S }, 'POST', `${BASE}/sessions/${S}`],
    ['browserbase_get_live_urls', { session_id: S }, 'GET', `${BASE}/sessions/${S}/debug`],
    ['browserbase_get_session_logs', { session_id: S }, 'GET', `${BASE}/sessions/${S}/logs`],
    ['browserbase_get_session_replay', { session_id: S }, 'GET', `${BASE}/sessions/${S}/replays`],
    ['browserbase_request_recording_downloads', { session_id: S }, 'POST', `${BASE}/sessions/${S}/recording/downloads`],
    ['browserbase_list_recording_downloads', { session_id: S }, 'GET', `${BASE}/sessions/${S}/recording/downloads`],
    ['browserbase_create_context', {}, 'POST', `${BASE}/contexts`],
    ['browserbase_get_context', { context_id: S }, 'GET', `${BASE}/contexts/${S}`],
    ['browserbase_delete_context', { context_id: S }, 'DELETE', `${BASE}/contexts/${S}`],
    ['browserbase_get_extension', { extension_id: S }, 'GET', `${BASE}/extensions/${S}`],
    ['browserbase_fetch_page', { url: 'https://example.com' }, 'POST', `${BASE}/fetch`],
    ['browserbase_search_web', { query: 'browserbase' }, 'POST', `${BASE}/search`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the API key header', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers['X-BB-API-Key']).toBe(FAKE_KEY);
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('creates a session with the SDK body names and nothing the caller left out', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('browserbase_create_session', {});
    expect(sent().data).toEqual({});
    mockedAxios.mockClear();
    await call('browserbase_create_session', {
      timeout: 120,
      keep_alive: false,
      region: 'eu-central-1',
      proxies: true,
      browser_settings: { context: { id: 'ctx', persist: true }, blockAds: true },
      user_metadata: { customer: 'acme' },
      project_id: P,
    });
    expect(sent().data).toEqual({
      projectId: P,
      timeout: 120,
      keepAlive: false,
      region: 'eu-central-1',
      proxies: true,
      browserSettings: { context: { id: 'ctx', persist: true }, blockAds: true },
      userMetadata: { customer: 'acme' },
    });
  });

  it('releases a session with status REQUEST_RELEASE', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('browserbase_release_session', { session_id: S });
    expect(sent().data).toEqual({ status: 'REQUEST_RELEASE' });
  });

  it('filters sessions and live-URL expiry with the SDK query names', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('browserbase_list_sessions', { status: 'RUNNING', q: "user_metadata['customer']:'acme'" });
    expect(sent().params).toEqual({ status: 'RUNNING', q: "user_metadata['customer']:'acme'" });
    mockedAxios.mockClear();
    await call('browserbase_get_live_urls', { session_id: S, expires_in: 600 });
    expect(sent().params).toEqual({ expiresIn: 600 });
  });

  it('fetches and searches with the documented body fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('browserbase_fetch_page', { url: 'https://example.com', format: 'json', schema: { type: 'object' }, allow_redirects: true });
    expect(sent().data).toEqual({ url: 'https://example.com', format: 'json', schema: { type: 'object' }, allowRedirects: true });
    mockedAxios.mockClear();
    await call('browserbase_search_web', { query: 'cloud browsers', provider: 'parallel', mode: 'fast' });
    expect(sent().data).toEqual({ query: 'cloud browsers', numResults: 10, provider: 'parallel', mode: 'fast' });
  });

  it('shapes a new session: connectUrl in, signing key and selenium URL out', () => {
    const out = shape('browserbase_create_session', {
      id: S,
      createdAt: '2026-10-15T08:00:00Z',
      expiresAt: '2026-10-15T08:05:00Z',
      keepAlive: false,
      projectId: P,
      proxyBytes: 0,
      region: 'us-west-2',
      startedAt: '2026-10-15T08:00:00Z',
      status: 'RUNNING',
      updatedAt: '2026-10-15T08:00:00Z',
      connectUrl: 'wss://connect.browserbase.com?signingKey=abc',
      seleniumRemoteUrl: 'http://connect.browserbase.com/webdriver',
      signingKey: 'abc',
    }).value as any;
    expect(out.connectUrl).toMatch(/^wss:/);
    expect(out.signingKey).toBeUndefined();
    expect(out.seleniumRemoteUrl).toBeUndefined();
    expect(out.status).toBe('RUNNING');
  });

  it('shapes sessions (a bare array), live URLs, logs and recording downloads', () => {
    expect(shape('browserbase_list_sessions', [{ id: S, status: 'COMPLETED', region: 'us-west-2', projectId: P, proxyBytes: 0, keepAlive: false, createdAt: 't', startedAt: 't', updatedAt: 't', expiresAt: 't', endedAt: 't2' }]).value).toEqual({
      sessions: [{ id: S, status: 'COMPLETED', region: 'us-west-2', createdAt: 't', startedAt: 't', endedAt: 't2', expiresAt: 't', keepAlive: false, proxyBytes: 0, contextId: null, userMetadata: null }],
    });
    expect(
      shape('browserbase_get_live_urls', {
        debuggerFullscreenUrl: 'https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=x',
        debuggerUrl: 'https://www.browserbase.com/devtools/inspector.html?wss=x',
        wsUrl: 'wss://x',
        pages: [{ id: 'p1', title: 'Example', url: 'https://example.com', faviconUrl: 'f', debuggerUrl: 'd', debuggerFullscreenUrl: 'df' }],
      }).value,
    ).toEqual({
      debuggerFullscreenUrl: 'https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=x',
      debuggerUrl: 'https://www.browserbase.com/devtools/inspector.html?wss=x',
      pages: [{ id: 'p1', title: 'Example', url: 'https://example.com', debuggerFullscreenUrl: 'df' }],
    });
    const logs = shape('browserbase_get_session_logs', [
      { method: 'Page.navigate', pageId: 0, sessionId: S, timestamp: 1, request: { params: { url: 'https://example.com' }, rawBody: 'BIG', timestamp: 1 }, response: { result: { frameId: 'f' }, rawBody: 'BIG', timestamp: 2 } },
    ]).value as any;
    expect(logs).toEqual({ logs: [{ method: 'Page.navigate', pageId: 0, timestamp: 1, params: { url: 'https://example.com' }, result: { frameId: 'f' } }] });
    expect(
      shape('browserbase_list_recording_downloads', { downloads: [{ pageId: '0', status: 'COMPLETED', completedAt: 't', downloadUrl: 'https://cdn/x.mp4' }] }).value,
    ).toEqual({ downloads: [{ pageId: '0', status: 'COMPLETED', completedAt: 't', downloadUrl: 'https://cdn/x.mp4' }] });
  });

  it('shapes a fetched page and search results', () => {
    expect(
      shape('browserbase_fetch_page', { id: 'f1', content: '# Example', contentType: 'text/markdown', encoding: 'utf-8', headers: { 'set-cookie': 'x' }, statusCode: 200 }).value,
    ).toEqual({ id: 'f1', statusCode: 200, contentType: 'text/markdown', content: '# Example' });
    expect(
      shape('browserbase_search_web', { query: 'q', requestId: 'r', results: [{ id: '1', title: 'T', url: 'https://t', favicon: 'f', image: 'i', author: null, publishedDate: '2026-10-01' }] }).value,
    ).toEqual({ query: 'q', results: [{ title: 'T', url: 'https://t', author: null, publishedDate: '2026-10-01' }] });
  });
});

const live = process.env.RUN_BROWSERBASE_LIVE === '1' ? describe : describe.skip;
live('browserbase adapter: live', () => {
  const realKey = process.env.BROWSERBASE_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  const S = '00000000-0000-0000-0000-000000000000';
  // Browserbase authenticates before routing: a wrong key gets 401 on a real
  // path and an unknown path 404, so these prove each route exists.
  it.each([
    ['browserbase_list_projects', {}],
    ['browserbase_get_project_usage', { project_id: S }],
    ['browserbase_list_sessions', {}],
    ['browserbase_get_session', { session_id: S }],
    ['browserbase_create_session', { timeout: 60 }],
    ['browserbase_release_session', { session_id: S }],
    ['browserbase_get_live_urls', { session_id: S }],
    ['browserbase_get_session_logs', { session_id: S }],
    ['browserbase_get_session_replay', { session_id: S }],
    ['browserbase_list_recording_downloads', { session_id: S }],
    ['browserbase_get_context', { context_id: S }],
    ['browserbase_get_extension', { extension_id: S }],
    ['browserbase_fetch_page', { url: 'https://example.com' }],
    ['browserbase_search_web', { query: 'browserbase' }],
  ])('%s reaches Browserbase and a wrong key is refused (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  const env = () => ({ BROWSERBASE_API_KEY: realKey! });
  const run = async (name: string, params: Record<string, unknown> = {}) => {
    const out = shape(name, await call(name, params, env()));
    expect(out.error).toBeUndefined();
    return out.value as any;
  };

  (realKey ? it : it.skip)('reads projects, usage and sessions (free)', async () => {
    const projects = await run('browserbase_list_projects');
    expect(projects.projects.length).toBeGreaterThan(0);
    const usage = await run('browserbase_get_project_usage', { project_id: projects.projects[0].id });
    expect(typeof usage.browserMinutes).toBe('number');
    expect(Array.isArray((await run('browserbase_list_sessions', { status: 'COMPLETED' })).sessions)).toBe(true);
  }, 60000);

  (realKey && process.env.BROWSERBASE_LIVE_WRITE === '1' ? it : it.skip)('starts a 60-second session, reads its live URLs and releases it (one browser minute)', async () => {
    const session = await run('browserbase_create_session', { timeout: 60, user_metadata: { source: 'amcp-live-spec' } });
    try {
      expect(session.connectUrl).toMatch(/^wss:/);
      const urls = await run('browserbase_get_live_urls', { session_id: session.id });
      expect(urls.debuggerFullscreenUrl).toMatch(/^https:/);
    } finally {
      const released = await run('browserbase_release_session', { session_id: session.id });
      expect(released.id).toBe(session.id);
    }
  }, 90000);

  (realKey && process.env.BROWSERBASE_LIVE_WRITE === '1' ? it : it.skip)('fetches one page and runs one search (one call each from the plan)', async () => {
    const page = await run('browserbase_fetch_page', { url: 'https://example.com', format: 'markdown' });
    expect(page.statusCode).toBe(200);
    const found = await run('browserbase_search_web', { query: 'Browserbase cloud browsers', num_results: 3 });
    expect(found.results.length).toBeGreaterThan(0);
  }, 90000);
});
