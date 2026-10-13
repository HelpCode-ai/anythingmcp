import axios from 'axios';
import * as adapter from './tavily.json';
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
 * Two layers of verification for the Tavily adapter:
 *
 *   1. Static: always runs. Pins Bearer auth, every tool's method, URL and
 *      body through the real RestEngine, checked against Tavily's OpenAPI
 *      document (docs.tavily.com/documentation/api-reference/openapi.json,
 *      fetched 13 Oct 2026): body field names, enums and bounds. Also the
 *      cheap defaults (basic depth, 5 results, small crawls inside the 30 s
 *      engine timeout) and the response shaping.
 *
 *   2. Live: skipped unless RUN_TAVILY_LIVE=1. Without a key it checks that
 *      Tavily refuses a wrong one with 401 on a real route and answers 404 on
 *      a made-up one. With TAVILY_API_KEY it reads the usage counters and runs
 *      one basic search with 1 result (1 credit):
 *
 *        RUN_TAVILY_LIVE=1 TAVILY_API_KEY=tvly-... npx jest src/adapters/intl/tavily.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[]; minimum?: number; maximum?: number }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.tavily.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'tvly-dev-' + 'x'.repeat(32);
const ENV: Record<string, string> = { TAVILY_API_KEY: FAKE_KEY };

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

const READ_ONLY = ['tavily_crawl', 'tavily_extract', 'tavily_get_research', 'tavily_get_usage', 'tavily_map', 'tavily_search'];

describe('tavily adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (checked against the OpenAPI document on 13 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('authenticates with the API key as Bearer, on api.tavily.com', () => {
    expect(a.category).toBe('data');
    expect(a.icon).toBe('tavily');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{TAVILY_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/usage');
    expect(a.requiredEnvVars).toEqual(['TAVILY_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'TAVILY_API_KEY', kind: 'credential', secret: true, required: true });
  });

  it('accepts Tavily key formats and refuses pasted Bearer headers', () => {
    const key = new RegExp(a.envVarMeta.TAVILY_API_KEY.pattern!);
    for (const ok of [FAKE_KEY, 'tvly-' + 'A1b2'.repeat(8), 'tvly-prod-' + 'z'.repeat(30)]) expect(key.test(ok)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, 'sk-' + 'x'.repeat(40), `${FAKE_KEY} `, 'tvly-']) expect(key.test(bad)).toBe(false);
  });

  it('probes with the usage counters and explains the documented error codes', () => {
    expect(a.probe).toEqual({ tool: 'tavily_get_usage' });
    for (const status of ['400', '401', '429', '432', '433']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/app\.tavily\.com/);
  });

  it('prefixes every tool with tavily_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^tavily_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks searches, extraction, maps and crawls read-only and the research start as an additive write', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    expect(annotationsOf(tool('tavily_start_research'))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(a.tools.every((t) => t.enabled !== false)).toBe(true);
  });

  it('keeps the defaults cheap and inside the 30 second engine timeout', () => {
    const search = tool('tavily_search').parameters.properties!;
    expect(search.search_depth.default).toBe('basic');
    expect(search.max_results.default).toBe(5);
    expect(search.topic.default).toBe('general');
    expect(search.include_answer.default).toBeUndefined();
    expect(search.include_raw_content.default).toBeUndefined();
    expect(tool('tavily_extract').parameters.properties!.extract_depth.default).toBe('basic');
    expect(tool('tavily_extract').parameters.properties!.timeout.maximum).toBeLessThanOrEqual(25);
    for (const name of ['tavily_map', 'tavily_crawl']) {
      const p = tool(name).parameters.properties!;
      expect(p.max_depth.default).toBe(1);
      expect(p.timeout.default).toBe(25);
      expect(p.timeout.maximum).toBeLessThanOrEqual(25);
      expect(p.limit.default as number).toBeLessThanOrEqual(20);
    }
    expect(tool('tavily_start_research').parameters.properties!.model.default).toBe('mini');
  });

  it('only points the model at tools that exist, documents setup and cost, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\btavily_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\btavily_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://app.tavily.com');
    expect(a.instructions).toMatch(/spend Tavily API credits/);
    expect(a.instructions).toMatch(/432/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('carries valid response mappings', () => {
    for (const t of a.tools) {
      if (t.responseMapping?.transform) expect(validateTransform(t.responseMapping.transform)).toBeNull();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['tavily_search', { query: 'mcp' }, 'POST', `${BASE}/search`],
    ['tavily_extract', { urls: ['https://example.com'] }, 'POST', `${BASE}/extract`],
    ['tavily_map', { url: 'https://example.com' }, 'POST', `${BASE}/map`],
    ['tavily_crawl', { url: 'https://example.com' }, 'POST', `${BASE}/crawl`],
    ['tavily_start_research', { input: 'State of MCP adoption' }, 'POST', `${BASE}/research`],
    ['tavily_get_research', { request_id: 'req-1' }, 'GET', `${BASE}/research/req-1`],
    ['tavily_get_usage', {}, 'GET', `${BASE}/usage`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer key', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('searches with the cheap defaults and only the given options', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('tavily_search', { query: 'mcp' });
    expect(sent().data).toEqual({ query: 'mcp', search_depth: 'basic', topic: 'general', max_results: 5, include_usage: true });
    mockedAxios.mockClear();
    await call('tavily_search', {
      query: 'eu ai act',
      search_depth: 'advanced',
      topic: 'news',
      time_range: 'week',
      include_answer: 'basic',
      include_domains: ['europa.eu'],
      exclude_domains: ['reddit.com'],
      max_results: 3,
    });
    expect(sent().data).toEqual({
      query: 'eu ai act',
      search_depth: 'advanced',
      topic: 'news',
      max_results: 3,
      time_range: 'week',
      include_answer: 'basic',
      include_domains: ['europa.eu'],
      exclude_domains: ['reddit.com'],
      include_usage: true,
    });
  });

  it('extracts, maps and crawls with the documented fields and small limits', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('tavily_extract', { urls: ['https://a.example', 'https://b.example'], query: 'pricing' });
    expect(sent().data).toEqual({ urls: ['https://a.example', 'https://b.example'], query: 'pricing', extract_depth: 'basic', format: 'markdown', include_usage: true });
    mockedAxios.mockClear();
    await call('tavily_map', { url: 'https://docs.example.com', select_paths: ['/api/.*'] });
    expect(sent().data).toEqual({ url: 'https://docs.example.com', max_depth: 1, max_breadth: 20, limit: 20, select_paths: ['/api/.*'], timeout: 25, include_usage: true });
    mockedAxios.mockClear();
    await call('tavily_crawl', { url: 'https://docs.example.com', instructions: 'auth pages' });
    expect(sent().data).toEqual({
      url: 'https://docs.example.com',
      instructions: 'auth pages',
      max_depth: 1,
      max_breadth: 20,
      limit: 10,
      extract_depth: 'basic',
      format: 'markdown',
      timeout: 25,
      include_usage: true,
    });
  });

  it('starts research on the mini model and polls it with usage', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('tavily_start_research', { input: 'State of MCP adoption', output_length: 'short' });
    expect(sent().data).toEqual({ input: 'State of MCP adoption', model: 'mini', output_length: 'short' });
    mockedAxios.mockClear();
    await call('tavily_get_research', { request_id: 'req-1' });
    expect(sent().params).toEqual({ include_usage: true });
    expect(sent().data).toBeUndefined();
  });

  it('scopes usage to a project only when one is given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('tavily_get_usage', {});
    expect(sent().headers).not.toHaveProperty('X-Project-ID');
    mockedAxios.mockClear();
    await call('tavily_get_usage', { project_id: 'proj-1' });
    expect(sent().headers['X-Project-ID']).toBe('proj-1');
  });

  it('shapes a search into its answer, sources and credits', () => {
    const raw = {
      query: 'mcp',
      follow_up_questions: null,
      answer: 'MCP is a protocol.',
      images: [],
      results: [
        { url: 'https://modelcontextprotocol.io', title: 'MCP', content: 'Intro', score: 0.9, raw_content: null, favicon: 'https://x/fav.ico' },
      ],
      auto_parameters: { topic: 'general' },
      response_time: 1.2,
      usage: { credits: 1 },
      request_id: 'req-1',
    };
    const out = applyResponseTransform(raw, tool('tavily_search').responseMapping as any);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      query: 'mcp',
      answer: 'MCP is a protocol.',
      results: [{ title: 'MCP', url: 'https://modelcontextprotocol.io', content: 'Intro', score: 0.9, raw_content: null }],
      images: [],
      usage: { credits: 1 },
      request_id: 'req-1',
    });
  });

  it('shapes a finished research job into report and sources', () => {
    const raw = {
      request_id: 'req-1',
      created_at: '2026-10-13T10:00:00Z',
      status: 'completed',
      content: '# Report',
      sources: [{ title: 'A', url: 'https://a.example', favicon: 'https://a.example/f.ico' }],
      response_time: 40,
      usage: { credits: 12 },
    };
    const out = applyResponseTransform(raw, tool('tavily_get_research').responseMapping as any);
    expect(out.value).toEqual({
      request_id: 'req-1',
      status: 'completed',
      content: '# Report',
      sources: [{ title: 'A', url: 'https://a.example' }],
      response_time: 40,
      usage: { credits: 12 },
    });
  });
});

const live = process.env.RUN_TAVILY_LIVE ? describe : describe.skip;
live('tavily adapter: live', () => {
  const realKey = process.env.TAVILY_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it('refuses a wrong key with 401 on a real route', async () => {
    await expect(call('tavily_get_usage', {}, { TAVILY_API_KEY: FAKE_KEY })).rejects.toMatchObject({ response: { status: 401 } });
    await expect(call('tavily_search', { query: 'model context protocol' }, { TAVILY_API_KEY: FAKE_KEY })).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  // Tavily validates some bodies before it checks the key (a too-short query
  // or an unknown research model answers 400 even with a wrong key), so a 401
  // here also says the body the tool builds passed validation.
  it.each([
    ['tavily_search', { query: 'model context protocol', search_depth: 'advanced', topic: 'news', time_range: 'week', include_answer: 'basic', include_raw_content: 'markdown', include_domains: ['europa.eu'], chunks_per_source: 2, country: 'germany' }],
    ['tavily_extract', { urls: ['https://example.com'], query: 'pricing', chunks_per_source: 2, extract_depth: 'advanced', format: 'text', timeout: 20 }],
    ['tavily_map', { url: 'https://example.com', instructions: 'docs', select_paths: ['/docs/.*'], allow_external: false }],
    ['tavily_crawl', { url: 'https://example.com', instructions: 'docs', chunks_per_source: 2, extract_depth: 'advanced' }],
    ['tavily_start_research', { input: 'State of MCP adoption', output_length: 'short', citation_format: 'apa' }],
    ['tavily_get_research', { request_id: '123e4567-e89b-12d3-a456-426614174111' }],
  ])('%s gets past validation to the key check (401)', async (name, params) => {
    await expect(call(name, params, { TAVILY_API_KEY: FAKE_KEY })).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers 404 on a made-up route', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/does-not-exist`, method: 'POST', headers: { Authorization: `Bearer ${FAKE_KEY}` } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (realKey ? it : it.skip)('reads usage and runs one basic search (1 credit)', async () => {
    const env = { TAVILY_API_KEY: realKey! };
    const usage = await call('tavily_get_usage', {}, env);
    expect(usage.key).toBeDefined();
    const raw = await call('tavily_search', { query: 'Model Context Protocol', max_results: 1 }, env);
    expect(raw.results.length).toBeGreaterThan(0);
    expect(raw.usage.credits).toBe(1);
  }, 60000);
});
