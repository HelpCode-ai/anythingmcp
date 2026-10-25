import axios from 'axios';
import * as adapter from './elasticsearch.json';
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
 * Two layers of verification for the Elasticsearch adapter:
 *
 *   1. Static: always runs. Pins the `Authorization: ApiKey <encoded>` header
 *      on the user's cluster URL and every tool's method, URL, query and body
 *      through the real RestEngine, checked against the official REST API
 *      specification (elastic/elasticsearch rest-api-spec and
 *      elastic/elasticsearch-specification, fetched 15 Oct 2026): info,
 *      security.authenticate, cluster.health, cat.indices, cat.aliases,
 *      indices.get_mapping, indices.get_data_stream, search, count,
 *      esql.query, get, index, update, delete, delete_by_query. Also the
 *      response shaping, on responses recorded from Elasticsearch 9.4.
 *
 *   2. Live: skipped unless RUN_ELASTICSEARCH_LIVE=1 and ELASTICSEARCH_URL.
 *      With a made-up key every route must answer 401. With
 *      ELASTICSEARCH_API_KEY (a read-only key is enough) it runs the read
 *      tools against ELASTICSEARCH_TEST_INDEX (default: the first index the
 *      key can list). Writes run only with RUN_ELASTICSEARCH_LIVE_WRITES=1
 *      and need a key with the write privilege on that index:
 *
 *        RUN_ELASTICSEARCH_LIVE=1 ELASTICSEARCH_URL=https://... \
 *        ELASTICSEARCH_API_KEY=... npx jest src/adapters/intl/elasticsearch.live.spec.ts
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
const shape = (name: string, raw: unknown) => {
  const out = applyResponseTransform(raw, tool(name).responseMapping as any);
  expect(out.error).toBeUndefined();
  return out.value as any;
};

const BASE = 'https://my-deployment.es.europe-west3.gcp.cloud.es.io';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = Buffer.from(['fakeid', 'fakesecret0000'].join(':')).toString('base64');
const ENV: Record<string, string> = { ELASTICSEARCH_URL: BASE, ELASTICSEARCH_API_KEY: FAKE_KEY };

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
const fullUrl = (req: any) => {
  const qs = new URLSearchParams(Object.entries(req.params ?? {}).map(([k, v]) => [k, String(v)])).toString();
  return qs ? `${req.url}?${qs}` : req.url;
};

const READ_ONLY = [
  'elasticsearch_aggregate',
  'elasticsearch_cluster_health',
  'elasticsearch_cluster_info',
  'elasticsearch_count',
  'elasticsearch_esql_query',
  'elasticsearch_get_document',
  'elasticsearch_get_mapping',
  'elasticsearch_list_aliases',
  'elasticsearch_list_data_streams',
  'elasticsearch_list_indices',
  'elasticsearch_search',
  'elasticsearch_whoami',
];
const WRITES = ['elasticsearch_index_document', 'elasticsearch_update_document'];
const DELETES = ['elasticsearch_delete_by_query', 'elasticsearch_delete_document'];

describe('elasticsearch adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the encoded API key as Authorization: ApiKey, to the cluster URL', () => {
    expect(a.category).toBe('database');
    expect(a.icon).toBe('elasticsearch');
    expect(a.connector.baseUrl).toBe('{{ELASTICSEARCH_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'ApiKey {{ELASTICSEARCH_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/_security/_authenticate');
    expect(a.requiredEnvVars).toEqual(['ELASTICSEARCH_URL', 'ELASTICSEARCH_API_KEY']);
    const meta = describeAdapterEnvVars(a as never);
    expect(meta.find((m) => m.name === 'ELASTICSEARCH_API_KEY')).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.find((m) => m.name === 'ELASTICSEARCH_URL')).toMatchObject({ kind: 'address', secret: false, required: true });
  });

  it('accepts endpoints and encoded keys, refuses pasted prefixes and trailing slashes', () => {
    const url = new RegExp(a.envVarMeta.ELASTICSEARCH_URL.pattern!);
    for (const ok of [BASE, 'https://my-project-a1b2c3.es.eu-west-1.aws.elastic.cloud', 'https://search.example.com:9200'])
      expect(url.test(ok)).toBe(true);
    for (const bad of ['', `${BASE}/`, 'my-deployment.es.io', 'https://a b.com']) expect(url.test(bad)).toBe(false);
    const key = new RegExp(a.envVarMeta.ELASTICSEARCH_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `ApiKey ${FAKE_KEY}`, `${FAKE_KEY} `, 'short']) expect(key.test(bad)).toBe(false);
  });

  it('probes with whoami, which needs no privileges, and explains the documented errors', () => {
    expect(a.probe).toEqual({ tool: 'elasticsearch_whoami' });
    for (const status of ['401', '403', '404', 'unreachable', 'rate_limited']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with elasticsearch_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^elasticsearch_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only (POST searches included), writes as writes and installs deletes switched off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    for (const name of [...WRITES, ...DELETES]) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tool(name).description).toMatch(/confirm/);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(DELETES);
  });

  it('never lets a write run a script', () => {
    expect(JSON.stringify(tool('elasticsearch_update_document').endpointMapping)).not.toMatch(/script/);
    expect(tool('elasticsearch_update_document').parameters.properties!.script).toBeUndefined();
  });

  it('caps the hits and keeps the defaults small', () => {
    const search = tool('elasticsearch_search').parameters.properties!;
    expect(search.size.default).toBe(10);
    expect(search.size.maximum).toBe(100);
    expect(tool('elasticsearch_list_indices').parameters.properties!.expand_wildcards.default).toBe('open');
  });

  it('only points the model at tools that exist, documents the read-only key and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\belasticsearch_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\belasticsearch_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('POST /_security/api_key');
    expect(a.instructions).toMatch(/"privileges": \["read", "view_index_metadata", "monitor"\]/);
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
    ['elasticsearch_whoami', {}, 'GET', `${BASE}/_security/_authenticate`],
    ['elasticsearch_cluster_info', {}, 'GET', `${BASE}/`],
    ['elasticsearch_cluster_health', {}, 'GET', `${BASE}/_cluster/health/*`],
    ['elasticsearch_list_indices', {}, 'GET', `${BASE}/_cat/indices/*?format=json&h=index%2Chealth%2Cstatus%2Cdocs.count%2Cstore.size%2Cpri%2Crep%2Ccreation.date.string&s=index&expand_wildcards=open`],
    ['elasticsearch_get_mapping', { index: 'products' }, 'GET', `${BASE}/products/_mapping`],
    ['elasticsearch_search', { index: 'logs-*,metrics-*' }, 'POST', `${BASE}/logs-*%2Cmetrics-*/_search`],
    ['elasticsearch_aggregate', { index: 'products', aggs: {} }, 'POST', `${BASE}/products/_search`],
    ['elasticsearch_count', { index: 'products' }, 'POST', `${BASE}/products/_count`],
    ['elasticsearch_esql_query', { query: 'FROM products | LIMIT 1' }, 'POST', `${BASE}/_query?format=json`],
    ['elasticsearch_get_document', { index: 'products', id: 'a/b c' }, 'GET', `${BASE}/products/_doc/a%2Fb%20c`],
    ['elasticsearch_list_aliases', {}, 'GET', `${BASE}/_cat/aliases/*?format=json&h=alias%2Cindex%2Cfilter%2Cis_write_index&s=alias`],
    ['elasticsearch_list_data_streams', {}, 'GET', `${BASE}/_data_stream/*`],
    ['elasticsearch_index_document', { index: 'products', id: '9', document: { name: 'x' } }, 'PUT', `${BASE}/products/_doc/9`],
    ['elasticsearch_update_document', { index: 'products', id: '9', doc: { name: 'x' } }, 'POST', `${BASE}/products/_update/9`],
    ['elasticsearch_delete_document', { index: 'products', id: '9' }, 'DELETE', `${BASE}/products/_doc/9`],
    ['elasticsearch_delete_by_query', { index: 'products', query: { term: { brand: 'x' } } }, 'POST', `${BASE}/products/_delete_by_query`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the documented route with the ApiKey header', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(fullUrl(req)).toBe(url);
    expect(req.headers.Authorization).toBe(`ApiKey ${FAKE_KEY}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('builds search, aggregation, count and ES|QL bodies with the documented field names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('elasticsearch_search', { index: 'products' });
    expect(sent().data).toEqual({ size: 10 });
    mockedAxios.mockClear();
    await call('elasticsearch_search', {
      index: 'products',
      query: { match: { name: 'shoe' } },
      size: 5,
      from: 5,
      sort: [{ price: 'asc' }],
      source_fields: ['name', 'price'],
      highlight: { fields: { name: {} } },
      search_after: [79.9],
      track_total_hits: true,
    });
    expect(sent().data).toEqual({
      query: { match: { name: 'shoe' } },
      size: 5,
      from: 5,
      sort: [{ price: 'asc' }],
      _source: ['name', 'price'],
      highlight: { fields: { name: {} } },
      search_after: [79.9],
      track_total_hits: true,
    });
    mockedAxios.mockClear();
    await call('elasticsearch_aggregate', { index: 'products', aggs: { by_brand: { terms: { field: 'brand' } } } });
    expect(sent().data).toEqual({ size: 0, aggs: { by_brand: { terms: { field: 'brand' } } } });
    mockedAxios.mockClear();
    await call('elasticsearch_count', { index: 'products', query: { term: { brand: 'acme' } } });
    expect(sent().data).toEqual({ query: { term: { brand: 'acme' } } });
    mockedAxios.mockClear();
    await call('elasticsearch_esql_query', { query: 'FROM products | WHERE brand == ? | LIMIT 5', params: ['acme'], filter: { match_all: {} } });
    expect(sent().data).toEqual({ query: 'FROM products | WHERE brand == ? | LIMIT 5', params: ['acme'], filter: { match_all: {} } });
  });

  it('writes the document as the body, partial updates under doc, and passes refresh and op_type', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('elasticsearch_index_document', { index: 'products', id: '9', document: { name: 'Shoe', price: 1 }, op_type: 'create', refresh: 'wait_for' });
    expect(sent().data).toEqual({ name: 'Shoe', price: 1 });
    expect(sent().params).toEqual({ op_type: 'create', refresh: 'wait_for' });
    mockedAxios.mockClear();
    await call('elasticsearch_update_document', { index: 'products', id: '9', doc: { price: 2 }, doc_as_upsert: true, retry_on_conflict: 3 });
    expect(sent().data).toEqual({ doc: { price: 2 }, doc_as_upsert: true });
    expect(sent().params).toEqual({ retry_on_conflict: 3 });
    mockedAxios.mockClear();
    await call('elasticsearch_delete_by_query', { index: 'products', query: { term: { brand: 'x' } }, max_docs: 10 });
    expect(sent().data).toEqual({ query: { term: { brand: 'x' } } });
    expect(sent().params).toEqual({ max_docs: 10 });
  });

  // Responses below were recorded from Elasticsearch 9.4.0 (15 Oct 2026).
  it('shapes a search: hits capped at 100, vectors dropped, absent keys left out', () => {
    const raw = {
      took: 27,
      timed_out: false,
      _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
      hits: {
        total: { value: 150, relation: 'eq' },
        max_score: 0.47,
        hits: Array.from({ length: 150 }, (_, i) => ({
          _index: 'products',
          _id: String(i),
          _score: 0.47,
          _source: { name: 'Red running shoe', brand: 'acme', embedding: [0.1, 0.2, 0.3] },
        })),
      },
    };
    const out = shape('elasticsearch_search', raw);
    expect(out.hits).toHaveLength(100);
    expect(out.hits[0]).toEqual({ _index: 'products', _id: '0', _score: 0.47, _source: { name: 'Red running shoe', brand: 'acme' } });
    expect(out).toMatchObject({ took: 27, timed_out: false, total: { value: 150, relation: 'eq' }, max_score: 0.47 });
    expect(out).not.toHaveProperty('aggregations');
    expect(out).not.toHaveProperty('_shards');
  });

  it('shapes ES|QL into columns and at most 500 rows', () => {
    const raw = {
      took: 166,
      is_partial: false,
      documents_found: 3,
      values_loaded: 3,
      columns: [{ name: 'c', type: 'long' }, { name: 'brand', type: 'keyword' }],
      values: Array.from({ length: 700 }, (_, i) => [i, 'acme']),
    };
    const out = shape('elasticsearch_esql_query', raw);
    expect(out.columns).toEqual(raw.columns);
    expect(out.values).toHaveLength(500);
    expect(out.row_count).toBe(700);
  });

  it('shapes data streams, index lists, aggregations and documents', () => {
    const ds = shape('elasticsearch_list_data_streams', {
      data_streams: [
        {
          name: 'logs-amcp-default',
          timestamp_field: { name: '@timestamp' },
          indices: [{ index_name: '.ds-logs-amcp-default-2026.10.15-000001', index_uuid: 'u', managed_by: 'Unmanaged' }],
          generation: 1,
          status: 'YELLOW',
          template: 'logs-amcp',
          hidden: false,
        },
      ],
    });
    expect(ds[0]).toMatchObject({ name: 'logs-amcp-default', status: 'YELLOW', template: 'logs-amcp', backing_indices: 1, write_index: '.ds-logs-amcp-default-2026.10.15-000001', timestamp_field: '@timestamp' });
    const idx = shape('elasticsearch_list_indices', Array.from({ length: 600 }, (_, i) => ({ index: `i${i}`, health: 'green' })));
    expect(idx).toHaveLength(500);
    const agg = shape('elasticsearch_aggregate', { took: 1, timed_out: false, hits: { total: { value: 3, relation: 'eq' }, hits: [] }, aggregations: { by_brand: { buckets: [{ key: 'acme', doc_count: 2 }] } } });
    expect(agg).toEqual({ took: 1, timed_out: false, total: { value: 3, relation: 'eq' }, aggregations: { by_brand: { buckets: [{ key: 'acme', doc_count: 2 }] } } });
    const doc = shape('elasticsearch_get_document', { _index: 'products', _id: '1', _version: 1, _seq_no: 0, _primary_term: 1, found: true, _source: { name: 'Red running shoe' } });
    expect(doc).toEqual({ _index: 'products', _id: '1', _version: 1, found: true, _source: { name: 'Red running shoe' } });
    const mapping = shape('elasticsearch_get_mapping', { products: { mappings: { _meta: { owner: 'x' }, properties: { brand: { type: 'keyword' } } } } });
    expect(mapping).toEqual({ products: { mappings: { properties: { brand: { type: 'keyword' } } } } });
    const who = shape('elasticsearch_whoami', { username: 'elastic', roles: [], authentication_realm: { name: '_es_api_key', type: '_es_api_key' }, authentication_type: 'api_key', api_key: { name: 'amcp-read', id: 'k' }, enabled: true });
    expect(who).toEqual({ username: 'elastic', roles: [], authentication_type: 'api_key', realm: '_es_api_key', api_key: { name: 'amcp-read', id: 'k' }, enabled: true });
  });
});

const live = process.env.RUN_ELASTICSEARCH_LIVE === '1' && process.env.ELASTICSEARCH_URL ? describe : describe.skip;
live('elasticsearch adapter: live', () => {
  const url = (process.env.ELASTICSEARCH_URL ?? '').replace(/\/+$/, '');
  const realKey = process.env.ELASTICSEARCH_API_KEY;
  const writes = process.env.RUN_ELASTICSEARCH_LIVE_WRITES === '1';
  const wrongEnv = { ELASTICSEARCH_URL: url, ELASTICSEARCH_API_KEY: FAKE_KEY };
  const env = { ELASTICSEARCH_URL: url, ELASTICSEARCH_API_KEY: realKey ?? '' };
  let index = process.env.ELASTICSEARCH_TEST_INDEX ?? '';
  // Live calls go through the tool's response mapping like a real tool call.
  const run = async (name: string, params: Record<string, unknown>) => {
    const out = applyResponseTransform(await call(name, params, env), tool(name).responseMapping as any);
    expect(out.error).toBeUndefined();
    return out.value as any;
  };
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['elasticsearch_whoami', {}],
    ['elasticsearch_cluster_info', {}],
    ['elasticsearch_list_indices', {}],
    ['elasticsearch_search', { index: 'any' }],
    ['elasticsearch_esql_query', { query: 'ROW a = 1' }],
    ['elasticsearch_get_document', { index: 'any', id: '1' }],
    ['elasticsearch_update_document', { index: 'any', id: '1', doc: { a: 1 } }],
  ])('%s: the cluster refuses a made-up key (401)', async (name, params) => {
    await expect(call(name, params, wrongEnv)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  const withKey = realKey ? it : it.skip;

  withKey('reads: whoami, info, index list, mapping, search, aggregate, count, ES|QL, document, aliases, data streams', async () => {
    const who = await run('elasticsearch_whoami', {});
    expect(who.authentication_type).toBe('api_key');
    const info = await run('elasticsearch_cluster_info', {});
    expect(info.version).toMatch(/^\d+\.\d+/);
    if (info.build_flavor !== 'serverless') {
      const health = await run('elasticsearch_cluster_health', {});
      expect(['green', 'yellow', 'red']).toContain(health.status);
    }
    const indices = await run('elasticsearch_list_indices', {});
    expect(Array.isArray(indices)).toBe(true);
    if (!index) index = indices.find((i: any) => !String(i.index).startsWith('.'))?.index;
    expect(index).toBeTruthy();
    const mapping = await run('elasticsearch_get_mapping', { index });
    expect(Object.keys(mapping).length).toBeGreaterThan(0);
    const search = await run('elasticsearch_search', { index, size: 2 });
    expect(search.hits.length).toBeLessThanOrEqual(2);
    expect(search.total).toBeDefined();
    const count = await run('elasticsearch_count', { index });
    expect(typeof count.count).toBe('number');
    const agg = await run('elasticsearch_aggregate', { index, aggs: { per_index: { terms: { field: '_index' } } } });
    expect(agg.aggregations.per_index.buckets.length).toBeGreaterThan(0);
    const esql = await run('elasticsearch_esql_query', { query: `FROM ${index} | STATS n = COUNT(*) | LIMIT 1` });
    expect(esql.columns[0].name).toBe('n');
    if (search.hits[0]) {
      const doc = await run('elasticsearch_get_document', { index: search.hits[0]._index, id: search.hits[0]._id });
      expect(doc.found).toBe(true);
    }
    expect(Array.isArray(await run('elasticsearch_list_aliases', {}))).toBe(true);
    expect(Array.isArray(await run('elasticsearch_list_data_streams', {}))).toBe(true);
  }, 120000);

  (realKey && writes ? it : it.skip)('writes: index, update and delete one test document', async () => {
    const id = `amcp-live-${Date.now()}`;
    const target = process.env.ELASTICSEARCH_TEST_INDEX ?? 'amcp-live-test';
    const created = await run('elasticsearch_index_document', { index: target, id, document: { title: 'AnythingMCP live test' }, op_type: 'create', refresh: 'wait_for' });
    expect(created.result).toBe('created');
    const updated = await run('elasticsearch_update_document', { index: target, id, doc: { title: 'updated' }, refresh: 'wait_for' });
    expect(updated.result).toBe('updated');
    const deleted = await run('elasticsearch_delete_document', { index: target, id, refresh: 'wait_for' });
    expect(deleted.result).toBe('deleted');
  }, 60000);
});
