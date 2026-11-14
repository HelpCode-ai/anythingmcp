import axios from 'axios';
import * as adapter from './browserless.json';
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
 * Browserless REST APIs (docs.browserless.io/rest-apis and the OpenAPI pages at
 * docs.browserless.io/open-api: chrome-content, chrome-scrape,
 * chrome-screenshot, chrome-pdf, chrome-performance, chrome-function, unblock,
 * smart-scrape, map, meta), checked on 30 Oct 2026 against those pages and the
 * open-source server (github.com/browserless/browserless, src/shared/*.http.ts
 * BodySchema and QuerySchema, src/utils.ts getTokenFromRequest, which reads the
 * `token` query parameter first).
 *
 *   1. Static: always runs. Token as ?token= on the region host, every tool's
 *      URL, query and camelCase body through the real RestEngine, parameter
 *      wiring, annotations, PAID labels and the switched-off set.
 *   2. Live: skipped unless RUN_BROWSERLESS_LIVE=1. Browserless authenticates
 *      before routing, so a wrong token only proves the host answers (401 on
 *      GET /meta). With BROWSERLESS_API_TOKEN (and optionally BROWSERLESS_HOST)
 *      it reads /meta (free):
 *
 *        RUN_BROWSERLESS_LIVE=1 BROWSERLESS_API_TOKEN=... npx jest src/adapters/intl/browserless.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; headers?: Record<string, string>; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const HOST = 'production-lon.browserless.io';
const BASE = `https://${HOST}`;
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = ['T', 'k'.repeat(20), '9'.repeat(19)].join('');
const ENV: Record<string, string> = { BROWSERLESS_API_TOKEN: FAKE_TOKEN, BROWSERLESS_HOST: HOST };

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

const READS = [
  'browserless_get_content',
  'browserless_get_meta',
  'browserless_map',
  'browserless_pdf',
  'browserless_performance',
  'browserless_scrape',
  'browserless_screenshot',
  'browserless_smart_scrape',
  'browserless_unblock',
];

describe('browserless adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the token as ?token= to the configured region host', () => {
    expect(a.slug).toBe('browserless');
    expect(a.icon).toBe('browserless');
    expect(a.connector.baseUrl).toBe('https://{{BROWSERLESS_HOST}}');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ token: '{{BROWSERLESS_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['BROWSERLESS_API_TOKEN', 'BROWSERLESS_HOST']);
    const metas = describeAdapterEnvVars(a as never);
    expect(metas.find((m) => m.name === 'BROWSERLESS_API_TOKEN')).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(metas.find((m) => m.name === 'BROWSERLESS_HOST')).toMatchObject({ kind: 'address', secret: false, required: true });
    const host = new RegExp(a.envVarMeta.BROWSERLESS_HOST.pattern!);
    for (const ok of ['production-sfo.browserless.io', 'production-lon.browserless.io', 'production-ams.browserless.io', 'chrome.browserless.io', 'chrome-eu-uk.browserless.io']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://production-sfo.browserless.io', 'production-sfo.browserless.io/', 'production sfo', '']) expect(host.test(bad)).toBe(false);
    const token = new RegExp(a.envVarMeta.BROWSERLESS_API_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `token=${FAKE_TOKEN}`, `${FAKE_TOKEN} `]) expect(token.test(bad)).toBe(false);
    for (const status of ['401', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('probes with the free /meta read, which takes no parameters', () => {
    expect(a.probe).toEqual({ tool: 'browserless_get_meta' });
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    expect(tool(a.probe.tool).endpointMapping).toEqual({ method: 'GET', path: '/meta' });
  });

  it('prefixes every tool, wires every declared parameter and documents each one', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.name).toMatch(/^browserless_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      if (t.responseMapping?.transform) expect(validateTransform(t.responseMapping.transform)).toBeNull();
    }
  });

  it('marks the POST-based reads read-only, the function a write, and switches off only the function', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READS);
    expect(annotationsOf(tool('browserless_function'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['browserless_function']);
    expect(a.instructions).toContain('**Switched off at install**: `browserless_function`');
  });

  it('labels every paid call, names every tool in the instructions and writes no em dash', () => {
    const paid = a.tools.filter((t) => t.description.startsWith('PAID:')).map((t) => t.name).sort();
    expect(paid).toEqual(a.tools.map((t) => t.name).filter((n) => n !== 'browserless_get_meta').sort());
    const names = new Set(a.tools.map((t) => t.name));
    for (const name of names) expect(`${name}:${a.instructions.includes(`\`${name}\``)}`).toBe(`${name}:true`);
    const mentioned = [...a.instructions.matchAll(/\bbrowserless_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbrowserless_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('https://mcp.browserless.io/mcp');
    for (const host of ['production-sfo.browserless.io', 'production-lon.browserless.io', 'production-ams.browserless.io']) expect(a.instructions).toContain(host);
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['browserless_get_meta', {}, 'GET', `${BASE}/meta`],
    ['browserless_smart_scrape', { url: 'https://example.com' }, 'POST', `${BASE}/smart-scrape`],
    ['browserless_get_content', { url: 'https://example.com' }, 'POST', `${BASE}/content`],
    ['browserless_scrape', { url: 'https://example.com', elements: [{ selector: 'h1' }] }, 'POST', `${BASE}/scrape`],
    ['browserless_screenshot', { url: 'https://example.com' }, 'POST', `${BASE}/screenshot`],
    ['browserless_pdf', { url: 'https://example.com' }, 'POST', `${BASE}/pdf`],
    ['browserless_map', { url: 'https://example.com' }, 'POST', `${BASE}/map`],
    ['browserless_performance', { url: 'https://example.com' }, 'POST', `${BASE}/performance`],
    ['browserless_unblock', { url: 'https://example.com' }, 'POST', `${BASE}/unblock`],
    ['browserless_function', { code: 'export default async () => ({ data: 1, type: "application/json" })' }, 'POST', `${BASE}/function`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the region host with ?token=', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.params.token).toBe(FAKE_TOKEN);
    expect(req.headers.Authorization).toBeUndefined();
  });

  it('maps snake_case arguments to the camelCase body and launch query names', async () => {
    mockedAxios.mockResolvedValue({ data: '<html></html>' });
    await call('browserless_get_content', {
      url: 'https://example.com',
      wait_for_selector: { selector: '#r', timeout: 5000 },
      wait_for_timeout: 500,
      goto_options: { waitUntil: 'networkidle2' },
      best_attempt: true,
      reject_resource_types: ['image'],
      set_extra_http_headers: { 'Accept-Language': 'de' },
      stealth: true,
      block_ads: true,
      proxy: 'residential',
      proxy_country: 'us',
      timeout: 60000,
    });
    expect(sent().params).toEqual({ token: FAKE_TOKEN, stealth: true, blockAds: true, proxy: 'residential', proxyCountry: 'us', timeout: 60000 });
    expect(sent().data).toEqual({
      url: 'https://example.com',
      waitForSelector: { selector: '#r', timeout: 5000 },
      waitForTimeout: 500,
      gotoOptions: { waitUntil: 'networkidle2' },
      bestAttempt: true,
      rejectResourceTypes: ['image'],
      setExtraHTTPHeaders: { 'Accept-Language': 'de' },
    });
  });

  it('asks smart scrape for markdown by default and unblock for content only, never a WebSocket endpoint', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('browserless_smart_scrape', { url: 'https://example.com', only_main_content: true, json_options: { prompt: 'price' } });
    expect(sent().data).toEqual({ url: 'https://example.com', formats: ['markdown'], onlyMainContent: true, jsonOptions: { prompt: 'price' } });
    mockedAxios.mockClear();
    await call('browserless_unblock', { url: 'https://example.com', proxy: 'residential' });
    expect(sent().data).toEqual({ url: 'https://example.com', content: true, cookies: false, screenshot: false, browserWSEndpoint: false });
    expect(sent().params).toEqual({ token: FAKE_TOKEN, proxy: 'residential' });
    mockedAxios.mockClear();
    await call('browserless_map', { url: 'https://example.com', search: 'pricing', include_subdomains: false });
    expect(sent().data).toEqual({ url: 'https://example.com', search: 'pricing', limit: 200, includeSubdomains: false });
    mockedAxios.mockClear();
    await call('browserless_screenshot', { url: 'https://example.com', options: { fullPage: true, type: 'png' }, scroll_page: true, block_consent_modals: true });
    expect(sent().data).toEqual({ url: 'https://example.com', options: { fullPage: true, type: 'png' }, scrollPage: true });
    expect(sent().params).toEqual({ token: FAKE_TOKEN, blockConsentModals: true });
  });

  it('keeps text, HTML and attributes of scraped elements and drops geometry', () => {
    const out = shape('browserless_scrape', {
      data: [{ selector: 'h1', results: [{ text: 'Hi', html: 'Hi', attributes: [{ name: 'class', value: 't' }], top: 1, left: 2, width: 3, height: 4 }] }],
    }).value;
    expect(out).toEqual({ data: [{ selector: 'h1', results: [{ text: 'Hi', html: 'Hi', attributes: [{ name: 'class', value: 't' }] }] }] });
    const unblocked = shape('browserless_unblock', { content: '<html></html>', cookies: [], browserWSEndpoint: 'wss://x', ttl: 0 }).value;
    expect(unblocked).toEqual({ content: '<html></html>', cookies: [] });
    const smart = shape('browserless_smart_scrape', { ok: true, statusCode: 200, markdown: '# Hi', headers: { a: 'b' }, pdf: null, strategy: 'http-fetch' }).value;
    expect(smart).toEqual({ ok: true, statusCode: 200, markdown: '# Hi', strategy: 'http-fetch' });
  });
});

const live = process.env.RUN_BROWSERLESS_LIVE === '1' ? describe : describe.skip;
live('browserless adapter: live (GET only)', () => {
  const realToken = process.env.BROWSERLESS_API_TOKEN;
  const host = process.env.BROWSERLESS_HOST || 'production-sfo.browserless.io';
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it('the shared host answers and refuses a wrong token (401)', async () => {
    await expect(call('browserless_get_meta', {}, { BROWSERLESS_API_TOKEN: FAKE_TOKEN, BROWSERLESS_HOST: host })).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (realToken ? it : it.skip)('reads /meta with the real token (free)', async () => {
    const meta = await call('browserless_get_meta', {}, { BROWSERLESS_API_TOKEN: realToken!, BROWSERLESS_HOST: host });
    expect(meta).toBeTruthy();
  }, 30000);
});
