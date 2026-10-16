import axios from 'axios';
import * as adapter from './pinecone.json';
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
 * Two layers of verification for the Pinecone adapter:
 *
 *   1. Static: always runs. Pins the Api-Key and X-Pinecone-Api-Version
 *      (2026-07) headers, the control plane on api.pinecone.io, the per-index
 *      data hosts and the assistant data hosts, and every tool's method, URL,
 *      query and body through the real RestEngine, checked against Pinecone's
 *      OpenAPI specs (pinecone-io/pinecone-api 2026-07: db_control, db_data,
 *      inference, assistant_control, assistant_data; fetched 15 Oct 2026).
 *      Also the response shaping (no vector values) and that a crafted
 *      index_host can never send the key outside *.pinecone.io.
 *
 *   2. Live: skipped unless RUN_PINECONE_LIVE=1. Without a key it checks that
 *      every real route refuses a made-up key with 401 (data routes on a
 *      made-up serverless index host) and that a made-up data route answers
 *      404. With PINECONE_API_KEY it runs the read tools on the first index
 *      (or PINECONE_TEST_INDEX). Writes run only with
 *      RUN_PINECONE_LIVE_WRITES=1 on PINECONE_TEST_INDEX, which must be an
 *      integrated index with the text field PINECONE_TEST_FIELD (default
 *      chunk_text):
 *
 *        RUN_PINECONE_LIVE=1 PINECONE_API_KEY=... npx jest src/adapters/intl/pinecone.live.spec.ts
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; encodePathParams?: boolean };
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

const API = 'https://api.pinecone.io';
const HOST = 'my-index-abc1234.svc.aped-4627-b74a';
const DATA = `https://${HOST}.pinecone.io`;
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['pcsk', 'fake0', '0000000000000000000000000000000000000000'].join('_');
const ENV: Record<string, string> = { PINECONE_API_KEY: FAKE_KEY };

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
  'pinecone_chat_assistant',
  'pinecone_describe_index',
  'pinecone_describe_index_stats',
  'pinecone_embed',
  'pinecone_fetch_vectors',
  'pinecone_list_assistants',
  'pinecone_list_indexes',
  'pinecone_list_models',
  'pinecone_list_namespaces',
  'pinecone_list_vector_ids',
  'pinecone_query_vectors',
  'pinecone_rerank',
  'pinecone_search_documents',
  'pinecone_search_records',
];
const WRITES = ['pinecone_update_metadata', 'pinecone_upsert_records'];

describe('pinecone adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends Api-Key and pins API version 2026-07 on api.pinecone.io', () => {
    expect(a.category).toBe('database');
    expect(a.icon).toBe('pinecone');
    expect(a.connector.baseUrl).toBe(API);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Api-Key', apiKey: '{{PINECONE_API_KEY}}' });
    expect(a.connector.headers['X-Pinecone-Api-Version']).toBe('2026-07');
    expect(a.connector.healthcheckPath).toBe('/indexes');
    expect(a.requiredEnvVars).toEqual(['PINECONE_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'PINECONE_API_KEY', kind: 'credential', secret: true, required: true });
  });

  it('accepts a key and refuses pasted headers or spaces', () => {
    const key = new RegExp(a.envVarMeta.PINECONE_API_KEY.pattern!);
    for (const ok of [FAKE_KEY, '01234567-89ab-cdef-0123-456789abcdef']) expect(key.test(ok)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, `Api-Key: ${FAKE_KEY}`, `${FAKE_KEY} `, 'short']) expect(key.test(bad)).toBe(false);
  });

  it('probes with the index list and explains the documented errors', () => {
    expect(a.probe).toEqual({ tool: 'pinecone_list_indexes' });
    for (const status of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with pinecone_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^pinecone_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only (POST searches included), writes as writes and installs the delete switched off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    for (const name of [...WRITES, 'pinecone_delete_vectors']) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tool(name).description).toMatch(/confirm/);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['pinecone_delete_vectors']);
    expect(JSON.stringify(tool('pinecone_delete_vectors').endpointMapping)).not.toMatch(/deleteAll|filter/);
  });

  it('only ever sends the key to *.pinecone.io: data paths end the host with .pinecone.io and encode index_host', () => {
    for (const t of a.tools) {
      const { path } = t.endpointMapping;
      if (!/^https?:\/\//.test(path)) continue;
      expect(t.endpointMapping.encodePathParams).toBe(true);
      expect(path).toMatch(/^https:\/\/(\{index_host\}\.pinecone\.io|\{assistant_host\})\//);
    }
    expect(tool('pinecone_chat_assistant').parameters.properties!.assistant_host.enum).toEqual(['prod-1-data.ke.pinecone.io', 'prod-eu-data.ke.pinecone.io']);
  });

  it.each(['evil.example.com/', 'evil.example.com#', 'evil.example.com?', 'user@evil.example.com', 'evil.example.com:443'])(
    'refuses to leave pinecone.io with index_host %p',
    async (host) => {
      // The outbound guard (off by default under jest) is what parses the URL
      // in production; the encoded value never forms a valid host.
      const previous = process.env.SSRF_GUARD;
      process.env.SSRF_GUARD = 'enabled';
      try {
        mockedAxios.mockResolvedValue({ data: {} });
        await expect(call('pinecone_describe_index_stats', { index_host: host })).rejects.toThrow(/invalid URL/);
        expect(mockedAxios).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env.SSRF_GUARD;
        else process.env.SSRF_GUARD = previous;
      }
    },
  );

  it('only points the model at tools that exist, explains index hosts and keys, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bpinecone_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bpinecone_[a-z_]+/g)]),
      ...a.tools.flatMap((t) => Object.values(t.parameters.properties ?? {}).flatMap((p) => [...(p.description ?? '').matchAll(/\bpinecone_[a-z_]+/g)])),
      ...Object.values(a.verifyHints).flatMap((h) => [...h.matchAll(/\bpinecone_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/ProjectViewer/);
    expect(a.instructions).toMatch(/index_host/);
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
    ['pinecone_list_indexes', {}, 'GET', `${API}/indexes`],
    ['pinecone_describe_index', { index_name: 'my-index' }, 'GET', `${API}/indexes/my-index`],
    ['pinecone_describe_index_stats', { index_host: HOST }, 'POST', `${DATA}/describe_index_stats`],
    ['pinecone_list_namespaces', { index_host: HOST }, 'GET', `${DATA}/namespaces`],
    ['pinecone_search_records', { index_host: HOST, text: 'q' }, 'POST', `${DATA}/records/namespaces/__default__/search`],
    ['pinecone_search_documents', { index_host: HOST, namespace: 'docs 2026', score_by: [] }, 'POST', `${DATA}/namespaces/docs%202026/documents/search`],
    ['pinecone_query_vectors', { index_host: HOST, id: 'a' }, 'POST', `${DATA}/query`],
    ['pinecone_fetch_vectors', { index_host: HOST, ids: ['a'] }, 'GET', `${DATA}/vectors/fetch`],
    ['pinecone_list_vector_ids', { index_host: HOST }, 'GET', `${DATA}/vectors/list`],
    ['pinecone_upsert_records', { index_host: HOST, namespace: 'faq', records_ndjson: '{"_id":"a"}' }, 'POST', `${DATA}/records/namespaces/faq/upsert`],
    ['pinecone_update_metadata', { index_host: HOST, id: 'a', set_metadata: { x: 1 } }, 'POST', `${DATA}/vectors/update`],
    ['pinecone_delete_vectors', { index_host: HOST, ids: ['a'] }, 'POST', `${DATA}/vectors/delete`],
    ['pinecone_list_models', {}, 'GET', `${API}/models`],
    ['pinecone_embed', { inputs: [{ text: 'q' }] }, 'POST', `${API}/embed`],
    ['pinecone_rerank', { query: 'q', documents: [{ text: 'd' }] }, 'POST', `${API}/rerank`],
    ['pinecone_list_assistants', {}, 'GET', `${API}/assistant/assistants`],
    ['pinecone_chat_assistant', { assistant_name: 'helper', messages: [] }, 'POST', 'https://prod-1-data.ke.pinecone.io/assistant/chat/helper'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the documented host and path with Api-Key and the API version', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers['Api-Key']).toBe(FAKE_KEY);
    expect(req.headers['X-Pinecone-Api-Version']).toBe('2026-07');
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('builds query, search and fetch requests with the documented field names and never asks for vector values', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('pinecone_query_vectors', { index_host: HOST, vector: [0.1, 0.2], namespace: 'ns', filter: { genre: { $eq: 'drama' } } });
    expect(sent().data).toEqual({ namespace: 'ns', vector: [0.1, 0.2], topK: 10, filter: { genre: { $eq: 'drama' } }, includeMetadata: true, includeValues: false });
    mockedAxios.mockClear();
    await call('pinecone_search_records', { index_host: HOST, text: 'refunds', top_k: 3, fields: ['chunk_text'], rerank: { model: 'bge-reranker-v2-m3', rank_fields: ['chunk_text'] } });
    expect(sent().data).toEqual({ query: { inputs: { text: 'refunds' }, top_k: 3 }, fields: ['chunk_text'], rerank: { model: 'bge-reranker-v2-m3', rank_fields: ['chunk_text'] } });
    mockedAxios.mockClear();
    const scoreBy = [{ type: 'text', fields: ['content'], query: 'refund policy' }];
    await call('pinecone_search_documents', { index_host: HOST, score_by: scoreBy, include_fields: ['title'] });
    expect(sent().data).toEqual({ score_by: scoreBy, top_k: 10, include_fields: ['title'] });
    mockedAxios.mockClear();
    await call('pinecone_fetch_vectors', { index_host: HOST, ids: ['a', 'b'], namespace: 'ns' });
    expect(sent().params).toEqual({ ids: ['a', 'b'], namespace: 'ns' });
    // Repeated ids=a&ids=b, the OpenAPI default for an exploded array.
    expect(sent().paramsSerializer(sent().params)).toBe('ids=a&ids=b&namespace=ns');
    mockedAxios.mockClear();
    await call('pinecone_list_vector_ids', { index_host: HOST, prefix: 'doc1#', pagination_token: 't' });
    expect(sent().params).toEqual({ prefix: 'doc1#', limit: 100, paginationToken: 't' });
    mockedAxios.mockClear();
    await call('pinecone_list_namespaces', { index_host: HOST });
    expect(sent().params).toEqual({ limit: 100 });
  });

  it('upserts records as NDJSON, updates metadata by id and deletes by ids only', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    const ndjson = '{"_id":"faq-1","chunk_text":"Refunds take 5 days."}\n{"_id":"faq-2","chunk_text":"Shipping is free."}';
    await call('pinecone_upsert_records', { index_host: HOST, records_ndjson: ndjson });
    expect(sent().data).toBe(ndjson);
    expect(sent().headers['Content-Type']).toBe('application/x-ndjson');
    expect(sent().url).toBe(`${DATA}/records/namespaces/__default__/upsert`);
    mockedAxios.mockClear();
    await call('pinecone_update_metadata', { index_host: HOST, id: 'faq-1', set_metadata: { status: 'archived' }, namespace: 'ns' });
    expect(sent().data).toEqual({ id: 'faq-1', setMetadata: { status: 'archived' }, namespace: 'ns' });
    mockedAxios.mockClear();
    await call('pinecone_delete_vectors', { index_host: HOST, ids: ['faq-1'] });
    expect(sent().data).toEqual({ ids: ['faq-1'] });
  });

  it('builds inference and assistant requests with the documented fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('pinecone_embed', { inputs: [{ text: 'q' }] });
    expect(sent().data).toEqual({ model: 'llama-text-embed-v2', inputs: [{ text: 'q' }], parameters: { input_type: 'query' } });
    mockedAxios.mockClear();
    await call('pinecone_rerank', { query: 'q', documents: [{ text: 'd' }], top_n: 1 });
    expect(sent().data).toEqual({ model: 'bge-reranker-v2-m3', query: 'q', documents: [{ text: 'd' }], top_n: 1, return_documents: false, parameters: {} });
    mockedAxios.mockClear();
    await call('pinecone_chat_assistant', { assistant_name: 'helper', assistant_host: 'prod-eu-data.ke.pinecone.io', messages: [{ role: 'user', content: 'hi' }] });
    expect(sent().url).toBe('https://prod-eu-data.ke.pinecone.io/assistant/chat/helper');
    expect(sent().data).toEqual({ messages: [{ role: 'user', content: 'hi' }], stream: false });
  });

  it('gives index_host ready to use, without .pinecone.io', () => {
    const index = {
      name: 'my-index',
      host: `${HOST}.pinecone.io`,
      private_host: `${HOST.replace('.svc.', '.svc.private.')}.pinecone.io`,
      status: { ready: true, state: 'Ready' },
      deployment: { deployment_type: 'managed', cloud: 'aws', region: 'us-east-1' },
      schema: { fields: { _values: { type: 'dense_vector', dimension: 1024, metric: 'cosine' } } },
      deletion_protection: 'disabled',
      tags: null,
    };
    const list = shape('pinecone_list_indexes', { indexes: [index] });
    expect(list.indexes[0]).toMatchObject({ name: 'my-index', index_host: HOST, host: `${HOST}.pinecone.io`, ready: true, state: 'Ready' });
    expect(JSON.stringify(list)).not.toContain('private');
    expect(shape('pinecone_describe_index', index).index_host).toBe(HOST);
  });

  it('drops vector values from queries and fetches and caps hits', () => {
    const q = shape('pinecone_query_vectors', {
      matches: Array.from({ length: 150 }, (_, i) => ({ id: `v${i}`, score: 0.9, values: [0.1, 0.2], sparseValues: { indices: [1], values: [0.5] }, metadata: { genre: 'drama' } })),
      results: [],
      namespace: 'ns',
      usage: { readUnits: 5 },
    });
    expect(q.matches).toHaveLength(100);
    expect(q.matches[0]).toEqual({ id: 'v0', score: 0.9, metadata: { genre: 'drama' } });
    expect(q).toMatchObject({ namespace: 'ns', usage: { readUnits: 5 } });
    const f = shape('pinecone_fetch_vectors', { vectors: { a: { id: 'a', values: [0.1], metadata: { x: 1 } } }, namespace: 'ns', usage: { readUnits: 1 } });
    expect(f.vectors.a).toEqual({ id: 'a', metadata: { x: 1 } });
    const s = shape('pinecone_search_records', { result: { hits: Array.from({ length: 120 }, (_, i) => ({ _id: `r${i}`, _score: 0.5, fields: { chunk_text: 't' } })) }, namespace: '__default__', usage: { read_units: 1, embed_total_tokens: 3 } });
    expect(s.hits).toHaveLength(100);
    expect(s.hits[0]).toEqual({ _id: 'r0', _score: 0.5, fields: { chunk_text: 't' } });
    const ids = shape('pinecone_list_vector_ids', { vectors: [{ id: 'doc1#a' }, { id: 'doc1#b' }], pagination: { next: 'n' }, namespace: 'ns', usage: { readUnits: 1 } });
    expect(ids).toEqual({ ids: ['doc1#a', 'doc1#b'], pagination: { next: 'n' }, namespace: 'ns' });
  });

  it('shapes an assistant answer into text and citations', () => {
    const out = shape('pinecone_chat_assistant', {
      id: 'c1',
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Refunds take 5 days.' },
      model: 'gpt-4o',
      citations: [{ position: 20, references: [{ file: { name: 'faq.pdf', id: 'f1', signed_url: 'https://storage.example/very-long', size: 1, status: 'Available' }, pages: [2], highlight: null }] }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(out).toEqual({
      answer: 'Refunds take 5 days.',
      finish_reason: 'stop',
      model: 'gpt-4o',
      citations: [{ position: 20, references: [{ file: 'faq.pdf', file_id: 'f1', pages: [2] }] }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });
});

const live = process.env.RUN_PINECONE_LIVE === '1' ? describe : describe.skip;
live('pinecone adapter: live', () => {
  const realKey = process.env.PINECONE_API_KEY;
  const env = { PINECONE_API_KEY: realKey ?? '' };
  // Serverless data hosts resolve for any index name, so a made-up index on
  // a real region reaches Pinecone's data plane.
  const PROBE_HOST = 'amcp-probe-0000000.svc.aped-4627-b74a';
  const run = async (name: string, params: Record<string, unknown>) => {
    const out = applyResponseTransform(await call(name, params, env), tool(name).responseMapping as any);
    expect(out.error).toBeUndefined();
    return out.value as any;
  };
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['pinecone_list_indexes', {}],
    ['pinecone_describe_index', { index_name: 'amcp-probe' }],
    ['pinecone_describe_index_stats', { index_host: PROBE_HOST }],
    ['pinecone_list_namespaces', { index_host: PROBE_HOST }],
    ['pinecone_search_records', { index_host: PROBE_HOST, text: 'q' }],
    ['pinecone_search_documents', { index_host: PROBE_HOST, score_by: [{ type: 'text', fields: ['a'], query: 'q' }] }],
    ['pinecone_query_vectors', { index_host: PROBE_HOST, id: 'a' }],
    ['pinecone_fetch_vectors', { index_host: PROBE_HOST, ids: ['a'] }],
    ['pinecone_list_vector_ids', { index_host: PROBE_HOST }],
    ['pinecone_upsert_records', { index_host: PROBE_HOST, records_ndjson: '{"_id":"a","chunk_text":"x"}' }],
    ['pinecone_update_metadata', { index_host: PROBE_HOST, id: 'a', set_metadata: { x: 1 } }],
    ['pinecone_delete_vectors', { index_host: PROBE_HOST, ids: ['a'] }],
    ['pinecone_embed', { inputs: [{ text: 'q' }] }],
    ['pinecone_rerank', { query: 'q', documents: [{ text: 'd' }] }],
    ['pinecone_list_assistants', {}],
    ['pinecone_chat_assistant', { assistant_name: 'amcp-probe', messages: [{ role: 'user', content: 'hi' }] }],
  ])('%s reaches a real route and Pinecone refuses a made-up key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers 404 on made-up routes of the data and assistant hosts', async () => {
    const headers = { 'Api-Key': FAKE_KEY, 'X-Pinecone-Api-Version': '2026-07' };
    await expect((mockedAxios.__actual as any).request({ url: `https://${PROBE_HOST}.pinecone.io/does-not-exist`, headers })).rejects.toMatchObject({ response: { status: 404 } });
    await expect((mockedAxios.__actual as any).request({ url: 'https://prod-1-data.ke.pinecone.io/assistant/does-not-exist', headers })).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (realKey ? it : it.skip)('reads: indexes, stats, namespaces, ids, models, assistants', async () => {
    const list = await run('pinecone_list_indexes', {});
    expect(Array.isArray(list.indexes)).toBe(true);
    const models = await run('pinecone_list_models', { type: 'embed' });
    expect(models.models.length).toBeGreaterThan(0);
    expect(Array.isArray((await run('pinecone_list_assistants', {})).assistants ?? [])).toBe(true);
    const name = process.env.PINECONE_TEST_INDEX ?? list.indexes[0]?.name;
    if (!name) return;
    const index = await run('pinecone_describe_index', { index_name: name });
    expect(index.index_host).not.toMatch(/pinecone\.io$/);
    const stats = await run('pinecone_describe_index_stats', { index_host: index.index_host });
    expect(stats.namespaces).toBeDefined();
    const ns = await run('pinecone_list_namespaces', { index_host: index.index_host });
    expect(Array.isArray(ns.namespaces ?? [])).toBe(true);
    const ids = await run('pinecone_list_vector_ids', { index_host: index.index_host, limit: 5 });
    if (ids.ids?.length) {
      const fetched = await run('pinecone_fetch_vectors', { index_host: index.index_host, ids: ids.ids.slice(0, 2) });
      for (const v of Object.values<any>(fetched.vectors)) expect(v.values).toBeUndefined();
      const q = await run('pinecone_query_vectors', { index_host: index.index_host, id: ids.ids[0], top_k: 3 });
      for (const m of q.matches) expect(m.values).toBeUndefined();
    }
  }, 120000);

  (realKey && process.env.RUN_PINECONE_LIVE_WRITES === '1' && process.env.PINECONE_TEST_INDEX ? it : it.skip)(
    'writes: upsert one text record, search it, update its metadata, delete it',
    async () => {
      const field = process.env.PINECONE_TEST_FIELD ?? 'chunk_text';
      const index = await run('pinecone_describe_index', { index_name: process.env.PINECONE_TEST_INDEX });
      const id = `amcp-live-${Date.now()}`;
      const namespace = 'amcp-live-test';
      await run('pinecone_upsert_records', { index_host: index.index_host, namespace, records_ndjson: JSON.stringify({ _id: id, [field]: 'AnythingMCP live test record about refunds' }) });
      await new Promise((r) => setTimeout(r, 10000));
      const found = await run('pinecone_search_records', { index_host: index.index_host, namespace, text: 'refunds', top_k: 3 });
      expect(found.hits.map((h: any) => h._id)).toContain(id);
      await run('pinecone_update_metadata', { index_host: index.index_host, namespace, id, set_metadata: { checked: true } });
      await run('pinecone_delete_vectors', { index_host: index.index_host, namespace, ids: [id] });
    },
    120000,
  );
});
