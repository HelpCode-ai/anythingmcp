import axios from 'axios';
import * as adapter from './bright-data.json';
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
 * Bright Data REST API (docs.brightdata.com/api-reference, OpenAPI blocks of the
 * Web Unlocker, SERP, Web Scraper API and account management pages), checked on
 * 30 Oct 2026 against those specs and the official MCP server
 * (github.com/brightdata/brightdata-mcp: server.js, scraper_run.js), which uses
 * the same /request, /zone/get_active_zones and /datasets/v3 calls.
 *
 *   1. Static: always runs. Bearer key on api.brightdata.com, every tool's
 *      method, URL, query and body through the real RestEngine, the wiring of
 *      every declared parameter, annotations and the switched-off set.
 *   2. Live: skipped unless RUN_BRIGHT_DATA_LIVE=1. Without a key it checks that
 *      a wrong key gets 401 on the GET routes (an unknown path answers 404) and
 *      reads the public network status. With BRIGHT_DATA_API_KEY it reads the
 *      account status, balance and zones (free, read-only):
 *
 *        RUN_BRIGHT_DATA_LIVE=1 BRIGHT_DATA_API_KEY=... npx jest src/adapters/intl/bright-data.live.spec.ts
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

const BASE = 'https://api.brightdata.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['b5', 'a'.repeat(30), '0'.repeat(32)].join('');
const ENV: Record<string, string> = { BRIGHT_DATA_API_KEY: FAKE_KEY };

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

const PAID = ['bright_data_fetch_page', 'bright_data_scrape_sync', 'bright_data_search', 'bright_data_trigger_collection'];
const WRITES = ['bright_data_cancel_snapshot', 'bright_data_scrape_sync', 'bright_data_set_zone_disabled', 'bright_data_trigger_collection'];

describe('bright-data adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the key as a Bearer token to api.brightdata.com and checks it on /status', () => {
    expect(a.slug).toBe('bright-data');
    expect(a.icon).toBe('bright-data');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{BRIGHT_DATA_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/status');
    expect(a.requiredEnvVars).toEqual(['BRIGHT_DATA_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'BRIGHT_DATA_API_KEY', kind: 'credential', secret: true, required: true });
    const re = new RegExp(a.envVarMeta.BRIGHT_DATA_API_KEY.pattern!);
    expect(re.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `, 'short']) expect(re.test(bad)).toBe(false);
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('probes with the free account status, which takes no parameters', () => {
    expect(a.probe).toEqual({ tool: 'bright_data_get_account_status' });
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
  });

  it('prefixes every tool, wires every declared parameter and requires path parameters', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.name).toMatch(/^bright_data_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters.required).toContain(p);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      if (t.responseMapping?.transform) expect(validateTransform(t.responseMapping.transform)).toBeNull();
    }
  });

  it('marks Unlocker and SERP read-only, collections as writes and switches off only the cancel', () => {
    for (const name of ['bright_data_fetch_page', 'bright_data_search']) expect(annotationsOf(tool(name)).readOnlyHint).toBe(true);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET')) expect(annotationsOf(t).readOnlyHint).toBe(true);
    for (const name of WRITES) expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
    expect(annotationsOf(tool('bright_data_cancel_snapshot'))).toMatchObject({ destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['bright_data_cancel_snapshot']);
    expect(a.instructions).toContain('**Switched off at install**: `bright_data_cancel_snapshot`');
  });

  it('labels the paid calls and names every tool in the instructions, with no em dash', () => {
    for (const name of PAID) expect(tool(name).description.startsWith('PAID:')).toBe(true);
    const paid = a.tools.filter((t) => t.description.startsWith('PAID:')).map((t) => t.name).sort();
    expect(paid).toEqual(PAID);
    const names = new Set(a.tools.map((t) => t.name));
    for (const name of names) expect(`${name}:${a.instructions.includes(`\`${name}\``)}`).toBe(`${name}:true`);
    const mentioned = [...a.instructions.matchAll(/\bbright_data_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbright_data_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('https://mcp.brightdata.com/mcp');
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });

  const S = 's_m4x7enmven8djfqak';
  const D = 'gd_l7q7dkf244hwjntr0';
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['bright_data_get_account_status', {}, 'GET', `${BASE}/status`],
    ['bright_data_get_balance', {}, 'GET', `${BASE}/customer/balance`],
    ['bright_data_list_active_zones', {}, 'GET', `${BASE}/zone/get_active_zones`],
    ['bright_data_list_all_zones', {}, 'GET', `${BASE}/zone/get_all_zones`],
    ['bright_data_get_zone', { zone: 'web_unlocker1' }, 'GET', `${BASE}/zone`],
    ['bright_data_get_zone_status', { zone: 'web_unlocker1' }, 'GET', `${BASE}/zone/status`],
    ['bright_data_get_zone_cost', { zone: 'web_unlocker1' }, 'GET', `${BASE}/zone/cost`],
    ['bright_data_get_network_status', { network_type: 'res' }, 'GET', `${BASE}/network_status/res`],
    ['bright_data_fetch_page', { url: 'https://example.com' }, 'POST', `${BASE}/request`],
    ['bright_data_search', { url: 'https://www.google.com/search?q=x' }, 'POST', `${BASE}/request`],
    ['bright_data_list_scrapers', {}, 'GET', `${BASE}/datasets/v3/scrapers`],
    ['bright_data_scrape_sync', { dataset_id: D, input: [{ url: 'https://example.com' }] }, 'POST', `${BASE}/datasets/v3/scrape`],
    ['bright_data_trigger_collection', { dataset_id: D, input: [{ url: 'https://example.com' }] }, 'POST', `${BASE}/datasets/v3/trigger`],
    ['bright_data_get_snapshot_progress', { snapshot_id: S }, 'GET', `${BASE}/datasets/v3/progress/${S}`],
    ['bright_data_download_snapshot', { snapshot_id: S }, 'GET', `${BASE}/datasets/v3/snapshot/${S}`],
    ['bright_data_list_snapshots', { dataset_id: D }, 'GET', `${BASE}/datasets/v3/snapshots`],
    ['bright_data_get_snapshot_input', { snapshot_id: S }, 'GET', `${BASE}/datasets/v3/snapshot/${S}/input`],
    ['bright_data_cancel_snapshot', { snapshot_id: S }, 'POST', `${BASE}/datasets/v3/snapshot/${S}/cancel`],
    ['bright_data_set_zone_disabled', { zone: 'web_unlocker1', disable: 1 }, 'POST', `${BASE}/zone/change_disable`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the documented URL with the Bearer key', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.params?.token).toBeUndefined();
  });

  it('sends Web Unlocker and SERP bodies with the default zones and the documented field names', async () => {
    mockedAxios.mockResolvedValue({ data: '# Example' });
    await call('bright_data_fetch_page', { url: 'https://example.com', data_format: 'markdown', country: 'de', render: 'true' });
    expect(sent().data).toEqual({ zone: 'web_unlocker1', url: 'https://example.com', format: 'raw', data_format: 'markdown', country: 'de', render: 'true' });
    mockedAxios.mockClear();
    await call('bright_data_search', { url: 'https://www.google.com/search?q=coffee&brd_json=1', zone: 'serp_eu' });
    expect(sent().data).toEqual({ zone: 'serp_eu', url: 'https://www.google.com/search?q=coffee&brd_json=1', format: 'raw' });
  });

  it('puts scraper options in the query and the inputs in the body', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('bright_data_scrape_sync', { dataset_id: D, input: [{ keyword: 'x' }], type: 'discover_new', discover_by: 'keyword', limit_per_input: 5, include_errors: true });
    expect(sent().params).toEqual({ dataset_id: D, type: 'discover_new', discover_by: 'keyword', format: 'json', include_errors: true });
    expect(sent().data).toEqual({ input: [{ keyword: 'x' }], limit_per_input: 5 });
    mockedAxios.mockClear();
    await call('bright_data_trigger_collection', { dataset_id: D, input: [{ url: 'https://example.com' }], limit_multiple_results: 100, custom_output_fields: 'url|title' });
    expect(sent().params).toEqual({ dataset_id: D, limit_multiple_results: 100 });
    expect(sent().data).toEqual({ input: [{ url: 'https://example.com' }], custom_output_fields: 'url|title' });
    mockedAxios.mockClear();
    await call('bright_data_download_snapshot', { snapshot_id: S, batch_size: 1000, part: 2 });
    expect(sent().params).toEqual({ format: 'json', batch_size: 1000, part: 2 });
    mockedAxios.mockClear();
    await call('bright_data_list_snapshots', { dataset_id: D, status: 'ready' });
    expect(sent().params).toEqual({ dataset_id: D, status: 'ready', limit: 50 });
    mockedAxios.mockClear();
    await call('bright_data_get_zone_cost', { zone: 'z', from: '2026-04-01', to: '2026-05-01' });
    expect(sent().params).toEqual({ zone: 'z', from: '2026-04-01', to: '2026-05-01' });
    mockedAxios.mockClear();
    await call('bright_data_set_zone_disabled', { zone: 'z', disable: 0 });
    expect(sent().data).toEqual({ zone: 'z', disable: 0 });
  });

  it('removes zone passwords and the scrapers list noise', () => {
    const zone = shape('bright_data_get_zone', { created: '2024-10-28', password: ['secret'], ips: ['any'], plan: { product: 'dc' }, perm: 'country' }).value as any;
    expect(zone.password).toBeUndefined();
    expect(zone.plan).toEqual({ product: 'dc' });
    const list = shape('bright_data_list_scrapers', [
      { id: D, name: 'npmjs', domain: 'npmjs.com', use_cases: ['x'], scrapers: { collect_by_url: { input_schema: [{ name: 'url' }], output_fields: [{ name: 'a' }], sample_output: [{}], sample_input: [{}] } } },
    ]).value as any;
    expect(list).toEqual([{ id: D, name: 'npmjs', domain: 'npmjs.com', scrapers: { collect_by_url: { input_schema: [{ name: 'url' }] } } }]);
    expect(shape('bright_data_get_account_status', { status: 'active', customer: 'c', can_make_requests: true, ip: '1.2.3.4' }).value).toEqual({ status: 'active', customer: 'c', can_make_requests: true });
  });
});

const live = process.env.RUN_BRIGHT_DATA_LIVE === '1' ? describe : describe.skip;
live('bright-data adapter: live (GET only)', () => {
  const realKey = process.env.BRIGHT_DATA_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  // A wrong key gets 401 on a real route and an unknown path 404, so these prove each GET route exists.
  it.each([
    ['bright_data_get_account_status', {}],
    ['bright_data_list_active_zones', {}],
    ['bright_data_get_balance', {}],
    ['bright_data_get_snapshot_progress', { snapshot_id: 's_test' }],
    ['bright_data_list_snapshots', { dataset_id: 'gd_test' }],
  ])('%s reaches Bright Data and a wrong key is refused (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('reads the public network status', async () => {
    expect(await call('bright_data_get_network_status', { network_type: 'all' })).toMatchObject({ status: true });
  }, 30000);

  (realKey ? it : it.skip)('reads account status, balance and zones (free)', async () => {
    const env = { BRIGHT_DATA_API_KEY: realKey! };
    expect(typeof (await call('bright_data_get_account_status', {}, env)).status).toBe('string');
    expect(typeof (await call('bright_data_get_balance', {}, env)).balance).toBe('number');
    expect(Array.isArray(await call('bright_data_list_active_zones', {}, env))).toBe(true);
  }, 60000);
});
