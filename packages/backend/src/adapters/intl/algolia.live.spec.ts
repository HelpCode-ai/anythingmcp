import axios from 'axios';
import * as adapter from './algolia.json';
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
 * Two layers of verification for the Algolia adapter:
 *
 *   1. Static: always runs. Pins the X-Algolia-Application-Id and
 *      X-Algolia-API-Key headers, the three hosts (<APP_ID>-dsn.algolia.net
 *      for reads, <APP_ID>.algolia.net for writes, analytics.<region>.
 *      algolia.com for analytics) and every tool's method, URL, query and
 *      body through the real RestEngine, checked against Algolia's OpenAPI
 *      specs (algolia/api-clients-automation specs/bundled/search.yml and
 *      analytics.yml, fetched 15 Oct 2026). Also the response shaping.
 *
 *   2. Live: skipped unless RUN_ALGOLIA_LIVE=1. Without credentials it uses
 *      Algolia's public demo application id (latency) with a made-up key:
 *      every search-host route must answer 403 "Invalid Application-ID or
 *      API key", every analytics route 401, and a made-up route 404. With
 *      ALGOLIA_APP_ID, ALGOLIA_API_KEY and ALGOLIA_TEST_INDEX (a search-only
 *      key is enough) it runs a search and a record read;
 *      ALGOLIA_FULL_READ=1 adds the connection check and the tools that need
 *      browse, listIndexes, settings and analytics. Writes are never run live:
 *
 *        RUN_ALGOLIA_LIVE=1 ALGOLIA_APP_ID=... ALGOLIA_API_KEY=... \
 *        ALGOLIA_TEST_INDEX=... npx jest src/adapters/intl/algolia.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[]; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, any>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
const shape = (name: string, raw: unknown) => {
  const out = applyResponseTransform(raw, tool(name).responseMapping as any);
  expect(out.error).toBeUndefined();
  return out.value as any;
};

const APP = 'ABCD1234EF';
const READ = `https://${APP}-dsn.algolia.net`;
const WRITE = `https://${APP}.algolia.net`;
const ANALYTICS = 'https://analytics.de.algolia.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['0000aaaa', '1111bbbb', '2222cccc', '3333dddd'].join('');
const ENV: Record<string, string> = { ALGOLIA_APP_ID: APP, ALGOLIA_API_KEY: FAKE_KEY, ALGOLIA_ANALYTICS_REGION: 'de' };

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
const sent = () => mockedAxios.mock.calls[0][0];

const READ_ONLY = [
  'algolia_browse',
  'algolia_get_object',
  'algolia_get_settings',
  'algolia_list_indices',
  'algolia_no_result_searches',
  'algolia_search',
  'algolia_search_count',
  'algolia_search_rules',
  'algolia_search_synonyms',
  'algolia_top_hits',
  'algolia_top_searches',
];
const WRITES = ['algolia_partial_update_object', 'algolia_save_object'];

describe('algolia adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the key and application id headers, reading from the -dsn host', () => {
    expect(a.category).toBe('database');
    expect(a.icon).toBe('algolia');
    expect(a.connector.baseUrl).toBe('https://{{ALGOLIA_APP_ID}}-dsn.algolia.net');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'X-Algolia-API-Key',
      apiKey: '{{ALGOLIA_API_KEY}}',
      extraHeaders: { 'X-Algolia-Application-Id': '{{ALGOLIA_APP_ID}}' },
    });
    expect(a.connector.healthcheckPath).toBe('/1/indexes?hitsPerPage=1');
    expect(a.requiredEnvVars).toEqual(['ALGOLIA_APP_ID', 'ALGOLIA_API_KEY', 'ALGOLIA_ANALYTICS_REGION']);
    const meta = describeAdapterEnvVars(a as never);
    expect(meta.find((m) => m.name === 'ALGOLIA_API_KEY')).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.find((m) => m.name === 'ALGOLIA_APP_ID')).toMatchObject({ secret: false, required: true });
  });

  it('validates the application id, key and analytics region', () => {
    const app = new RegExp(a.envVarMeta.ALGOLIA_APP_ID.pattern!);
    for (const ok of [APP, 'latency']) expect(app.test(ok)).toBe(true);
    for (const bad of ['', 'ABC 123', 'https://ABCD1234EF-dsn.algolia.net']) expect(app.test(bad)).toBe(false);
    const key = new RegExp(a.envVarMeta.ALGOLIA_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `${FAKE_KEY} `, 'short']) expect(key.test(bad)).toBe(false);
    const region = new RegExp(a.envVarMeta.ALGOLIA_ANALYTICS_REGION.pattern!);
    for (const ok of ['us', 'de']) expect(region.test(ok)).toBe(true);
    for (const bad of ['', 'US', 'eu', 'analytics.de.algolia.com']) expect(region.test(bad)).toBe(false);
  });

  it('probes with one page of the index list and explains that it needs listIndexes', () => {
    expect(a.probe).toEqual({ tool: 'algolia_list_indices', params: { hits_per_page: 1 } });
    for (const status of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['403']).toContain('Invalid Application-ID or API key');
    expect(a.verifyHints['403']).toContain('listIndexes');
    expect(a.verifyHints['403']).toContain('Search-Only');
  });

  it('never puts the API key in a URL: only the auth header carries it', () => {
    const KEY = '{{ALGOLIA_API_KEY}}';
    expect(a.connector.baseUrl).not.toContain(KEY);
    expect(a.connector.healthcheckPath).not.toContain(KEY);
    expect(JSON.stringify(a.connector.headers)).not.toContain(KEY);
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.path}`).not.toContain(KEY);
      for (const v of Object.values(t.endpointMapping.queryParams ?? {})) expect(`${t.name}:${JSON.stringify(v)}`).not.toContain(KEY);
      expect(JSON.stringify(t.endpointMapping)).not.toContain(KEY);
    }
    expect(a.connector.authConfig.apiKey).toBe(KEY);
  });

  it('prefixes every tool with algolia_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^algolia_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only (POST searches included), writes as writes and installs the delete switched off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    for (const name of [...WRITES, 'algolia_delete_object']) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tool(name).description).toMatch(/confirm/);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['algolia_delete_object']);
  });

  it('keeps searches small and out of the user analytics', () => {
    const search = tool('algolia_search').parameters.properties!;
    expect(search.hits_per_page.default).toBe(10);
    expect(search.hits_per_page.maximum).toBe(100);
    expect(search.record_analytics.default).toBe(false);
    expect(tool('algolia_partial_update_object').parameters.properties!.create_if_not_exists.default).toBe(false);
  });

  it('only points the model at tools that exist, explains the keys and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\balgolia_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\balgolia_[a-z_]+/g)]),
      ...Object.values(a.verifyHints).flatMap((h) => [...h.matchAll(/\balgolia_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/Search-Only API key/);
    expect(a.instructions).toMatch(/`search`, `browse`, `listIndexes`, `settings` and `analytics`/);
    expect(a.instructions).toMatch(/Admin API key/);
    expect(a.instructions).toMatch(/Search-Only API key\*\* has only `search`, so it fails the check with 403/);
    expect(a.instructions).toMatch(/Settings > API Keys > All API keys/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings, never a maxBytes-only transform', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      if (!tr) continue;
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.expression ?? tr.exclude ?? tr.include).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['algolia_list_indices', {}, 'GET', `${READ}/1/indexes`],
    ['algolia_search', { index_name: 'prod products' }, 'POST', `${READ}/1/indexes/prod%20products/query`],
    ['algolia_browse', { index_name: 'products' }, 'POST', `${READ}/1/indexes/products/browse`],
    ['algolia_get_object', { index_name: 'products', object_id: 'a/b' }, 'GET', `${READ}/1/indexes/products/a%2Fb`],
    ['algolia_get_settings', { index_name: 'products' }, 'GET', `${READ}/1/indexes/products/settings`],
    ['algolia_search_synonyms', { index_name: 'products' }, 'POST', `${READ}/1/indexes/products/synonyms/search`],
    ['algolia_search_rules', { index_name: 'products' }, 'POST', `${READ}/1/indexes/products/rules/search`],
    ['algolia_save_object', { index_name: 'products', object_id: 'sku-1', record: { name: 'x' } }, 'PUT', `${WRITE}/1/indexes/products/sku-1`],
    ['algolia_partial_update_object', { index_name: 'products', object_id: 'sku-1', attributes: { price: 1 } }, 'POST', `${WRITE}/1/indexes/products/sku-1/partial`],
    ['algolia_delete_object', { index_name: 'products', object_id: 'sku-1' }, 'DELETE', `${WRITE}/1/indexes/products/sku-1`],
    ['algolia_top_searches', { index: 'products' }, 'GET', `${ANALYTICS}/2/searches`],
    ['algolia_no_result_searches', { index: 'products' }, 'GET', `${ANALYTICS}/2/searches/noResults`],
    ['algolia_top_hits', { index: 'products' }, 'GET', `${ANALYTICS}/2/hits`],
    ['algolia_search_count', { index: 'products' }, 'GET', `${ANALYTICS}/2/searches/count`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the documented host and path with both Algolia headers', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers['X-Algolia-API-Key']).toBe(FAKE_KEY);
    expect(req.headers['X-Algolia-Application-Id']).toBe(APP);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('searches with the documented parameter names, no highlighting and no analytics by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('algolia_search', { index_name: 'products', query: 'shoe' });
    expect(sent().data).toEqual({ query: 'shoe', hitsPerPage: 10, analytics: false, attributesToHighlight: [], attributesToSnippet: [] });
    mockedAxios.mockClear();
    await call('algolia_search', {
      index_name: 'products',
      query: 'shoe',
      filters: 'brand:acme AND price < 100',
      facet_filters: ['color:red'],
      numeric_filters: ['price >= 10'],
      facets: ['brand'],
      attributes_to_retrieve: ['name'],
      hits_per_page: 5,
      page: 2,
      record_analytics: true,
    });
    expect(sent().data).toEqual({
      query: 'shoe',
      filters: 'brand:acme AND price < 100',
      facetFilters: ['color:red'],
      numericFilters: ['price >= 10'],
      facets: ['brand'],
      attributesToRetrieve: ['name'],
      hitsPerPage: 5,
      page: 2,
      analytics: true,
      attributesToHighlight: [],
      attributesToSnippet: [],
    });
    mockedAxios.mockClear();
    await call('algolia_browse', { index_name: 'products', cursor: 'abc' });
    expect(sent().data).toEqual({ hitsPerPage: 50, cursor: 'abc' });
    mockedAxios.mockClear();
    await call('algolia_search_rules', { index_name: 'products', query: 'sale', anchoring: 'contains', enabled: true });
    expect(sent().data).toEqual({ query: 'sale', anchoring: 'contains', enabled: true, hitsPerPage: 20 });
    mockedAxios.mockClear();
    await call('algolia_search_synonyms', { index_name: 'products', type: 'onewaysynonym' });
    expect(sent().data).toEqual({ type: 'onewaysynonym', hitsPerPage: 20 });
    mockedAxios.mockClear();
    await call('algolia_get_object', { index_name: 'products', object_id: '1', attributes_to_retrieve: 'name,price' });
    expect(sent().params).toEqual({ attributesToRetrieve: 'name,price' });
    mockedAxios.mockClear();
    await call('algolia_list_indices', {});
    expect(sent().params).toEqual({ page: 0, hitsPerPage: 100 });
    mockedAxios.mockClear();
    await call('algolia_list_indices', a.probe.params ?? {});
    expect(sent().params).toEqual({ page: 0, hitsPerPage: 1 });
  });

  it('sends the record as the body and asks for createIfNotExists explicitly', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('algolia_save_object', { index_name: 'products', object_id: 'sku-1', record: { name: 'Shoe', price: 9 } });
    expect(sent().data).toEqual({ name: 'Shoe', price: 9 });
    mockedAxios.mockClear();
    await call('algolia_partial_update_object', { index_name: 'products', object_id: 'sku-1', attributes: { stock: { _operation: 'Decrement', value: 1 } } });
    expect(sent().data).toEqual({ stock: { _operation: 'Decrement', value: 1 } });
    expect(sent().params).toEqual({ createIfNotExists: false });
  });

  it('passes analytics filters with the documented camelCase names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('algolia_top_searches', { index: 'products', start_date: '2026-10-01', end_date: '2026-10-14', tags: 'device:mobile', click_analytics: true, order_by: 'clickThroughRate', direction: 'desc', offset: 10 });
    expect(sent().params).toEqual({ index: 'products', startDate: '2026-10-01', endDate: '2026-10-14', tags: 'device:mobile', clickAnalytics: true, orderBy: 'clickThroughRate', direction: 'desc', limit: 10, offset: 10 });
    mockedAxios.mockClear();
    await call('algolia_top_hits', { index: 'products', search: 'shoe' });
    expect(sent().params).toEqual({ index: 'products', search: 'shoe', limit: 10 });
    mockedAxios.mockClear();
    await call('algolia_search_count', { index: 'products' });
    expect(sent().params).toEqual({ index: 'products' });
  });

  it('shapes a search: no highlight markup, at most 100 hits, absent keys left out', () => {
    const raw = {
      hits: Array.from({ length: 120 }, (_, i) => ({
        name: 'Apple - iPhone SE',
        price: 449.99,
        objectID: String(i),
        _snippetResult: { description: { value: '<em>iPhone</em>', matchLevel: 'full' } },
        _highlightResult: { name: { value: '<em>iPhone</em>' } },
        _rankingInfo: { nbTypos: 0 },
      })),
      nbHits: 4093,
      page: 0,
      nbPages: 41,
      hitsPerPage: 120,
      exhaustiveNbHits: true,
      query: 'iphone',
      params: 'query=iphone',
      processingTimeMS: 1,
      processingTimingsMS: { total: 1 },
      serverTimeMS: 2,
    };
    const out = shape('algolia_search', raw);
    expect(out.hits).toHaveLength(100);
    expect(out.hits[0]).toEqual({ name: 'Apple - iPhone SE', price: 449.99, objectID: '0' });
    expect(out).toMatchObject({ nbHits: 4093, page: 0, nbPages: 41, query: 'iphone', processingTimeMS: 1 });
    expect(out).not.toHaveProperty('facets');
    expect(out).not.toHaveProperty('params');
    expect(out).not.toHaveProperty('serverTimeMS');
  });

  it('keeps index lists, analytics and write answers compact', () => {
    const list = shape('algolia_list_indices', { items: [{ name: 'products', entries: 3, dataSize: 10, fileSize: 20, createdAt: 'c', updatedAt: 'u', lastBuildTimeS: 0, numberOfPendingTasks: 0, pendingTask: false }], nbPages: 1 });
    expect(list).toEqual({ indices: [{ name: 'products', entries: 3, dataSize: 10, fileSize: 20, updatedAt: 'u', lastBuildTimeS: 0, numberOfPendingTasks: 0 }], nbPages: 1 });
    expect(shape('algolia_no_result_searches', { searches: [{ search: 'shoez', count: 4, withFilterCount: 1 }] })).toEqual({ searches: [{ search: 'shoez', count: 4, withFilterCount: 1 }] });
    expect(shape('algolia_search_count', { count: 3, dates: [{ date: '2026-10-14', count: 3 }] })).toEqual({ count: 3, dates: [{ date: '2026-10-14', count: 3 }] });
    expect(shape('algolia_save_object', { objectID: 'sku-1', taskID: 7, updatedAt: 't' })).toEqual({ objectID: 'sku-1', taskID: 7, updatedAt: 't' });
  });
});

const live = process.env.RUN_ALGOLIA_LIVE === '1' ? describe : describe.skip;
live('algolia adapter: live', () => {
  // Algolia's public demo application, used here only with a made-up key.
  const wrongEnv = { ALGOLIA_APP_ID: 'latency', ALGOLIA_API_KEY: FAKE_KEY, ALGOLIA_ANALYTICS_REGION: 'us' };
  const realEnv = process.env.ALGOLIA_APP_ID && process.env.ALGOLIA_API_KEY
    ? { ALGOLIA_APP_ID: process.env.ALGOLIA_APP_ID, ALGOLIA_API_KEY: process.env.ALGOLIA_API_KEY, ALGOLIA_ANALYTICS_REGION: process.env.ALGOLIA_ANALYTICS_REGION ?? 'us' }
    : undefined;
  const index = process.env.ALGOLIA_TEST_INDEX ?? '';
  const run = async (name: string, params: Record<string, unknown>) => {
    const out = applyResponseTransform(await call(name, params, realEnv), tool(name).responseMapping as any);
    expect(out.error).toBeUndefined();
    return out.value as any;
  };
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  const params: Record<string, Record<string, unknown>> = {
    algolia_list_indices: {},
    algolia_search: { index_name: 'instant_search', query: 'phone' },
    algolia_browse: { index_name: 'instant_search' },
    algolia_get_object: { index_name: 'instant_search', object_id: '1' },
    algolia_get_settings: { index_name: 'instant_search' },
    algolia_search_synonyms: { index_name: 'instant_search' },
    algolia_search_rules: { index_name: 'instant_search' },
    algolia_save_object: { index_name: 'instant_search', object_id: 'x', record: { a: 1 } },
    algolia_partial_update_object: { index_name: 'instant_search', object_id: 'x', attributes: { a: 1 } },
    algolia_delete_object: { index_name: 'instant_search', object_id: 'x' },
  };
  it.each(Object.entries(params))('%s reaches a real route and Algolia refuses a made-up key (403)', async (name, p) => {
    await expect(call(name, p, wrongEnv)).rejects.toMatchObject({ response: { status: 403 } });
  }, 30000);

  it.each(['algolia_top_searches', 'algolia_no_result_searches', 'algolia_search_count'])(
    '%s reaches a real analytics route and refuses a made-up key (401)',
    async (name) => {
      await expect(call(name, { index: 'instant_search' }, wrongEnv)).rejects.toMatchObject({ response: { status: 401 } });
    },
    30000,
  );

  it('answers 404 on made-up routes of both APIs', async () => {
    const headers = { 'X-Algolia-Application-Id': 'latency', 'X-Algolia-API-Key': FAKE_KEY };
    await expect((mockedAxios.__actual as any).request({ url: 'https://latency-dsn.algolia.net/1/does-not-exist', headers })).rejects.toMatchObject({ response: { status: 404 } });
    await expect((mockedAxios.__actual as any).request({ url: 'https://analytics.us.algolia.com/2/does-not-exist', headers })).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (realEnv && index ? it : it.skip)('with a key: search and record read on ALGOLIA_TEST_INDEX', async () => {
    const res = await run('algolia_search', { index_name: index, query: '', hits_per_page: 2 });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0]._highlightResult).toBeUndefined();
    const record = await run('algolia_get_object', { index_name: index, object_id: res.hits[0].objectID });
    expect(record.objectID).toBe(res.hits[0].objectID);
  }, 60000);

  (realEnv && index && process.env.ALGOLIA_FULL_READ === '1' ? it : it.skip)('with a read key: indices, browse, settings, synonyms, rules and analytics', async () => {
    expect((await run('algolia_list_indices', { hits_per_page: 1 })).indices.length).toBe(1);
    expect((await run('algolia_browse', { index_name: index, hits_per_page: 2 })).hits.length).toBeGreaterThan(0);
    expect(await run('algolia_get_settings', { index_name: index })).toBeTruthy();
    expect(Array.isArray((await run('algolia_search_synonyms', { index_name: index })).hits)).toBe(true);
    expect(Array.isArray((await run('algolia_search_rules', { index_name: index })).hits)).toBe(true);
    expect(Array.isArray((await run('algolia_top_searches', { index })).searches)).toBe(true);
    expect(typeof (await run('algolia_search_count', { index })).count).toBe('number');
  }, 90000);
});
