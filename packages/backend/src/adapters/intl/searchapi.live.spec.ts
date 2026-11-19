import axios from 'axios';
import * as adapter from './searchapi.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the SearchApi adapter:
 *
 *   1. Static: always runs, no network. Pins the key as the Authorization:
 *      Bearer header built by BEARER_TOKEN from the encrypted authConfig (never
 *      a query parameter, never a tool parameter), the one endpoint with a
 *      fixed engine per tool, every declared parameter reaching the query
 *      through the real RestEngine, read-only annotations, and the response
 *      trimming against the answer shapes SearchApi returned on 17 Nov 2026.
 *
 *   2. Live: skipped unless RUN_SEARCHAPI_LIVE=1. Without a key it checks that
 *      SearchApi refuses a wrong key with 401 and `Invalid API key.`. With
 *      SEARCHAPI_API_KEY it runs one search per tool (3 requests of the plan):
 *
 *        RUN_SEARCHAPI_LIVE=1 SEARCHAPI_API_KEY=... npx jest src/adapters/intl/searchapi.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
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
  probe: { tool: string; params: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const BASE = 'https://www.searchapi.io';
const PATH = '/api/v1/search';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'k'.repeat(24);
const ENV: Record<string, string> = { SEARCHAPI_API_KEY: FAKE_KEY };

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
    { ...params, ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);

// The fixed engine of each tool and the parameters SearchApi documents for it
// (searchapi.io/docs/google, /docs/google-news, /docs/google-scholar).
const ENGINES: Record<string, [string, string[]]> = {
  searchapi_google_search: ['google', ['q', 'num', 'page', 'gl', 'hl']],
  searchapi_google_news: ['google_news', ['q', 'num', 'page', 'gl', 'hl']],
  searchapi_google_scholar: ['google_scholar', ['q', 'num', 'page', 'hl']],
};

describe('searchapi adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed under data with its own icon and three tools', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.category).toBe('data');
    expect(a.icon).toBe('searchapi');
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(ENGINES).sort());
  });

  it('sends the key as Authorization: Bearer from the encrypted authConfig, never in the URL', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SEARCHAPI_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['SEARCHAPI_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'SEARCHAPI_API_KEY', kind: 'credential', secret: true, required: true });
    for (const t of a.tools) {
      expect(Object.keys(t.endpointMapping.queryParams ?? {})).not.toContain('api_key');
      expect(Object.keys(t.parameters.properties ?? {})).not.toContain('api_key');
    }
  });

  it('accepts a plain alphanumeric key and refuses a pasted header or whitespace', () => {
    const key = new RegExp(a.envVarMeta.SEARCHAPI_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `, `${FAKE_KEY}\n`, 'short']) expect(key.test(bad)).toBe(false);
  });

  it('probes with one web search and explains a refused key', () => {
    expect(a.probe).toEqual({ tool: 'searchapi_google_search', params: { q: 'searchapi', num: 1 } });
    expect(a.verifyHints['401']).toContain('https://www.searchapi.io');
    expect(a.verifyHints['429']).toBeTruthy();
  });

  it('prefixes every tool with searchapi_, shares no tool name with another adapter, and is all reads', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^searchapi_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(
        deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations }).readOnlyHint,
      ).toBe(true);
    }
  });

  it.each(Object.keys(ENGINES))('%s calls the one endpoint with its fixed engine and only documented parameters', (name) => {
    const [engine, documented] = ENGINES[name];
    const t = tool(name);
    const qp = t.endpointMapping.queryParams!;
    expect(t.endpointMapping.path).toBe(PATH);
    expect(qp.engine).toBe(engine);
    for (const key of Object.keys(qp)) if (key !== 'engine') expect(documented).toContain(key);
    for (const value of Object.values(qp)) {
      if (typeof value === 'string' && value.startsWith('$')) expect(t.parameters.properties).toHaveProperty(value.slice(1));
    }
    for (const param of Object.keys(t.parameters.properties ?? {})) expect(qp[param]).toBe(`$${param}`);
    expect(t.parameters.required).toEqual(['q']);
    expect(t.description).toMatch(/Spends 1 SearchApi request/);
  });

  it('only points the model at tools that exist, documents setup, cost and the redirect links, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bsearchapi_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bsearchapi_[a-z_]+/g), ...JSON.stringify(t.parameters).matchAll(/\bsearchapi_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/Every call spends one request/);
    expect(a.instructions).toMatch(/Authorization: Bearer/);
    expect(a.instructions).toMatch(/google\.com\/goto\?url=/);
    expect(a.instructions).toMatch(/Google didn't return any results/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings', () => {
    for (const t of a.tools) expect(validateTransform(t.responseMapping!.transform)).toBeNull();
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['searchapi_google_search', { q: 'mcp' }, { engine: 'google', q: 'mcp' }],
    ['searchapi_google_search', { q: 'mcp', num: 5, page: 2, gl: 'br', hl: 'pt' }, { engine: 'google', q: 'mcp', num: 5, page: 2, gl: 'br', hl: 'pt' }],
    ['searchapi_google_news', { q: 'open source', num: 3, gl: 'de', hl: 'de' }, { engine: 'google_news', q: 'open source', num: 3, gl: 'de', hl: 'de' }],
    ['searchapi_google_scholar', { q: 'attention is all you need', num: 2, hl: 'en' }, { engine: 'google_scholar', q: 'attention is all you need', num: 2, hl: 'en' }],
  ])('%s sends a GET with the bearer header and only the given parameters', async (name, params, query) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${BASE}${PATH}`);
    expect(req.params).toEqual(query);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.headers['User-Agent']).toMatch(/^AnythingMCP/);
    expect(JSON.stringify(req.params)).not.toContain(FAKE_KEY);
  });

  it('trims a web answer to the useful blocks, keeps redirect links as they come, and drops empty fields', () => {
    const raw = {
      search_metadata: { id: 'search_x', status: 'Success', request_url: 'https://www.google.com/search?q=mcp', json_url: 'https://www.searchapi.io/api/v1/searches/search_x' },
      search_parameters: { engine: 'google', q: 'mcp', device: 'desktop', hl: 'en', gl: 'us', num: 3 },
      search_information: { query_displayed: 'mcp', total_results: 69, time_taken_displayed: 0.32, detected_location: 'Unknown', has_no_results_for: false },
      knowledge_graph: { kgmid: '/g/x', knowledge_graph_type: 'Protocol', title: 'Model Context Protocol', description: 'An open standard.', source: { name: 'Example', link: 'https://example.com' }, people_also_search_for: [{ name: 'Other' }], images: [{ source: 'https://example.com/i.png' }] },
      organic_results: [
        { position: 1, title: 'MCP explained', link: 'https://example.com/mcp', source: 'Example', domain: 'example.com', displayed_link: 'https://example.com › mcp', snippet: 'What MCP is.', snippet_highlighted_words: ['MCP'], date: 'Jun 5, 2026', favicon: 'https://example.com/favicon.ico', thumbnail: 'https://example.com/t.png' },
        { position: 2, title: 'MCP intro', link: 'https://www.google.com/goto?url=opaque-token', link_token: 'tok', source: 'Example News', domain: 'news.example.com', displayed_link: 'https://news.example.com › intro', snippet: 'An intro.' },
      ],
      related_questions: [{ position: 1, question: 'What is MCP?', snippet: 'A protocol.', title: 'MCP', link: 'https://example.com/faq', displayed_link: 'example.com', source: 'Example' }],
      related_searches: [{ query: 'mcp servers', link: 'https://www.google.com/search?q=mcp+servers' }],
      pagination: { current: 1, next: 'https://www.google.com/search?q=mcp&start=3' },
    };
    expect(shape('searchapi_google_search', raw).value).toEqual({
      total_results: 69,
      knowledge_graph: { title: 'Model Context Protocol', type: 'Protocol', description: 'An open standard.' },
      organic_results: [
        { position: 1, title: 'MCP explained', link: 'https://example.com/mcp', source: 'Example', domain: 'example.com', displayed_link: 'https://example.com › mcp', date: 'Jun 5, 2026', snippet: 'What MCP is.' },
        { position: 2, title: 'MCP intro', link: 'https://www.google.com/goto?url=opaque-token', source: 'Example News', domain: 'news.example.com', displayed_link: 'https://news.example.com › intro', snippet: 'An intro.' },
      ],
      related_questions: [{ question: 'What is MCP?', snippet: 'A protocol.', title: 'MCP', link: 'https://example.com/faq' }],
      related_searches: ['mcp servers'],
      current_page: 1,
    });
  });

  it('keeps an empty answer a result that carries the error text', () => {
    const raw = {
      search_metadata: { id: 'search_y', status: 'Success' },
      search_parameters: { engine: 'google', q: 'zzqqxx' },
      error: "Google didn't return any results.",
    };
    expect(shape('searchapi_google_search', raw).value).toEqual({ error: "Google didn't return any results." });
  });

  it('shapes news rows with source and dates and Scholar rows with publication, authors and citations', () => {
    const news = {
      search_metadata: { id: 'search_n' },
      search_information: { total_results: 1200 },
      organic_results: [
        { position: 1, title: 'Headline', link: 'https://www.google.com/goto?url=opaque-token', link_token: 'tok', source: 'Example Daily', date: '43 minutes ago', iso_date: '2026-11-17T17:06:11Z', snippet: 'Lead.', favicon: 'https://example.com/f.ico', thumbnail: 'https://example.com/t.png' },
      ],
    };
    expect(shape('searchapi_google_news', news).value).toEqual({
      total_results: 1200,
      organic_results: [{ position: 1, title: 'Headline', link: 'https://www.google.com/goto?url=opaque-token', source: 'Example Daily', date: '43 minutes ago', iso_date: '2026-11-17T17:06:11Z', snippet: 'Lead.' }],
    });
    const scholar = {
      search_metadata: { id: 'search_s' },
      organic_results: [
        {
          position: 1,
          title: 'A paper',
          data_cid: 'cid',
          link: 'https://example.com/paper',
          publication: 'A Author, B Author - Journal, 2024 - example.com',
          snippet: 'Abstract.',
          inline_links: { cited_by: { cites_id: '1', total: 42, link: 'https://scholar.google.com/x' }, versions: { cluster_id: '2', total: 3, link: 'https://scholar.google.com/y' } },
          authors: [{ name: 'A Author', link: 'https://scholar.google.com/a' }, { name: 'B Author' }],
          resource: { title: 'example.com', file_format: 'PDF', link: 'https://example.com/paper.pdf' },
        },
      ],
    };
    expect(shape('searchapi_google_scholar', scholar).value).toEqual({
      organic_results: [
        { position: 1, title: 'A paper', link: 'https://example.com/paper', snippet: 'Abstract.', publication: 'A Author, B Author - Journal, 2024 - example.com', authors: ['A Author', 'B Author'], cited_by: 42, resource: 'https://example.com/paper.pdf' },
      ],
    });
  });
});

const live = process.env.RUN_SEARCHAPI_LIVE ? describe : describe.skip;
live('searchapi adapter: live', () => {
  const realKey = process.env.SEARCHAPI_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it('refuses a wrong key with 401 and Invalid API key', async () => {
    await expect(call('searchapi_google_search', { q: 'anythingmcp connector test', num: 1 })).rejects.toMatchObject({
      response: { status: 401, data: { error: expect.stringMatching(/Invalid API key/) } },
    });
  }, 30000);

  (realKey ? it : it.skip)('searchapi_google_search returns organic_results[] with title and link (1 request)', async () => {
    const out = shape('searchapi_google_search', await call('searchapi_google_search', { q: 'model context protocol', num: 3 }, { SEARCHAPI_API_KEY: realKey! }));
    expect(out.error).toBeUndefined();
    const res = out.value as any;
    expect(res.organic_results.length).toBeGreaterThan(0);
    expect(res.organic_results[0]).toEqual(expect.objectContaining({ title: expect.any(String), link: expect.stringMatching(/^https?:\/\//) }));
  }, 30000);

  (realKey ? it : it.skip)('searchapi_google_news returns articles with a source (1 request)', async () => {
    const res = shape('searchapi_google_news', await call('searchapi_google_news', { q: 'open source', num: 3 }, { SEARCHAPI_API_KEY: realKey! })).value as any;
    expect(res.organic_results.length).toBeGreaterThan(0);
    expect(res.organic_results[0]).toEqual(expect.objectContaining({ title: expect.any(String), link: expect.stringMatching(/^https?:\/\//), source: expect.any(String) }));
  }, 30000);

  (realKey ? it : it.skip)('searchapi_google_scholar returns papers (1 request)', async () => {
    const res = shape('searchapi_google_scholar', await call('searchapi_google_scholar', { q: 'attention is all you need', num: 2 }, { SEARCHAPI_API_KEY: realKey! })).value as any;
    expect(res.organic_results.length).toBeGreaterThan(0);
    expect(res.organic_results[0]).toEqual(expect.objectContaining({ title: expect.any(String) }));
  }, 30000);
});
