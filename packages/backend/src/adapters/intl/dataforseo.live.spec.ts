import axios from 'axios';
import * as adapter from './dataforseo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, readTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the DataForSEO adapter:
 *
 *   1. Static: always runs. Pins HTTP Basic auth with the API login and
 *      password, every tool's URL and the one-task JSON array it posts through
 *      the real RestEngine, the body fields against DataForSEO's own OpenAPI
 *      document (github.com/dataforseo/OpenApiDocumentation, fetched 14 Oct
 *      2026), the cheap defaults, the prices in the descriptions
 *      (dataforseo.com/pricing, 14 Oct 2026), the status-code rules for errors
 *      that arrive with HTTP 200, and the response trimming on answers built
 *      from the documented result fields.
 *
 *   2. Live: skipped unless RUN_DATAFORSEO_LIVE=1. Without credentials it
 *      checks that a wrong login is refused with 401 on the free account call
 *      and on a paid endpoint (refused before anything is charged). With
 *      DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD it reads the account and the
 *      location and language lists (free), then runs every paid tool against
 *      sandbox.dataforseo.com, which answers with dummy data of the real shape
 *      and charges nothing, and shapes each answer like production:
 *
 *        RUN_DATAFORSEO_LIVE=1 DATAFORSEO_LOGIN=... DATAFORSEO_PASSWORD=... \
 *          npx jest src/adapters/intl/dataforseo.live.spec.ts
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

type Schema = { description?: string; default?: unknown; enum?: unknown[]; minimum?: number; maximum?: number };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, Schema>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping?: Array<Record<string, unknown>> };
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
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
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

const BASE = 'https://api.dataforseo.com/v3';
const SANDBOX = 'https://sandbox.dataforseo.com/v3';
// Built at runtime so no literal looks like a real credential.
const FAKE_LOGIN = ['nobody', 'example.com'].join('@');
const FAKE_PASSWORD = 'p'.repeat(16);
const ENV: Record<string, string> = { DATAFORSEO_LOGIN: FAKE_LOGIN, DATAFORSEO_PASSWORD: FAKE_PASSWORD };
const BASIC = `Basic ${Buffer.from(`${FAKE_LOGIN}:${FAKE_PASSWORD}`).toString('base64')}`;

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call; the adapter's
// errorWhen rules applied like connectorErrorWhen does in production.
const call = (name: string, params: Record<string, unknown>, env = ENV, baseUrl = a.connector.baseUrl) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl, headers: a.connector.headers }, tool(name).endpointMapping as any, env);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
      errorWhen: a.connector.config.errorWhen,
    } as any,
    endpointMapping as any,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);
// The envelope DataForSEO wraps every answer in.
const envelope = (result: unknown[] | null, task: Record<string, unknown> = {}) => ({
  version: '0.1.20260917',
  status_code: 20000,
  status_message: 'Ok.',
  time: '0.5 sec.',
  cost: 0.0144,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [{ id: '10141200-0000-0000-0000-000000000000', status_code: 20000, status_message: 'Ok.', time: '0.4 sec.', cost: 0.0144, result_count: 1, path: [], data: {}, result, ...task }],
});

const FREE = ['dataforseo_get_account', 'dataforseo_list_languages', 'dataforseo_list_labs_locations', 'dataforseo_list_locations'];

// Body fields each endpoint documents in DataForSEO's OpenAPI document
// (14 Oct 2026). DataForSEO rejects unknown fields with 40506.
const DOCUMENTED: Record<string, [string, string[]]> = {
  dataforseo_serp_google_organic: ['/serp/google/organic/live/advanced', ['keyword', 'location_code', 'language_code', 'depth', 'device', 'load_async_ai_overview', 'location_name', 'language_name', 'os', 'tag', 'stop_crawl_on_match', 'max_crawl_pages', 'search_param', 'remove_from_url', 'people_also_ask_click_depth', 'group_organic_results', 'calculate_rectangles', 'url', 'location_coordinate', 'se_domain', 'target']],
  dataforseo_keywords_search_volume: ['/keywords_data/google_ads/search_volume/live', ['keywords', 'location_name', 'location_code', 'location_coordinate', 'language_name', 'language_code', 'search_partners', 'date_from', 'date_to', 'include_adult_keywords', 'sort_by', 'tag']],
  dataforseo_keywords_for_keywords: ['/keywords_data/google_ads/keywords_for_keywords/live', ['keywords', 'location_name', 'location_code', 'location_coordinate', 'language_name', 'language_code', 'search_partners', 'date_from', 'date_to', 'sort_by', 'include_adult_keywords', 'tag']],
  dataforseo_labs_ranked_keywords: ['/dataforseo_labs/google/ranked_keywords/live', ['target', 'location_name', 'location_code', 'language_name', 'language_code', 'ignore_synonyms', 'item_types', 'include_clickstream_data', 'limit', 'offset', 'load_rank_absolute', 'historical_serp_mode', 'filters', 'order_by', 'tag']],
  dataforseo_labs_keyword_ideas: ['/dataforseo_labs/google/keyword_ideas/live', ['keywords', 'location_name', 'location_code', 'language_name', 'language_code', 'closely_variants', 'ignore_synonyms', 'include_serp_info', 'include_clickstream_data', 'limit', 'offset', 'offset_token', 'filters', 'order_by', 'tag']],
  dataforseo_labs_related_keywords: ['/dataforseo_labs/google/related_keywords/live', ['keyword', 'location_name', 'location_code', 'language_name', 'language_code', 'depth', 'include_seed_keyword', 'include_serp_info', 'include_clickstream_data', 'ignore_synonyms', 'replace_with_core_keyword', 'filters', 'order_by', 'limit', 'offset', 'tag']],
  dataforseo_labs_competitors_domain: ['/dataforseo_labs/google/competitors_domain/live', ['target', 'location_name', 'location_code', 'language_name', 'language_code', 'item_types', 'include_clickstream_data', 'filters', 'order_by', 'limit', 'offset', 'max_rank_group', 'exclude_top_domains', 'exclude_domains', 'intersecting_domains', 'ignore_synonyms', 'tag']],
  dataforseo_labs_domain_rank_overview: ['/dataforseo_labs/google/domain_rank_overview/live', ['target', 'location_name', 'location_code', 'language_name', 'language_code', 'ignore_synonyms', 'limit', 'offset', 'tag']],
  dataforseo_labs_bulk_keyword_difficulty: ['/dataforseo_labs/google/bulk_keyword_difficulty/live', ['keywords', 'location_name', 'location_code', 'language_name', 'language_code', 'tag']],
  dataforseo_backlinks_summary: ['/backlinks/summary/live', ['target', 'include_subdomains', 'include_indirect_links', 'exclude_internal_backlinks', 'internal_list_limit', 'backlinks_status_type', 'backlinks_filters', 'rank_scale', 'tag']],
  dataforseo_backlinks_list: ['/backlinks/backlinks/live', ['target', 'mode', 'custom_mode', 'filters', 'order_by', 'offset', 'search_after_token', 'limit', 'backlinks_status_type', 'include_subdomains', 'exclude_internal_backlinks', 'rank_scale', 'tag']],
  dataforseo_backlinks_referring_domains: ['/backlinks/referring_domains/live', ['target', 'limit', 'offset', 'internal_list_limit', 'backlinks_status_type', 'filters', 'order_by', 'backlinks_filters', 'include_subdomains', 'include_indirect_links', 'exclude_internal_backlinks', 'rank_scale', 'tag']],
  dataforseo_onpage_instant_page: ['/on_page/instant_pages', ['url', 'custom_user_agent', 'browser_preset', 'store_raw_html', 'accept_language', 'load_resources', 'enable_browser_rendering', 'disable_cookie_popup', 'return_despite_timeout', 'enable_javascript', 'enable_xhr', 'check_spell']],
  dataforseo_domain_technologies: ['/domain_analytics/technologies/domain_technologies/live', ['target']],
};
const PAID = Object.keys(DOCUMENTED);

// One minimal, valid call per paid tool, used by the URL table and the sandbox run.
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  dataforseo_serp_google_organic: { keyword: 'model context protocol', location_code: 2840, language_code: 'en' },
  dataforseo_keywords_search_volume: { keywords: ['seo api'], location_code: 2840, language_code: 'en' },
  dataforseo_keywords_for_keywords: { keywords: ['seo api'], location_code: 2840, language_code: 'en' },
  dataforseo_labs_ranked_keywords: { target: 'dataforseo.com', location_code: 2840, language_code: 'en' },
  dataforseo_labs_keyword_ideas: { keywords: ['seo api'], location_code: 2840, language_code: 'en' },
  dataforseo_labs_related_keywords: { keyword: 'seo api', location_code: 2840, language_code: 'en' },
  dataforseo_labs_competitors_domain: { target: 'dataforseo.com', location_code: 2840, language_code: 'en' },
  dataforseo_labs_domain_rank_overview: { target: 'dataforseo.com', location_code: 2840, language_code: 'en' },
  dataforseo_labs_bulk_keyword_difficulty: { keywords: ['seo api'], location_code: 2840, language_code: 'en' },
  dataforseo_backlinks_summary: { target: 'dataforseo.com' },
  dataforseo_backlinks_list: { target: 'dataforseo.com' },
  dataforseo_backlinks_referring_domains: { target: 'dataforseo.com' },
  dataforseo_onpage_instant_page: { url: 'https://dataforseo.com/' },
  dataforseo_domain_technologies: { target: 'dataforseo.com' },
};

describe('dataforseo adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against vendor SDKs, specs and working clients on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('analytics');
    expect(a.icon).toBe('dataforseo');
  });

  it('authenticates with HTTP Basic from the encrypted authConfig and checks health on the free account call', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{DATAFORSEO_LOGIN}}', password: '{{DATAFORSEO_PASSWORD}}' });
    expect(a.connector.healthcheckPath).toBe('/appendix/user_data');
    expect(a.requiredEnvVars).toEqual(['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']);
    const meta = describeAdapterEnvVars(a as never);
    expect(meta.find((m) => m.name === 'DATAFORSEO_PASSWORD')).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.find((m) => m.name === 'DATAFORSEO_LOGIN')).toMatchObject({ kind: 'credential', required: true });
    for (const t of a.tools) {
      for (const p of Object.keys(t.parameters.properties ?? {})) expect(p).not.toMatch(/login|password/i);
    }
  });

  it('accepts the API login and password and refuses pasted headers', () => {
    const login = new RegExp(a.envVarMeta.DATAFORSEO_LOGIN.pattern!);
    const password = new RegExp(a.envVarMeta.DATAFORSEO_PASSWORD.pattern!);
    expect(login.test(FAKE_LOGIN)).toBe(true);
    expect(password.test(FAKE_PASSWORD)).toBe(true);
    expect(password.test('a1B2c3D4e5F6a7B8')).toBe(true);
    for (const bad of ['', `${FAKE_LOGIN}:${FAKE_PASSWORD}`, `Basic ${FAKE_LOGIN}`, ` ${FAKE_LOGIN}`]) expect(login.test(bad)).toBe(false);
    for (const bad of ['', 'short', `${FAKE_PASSWORD} `]) expect(password.test(bad)).toBe(false);
  });

  it('probes with the free account call and explains the documented failures', () => {
    expect(a.probe).toEqual({ tool: 'dataforseo_get_account' });
    expect(tool('dataforseo_get_account').endpointMapping).toEqual({ method: 'GET', path: '/appendix/user_data' });
    for (const status of ['401', '402', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toContain('https://app.dataforseo.com/api-access');
  });

  it('prefixes every tool with dataforseo_, shares no tool name with another adapter, and is read-only', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^dataforseo_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      const ann = deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
      expect(`${t.name}:${ann.readOnlyHint}:${ann.destructiveHint}`).toBe(`${t.name}:true:false`);
      expect(t.enabled).not.toBe(false);
    }
    expect([...FREE, ...PAID].sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it('only posts fields DataForSEO documents for each endpoint', () => {
    for (const [name, [path, documented]] of Object.entries(DOCUMENTED)) {
      const em = tool(name).endpointMapping;
      expect(`${name}:${em.method}:${em.path}`).toBe(`${name}:POST:${path}`);
      expect(Array.isArray(em.bodyMapping)).toBe(true);
      expect(em.bodyMapping).toHaveLength(1);
      for (const [field, value] of Object.entries(em.bodyMapping![0])) {
        expect(documented).toContain(field);
        expect(value).toBe(`$${field}`);
        expect(tool(name).parameters.properties).toHaveProperty(field);
      }
    }
    // Premium options that double the price are not offered at all.
    for (const t of a.tools) expect(Object.keys(t.parameters.properties ?? {})).not.toContain('include_clickstream_data');
  });

  it('keeps the defaults cheap: small limits, one SERP page, related keywords one level deep', () => {
    for (const t of a.tools) {
      const l = t.parameters.properties?.limit;
      if (l) expect(l.default as number).toBeLessThanOrEqual(20);
    }
    expect(tool('dataforseo_serp_google_organic').parameters.properties!.depth.default).toBe(10);
    expect(tool('dataforseo_labs_related_keywords').parameters.properties!.depth.default).toBe(1);
    expect(tool('dataforseo_backlinks_summary').parameters.properties!.internal_list_limit.default).toBe(10);
  });

  it('puts the documented price in every paid tool and says the free ones are free', () => {
    const price: Record<string, RegExp> = {
      dataforseo_serp_google_organic: /\$0\.002 per call/,
      dataforseo_keywords_search_volume: /\$0\.09 per call/,
      dataforseo_keywords_for_keywords: /\$0\.09 per call/,
      dataforseo_backlinks_summary: /\$0\.024 per call/,
      dataforseo_backlinks_list: /\$0\.024 per call plus \$0\.000036/,
      dataforseo_backlinks_referring_domains: /\$0\.024 per call plus \$0\.000036/,
      dataforseo_onpage_instant_page: /\$0\.00015 per page/,
      dataforseo_domain_technologies: /\$0\.012 per call/,
    };
    for (const name of PAID) {
      const expected = price[name] ?? /\$0\.012 per call plus \$0\.00012 per/;
      expect(tool(name).description).toMatch(expected);
    }
    for (const name of FREE) expect(tool(name).description).toMatch(/Free/);
  });

  it('only points the model at tools that exist, documents setup and cost, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bdataforseo_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bdataforseo_[a-z_]+/g), ...JSON.stringify(t.parameters).matchAll(/\bdataforseo_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://app.dataforseo.com/api-access');
    expect(a.instructions).toMatch(/Every data call spends money/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid error rules and a working response mapping on every tool', () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    for (const t of a.tools) {
      expect(validateTransform(t.responseMapping?.transform)).toBeNull();
      // A transform with only maxBytes is skipped: each one must select something.
      expect(`${t.name}:${readTransform(t.responseMapping as any) !== null}`).toBe(`${t.name}:true`);
    }
  });

  const urlTable: Array<[string, Record<string, unknown>, string, string]> = [
    ['dataforseo_get_account', {}, 'GET', `${BASE}/appendix/user_data`],
    ['dataforseo_list_languages', {}, 'GET', `${BASE}/serp/google/languages`],
    ['dataforseo_list_labs_locations', {}, 'GET', `${BASE}/dataforseo_labs/locations_and_languages`],
    ['dataforseo_list_locations', { country: 'de' }, 'GET', `${BASE}/serp/google/locations/de`],
    ...PAID.map((name): [string, Record<string, unknown>, string, string] => [name, SAMPLE_ARGS[name], 'POST', `${BASE}${DOCUMENTED[name][0]}`]),
  ];

  it('lists every tool in the URL table', () => {
    expect(urlTable.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(urlTable)('%s sends %s to the right URL with Basic auth', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: envelope([]) });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    // axios turns `auth` into the Basic header on the wire.
    expect(req.auth).toEqual({ username: FAKE_LOGIN, password: FAKE_PASSWORD });
    expect(`Basic ${Buffer.from(`${req.auth.username}:${req.auth.password}`).toString('base64')}`).toBe(BASIC);
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
    if (method === 'POST') {
      expect(Array.isArray(req.data)).toBe(true);
      expect(req.data).toHaveLength(1);
    } else {
      expect(req.data).toBeUndefined();
    }
  });

  it('posts one task with the given arguments and the cheap defaults only', async () => {
    mockedAxios.mockResolvedValue({ data: envelope([]) });
    await call('dataforseo_serp_google_organic', { keyword: 'mcp', location_name: 'Munich,Bavaria,Germany', language_code: 'de' });
    expect(sent().data).toEqual([{ keyword: 'mcp', location_name: 'Munich,Bavaria,Germany', language_code: 'de', depth: 10 }]);
    mockedAxios.mockClear();
    await call('dataforseo_labs_ranked_keywords', {
      target: 'example.com',
      location_code: 2276,
      language_code: 'de',
      filters: [['keyword_data.keyword_info.search_volume', '>', 100], 'and', ['ranked_serp_element.serp_item.rank_group', '<=', 10]],
      order_by: ['keyword_data.keyword_info.search_volume,desc'],
    });
    expect(sent().data).toEqual([
      {
        target: 'example.com',
        location_code: 2276,
        language_code: 'de',
        limit: 20,
        filters: [['keyword_data.keyword_info.search_volume', '>', 100], 'and', ['ranked_serp_element.serp_item.rank_group', '<=', 10]],
        order_by: ['keyword_data.keyword_info.search_volume,desc'],
      },
    ]);
    mockedAxios.mockClear();
    await call('dataforseo_keywords_search_volume', { keywords: ['a', 'b'] });
    expect(sent().data).toEqual([{ keywords: ['a', 'b'] }]);
    mockedAxios.mockClear();
    await call('dataforseo_backlinks_summary', { target: 'example.com', include_subdomains: false });
    expect(sent().data).toEqual([{ target: 'example.com', include_subdomains: false, internal_list_limit: 10 }]);
    mockedAxios.mockClear();
    await call('dataforseo_domain_technologies', { target: 'example.com' });
    expect(sent().data).toEqual([{ target: 'example.com' }]);
  });

  it('turns task errors inside HTTP 200 into failures, but keeps "no results" an answer', async () => {
    mockedAxios.mockResolvedValue({ data: envelope(null, { status_code: 40501, status_message: 'Invalid Field: keyword.' }) });
    await expect(call('dataforseo_serp_google_organic', { keyword: 'x', location_code: 1 })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Invalid Field: keyword/) });
    mockedAxios.mockResolvedValue({ data: envelope(null, { status_code: 40204, status_message: 'Access denied. Visit Plans and Subscriptions to activate your subscription.' }) });
    await expect(call('dataforseo_backlinks_summary', { target: 'example.com' })).rejects.toMatchObject({ status: 403 });
    mockedAxios.mockResolvedValue({ data: { ...envelope(null), status_code: 40200, status_message: 'Payment Required.', tasks: null } });
    await expect(call('dataforseo_labs_keyword_ideas', { keywords: ['x'], location_code: 2840 })).rejects.toMatchObject({ status: 402 });
    mockedAxios.mockResolvedValue({ data: { ...envelope(null), status_code: 40202, status_message: 'Rate limit exceeded.', tasks: null } });
    await expect(call('dataforseo_get_account', {})).rejects.toMatchObject({ status: 429 });
    mockedAxios.mockResolvedValue({ data: envelope(null, { status_code: 50000, status_message: 'Internal Error.' }) });
    await expect(call('dataforseo_domain_technologies', { target: 'example.com' })).rejects.toMatchObject({ status: 502 });
    const empty = envelope(null, { status_code: 40102, status_message: 'No Search Results.' });
    mockedAxios.mockResolvedValue({ data: empty });
    const raw = await call('dataforseo_serp_google_organic', { keyword: 'zzqqxx', location_code: 2840 });
    expect(shape('dataforseo_serp_google_organic', raw).value).toEqual({ cost: 0.0144, status: 'No Search Results.' });
  });

  it('shapes the account without the price list', () => {
    const raw = envelope([{ login: FAKE_LOGIN, timezone: 'UTC', rates: { limits: {} }, money: { total: 50, balance: 41.27, limits: {}, statistics: {} }, price: { serp: { a: 1 } } }]);
    expect(shape('dataforseo_get_account', raw).value).toEqual({ login: FAKE_LOGIN, timezone: 'UTC', balance_usd: 41.27, total_deposited_usd: 50, status: 'Ok.' });
  });

  it('orders locations country first and drops postal codes and neighbourhoods', () => {
    const raw = envelope([
      { location_code: 1004234, location_name: 'Munich,Bavaria,Germany', location_code_parent: 20229, country_iso_code: 'DE', location_type: 'City' },
      { location_code: 9041134, location_name: '80331,Bavaria,Germany', location_code_parent: 20229, country_iso_code: 'DE', location_type: 'Postal Code' },
      { location_code: 20229, location_name: 'Bavaria,Germany', location_code_parent: 2276, country_iso_code: 'DE', location_type: 'State' },
      { location_code: 2276, location_name: 'Germany', location_code_parent: null, country_iso_code: 'DE', location_type: 'Country' },
      { location_code: 9200331, location_name: 'Milan,Lombardy,Italy', location_code_parent: 1, country_iso_code: 'IT', location_type: 'Municipality' },
      { location_code: 9999, location_name: 'Schwabing,Munich,Bavaria,Germany', location_code_parent: 1, country_iso_code: 'DE', location_type: 'Neighborhood' },
    ]);
    expect(shape('dataforseo_list_locations', raw).value).toEqual([
      { code: 2276, name: 'Germany', type: 'Country' },
      { code: 20229, name: 'Bavaria,Germany', type: 'State' },
      { code: 1004234, name: 'Munich,Bavaria,Germany', type: 'City' },
      { code: 9200331, name: 'Milan,Lombardy,Italy', type: 'Municipality' },
    ]);
    const many = envelope(Array.from({ length: 5000 }, (_, i) => ({ location_code: i, location_name: `City ${i},Region,Germany`, location_type: 'City' })));
    const capped = shape('dataforseo_list_locations', many);
    expect(capped.truncated).toBe(true);
    expect((capped.value as any)._note).toMatch(/kept \d+ of 5000 items/);
  });

  it('shapes a SERP into compact items of every kind', () => {
    const raw = envelope([
      {
        keyword: 'coffee',
        type: 'organic',
        se_domain: 'google.com',
        location_code: 2840,
        language_code: 'en',
        check_url: 'https://www.google.com/search?q=coffee',
        datetime: '2026-10-14 10:00:00 +00:00',
        spell: null,
        item_types: ['ai_overview', 'organic', 'people_also_ask', 'related_searches'],
        se_results_count: 1790000,
        items_count: 4,
        items: [
          { type: 'ai_overview', rank_group: 1, rank_absolute: 1, position: 'left', xpath: '/html', markdown: 'Coffee is a drink.', items: [{ type: 'ai_overview_element', title: null, text: 'Coffee is a drink.', references: null }], references: [{ type: 'ai_overview_reference', source: 'Wikipedia', domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Coffee', title: 'Coffee', text: 'x' }] },
          { type: 'organic', rank_group: 1, rank_absolute: 2, position: 'left', xpath: '/html', domain: 'en.wikipedia.org', title: 'Coffee - Wikipedia', url: 'https://en.wikipedia.org/wiki/Coffee', breadcrumb: 'x', description: 'Coffee is...', highlighted: ['Coffee'], links: null, rating: null, is_image: false },
          { type: 'people_also_ask', rank_group: 1, rank_absolute: 3, position: 'left', xpath: '/html', items: [{ type: 'people_also_ask_element', title: 'Is coffee healthy?', seed_question: null, xpath: '/x', expanded_element: [{ type: 'people_also_ask_expanded_element', description: 'Yes.' }] }] },
          { type: 'related_searches', rank_group: 1, rank_absolute: 4, position: 'left', xpath: '/html', items: ['coffee near me', 'coffee beans'] },
        ],
      },
    ]);
    const out = shape('dataforseo_serp_google_organic', raw);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      cost: 0.0144,
      status: 'Ok.',
      keyword: 'coffee',
      se_domain: 'google.com',
      results_count: 1790000,
      item_types: ['ai_overview', 'organic', 'people_also_ask', 'related_searches'],
      items: [
        { type: 'ai_overview', rank_group: 1, rank_absolute: 1, markdown: 'Coffee is a drink.', items: [{ text: 'Coffee is a drink.' }], references: [{ title: 'Coffee', url: 'https://en.wikipedia.org/wiki/Coffee', source: 'Wikipedia' }] },
        { type: 'organic', rank_group: 1, rank_absolute: 2, title: 'Coffee - Wikipedia', url: 'https://en.wikipedia.org/wiki/Coffee', domain: 'en.wikipedia.org', description: 'Coffee is...' },
        { type: 'people_also_ask', rank_group: 1, rank_absolute: 3, items: [{ title: 'Is coffee healthy?' }] },
        { type: 'related_searches', rank_group: 1, rank_absolute: 4, items: ['coffee near me', 'coffee beans'] },
      ],
    });
  });

  it('shapes Google Ads volumes and caps keyword ideas at 100', () => {
    const row = (k: string) => ({ keyword: k, spell: null, location_code: 2840, language_code: 'en', search_partners: false, competition: 'LOW', competition_index: 12, search_volume: 880, low_top_of_page_bid: 1.2, high_top_of_page_bid: 4.5, cpc: 3.1, monthly_searches: [{ year: 2026, month: 9, search_volume: 900 }] });
    expect(shape('dataforseo_keywords_search_volume', envelope([row('seo api')])).value).toEqual({
      cost: 0.0144,
      status: 'Ok.',
      items: [{ keyword: 'seo api', search_volume: 880, competition: 'LOW', competition_index: 12, cpc: 3.1, low_top_of_page_bid: 1.2, high_top_of_page_bid: 4.5, monthly_searches: [{ year: 2026, month: 9, search_volume: 900 }] }],
    });
    const ideas = shape('dataforseo_keywords_for_keywords', envelope(Array.from({ length: 300 }, (_, i) => row(`k${i}`)))).value as any;
    expect(ideas.total).toBe(300);
    expect(ideas.items).toHaveLength(100);
    expect(ideas.items[0]).not.toHaveProperty('monthly_searches');
  });

  it('shapes Labs ranked keywords, ideas, related keywords, competitors, overview and difficulty', () => {
    const keywordData = { se_type: 'google', keyword: 'seo api', location_code: 2840, language_code: 'en', keyword_info: { se_type: 'google', competition: 0.2, competition_level: 'LOW', cpc: 5.5, search_volume: 1000, monthly_searches: [{ year: 2026, month: 9, search_volume: 1000 }] }, keyword_properties: { keyword_difficulty: 41, core_keyword: null }, search_intent_info: { main_intent: 'commercial', foreign_intent: null }, serp_info: null, avg_backlinks_info: { backlinks: 10 } };
    const ranked = envelope([
      {
        se_type: 'google',
        target: 'dataforseo.com',
        total_count: 1234,
        items_count: 1,
        metrics: { organic: { pos_1: 10, pos_2_3: 20, pos_4_10: 30, pos_11_20: 40, pos_21_30: 1, etv: 5000.5, count: 1234, estimated_paid_traffic_cost: 9000, is_new: 5, is_up: 6, is_down: 7, is_lost: 8, clickstream_etv: null }, paid: { count: 2, etv: 10, pos_1: 1 } },
        items: [{ se_type: 'google', keyword_data: keywordData, ranked_serp_element: { se_type: 'google', serp_item: { type: 'organic', rank_group: 3, rank_absolute: 4, position: 'left', xpath: '/x', url: 'https://dataforseo.com/apis', title: 'APIs', etv: 120.4, description: 'long text' }, check_url: 'x', is_lost: false } }],
      },
    ]);
    expect(shape('dataforseo_labs_ranked_keywords', ranked).value).toEqual({
      cost: 0.0144,
      status: 'Ok.',
      target: 'dataforseo.com',
      total_count: 1234,
      organic: { count: 1234, etv: 5000.5, estimated_paid_traffic_cost: 9000, pos_1: 10, pos_2_3: 20, pos_4_10: 30, pos_11_20: 40, is_new: 5, is_up: 6, is_down: 7, is_lost: 8 },
      paid: { count: 2, etv: 10 },
      items: [{ keyword: 'seo api', search_volume: 1000, cpc: 5.5, competition_level: 'LOW', keyword_difficulty: 41, intent: 'commercial', type: 'organic', rank_group: 3, rank_absolute: 4, url: 'https://dataforseo.com/apis', title: 'APIs', etv: 120.4, is_lost: false }],
    });
    const compact = { keyword: 'seo api', search_volume: 1000, cpc: 5.5, competition_level: 'LOW', keyword_difficulty: 41, intent: 'commercial' };
    expect(shape('dataforseo_labs_keyword_ideas', envelope([{ seed_keywords: ['seo'], total_count: 50, items_count: 1, offset: 0, offset_token: 'tok', items: [keywordData] }])).value).toEqual({
      cost: 0.0144,
      status: 'Ok.',
      total_count: 50,
      items: [compact],
    });
    expect(
      shape('dataforseo_labs_related_keywords', envelope([{ seed_keyword: 'seo api', seed_keyword_data: keywordData, total_count: 8, items_count: 1, items: [{ se_type: 'google', keyword_data: { ...keywordData, keyword: 'best seo api' }, depth: 1, related_keywords: ['a', 'b'] }] }])).value,
    ).toEqual({ cost: 0.0144, status: 'Ok.', seed_keyword: 'seo api', seed: compact, total_count: 8, items: [{ ...compact, keyword: 'best seo api', depth: 1 }] });
    const metric = { pos_1: 1, pos_2_3: 2, pos_4_10: 3, etv: 50, count: 6, estimated_paid_traffic_cost: 70, is_new: 0 };
    expect(
      shape('dataforseo_labs_competitors_domain', envelope([{ target: 'dataforseo.com', total_count: 99, items_count: 1, items: [{ se_type: 'google', domain: 'semrush.com', avg_position: 12.5, sum_position: 300, intersections: 24, full_domain_metrics: { organic: metric, paid: metric }, metrics: { organic: metric, paid: metric }, competitor_metrics: { organic: metric } }] }])).value,
    ).toEqual({
      cost: 0.0144,
      status: 'Ok.',
      target: 'dataforseo.com',
      total_count: 99,
      items: [{ domain: 'semrush.com', intersections: 24, avg_position: 12.5, shared_organic: { count: 6, etv: 50, pos_1: 1, pos_2_3: 2, pos_4_10: 3 }, organic: { count: 6, etv: 50, estimated_paid_traffic_cost: 70 }, paid: { count: 6, etv: 50 } }],
    });
    const overview = shape('dataforseo_labs_domain_rank_overview', envelope([{ target: 'dataforseo.com', total_count: 1, items_count: 1, items: [{ se_type: 'google', location_code: 2840, language_code: 'en', metrics: { organic: metric, paid: metric } }] }])).value as any;
    expect(overview.items[0]).toMatchObject({ location_code: 2840, language_code: 'en', organic: { count: 6, pos_1: 1, is_new: 0 }, paid: { count: 6 } });
    expect(shape('dataforseo_labs_bulk_keyword_difficulty', envelope([{ total_count: 1, items_count: 1, items: [{ se_type: 'google', keyword: 'seo api', keyword_difficulty: 41 }] }])).value).toEqual({
      cost: 0.0144,
      status: 'Ok.',
      items: [{ keyword: 'seo api', keyword_difficulty: 41 }],
    });
  });

  it('shapes backlinks, referring domains, an instant page and technologies', () => {
    const summary = { target: 'dataforseo.com', rank: 512, backlinks: 100000, referring_domains: 3000, referring_links_tld: { com: 10 } };
    expect(shape('dataforseo_backlinks_summary', envelope([summary])).value).toEqual({ cost: 0.0144, status: 'Ok.', summary });
    const backlink = { type: 'backlink', domain_from: 'a.com', url_from: 'https://a.com/x', url_from_https: true, domain_to: 'dataforseo.com', url_to: 'https://dataforseo.com/', anchor: 'DataForSEO', dofollow: true, rank: 300, page_from_rank: 200, domain_from_rank: 500, page_from_title: 'X', domain_from_country: null, first_seen: '2024-01-01 00:00:00 +00:00', last_seen: '2026-10-01 00:00:00 +00:00', is_new: false, is_lost: false, is_broken: false, backlink_spam_score: 3, item_type: 'anchor', text_pre: 'long', text_post: 'long', page_from_external_links: 50 };
    const list = shape('dataforseo_backlinks_list', envelope([{ target: 'dataforseo.com', mode: 'as_is', total_count: 100000, items_count: 1, items: [backlink], search_after_token: 'next' }])).value as any;
    expect(list).toMatchObject({ target: 'dataforseo.com', total_count: 100000, search_after_token: 'next' });
    expect(list.items[0]).toEqual({ url_from: 'https://a.com/x', domain_from: 'a.com', url_to: 'https://dataforseo.com/', anchor: 'DataForSEO', dofollow: true, item_type: 'anchor', rank: 300, page_from_rank: 200, domain_from_rank: 500, page_from_title: 'X', first_seen: '2024-01-01 00:00:00 +00:00', last_seen: '2026-10-01 00:00:00 +00:00', is_new: false, is_lost: false, is_broken: false, backlink_spam_score: 3 });
    const domains = shape('dataforseo_backlinks_referring_domains', envelope([{ target: 'dataforseo.com', total_count: 3000, items_count: 1, items: [{ type: 'backlinks_referring_domains', domain: 'a.com', rank: 500, backlinks: 12, first_seen: '2024-01-01', lost_date: null, backlinks_spam_score: 2, broken_backlinks: 0, referring_pages: 10, referring_domains: 40, referring_links_tld: { com: 1 } }] }])).value as any;
    expect(domains.items[0]).toEqual({ domain: 'a.com', rank: 500, backlinks: 12, referring_pages: 10, referring_domains: 40, broken_backlinks: 0, backlinks_spam_score: 2, first_seen: '2024-01-01' });
    const page = {
      resource_type: 'html', status_code: 200, location: null, url: 'https://dataforseo.com/', size: 120000, total_dom_size: 130000, fetch_time: '2026-10-14 10:00:00 +00:00', media_type: 'text/html', onpage_score: 92.5,
      meta: { title: 'DataForSEO', description: 'APIs', canonical: 'https://dataforseo.com/', htags: { h1: ['SEO APIs'] }, internal_links_count: 100, external_links_count: 10, images_count: 20, scripts_count: 5, cumulative_layout_shift: 0.01, content: { plain_text_word_count: 900, flesch_kincaid_readability_index: 40.2, automated_readability_index: 12 }, social_media_tags: { 'og:title': 'x' } },
      page_timing: { time_to_interactive: 900, dom_complete: 1200, largest_contentful_paint: 800, download_time: 50, connection_time: 3 },
      // Some checks pass when true (is_https, canonical, has_meta_title), is_www is neutral.
      checks: { no_h1_tag: false, is_https: true, is_www: true, high_loading_time: true, title_too_long: false, has_meta_title: false },
      broken_links: false, broken_resources: false,
    };
    expect(shape('dataforseo_onpage_instant_page', envelope([{ crawl_progress: 'finished', crawl_status: null, items_count: 1, items: [page] }])).value).toEqual({
      cost: 0.0144,
      status: 'Ok.',
      pages: [
        {
          url: 'https://dataforseo.com/', status_code: 200, onpage_score: 92.5, media_type: 'text/html', size: 120000, total_dom_size: 130000, fetch_time: '2026-10-14 10:00:00 +00:00',
          title: 'DataForSEO', description: 'APIs', canonical: 'https://dataforseo.com/', htags: { h1: ['SEO APIs'] }, word_count: 900, readability_flesch_kincaid: 40.2,
          internal_links_count: 100, external_links_count: 10, images_count: 20, scripts_count: 5,
          page_timing: { time_to_interactive: 900, dom_complete: 1200, largest_contentful_paint: 800, download_time: 50 }, cumulative_layout_shift: 0.01,
          broken_links: false, broken_resources: false, failed_checks: ['high_loading_time', 'has_meta_title'],
        },
      ],
    });
    const tech = { type: 'domain_technology_item', domain: 'dataforseo.com', title: 'DataForSEO', description: 'APIs', meta_keywords: null, domain_rank: 600, last_visited: '2026-10-01', country_iso_code: 'UA', language_code: 'en', content_language_code: 'en', phone_numbers: ['+3726027642'], emails: ['info@example.com'], social_graph_urls: ['https://x.com/dataforseo'], technologies: { analytics: { analytics: ['Google Analytics'] } } };
    const shaped = shape('dataforseo_domain_technologies', envelope([tech])).value as any;
    expect(shaped.site).toEqual({ domain: 'dataforseo.com', title: 'DataForSEO', description: 'APIs', domain_rank: 600, last_visited: '2026-10-01', country_iso_code: 'UA', language_code: 'en', social_graph_urls: ['https://x.com/dataforseo'], technologies: { analytics: { analytics: ['Google Analytics'] } } });
    expect(JSON.stringify(shaped)).not.toMatch(/info@example\.com|\+3726027642/);
  });
});

const live = process.env.RUN_DATAFORSEO_LIVE ? describe : describe.skip;
live('dataforseo adapter: live', () => {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  const realEnv = login && password ? { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password } : undefined;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it('refuses a wrong login with 401 on the free account call and on a paid endpoint', async () => {
    await expect(call('dataforseo_get_account', {})).rejects.toMatchObject({ response: { status: 401, data: { status_code: 40100 } } });
    await expect(call('dataforseo_serp_google_organic', SAMPLE_ARGS.dataforseo_serp_google_organic)).rejects.toMatchObject({ response: { status: 401 } });
    await expect(call('dataforseo_get_account', {}, ENV, SANDBOX)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (realEnv ? it : it.skip)('reads the account, the languages and the locations of a country (all free)', async () => {
    const account = shape('dataforseo_get_account', await call('dataforseo_get_account', {}, realEnv)).value as any;
    expect(account.login).toBe(login);
    expect(typeof account.balance_usd).toBe('number');
    const languages = shape('dataforseo_list_languages', await call('dataforseo_list_languages', {}, realEnv)).value as any[];
    expect(languages).toEqual(expect.arrayContaining([{ code: 'de', name: 'German' }]));
    const labs = shape('dataforseo_list_labs_locations', await call('dataforseo_list_labs_locations', {}, realEnv)).value as any[];
    expect(labs.find((l) => l.code === 2276)).toMatchObject({ name: 'Germany' });
    const locations = shape('dataforseo_list_locations', await call('dataforseo_list_locations', { country: 'at' }, realEnv));
    expect(locations.error).toBeUndefined();
    const rows = (locations.truncated ? (locations.value as any).items : locations.value) as any[];
    expect(rows[0]).toEqual({ code: 2040, name: 'Austria', type: 'Country' });
  }, 60000);

  // The sandbox answers every endpoint with dummy data of the real shape and
  // charges nothing, so each paid tool is run and shaped here for free.
  (realEnv ? it.each(PAID) : it.skip.each(PAID))('%s runs on the free sandbox and shapes its answer', async (name) => {
    const raw = await call(name, SAMPLE_ARGS[name], realEnv, SANDBOX);
    expect(raw.status_code).toBe(20000);
    expect(raw.tasks[0].status_code).toBe(20000);
    const out = shape(name, raw);
    expect(out.error).toBeUndefined();
    expect(JSON.stringify(out.value).length).toBeLessThan(JSON.stringify(raw).length);
  }, 60000);
});
