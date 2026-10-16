import axios from 'axios';
import * as adapter from './exa.json';
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
 * Two layers of verification for the Exa adapter:
 *
 *   1. Static: always runs. Pins the x-api-key header on api.exa.ai, every
 *      tool's method, URL and body through the real RestEngine, checked
 *      against Exa's OpenAPI document (exa.ai/docs/exa-spec.yaml, fetched
 *      13 Oct 2026): camelCase body fields, the contents object, the Agent
 *      run request. Also the cheap defaults (search type auto, 10 results,
 *      highlights, Agent effort medium) and the response shaping.
 *
 *   2. Live: skipped unless RUN_EXA_LIVE=1. Without a key it checks that Exa
 *      refuses a wrong one with 401 on every real route and answers 404 on a
 *      made-up one. With EXA_API_KEY it lists Agent runs (free) and runs one
 *      instant search with 1 result (about $0.004):
 *
 *        RUN_EXA_LIVE=1 EXA_API_KEY=... npx jest src/adapters/intl/exa.live.spec.ts
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

const BASE = 'https://api.exa.ai';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['0000aaaa', '1111', '2222', '3333', 'bbbbcccc4444'].join('-');
const ENV: Record<string, string> = { EXA_API_KEY: FAKE_KEY };

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

const READ_ONLY = ['exa_answer', 'exa_find_similar', 'exa_get_agent_run', 'exa_get_contents', 'exa_list_agent_runs', 'exa_search'];

describe('exa adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until it has been tried with a real key', () => {
    expect(a.unlisted).toBe(true);
  });

  it('sends the API key as x-api-key, on api.exa.ai', () => {
    expect(a.category).toBe('data');
    expect(a.icon).toBe('exa');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-api-key', apiKey: '{{EXA_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/agent/runs?limit=1');
    expect(a.requiredEnvVars).toEqual(['EXA_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'EXA_API_KEY', kind: 'credential', secret: true, required: true });
  });

  it('accepts a key and refuses pasted headers or spaces', () => {
    const key = new RegExp(a.envVarMeta.EXA_API_KEY.pattern!);
    for (const ok of [FAKE_KEY, 'a'.repeat(32)]) expect(key.test(ok)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, `x-api-key: ${FAKE_KEY}`, `${FAKE_KEY} `, 'short']) expect(key.test(bad)).toBe(false);
  });

  it('probes with the free run list and explains the documented error codes', () => {
    expect(a.probe).toEqual({ tool: 'exa_list_agent_runs', params: { limit: 1 } });
    for (const status of ['401', '402', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toContain('dashboard.exa.ai');
  });

  it('prefixes every tool with exa_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^exa_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks the POST searches read-only, the run start additive and the cancel a write', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    expect(annotationsOf(tool('exa_start_agent_run'))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(annotationsOf(tool('exa_cancel_agent_run'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.every((t) => t.enabled !== false)).toBe(true);
  });

  it('keeps the defaults cheap', () => {
    const search = tool('exa_search').parameters.properties!;
    expect(search.type.default).toBe('auto');
    expect(search.type.enum).toEqual(['instant', 'fast', 'auto', 'deep-lite', 'deep', 'deep-reasoning']);
    expect(search.num_results.default).toBe(10);
    expect(search.num_results.maximum).toBe(100);
    expect(search.highlights.default).toBe(true);
    expect(search.text.default).toBeUndefined();
    expect(search.summary.default).toBeUndefined();
    expect(tool('exa_get_contents').parameters.properties!.livecrawl_timeout.maximum).toBeLessThanOrEqual(20000);
    const effort = tool('exa_start_agent_run').parameters.properties!.effort;
    expect(effort.default).toBe('medium');
    expect(effort.enum).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'auto', 'ultra']);
  });

  it('only points the model at tools that exist, documents setup and cost, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bexa_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bexa_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://dashboard.exa.ai/api-keys');
    expect(a.instructions).toMatch(/billed to the user's Exa credits/);
    expect(a.instructions).toMatch(/costDollars/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings', () => {
    for (const t of a.tools) {
      if (t.responseMapping?.transform) expect(validateTransform(t.responseMapping.transform)).toBeNull();
    }
  });

  const RUN = 'agent_run_01jtest';
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['exa_search', { query: 'mcp servers' }, 'POST', `${BASE}/search`],
    ['exa_get_contents', { urls: ['https://example.com'] }, 'POST', `${BASE}/contents`],
    ['exa_answer', { query: 'What is MCP?' }, 'POST', `${BASE}/answer`],
    ['exa_find_similar', { url: 'https://example.com' }, 'POST', `${BASE}/findSimilar`],
    ['exa_start_agent_run', { query: 'Find MCP gateways' }, 'POST', `${BASE}/agent/runs`],
    ['exa_get_agent_run', { id: RUN }, 'GET', `${BASE}/agent/runs/${RUN}`],
    ['exa_list_agent_runs', {}, 'GET', `${BASE}/agent/runs`],
    ['exa_cancel_agent_run', { id: RUN }, 'POST', `${BASE}/agent/runs/${RUN}/cancel`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the x-api-key header', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers['x-api-key']).toBe(FAKE_KEY);
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('searches with the cheap defaults and maps options to Exa field names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('exa_search', { query: 'mcp servers' });
    expect(sent().data).toEqual({ query: 'mcp servers', type: 'auto', numResults: 10, contents: { highlights: true } });
    mockedAxios.mockClear();
    await call('exa_search', {
      query: 'eu ai act guidance',
      type: 'deep',
      num_results: 5,
      category: 'news',
      include_domains: ['europa.eu'],
      exclude_domains: ['reddit.com'],
      start_published_date: '2026-01-01T00:00:00Z',
      user_location: 'DE',
      text: true,
      summary: { query: 'obligations' },
      max_age_hours: 0,
      output_schema: { type: 'text', description: 'a short answer' },
      additional_queries: ['AI Act implementation'],
    });
    expect(sent().data).toEqual({
      query: 'eu ai act guidance',
      type: 'deep',
      numResults: 5,
      category: 'news',
      includeDomains: ['europa.eu'],
      excludeDomains: ['reddit.com'],
      startPublishedDate: '2026-01-01T00:00:00Z',
      userLocation: 'DE',
      outputSchema: { type: 'text', description: 'a short answer' },
      additionalQueries: ['AI Act implementation'],
      contents: { highlights: true, text: true, summary: { query: 'obligations' }, maxAgeHours: 0 },
    });
  });

  it('reads contents, answers and similar pages with the documented fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('exa_get_contents', { urls: ['https://a.example'], highlights: true, subpages: 2, subpage_target: ['pricing'], livecrawl_timeout: 8000 });
    expect(sent().data).toEqual({ urls: ['https://a.example'], text: true, highlights: true, subpages: 2, subpageTarget: ['pricing'], livecrawlTimeout: 8000 });
    mockedAxios.mockClear();
    await call('exa_answer', { query: 'Who maintains MCP?', system_prompt: 'Be brief', output_schema: { type: 'object' } });
    expect(sent().data).toEqual({ query: 'Who maintains MCP?', systemPrompt: 'Be brief', outputSchema: { type: 'object' } });
    mockedAxios.mockClear();
    await call('exa_find_similar', { url: 'https://example.com', exclude_source_domain: true, num_results: 3 });
    expect(sent().data).toEqual({ url: 'https://example.com', numResults: 3, excludeSourceDomain: true, contents: { highlights: true } });
  });

  it('starts an Agent run on medium effort and sends only the given options', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('exa_start_agent_run', { query: 'Find MCP gateways' });
    expect(sent().data).toEqual({ query: 'Find MCP gateways', effort: 'medium' });
    mockedAxios.mockClear();
    await call('exa_start_agent_run', {
      query: 'Enrich these',
      effort: 'auto',
      input: { data: [{ company: 'Acme' }] },
      output_schema: { type: 'object', properties: { ceo: { type: 'string' } } },
      data_sources: [{ provider: 'similarweb' }],
      budget: { maxCostDollars: 2 },
      previous_run_id: 'agent_run_prev',
    });
    expect(sent().data).toEqual({
      query: 'Enrich these',
      effort: 'auto',
      input: { data: [{ company: 'Acme' }] },
      outputSchema: { type: 'object', properties: { ceo: { type: 'string' } } },
      dataSources: [{ provider: 'similarweb' }],
      budget: { maxCostDollars: 2 },
      previousRunId: 'agent_run_prev',
    });
    mockedAxios.mockClear();
    await call('exa_list_agent_runs', { cursor: 'agent_run_x' });
    expect(sent().params).toEqual({ limit: 10, cursor: 'agent_run_x' });
  });

  it('shapes a search into results, synthesized output and cost', () => {
    const raw = {
      requestId: 'r1',
      resolvedSearchType: 'neural',
      results: [{ id: 'https://a.example', title: 'A', url: 'https://a.example', publishedDate: '2026-01-02', author: null, highlights: ['x'], highlightScores: [0.4], favicon: 'f', image: 'i' }],
      output: { content: 'answer', grounding: [] },
      costDollars: { total: 0.007 },
      searchTime: 300,
    };
    const out = applyResponseTransform(raw, tool('exa_search').responseMapping as any);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      requestId: 'r1',
      results: [{ id: 'https://a.example', title: 'A', url: 'https://a.example', publishedDate: '2026-01-02', author: null, highlights: ['x'] }],
      output: { content: 'answer', grounding: [] },
      costDollars: { total: 0.007 },
    });
  });

  it('shapes the run list into ids, status, query and cost', () => {
    const raw = {
      object: 'list',
      data: [{ id: RUN, object: 'agent_run', status: 'completed', stopReason: 'schema_satisfied', createdAt: 'c', completedAt: 'd', request: { query: 'q', effort: 'low' }, output: { text: 'long' }, usage: {}, costDollars: { total: 0.025 } }],
      hasMore: false,
      nextCursor: null,
    };
    const out = applyResponseTransform(raw, tool('exa_list_agent_runs').responseMapping as any);
    expect(out.value).toEqual({
      runs: [{ id: RUN, status: 'completed', stopReason: 'schema_satisfied', query: 'q', effort: 'low', createdAt: 'c', completedAt: 'd', costDollars: 0.025 }],
      hasMore: false,
      nextCursor: null,
    });
  });
});

const live = process.env.RUN_EXA_LIVE === '1' ? describe : describe.skip;
live('exa adapter: live', () => {
  const realKey = process.env.EXA_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['exa_search', { query: 'model context protocol', type: 'instant', num_results: 1 }],
    ['exa_get_contents', { urls: ['https://example.com'] }],
    ['exa_answer', { query: 'What is the Model Context Protocol?' }],
    ['exa_find_similar', { url: 'https://modelcontextprotocol.io', num_results: 1 }],
    ['exa_start_agent_run', { query: 'List three MCP gateways', effort: 'minimal' }],
    ['exa_get_agent_run', { id: 'agent_run_doesnotexist' }],
    ['exa_list_agent_runs', { limit: 1 }],
    ['exa_cancel_agent_run', { id: 'agent_run_doesnotexist' }],
  ])('%s reaches a real route and Exa refuses a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers 404 on a made-up route', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/does-not-exist`, method: 'GET', headers: { 'x-api-key': FAKE_KEY } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (realKey ? it : it.skip)('lists Agent runs (free) and runs one instant search with 1 result', async () => {
    const env = { EXA_API_KEY: realKey! };
    const runs = await call('exa_list_agent_runs', { limit: 1 }, env);
    expect(Array.isArray(runs.data)).toBe(true);
    const raw = await call('exa_search', { query: 'Model Context Protocol', type: 'instant', num_results: 1 }, env);
    expect(raw.results.length).toBeGreaterThan(0);
    expect(raw.costDollars.total).toBeGreaterThan(0);
  }, 60000);
});
