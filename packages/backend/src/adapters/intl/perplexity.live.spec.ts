import axios from 'axios';
import * as adapter from './perplexity.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Perplexity API adapter:
 *
 *   1. Static: always runs. Pins Bearer auth, every tool's method, URL and
 *      body through the real RestEngine, checked against Perplexity's OpenAPI
 *      document (docs.perplexity.ai/openapi.json, fetched 13 Oct 2026): the
 *      Agent API body with its web_search tool and filters, the Search API,
 *      Sonar chat completions (the model names of that document), background
 *      runs, cancel and the model list. Also the cheap defaults, the failed-run
 *      error rule and the response shaping.
 *
 *   2. Live: skipped unless RUN_PERPLEXITY_LIVE=1. Without a key it checks
 *      that Perplexity refuses a wrong one with 401 on every real route and
 *      answers 404 on a made-up one. With PERPLEXITY_API_KEY it lists the
 *      models (free) and runs one Search API request (fast, 1 result, a
 *      tenth of a cent):
 *
 *        RUN_PERPLEXITY_LIVE=1 PERPLEXITY_API_KEY=pplx-... npx jest src/adapters/intl/perplexity.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping?: Record<string, unknown> };
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
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown };
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

const BASE = 'https://api.perplexity.ai';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'pplx-' + 'x'.repeat(48);
const ENV: Record<string, string> = { PERPLEXITY_API_KEY: FAKE_KEY };

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
      errorWhen: a.connector.config.errorWhen,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);

const READ_ONLY = ['perplexity_ask', 'perplexity_get_response', 'perplexity_list_models', 'perplexity_search', 'perplexity_sonar'];

// An Agent API response as the OpenAPI document describes it.
const AGENT_RESPONSE = {
  id: 'resp_1',
  object: 'response',
  created_at: 1784292159,
  model: 'openai/gpt-5.6-luna',
  status: 'completed',
  output: [
    {
      type: 'search_results',
      queries: ['ai agents news'],
      results: [
        { id: 1, title: 'State of AI Agents', url: 'https://a.example', snippet: 'Autonomy...', date: '2026-02-26', last_updated: '2026-07-12', source: 'web' },
        { id: 2, title: 'Agents roundup', url: 'https://b.example', snippet: 'Launches...', source: 'web' },
      ],
    },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: 'Agents gained autonomy[1] ', annotations: [{ type: 'url_citation', url: 'https://a.example', title: 'State' }] },
        { type: 'output_text', text: 'and new toolkits[2].', annotations: [] },
      ],
    },
  ],
  usage: { input_tokens: 900, output_tokens: 120, total_tokens: 1020, cost: { currency: 'USD', input_cost: 0.0002, output_cost: 0.0001, total_cost: 0.0013 } },
};

describe('perplexity adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (checked against the OpenAPI document on 13 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('authenticates with the API key as Bearer, on api.perplexity.ai', () => {
    expect(a.category).toBe('data');
    expect(a.icon).toBe('perplexity');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{PERPLEXITY_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/v1/models');
    expect(a.requiredEnvVars).toEqual(['PERPLEXITY_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'PERPLEXITY_API_KEY', kind: 'credential', secret: true, required: true });
  });

  it('accepts Perplexity key formats and refuses pasted Bearer headers', () => {
    const key = new RegExp(a.envVarMeta.PERPLEXITY_API_KEY.pattern!);
    for (const ok of [FAKE_KEY, 'pplx-' + 'Ab1'.repeat(16)]) expect(key.test(ok)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, 'sk-' + 'x'.repeat(40), `${FAKE_KEY} `, 'pplx-short']) expect(key.test(bad)).toBe(false);
  });

  it('probes with the free model list and explains 401 as a wrong key or no credits', () => {
    expect(a.probe).toEqual({ tool: 'perplexity_list_models' });
    for (const status of ['400', '401', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/no API credits left/);
  });

  it('prefixes every tool with perplexity_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^perplexity_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks answers and searches read-only, a research start additive and cancel destructive', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    expect(annotationsOf(tool('perplexity_start_research'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsOf(tool('perplexity_cancel_response'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool('perplexity_cancel_response').description).toMatch(/Confirm with the user first/);
    expect(tool('perplexity_start_research').description).toMatch(/confirm with the user/);
  });

  it('keeps the defaults cheap and synchronous calls inside the 30 second engine timeout', () => {
    expect(tool('perplexity_ask').parameters.properties!.preset).toMatchObject({ default: 'fast', enum: ['fast', 'low'] });
    expect(tool('perplexity_search').parameters.properties!.search_type.default).toBe('fast');
    expect(tool('perplexity_search').parameters.properties!.max_results.default).toBe(5);
    expect(tool('perplexity_sonar').parameters.properties!.model).toMatchObject({ default: 'sonar', enum: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'] });
    expect(tool('perplexity_sonar').parameters.properties!.search_context_size.default).toBe('low');
    expect(tool('perplexity_start_research').parameters.properties!.preset).toMatchObject({ default: 'medium', enum: ['medium', 'high', 'xhigh'] });
    expect(tool('perplexity_start_research').endpointMapping.bodyMapping!.background).toBe(true);
  });

  it('only points the model at tools that exist, documents setup, cost and the Sonar end of support, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bperplexity_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bperplexity_[a-z_]+/g), ...JSON.stringify(t.parameters).matchAll(/\bperplexity_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://console.perplexity.ai');
    expect(a.instructions).toMatch(/billed to the user's Perplexity credits/);
    expect(a.instructions).toMatch(/ended support for Sonar Chat Completions on 27 September 2026/);
    expect(a.instructions).toMatch(/Out of scope/);
    expect(a.prerequisites).toMatch(/Pro subscription does not include API usage/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('carries valid response mappings and error rules', () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    for (const t of a.tools) {
      if (t.responseMapping?.transform) expect(validateTransform(t.responseMapping.transform)).toBeNull();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['perplexity_ask', { input: 'Hi' }, 'POST', `${BASE}/v1/agent`],
    ['perplexity_search', { query: 'mcp' }, 'POST', `${BASE}/search`],
    ['perplexity_sonar', { prompt: 'Hi' }, 'POST', `${BASE}/v1/sonar`],
    ['perplexity_start_research', { input: 'Report on MCP' }, 'POST', `${BASE}/v1/agent`],
    ['perplexity_get_response', { id: 'resp_1' }, 'GET', `${BASE}/v1/agent/resp_1`],
    ['perplexity_cancel_response', { id: 'resp_1' }, 'POST', `${BASE}/v1/agent/resp_1/cancel`],
    ['perplexity_list_models', {}, 'GET', `${BASE}/v1/models`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer key', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('asks the Agent API with the fast preset and puts the filters on the web_search tool', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('perplexity_ask', { input: 'Hi' });
    expect(sent().data).toEqual({ input: 'Hi', preset: 'fast', tools: [{ type: 'web_search', filters: {} }] });
    mockedAxios.mockClear();
    await call('perplexity_ask', {
      input: 'News on the EU AI Act',
      preset: 'low',
      search_domain_filter: ['europa.eu'],
      search_recency_filter: 'week',
      search_after_date_filter: '10/01/2026',
      max_results: 5,
      search_type: 'web',
      language_preference: 'de',
    });
    expect(sent().data).toEqual({
      input: 'News on the EU AI Act',
      preset: 'low',
      language_preference: 'de',
      tools: [
        {
          type: 'web_search',
          search_type: 'web',
          max_results: 5,
          filters: { search_domain_filter: ['europa.eu'], search_recency_filter: 'week', search_after_date_filter: '10/01/2026' },
        },
      ],
    });
  });

  it('starts research as a background run on the medium preset', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('perplexity_start_research', { input: 'Report on MCP', search_recency_filter: 'month' });
    expect(sent().data).toEqual({
      input: 'Report on MCP',
      preset: 'medium',
      background: true,
      tools: [{ type: 'web_search', filters: { search_recency_filter: 'month' } }],
    });
  });

  it('searches with fast search and 5 results, and asks Sonar with a system and a user message', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('perplexity_search', { query: 'mcp', search_domain_filter: ['-reddit.com'] });
    expect(sent().data).toEqual({ query: 'mcp', max_results: 5, search_type: 'fast', search_domain_filter: ['-reddit.com'] });
    mockedAxios.mockClear();
    await call('perplexity_sonar', { prompt: 'Hi', search_recency_filter: 'day', return_related_questions: true });
    expect(sent().data).toEqual({
      model: 'sonar',
      messages: [
        { role: 'system', content: 'Be precise and concise.' },
        { role: 'user', content: 'Hi' },
      ],
      search_recency_filter: 'day',
      return_related_questions: true,
      web_search_options: { search_context_size: 'low' },
    });
    mockedAxios.mockClear();
    await call('perplexity_cancel_response', { id: 'resp_1' });
    expect(sent().data).toBeUndefined();
  });

  it('shapes an Agent API answer into text, sources, citations and cost', () => {
    for (const name of ['perplexity_ask', 'perplexity_get_response']) {
      const out = shape(name, AGENT_RESPONSE);
      expect(out.error).toBeUndefined();
      expect(out.value).toEqual({
        id: 'resp_1',
        status: 'completed',
        model: 'openai/gpt-5.6-luna',
        answer: 'Agents gained autonomy[1] and new toolkits[2].',
        sources: [
          { id: 1, title: 'State of AI Agents', url: 'https://a.example', date: '2026-02-26', snippet: 'Autonomy...' },
          { id: 2, title: 'Agents roundup', url: 'https://b.example', date: null, snippet: 'Launches...' },
        ],
        citations: ['https://a.example'],
        usage: { input_tokens: 900, output_tokens: 120, total_cost: 0.0013, currency: 'USD' },
      });
    }
  });

  it('shapes a queued background run without inventing an answer', () => {
    const out = shape('perplexity_get_response', { id: 'resp_2', object: 'response', created_at: 1, model: 'openai/gpt-5.6-luna', status: 'in_progress', output: [] });
    expect(out.value).toEqual({ id: 'resp_2', status: 'in_progress', model: 'openai/gpt-5.6-luna', answer: '', sources: [], citations: [] });
  });

  it('shapes a Sonar completion into answer, citations and search results', () => {
    const raw = {
      id: 'c1',
      model: 'sonar',
      created: 1,
      object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Answer [1].' }, delta: {} }],
      citations: ['https://a.example'],
      search_results: [{ title: 'A', url: 'https://a.example', date: '2026-06-14', last_updated: '2026-06-21', snippet: 'S', source: 'web' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, search_context_size: 'low', cost: { input_tokens_cost: 0, output_tokens_cost: 0, request_cost: 0.005, total_cost: 0.005 } },
    };
    expect(shape('perplexity_sonar', raw).value).toEqual({
      id: 'c1',
      model: 'sonar',
      answer: 'Answer [1].',
      finish_reason: 'stop',
      citations: ['https://a.example'],
      search_results: [{ title: 'A', url: 'https://a.example', date: '2026-06-14', snippet: 'S' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_cost: 0.005 },
    });
  });

  it('turns a failed run into an error with Perplexity message, and leaves the others alone', async () => {
    mockedAxios.mockResolvedValue({ data: { ...AGENT_RESPONSE, status: 'failed', output: [], error: { code: 'internal_error', message: 'The run failed.' } } });
    await expect(call('perplexity_get_response', { id: 'resp_1' })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('The run failed.') });
    mockedAxios.mockResolvedValue({ data: { ...AGENT_RESPONSE, status: 'incomplete' } });
    await expect(call('perplexity_get_response', { id: 'resp_1' })).resolves.toBeDefined();
    mockedAxios.mockResolvedValue({ data: { response_id: 'resp_1', status: 'cancelling' } });
    await expect(call('perplexity_cancel_response', { id: 'resp_1' })).resolves.toEqual({ response_id: 'resp_1', status: 'cancelling' });
  });
});

const live = process.env.RUN_PERPLEXITY_LIVE ? describe : describe.skip;
live('perplexity adapter: live', () => {
  const realKey = process.env.PERPLEXITY_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each<[string, Record<string, unknown>]>([
    ['perplexity_ask', { input: 'What is MCP?' }],
    ['perplexity_search', { query: 'model context protocol' }],
    ['perplexity_sonar', { prompt: 'What is MCP?' }],
    ['perplexity_start_research', { input: 'Report on MCP' }],
    ['perplexity_get_response', { id: 'resp_00000000-0000-0000-0000-000000000000' }],
    ['perplexity_cancel_response', { id: 'resp_00000000-0000-0000-0000-000000000000' }],
    ['perplexity_list_models', {}],
  ])('%s reaches a real route that refuses a wrong key with 401', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401, data: { error: { type: 'invalid_api_key' } } } });
  }, 30000);

  it('answers 404 on a made-up route', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/v1/does-not-exist`, headers: { Authorization: `Bearer ${FAKE_KEY}` } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (realKey ? it : it.skip)('lists the models and runs one fast search', async () => {
    const env = { PERPLEXITY_API_KEY: realKey! };
    const models = shape('perplexity_list_models', await call('perplexity_list_models', {}, env)).value as any;
    expect(models.models.length).toBeGreaterThan(0);
    const res = shape('perplexity_search', await call('perplexity_search', { query: 'Model Context Protocol', max_results: 1 }, env)).value as any;
    expect(res.results.length).toBeGreaterThan(0);
  }, 60000);
});
