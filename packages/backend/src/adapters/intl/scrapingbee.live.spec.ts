import axios from 'axios';
import * as adapter from './scrapingbee.json';
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
 * ScrapingBee API (www.scrapingbee.com/documentation, machine-readable copies at
 * www.scrapingbee.com/llms/*.txt: html-api, data-extraction, google-search-api,
 * fast-search-api, amazon-search-api, amazon-product-api, usage-api), checked
 * on 30 Oct 2026 against those pages and the official Node client
 * (github.com/ScrapingBee/scrapingbee-node, src/index.ts), which also stringifies
 * extract_rules and js_scenario into the query. ScrapingBee recommends the
 * Bearer header; the api_key query parameter is deprecated.
 *
 *   1. Static: always runs. Bearer key on app.scrapingbee.com/api/v1, every
 *      tool's URL and query through the real RestEngine, parameter wiring,
 *      read-only annotations and PAID labels.
 *   2. Live: skipped unless RUN_SCRAPINGBEE_LIVE=1. Without a key it checks that
 *      a wrong key gets 401 on each route (an unknown path answers 404). With
 *      SCRAPINGBEE_API_KEY it reads the usage only (free):
 *
 *        RUN_SCRAPINGBEE_LIVE=1 SCRAPINGBEE_API_KEY=... npx jest src/adapters/intl/scrapingbee.live.spec.ts
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

const BASE = 'https://app.scrapingbee.com/api/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['TEST', 'X'.repeat(36), '0'.repeat(40)].join('');
const ENV: Record<string, string> = { SCRAPINGBEE_API_KEY: FAKE_KEY };

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

describe('scrapingbee adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the key as a Bearer token to app.scrapingbee.com/api/v1 and checks it on /usage', () => {
    expect(a.slug).toBe('scrapingbee');
    expect(a.icon).toBe('scrapingbee');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SCRAPINGBEE_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/usage');
    expect(a.requiredEnvVars).toEqual(['SCRAPINGBEE_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'SCRAPINGBEE_API_KEY', kind: 'credential', secret: true, required: true });
    const re = new RegExp(a.envVarMeta.SCRAPINGBEE_API_KEY.pattern!);
    expect(re.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `, 'short']) expect(re.test(bad)).toBe(false);
    for (const status of ['401', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('probes with the free usage read, which takes no parameters', () => {
    expect(a.probe).toEqual({ tool: 'scrapingbee_get_usage' });
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
  });

  it('prefixes every tool, wires every declared parameter and documents each one', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.name).toMatch(/^scrapingbee_[a-z_]+$/);
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

  it('is read-only (GET everywhere), switches nothing off and labels every paid call', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(annotationsOf(t).readOnlyHint).toBe(true);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual([]);
    const paid = a.tools.filter((t) => t.description.startsWith('PAID:')).map((t) => t.name).sort();
    expect(paid).toEqual(a.tools.map((t) => t.name).filter((n) => n !== 'scrapingbee_get_usage').sort());
  });

  it('names every tool in the instructions and writes no em dash', () => {
    const names = new Set(a.tools.map((t) => t.name));
    for (const name of names) expect(`${name}:${a.instructions.includes(`\`${name}\``)}`).toBe(`${name}:true`);
    const mentioned = [...a.instructions.matchAll(/\bscrapingbee_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bscrapingbee_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('https://mcp.scrapingbee.com/mcp');
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });

  const table: Array<[string, Record<string, unknown>, string]> = [
    ['scrapingbee_get_usage', {}, `${BASE}/usage`],
    ['scrapingbee_scrape_page', { url: 'https://example.com' }, `${BASE}/`],
    ['scrapingbee_extract_data', { url: 'https://example.com', extract_rules: '{"title":"h1"}' }, `${BASE}/`],
    ['scrapingbee_take_screenshot', { url: 'https://example.com' }, `${BASE}/`],
    ['scrapingbee_google_search', { search: 'coffee' }, `${BASE}/google`],
    ['scrapingbee_fast_search', { search: 'coffee' }, `${BASE}/fast_search`],
    ['scrapingbee_amazon_search', { query: 'charger' }, `${BASE}/amazon/search`],
    ['scrapingbee_amazon_product', { query: 'B08N5WRWNW' }, `${BASE}/amazon/product`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s calls the documented URL with the Bearer key and no api_key in the query', async (name, params, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe('GET');
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.params?.api_key).toBeUndefined();
  });

  it('passes the HTML API options with their documented names, JSON options as text', async () => {
    mockedAxios.mockResolvedValue({ data: '# Example' });
    const scenario = JSON.stringify({ instructions: [{ click: '#accept' }] });
    await call('scrapingbee_scrape_page', { url: 'https://example.com', return_page_markdown: true, render_js: false, premium_proxy: true, country_code: 'de', js_scenario: scenario, wait_browser: 'networkidle2' });
    expect(sent().params).toEqual({ url: 'https://example.com', return_page_markdown: true, render_js: false, premium_proxy: true, country_code: 'de', js_scenario: scenario, wait_browser: 'networkidle2' });
    mockedAxios.mockClear();
    await call('scrapingbee_extract_data', { url: 'https://example.com', ai_extract_rules: '{"price":"product price"}', ai_selector: '#product' });
    expect(sent().params).toEqual({ url: 'https://example.com', ai_extract_rules: '{"price":"product price"}', ai_selector: '#product' });
    mockedAxios.mockClear();
    await call('scrapingbee_take_screenshot', { url: 'https://example.com', screenshot_full_page: true });
    expect(sent().params).toEqual({ url: 'https://example.com', screenshot: 'true', screenshot_full_page: true });
  });

  it('passes search and Amazon options with their documented names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('scrapingbee_google_search', { search: 'site:example.com pricing', search_type: 'news', country_code: 'de', language: 'de', light_request: false, date_range: 'past_week' });
    expect(sent().params).toEqual({ search: 'site:example.com pricing', search_type: 'news', country_code: 'de', language: 'de', light_request: false, date_range: 'past_week' });
    mockedAxios.mockClear();
    await call('scrapingbee_amazon_search', { query: 'charger', domain: 'de', start_page: 2, pages: 2, sort_by: 'bestsellers', zip_code: '10115' });
    expect(sent().params).toEqual({ query: 'charger', domain: 'de', start_page: 2, pages: 2, sort_by: 'bestsellers', zip_code: '10115' });
  });

  it('drops raw HTML and refinements from search answers', () => {
    expect(shape('scrapingbee_amazon_search', { products: [{ asin: 'B0', title: 'T' }], products_count: 1, refinements: { brand: ['x'] }, html: '<html>' }).value).toEqual({ products: [{ asin: 'B0', title: 'T' }], products_count: 1 });
    expect(shape('scrapingbee_google_search', { organic_results: [{ title: 'T' }], full_html: '<html>' }).value).toEqual({ organic_results: [{ title: 'T' }] });
    expect(shape('scrapingbee_amazon_product', { asin: 'B0', price: 10, html: '<html>' }).value).toEqual({ asin: 'B0', price: 10 });
  });
});

const live = process.env.RUN_SCRAPINGBEE_LIVE === '1' ? describe : describe.skip;
live('scrapingbee adapter: live (GET, free reads only)', () => {
  const realKey = process.env.SCRAPINGBEE_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  // ScrapingBee checks the key before anything else: a wrong key gets 401 on a
  // real route and an unknown path 404, so these prove each route exists. A
  // refused call is never billed.
  it.each([
    ['scrapingbee_get_usage', {}],
    ['scrapingbee_google_search', { search: 'test' }],
    ['scrapingbee_fast_search', { search: 'test' }],
    ['scrapingbee_amazon_search', { query: 'test' }],
    ['scrapingbee_amazon_product', { query: 'B08N5WRWNW' }],
  ])('%s reaches ScrapingBee and a wrong key is refused (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (realKey ? it : it.skip)('reads the plan usage (free)', async () => {
    const usage = await call('scrapingbee_get_usage', {}, { SCRAPINGBEE_API_KEY: realKey! });
    expect(typeof usage.max_api_credit).toBe('number');
    expect(typeof usage.used_api_credit).toBe('number');
  }, 30000);
});
