import axios from 'axios';
import * as adapter from './serpapi.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { findSecretInQueryParam } from '../../common/secret-literals.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the SerpApi adapter:
 *
 *   1. Static: always runs. Pins the key as the api_key query parameter added
 *      by QUERY_AUTH from the encrypted authConfig (never a literal, never a
 *      tool parameter), every tool's engine and query parameters through the
 *      real RestEngine, the parameter names and enum values against SerpApi's
 *      per-engine parameter catalog (serpapi.com/playground, fetched 13 Oct
 *      2026), the error rule and the response trimming.
 *
 *   2. Live: skipped unless RUN_SERPAPI_LIVE=1. Without a key it checks that
 *      SerpApi refuses a wrong key with 401 (on the free account endpoint and
 *      on a search) and answers 404 on a made-up route, then runs every search
 *      tool on SerpApi's public demo query ("coffee", served without a key) and
 *      shapes the real answers. With SERPAPI_API_KEY it reads the account
 *      (free) and runs one Google search (1 search of the plan):
 *
 *        RUN_SERPAPI_LIVE=1 SERPAPI_API_KEY=... npx jest src/adapters/intl/serpapi.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown> };
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

const BASE = 'https://serpapi.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'f'.repeat(64);
const ENV: Record<string, string> = { SERPAPI_API_KEY: FAKE_KEY };

const call = (name: string, params: Record<string, unknown>, env = ENV, authType = a.connector.authType) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType,
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

// Engine per search tool, and the documented parameter names of each engine
// (SerpApi playground catalog; api_key and engine are SerpApi's own).
const ENGINES: Record<string, [string, string[]]> = {
  serpapi_google_search: ['google', ['q', 'location', 'uule', 'lat', 'lon', 'radius', 'google_domain', 'gl', 'hl', 'cr', 'lr', 'tbs', 'safe', 'nfpr', 'filter', 'tbm', 'start']],
  serpapi_google_news: ['google_news', ['q', 'gl', 'hl', 'topic_token', 'kgmid', 'publication_token', 'section_token', 'story_token', 'so']],
  serpapi_google_images: ['google_images', ['q', 'location', 'uule', 'google_domain', 'gl', 'hl', 'cr', 'period_unit', 'period_value', 'start_date', 'end_date', 'chips', 'tbs', 'imgar', 'imgsz', 'image_color', 'image_type', 'licenses', 'safe', 'nfpr', 'filter', 'ijn']],
  serpapi_google_maps: ['google_maps', ['q', 'll', 'location', 'lat', 'lon', 'z', 'm', 'nearby', 'google_domain', 'hl', 'gl', 'data', 'place_id', 'data_cid', 'type', 'min_price', 'max_price', 'min_rating', 'open_state', 'open_on_day', 'open_at_hour', 'start']],
  serpapi_google_shopping: ['google_shopping', ['q', 'location', 'uule', 'google_domain', 'gl', 'hl', 'shoprs', 'min_price', 'max_price', 'sort_by', 'free_shipping', 'on_sale', 'small_business', 'safe', 'start']],
  serpapi_google_scholar: ['google_scholar', ['q', 'cites', 'as_ylo', 'as_yhi', 'scisbd', 'cluster', 'hl', 'lr', 'start', 'num', 'as_sdt', 'safe', 'filter', 'as_vis', 'as_rr']],
  serpapi_google_trends: ['google_trends', ['q', 'hl', 'geo', 'region', 'data_type', 'tz', 'cat', 'gprop', 'date', 'csv', 'include_low_search_volume']],
  serpapi_youtube_search: ['youtube', ['search_query', 'gl', 'hl', 'sp']],
  serpapi_bing_search: ['bing', ['q', 'location', 'lat', 'lon', 'mkt', 'cc', 'first', 'safeSearch', 'filters']],
};
const SEARCH_TOOLS = Object.keys(ENGINES);

describe('serpapi adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (parameters checked against the engine catalog, mappings against real answers, 13 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.category).toBe('data');
    expect(a.icon).toBe('serpapi');
  });

  it('sends the key as the api_key query parameter from the encrypted authConfig, never as a literal', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ api_key: '{{SERPAPI_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/account.json');
    expect(a.requiredEnvVars).toEqual(['SERPAPI_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'SERPAPI_API_KEY', kind: 'credential', secret: true, required: true });
    // The v0.26.0 secret guard accepts the {{VAR}} reference and would move a
    // pasted literal key out of the query string.
    expect(findSecretInQueryParam('api_key', '{{SERPAPI_API_KEY}}')).toEqual([]);
    expect(findSecretInQueryParam('api_key', 'a1b2c3d4'.repeat(8))).toHaveLength(1);
    for (const t of a.tools) {
      expect(Object.keys(t.endpointMapping.queryParams ?? {})).not.toContain('api_key');
      expect(Object.keys(t.parameters.properties ?? {})).not.toContain('api_key');
    }
  });

  it('accepts the 64-character key and refuses pasted query strings', () => {
    const key = new RegExp(a.envVarMeta.SERPAPI_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `api_key=${FAKE_KEY}`, `${FAKE_KEY} `, 'short']) expect(key.test(bad)).toBe(false);
  });

  it('probes with the free account endpoint and explains the documented error codes', () => {
    expect(a.probe).toEqual({ tool: 'serpapi_get_account' });
    for (const status of ['400', '401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/manage-api-key/);
  });

  it('prefixes every tool with serpapi_, shares no tool name with another adapter, and is all reads', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^serpapi_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations }).readOnlyHint).toBe(true);
    }
  });

  it.each(SEARCH_TOOLS)('%s only sends documented parameters of its engine', (name) => {
    const [engine, documented] = ENGINES[name];
    const qp = tool(name).endpointMapping.queryParams!;
    expect(tool(name).endpointMapping.path).toBe('/search.json');
    expect(qp.engine).toBe(engine);
    for (const key of Object.keys(qp)) if (key !== 'engine') expect(documented).toContain(key);
    for (const value of Object.values(qp)) {
      if (typeof value === 'string' && value.startsWith('$')) expect(tool(name).parameters.properties).toHaveProperty(value.slice(1));
    }
    expect(tool(name).description).toMatch(/Spends 1 SerpApi search/);
  });

  it('only points the model at tools that exist, documents setup and cost, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bserpapi_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bserpapi_[a-z_]+/g), ...JSON.stringify(t.parameters).matchAll(/\bserpapi_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://serpapi.com/manage-api-key');
    expect(a.instructions).toMatch(/Every search spends one search from the user's SerpApi plan/);
    expect(a.instructions).toMatch(/Out of scope/);
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
    for (const t of a.tools) expect(validateTransform(t.responseMapping!.transform)).toBeNull();
  });

  const table: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ['serpapi_google_search', { q: 'mcp' }, '/search.json', { engine: 'google', q: 'mcp' }],
    ['serpapi_google_news', { q: 'mcp' }, '/search.json', { engine: 'google_news', q: 'mcp' }],
    ['serpapi_google_images', { q: 'mcp' }, '/search.json', { engine: 'google_images', q: 'mcp' }],
    ['serpapi_google_maps', { q: 'coffee in Freiburg' }, '/search.json', { engine: 'google_maps', type: 'search', q: 'coffee in Freiburg' }],
    ['serpapi_google_shopping', { q: 'espresso machine' }, '/search.json', { engine: 'google_shopping', q: 'espresso machine' }],
    ['serpapi_google_scholar', { q: 'retrieval augmented generation' }, '/search.json', { engine: 'google_scholar', q: 'retrieval augmented generation' }],
    ['serpapi_google_trends', { q: 'coffee,tea' }, '/search.json', { engine: 'google_trends', q: 'coffee,tea', data_type: 'TIMESERIES', date: 'today 12-m' }],
    ['serpapi_youtube_search', { search_query: 'mcp' }, '/search.json', { engine: 'youtube', search_query: 'mcp' }],
    ['serpapi_bing_search', { q: 'mcp' }, '/search.json', { engine: 'bing', q: 'mcp' }],
    ['serpapi_get_account', {}, '/account.json', {}],
    ['serpapi_search_locations', { q: 'Munich' }, '/locations.json', { q: 'Munich', limit: 5 }],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s calls the right URL with the key and only the given parameters', async (name, params, path, query) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.params).toEqual({ api_key: FAKE_KEY, ...query });
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('passes filters through with SerpApi names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('serpapi_google_search', { q: 'mcp', location: 'Berlin, Germany', gl: 'de', hl: 'de', tbs: 'qdr:w', start: 10 });
    expect(sent().params).toEqual({ api_key: FAKE_KEY, engine: 'google', q: 'mcp', location: 'Berlin, Germany', gl: 'de', hl: 'de', tbs: 'qdr:w', start: 10 });
    mockedAxios.mockClear();
    await call('serpapi_bing_search', { q: 'mcp', safeSearch: 'strict', mkt: 'de-DE', first: 11 });
    expect(sent().params).toEqual({ api_key: FAKE_KEY, engine: 'bing', q: 'mcp', safeSearch: 'strict', mkt: 'de-DE', first: 11 });
  });

  it('turns a search that SerpApi could not process into an error, but keeps an empty result a result', async () => {
    mockedAxios.mockResolvedValue({ data: { search_metadata: { status: 'Error' }, error: 'Something went wrong.' } });
    await expect(call('serpapi_google_search', { q: 'mcp' })).rejects.toMatchObject({ status: 502 });
    mockedAxios.mockResolvedValue({
      data: { search_metadata: { status: 'Success' }, search_information: { organic_results_state: 'Fully empty' }, error: "Google hasn't returned any results for this query." },
    });
    const raw = await call('serpapi_google_search', { q: 'zzqqxx' });
    expect(shape('serpapi_google_search', raw).value).toEqual({ error: "Google hasn't returned any results for this query." });
  });

  it('trims a Google answer to the useful blocks and drops empty fields', () => {
    const raw = {
      search_metadata: { id: 'x', status: 'Success' },
      search_parameters: { engine: 'google', q: 'coffee' },
      search_information: { total_results: 1790000, time_taken_displayed: 0.4 },
      answer_box: { type: 'organic_result', title: 'Coffee', snippet: 'A drink.' },
      knowledge_graph: { title: 'Coffee', type: 'Beverage', header_images: [{ image: 'https://x' }], people_also_search_for: [{ name: 'Tea' }], description: 'A drink.' },
      organic_results: [
        { position: 1, title: 'Coffee - Wikipedia', link: 'https://en.wikipedia.org/wiki/Coffee', redirect_link: 'https://www.google.com/url?x', displayed_link: 'en.wikipedia.org', favicon: 'https://x', snippet: 'Coffee is...', snippet_highlighted_words: ['Coffee'], source: 'Wikipedia' },
        { position: 2, title: 'Coffee | Britannica', link: 'https://britannica.com/coffee', snippet: 'Beverage...', date: 'Oct 2, 2026' },
      ],
      related_questions: [{ question: 'Is coffee healthy?', type: 'ai_overview', page_token: 'abc' }],
      related_searches: [{ query: 'coffee near me', link: 'https://google.com/x' }],
      serpapi_pagination: { next: 'https://serpapi.com/search.json?start=10' },
    };
    expect(shape('serpapi_google_search', raw).value).toEqual({
      total_results: 1790000,
      answer_box: raw.answer_box,
      knowledge_graph: { title: 'Coffee', type: 'Beverage', description: 'A drink.' },
      organic_results: [
        { position: 1, title: 'Coffee - Wikipedia', link: 'https://en.wikipedia.org/wiki/Coffee', source: 'Wikipedia', displayed_link: 'en.wikipedia.org', snippet: 'Coffee is...' },
        { position: 2, title: 'Coffee | Britannica', link: 'https://britannica.com/coffee', date: 'Oct 2, 2026', snippet: 'Beverage...' },
      ],
      related_questions: [{ question: 'Is coffee healthy?' }],
      related_searches: ['coffee near me'],
    });
  });

  it('caps news at 20 articles and keeps the topic tokens', () => {
    const raw = {
      news_results: Array.from({ length: 30 }, (_, i) => ({ position: i + 1, title: `T${i}`, link: `https://n.example/${i}`, source: { name: 'Reuters', icon: 'https://x' }, date: '10/12/2026', thumbnail: 'https://x' })),
      menu_links: [{ title: 'World', topic_token: 'tok', serpapi_link: 'https://serpapi.com/x' }],
    };
    const out = shape('serpapi_google_news', raw).value as any;
    expect(out.news_results).toHaveLength(20);
    expect(out.news_results[0]).toEqual({ position: 1, title: 'T0', link: 'https://n.example/0', source: 'Reuters', date: '10/12/2026' });
    expect(out.menu_links).toEqual([{ title: 'World', topic_token: 'tok' }]);
  });

  it('shapes YouTube results with the next page token and Trends points with their values', () => {
    const yt = {
      video_results: [{ position_on_page: 2, title: 'V', link: 'https://youtube.com/watch?v=1', video_id: '1', channel: { name: 'C', link: 'https://x' }, views: 10, length: '1:00', thumbnail: { static: 'https://x' } }],
      serpapi_pagination: { next_page_token: 'NEXT' },
    };
    expect(shape('serpapi_youtube_search', yt).value).toEqual({
      video_results: [{ position: 2, title: 'V', link: 'https://youtube.com/watch?v=1', video_id: '1', channel: 'C', views: 10, length: '1:00' }],
      next_page_token: 'NEXT',
    });
    const trends = { interest_over_time: { timeline_data: [{ date: 'Oct 12 - 18, 2025', timestamp: '1760227200', values: [{ query: 'coffee', query_index: 0, value: '60', extracted_value: 60 }] }] } };
    expect(shape('serpapi_google_trends', trends).value).toEqual({
      interest_over_time: { timeline_data: [{ date: 'Oct 12 - 18, 2025', values: [{ query: 'coffee', value: 60 }] }] },
    });
  });

  it('never returns the API key from the account endpoint', () => {
    const raw = { account_id: '1', api_key: FAKE_KEY, account_email: 'a@b.c', plan_name: 'Free Plan', searches_per_month: 250, plan_searches_left: 240, total_searches_left: 240, this_month_usage: 10, account_rate_limit_per_hour: 50 };
    const out = shape('serpapi_get_account', raw).value as any;
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(out).toEqual({ plan_name: 'Free Plan', searches_per_month: 250, this_month_usage: 10, plan_searches_left: 240, total_searches_left: 240, account_rate_limit_per_hour: 50 });
  });
});

const live = process.env.RUN_SERPAPI_LIVE ? describe : describe.skip;
live('serpapi adapter: live', () => {
  const realKey = process.env.SERPAPI_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it('refuses a wrong key with 401 on the free account endpoint and on a search', async () => {
    await expect(call('serpapi_get_account', {})).rejects.toMatchObject({ response: { status: 401, data: { error: expect.stringMatching(/Invalid API key/) } } });
    await expect(call('serpapi_google_search', { q: 'anythingmcp connector test' })).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers 404 on a made-up route', async () => {
    await expect((mockedAxios.__actual as any).request({ url: `${BASE}/does-not-exist.json`, params: { api_key: FAKE_KEY } })).rejects.toMatchObject({
      response: { status: 404 },
    });
  }, 30000);

  // SerpApi answers its playground demo query ("coffee") without a key and
  // validates the parameters on the way (an unsupported value answers 400), so
  // every search tool can be run for real here at no cost.
  it.each<[string, Record<string, unknown>, string]>([
    ['serpapi_google_search', { q: 'coffee', gl: 'us', hl: 'en' }, 'organic_results'],
    ['serpapi_google_news', { q: 'coffee', gl: 'us', hl: 'en' }, 'news_results'],
    ['serpapi_google_images', { q: 'coffee', imgsz: 'l' }, 'images_results'],
    ['serpapi_google_maps', { q: 'coffee' }, 'local_results'],
    ['serpapi_google_shopping', { q: 'coffee', sort_by: '1' }, 'shopping_results'],
    ['serpapi_google_scholar', { q: 'coffee', num: 5 }, 'organic_results'],
    ['serpapi_google_trends', { q: 'coffee' }, 'interest_over_time'],
    ['serpapi_youtube_search', { search_query: 'coffee', gl: 'us' }, 'video_results'],
    ['serpapi_bing_search', { q: 'coffee', safeSearch: 'strict' }, 'organic_results'],
  ])('%s runs on the keyless demo query and shapes the real answer', async (name, params, block) => {
    const raw = await call(name, params, {}, 'NONE');
    const out = shape(name, raw);
    expect(out.error).toBeUndefined();
    expect((out.value as any)[block]).toBeTruthy();
    expect(JSON.stringify(out.value).length).toBeLessThan(JSON.stringify(raw).length);
  }, 60000);

  it('reports an unsupported parameter value as 400', async () => {
    await expect(call('serpapi_google_trends', { q: 'coffee', data_type: 'NOPE' }, {}, 'NONE')).rejects.toMatchObject({ response: { status: 400 } });
  }, 60000);

  (realKey ? it : it.skip)('reads the account (free) and runs one Google search (1 search)', async () => {
    const env = { SERPAPI_API_KEY: realKey! };
    const account = shape('serpapi_get_account', await call('serpapi_get_account', {}, env)).value as any;
    expect(account.plan_name).toBeDefined();
    const res = shape('serpapi_google_search', await call('serpapi_google_search', { q: 'Model Context Protocol' }, env)).value as any;
    expect(res.organic_results.length).toBeGreaterThan(0);
  }, 60000);
});
