import axios from 'axios';
import * as adapter from './moz.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, readTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Moz adapter:
 *
 *   1. Static: always runs. Pins the token in the x-moz-token header, the
 *      JSON-RPC 2.0 envelope every tool posts to /jsonrpc (method name, an id
 *      Moz accepts, params.data) through the real RestEngine, the data fields
 *      against the method definitions published in the Moz API docs
 *      (moz.com/api/docs/methods/*, fetched 14 Oct 2026), the quota costs in
 *      the descriptions, the JSON-RPC errors Moz returns, and the response
 *      trimming on answers built from the documented result fields.
 *
 *   2. Live: skipped unless RUN_MOZ_LIVE=1. Without a token it checks once
 *      that a wrong token is refused with 401 and the JSON-RPC code -32651
 *      (only one call: Moz blocks an IP for 30 minutes after 10 failed logins
 *      in 5 minutes). With MOZ_API_TOKEN it only makes calls that cost no
 *      quota: the quota lookup, the locale list (zero rows) and an async job
 *      of Moz's free test.ping.async method collected with
 *      moz_get_async_result:
 *
 *        RUN_MOZ_LIVE=1 MOZ_API_TOKEN=... npx jest src/adapters/intl/moz.live.spec.ts
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
  endpointMapping: { method: string; path: string; bodyMapping: { jsonrpc: string; id: string; method: string; params: { data: Record<string, unknown> } } };
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
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string; config?: unknown };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const ENDPOINT = 'https://api.moz.com/jsonrpc';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'mozT0ken' + 'x'.repeat(40);
const ENV: Record<string, string> = { MOZ_API_TOKEN: FAKE_TOKEN };

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping as any, env);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping as any,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);
const ok = (result: unknown) => ({ id: 'anythingmcp-x', jsonrpc: '2.0', result });

// JSON-RPC method of each tool and the params.data fields its Moz method
// definition documents (14 Oct 2026); nested objects list their own fields.
const METHODS: Record<string, [string, Record<string, string[]>]> = {
  moz_get_quota: ['quota.lookup', { path: [] }],
  moz_site_metrics: ['data.site.metrics.fetch', { site_query: ['query', 'scope'] }],
  moz_site_metrics_multiple: ['data.site.metrics.fetch.multiple', { site_queries: [] }],
  moz_brand_authority: ['data.site.metrics.brand.authority.fetch', { site_query: ['query', 'scope'] }],
  moz_list_links: ['data.site.link.list', { site_query: ['query', 'scope'], options: ['scope', 'subdomains_limited_to_one', 'sort', 'filters'], offset: ['token', 'limit'] }],
  moz_list_linking_domains: ['data.site.linking-domain.list', { site_query: ['query', 'scope'], options: ['sort', 'filters'], offset: ['token', 'limit'] }],
  moz_list_anchor_texts: ['data.site.anchor-text.list', { site_query: ['query', 'scope'], offset: ['token', 'limit'] }],
  moz_list_ranking_keywords: ['data.site.ranking-keyword.list', { target_query: ['query', 'scope', 'locale'], options: ['sort'], page: ['n', 'limit'] }],
  moz_count_ranking_keywords: ['data.site.ranking-keyword.count', { target_query: ['query', 'scope', 'locale'] }],
  moz_list_top_pages: ['data.site.top-page.list', { site_query: ['query', 'scope'], options: ['filter', 'sort'], offset: ['token', 'limit'] }],
  moz_keyword_metrics: ['data.keyword.metrics.fetch', { serp_query: ['keyword', 'locale', 'device', 'engine', 'vicinity'], options: ['include_intent', 'max_age'] }],
  moz_keyword_metrics_multiple: ['data.keyword.metrics.fetch.multiple', { serp_queries: [] }],
  moz_keyword_suggestions: ['data.keyword.suggestion.list', { serp_query: ['keyword', 'locale', 'device', 'engine', 'vicinity'], options: ['strategy'], page: ['n', 'limit'] }],
  moz_get_async_result: ['async.call.lookup', { id: [] }],
  moz_list_locales: ['metadata.locale.list', { engine: [] }],
};
const FREE = ['moz_get_quota', 'moz_get_async_result'];

describe('moz adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until a live run with a paid token', () => {
    expect(a.unlisted).toBe(true);
    expect(a.category).toBe('analytics');
    expect(a.icon).toBe('moz');
  });

  it('sends the token in x-moz-token from the encrypted authConfig, never as a tool parameter', () => {
    expect(a.connector.baseUrl).toBe('https://api.moz.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-moz-token', apiKey: '{{MOZ_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['MOZ_API_TOKEN']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'MOZ_API_TOKEN', kind: 'credential', secret: true, required: true });
    for (const t of a.tools) expect(Object.keys(t.parameters.properties ?? {})).not.toContain('token');
  });

  it('accepts a pasted token and refuses a pasted header', () => {
    const re = new RegExp(a.envVarMeta.MOZ_API_TOKEN.pattern!);
    expect(re.test(FAKE_TOKEN)).toBe(true);
    expect(re.test('bW96LWFwaS10b2tlbi1leGFtcGxlLXZhbHVl==')).toBe(true);
    for (const bad of ['', `x-moz-token: ${FAKE_TOKEN}`, `Bearer ${FAKE_TOKEN}`, 'short']) expect(re.test(bad)).toBe(false);
  });

  // Every Moz method is a POST; a GET on /jsonrpc or / answers 404, so the
  // GET-only healthcheck has no path to use and the free quota lookup stands
  // in for it as the install probe.
  it('has no GET healthcheck and probes with the free quota lookup', () => {
    expect(a.connector.healthcheckPath).toBeUndefined();
    expect(a.probe).toEqual({ tool: 'moz_get_quota' });
    expect(tool('moz_get_quota').parameters.required ?? []).toEqual([]);
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toContain('https://moz.com/api/dashboard');
  });

  it('prefixes every tool with moz_, shares no tool name with another adapter, and is read-only', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^moz_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      const ann = deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
      expect(`${t.name}:${ann.readOnlyHint}:${ann.destructiveHint}`).toBe(`${t.name}:true:false`);
      expect(t.enabled).not.toBe(false);
    }
    expect(Object.keys(METHODS).sort()).toEqual([...mine].sort());
  });

  it('builds a valid JSON-RPC envelope with only documented data fields', () => {
    for (const [name, [method, documented]] of Object.entries(METHODS)) {
      const em = tool(name).endpointMapping;
      expect(`${name}:${em.method}:${em.path}`).toBe(`${name}:POST:/jsonrpc`);
      expect(em.bodyMapping.jsonrpc).toBe('2.0');
      expect(em.bodyMapping.method).toBe(method);
      // Moz: letters, digits and hyphens only, and longer than 24 characters
      // (an id of exactly 24 was refused live with -32654 on 14 Oct 2026).
      expect(em.bodyMapping.id).toMatch(/^[A-Za-z0-9-]{25,}$/);
      expect(Object.keys(em.bodyMapping).sort()).toEqual(['id', 'jsonrpc', 'method', 'params']);
      for (const [field, value] of Object.entries(em.bodyMapping.params.data)) {
        expect(Object.keys(documented)).toContain(field);
        if (value && typeof value === 'object') {
          for (const sub of Object.keys(value)) expect(`${name}.${field}.${sub}:${documented[field].includes(sub)}`).toBe(`${name}.${field}.${sub}:true`);
        }
      }
    }
  });

  it('keeps list defaults small and states the quota cost of every tool', () => {
    for (const t of a.tools) {
      const l = t.parameters.properties?.limit;
      if (l) expect(l.default as number).toBeLessThanOrEqual(20);
      if (FREE.includes(t.name)) expect(t.description).toMatch(/Free: uses no quota/);
      else expect(t.description).toMatch(/rows? of quota|Uses no rows/);
    }
  });

  it('only points the model at tools that exist, documents setup and quota, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bmoz_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmoz_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://moz.com/api/dashboard');
    expect(a.instructions).toMatch(/Data calls use rows/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries a working response mapping on every tool', () => {
    for (const t of a.tools) {
      expect(validateTransform(t.responseMapping?.transform)).toBeNull();
      expect(`${t.name}:${readTransform(t.responseMapping as any) !== null}`).toBe(`${t.name}:true`);
    }
  });

  it('sends every tool as one JSON-RPC call to /jsonrpc with the token header', async () => {
    const args: Record<string, Record<string, unknown>> = {
      moz_site_metrics: { query: 'moz.com' },
      moz_site_metrics_multiple: { site_queries: [{ query: 'moz.com', scope: 'domain' }] },
      moz_brand_authority: { query: 'moz.com' },
      moz_list_links: { query: 'moz.com' },
      moz_list_linking_domains: { query: 'moz.com' },
      moz_list_anchor_texts: { query: 'moz.com' },
      moz_list_ranking_keywords: { query: 'moz.com' },
      moz_count_ranking_keywords: { query: 'moz.com' },
      moz_list_top_pages: { query: 'moz.com' },
      moz_keyword_metrics: { keyword: 'seo' },
      moz_keyword_metrics_multiple: { serp_queries: [{ keyword: 'seo', locale: 'en-US', device: 'desktop', engine: 'google' }] },
      moz_keyword_suggestions: { keyword: 'seo' },
      moz_get_async_result: { id: 'c3397e5a-ce31-42fb-8607-ed40487aea18' },
    };
    for (const name of Object.keys(METHODS)) {
      mockedAxios.mockReset();
      mockedAxios.mockResolvedValue({ data: ok({}) });
      await call(name, args[name] ?? {});
      const req = sent();
      expect(`${name}:${req.method}:${req.url}`).toBe(`${name}:POST:${ENDPOINT}`);
      expect(req.headers['x-moz-token']).toBe(FAKE_TOKEN);
      expect(req.headers['User-Agent']).toBe('AnythingMCP');
      expect(req.data.method).toBe(METHODS[name][0]);
      expect(req.data.jsonrpc).toBe('2.0');
    }
  });

  it('fills the required nested fields with defaults and leaves unset options out', async () => {
    mockedAxios.mockResolvedValue({ data: ok({}) });
    const data = async (name: string, params: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await call(name, params);
      return sent().data.params.data;
    };
    expect(await data('moz_get_quota', {})).toEqual({ path: 'api.limits.data.rows' });
    expect(await data('moz_site_metrics', { query: 'moz.com/blog', scope: 'subfolder' })).toEqual({ site_query: { query: 'moz.com/blog', scope: 'subfolder' } });
    expect(await data('moz_brand_authority', { query: 'moz.com' })).toEqual({ site_query: { query: 'moz.com', scope: 'domain' } });
    expect(await data('moz_list_links', { query: 'moz.com' })).toEqual({
      site_query: { query: 'moz.com', scope: 'domain' },
      options: { sort: 'source_page_authority' },
      offset: { limit: 10 },
    });
    expect(await data('moz_list_links', { query: 'moz.com', filters: ['external', 'follow'], link_scope: 'domain', limit: 50, next_token: 'tok' })).toEqual({
      site_query: { query: 'moz.com', scope: 'domain' },
      options: { sort: 'source_page_authority', scope: 'domain', filters: ['external', 'follow'] },
      offset: { limit: 50, token: 'tok' },
    });
    expect(await data('moz_list_ranking_keywords', { query: 'moz.com', page_number: 2 })).toEqual({
      target_query: { query: 'moz.com', scope: 'domain', locale: 'en-US' },
      options: { sort: 'rank' },
      page: { n: 2, limit: 20 },
    });
    expect(await data('moz_list_top_pages', { query: 'moz.com', status_filter: 'status_200' })).toEqual({
      site_query: { query: 'moz.com', scope: 'domain' },
      options: { sort: 'page_authority', filter: 'status_200' },
      offset: { limit: 10 },
    });
    expect(await data('moz_keyword_metrics', { keyword: 'seo', locale: 'de-DE' })).toEqual({
      serp_query: { keyword: 'seo', locale: 'de-DE', device: 'desktop', engine: 'google' },
      options: { include_intent: false },
    });
    expect(await data('moz_keyword_suggestions', { keyword: 'seo', vicinity: 'New York, NY' })).toEqual({
      serp_query: { keyword: 'seo', locale: 'en-US', device: 'desktop', engine: 'google', vicinity: 'New York, NY' },
      options: { strategy: 'default' },
      page: { limit: 20 },
    });
    expect(await data('moz_get_async_result', { id: 'abc' })).toEqual({ id: 'abc' });
    expect(await data('moz_list_locales', {})).toEqual({ engine: 'google' });
  });

  it('turns a JSON-RPC error that arrives with HTTP 200 into a failure', async () => {
    mockedAxios.mockResolvedValue({
      data: { id: 'x', jsonrpc: '2.0', error: { code: -32652, status: 400, data: { explanation: 'query is a required field and was not included.', issue: 'param-is-missing', key: 'query' }, message: 'Please include a query' } },
    });
    await expect(call('moz_site_metrics', { query: 'moz.com' })).rejects.toThrow(/Please include a query/);
  });

  it('shapes quota, site metrics and brand authority without the JSON-RPC envelope', () => {
    const quota = { path: 'api.limits.data.rows', account_id: 1, allotted: 50, used: 3, reset: 'month', report: 'day', overage: false, period_start: 1, period_reset: 2 };
    expect(shape('moz_get_quota', ok({ quota })).value).toEqual({ quota });
    const metrics = { page: 'moz.com/', root_domain: 'moz.com', domain_authority: 91, page_authority: 70, spam_score: 1 };
    expect(shape('moz_site_metrics', ok({ site_query: { query: 'moz.com', scope: 'domain' }, site_metrics: metrics })).value).toEqual({ site_query: { query: 'moz.com', scope: 'domain' }, site_metrics: metrics });
    expect(shape('moz_brand_authority', ok({ site_metrics: { brand_authority_score: 66 }, site_query: { query: 'moz.com', scope: 'domain' } })).value).toEqual({
      site_query: { query: 'moz.com', scope: 'domain' },
      brand_authority_score: 66,
    });
  });

  it('shapes multi-site metrics into rows and errors', () => {
    const raw = ok({
      results_by_site: [{ site_query: { query: 'moz.com', scope: 'domain' }, site_metrics: { page: 'moz.com/', title: 'Moz', http_code: 200, domain_authority: 91, page_authority: 70, spam_score: 1, link_propensity: 0.1, root_domains_to_root_domain: 200000, pages_to_page: 5, external_pages_to_root_domain: 9000000, last_crawled: '2026-10-01' } }],
      errors_by_site: [{ site_query: { query: 'nope.invalid', scope: 'domain' }, error: { message: 'No data found for that query.', name: 'NotFoundError', httpStatus: 404, jsonrpcCode: -32655 } }],
    });
    expect(shape('moz_site_metrics_multiple', raw).value).toEqual({
      results: [{ query: 'moz.com', scope: 'domain', page: 'moz.com/', title: 'Moz', http_code: 200, domain_authority: 91, page_authority: 70, spam_score: 1, link_propensity: 0.1, root_domains_to_root_domain: 200000, external_pages_to_root_domain: 9000000, last_crawled: '2026-10-01' }],
      errors: [{ query: 'nope.invalid', scope: 'domain', message: 'No data found for that query.' }],
    });
  });

  it('shapes links, linking domains, anchor texts and top pages with the next page token', () => {
    const sm = (page: string) => ({ page, subdomain: 'www.a.com', root_domain: 'a.com', title: 'A', last_crawled: '2026-09-01', http_code: 200, page_authority: 40, domain_authority: 55, link_propensity: 0.02, spam_score: 2, root_domains_to_page: 12, external_pages_to_page: 30, pages_to_page: 99 });
    const links = ok({
      site_query: { query: 'moz.com', scope: 'domain' },
      offset: { provided_token: null, token: 'NEXT', limit: 1 },
      links: [{ source_site_metrics: sm('a.com/post'), target_site_metrics: sm('moz.com/'), anchor_text: 'Moz', date_first_seen: '2024-01-01', date_last_seen: '2026-09-01', date_disappeared: null, nofollow: false, redirect: false, rel_canonical: false, via_redirect: false, via_rel_canonical: false }],
      options: { scope: 'page', sort: 'source_page_authority', filters: [] },
    });
    expect(shape('moz_list_links', links).value).toEqual({
      site_query: { query: 'moz.com', scope: 'domain' },
      links: [{ source_page: 'a.com/post', source_title: 'A', source_root_domain: 'a.com', source_domain_authority: 55, source_page_authority: 40, source_spam_score: 2, target_page: 'moz.com/', anchor_text: 'Moz', nofollow: false, redirect: false, rel_canonical: false, date_first_seen: '2024-01-01', date_last_seen: '2026-09-01', date_disappeared: null }],
      next_token: 'NEXT',
    });
    const domains = ok({ site_query: { query: 'moz.com', scope: 'domain' }, offset: { token: 'N2', limit: 1 }, linking_domains: [{ site_metrics: sm('a.com/'), link_propensity: 0.02, targeted_pages: 4, targeted_nofollow_pages: 0, targeted_redirect_pages: 0, targeted_deleted_pages: 1 }] });
    expect(shape('moz_list_linking_domains', domains).value).toEqual({
      site_query: { query: 'moz.com', scope: 'domain' },
      linking_domains: [{ root_domain: 'a.com', domain_authority: 55, spam_score: 2, link_propensity: 0.02, targeted_pages: 4, targeted_nofollow_pages: 0, targeted_redirect_pages: 0, targeted_deleted_pages: 1 }],
      next_token: 'N2',
    });
    const anchors = ok({ site_query: { query: 'moz.com', scope: 'domain' }, offset: { token: null, limit: 1 }, anchor_texts: [{ text: 'moz', external_root_domains: 900, external_pages: 5000 }] });
    expect(shape('moz_list_anchor_texts', anchors).value).toEqual({ site_query: { query: 'moz.com', scope: 'domain' }, anchor_texts: [{ text: 'moz', external_root_domains: 900, external_pages: 5000 }], next_token: null });
    const pages = ok({ site_query: { query: 'moz.com', scope: 'domain' }, offset: { token: 'N3', limit: 1 }, options: { filter: 'all', sort: 'page_authority' }, top_pages: [sm('moz.com/')] });
    expect(shape('moz_list_top_pages', pages).value).toEqual({
      site_query: { query: 'moz.com', scope: 'domain' },
      top_pages: [{ page: 'moz.com/', title: 'A', http_code: 200, page_authority: 40, spam_score: 2, root_domains_to_page: 12, external_pages_to_page: 30, last_crawled: '2026-09-01' }],
      next_token: 'N3',
    });
  });

  it('shapes ranking keywords, keyword metrics and async calls', () => {
    const target = { query: 'moz.com', scope: 'domain', locale: 'en-US' };
    expect(shape('moz_list_ranking_keywords', ok({ ranking_keywords: [{ keyword: 'seo', ranking_page: 'moz.com/learn/seo', rank_position: 2, difficulty: 80, volume: 100000 }], target_query: target, options: { sort: 'rank' }, page: { n: 0, limit: 20 } })).value).toEqual({
      target_query: target,
      ranking_keywords: [{ keyword: 'seo', ranking_page: 'moz.com/learn/seo', rank_position: 2, difficulty: 80, volume: 100000 }],
      page: { n: 0, limit: 20 },
    });
    expect(shape('moz_count_ranking_keywords', ok({ ranking_keyword_count: { total: 500, position: { rank_1: 10 } }, target_query: target })).value).toEqual({
      target_query: target,
      ranking_keyword_count: { total: 500, position: { rank_1: 10 } },
    });
    const serp = { keyword: 'domain authority', locale: 'en-US', device: 'desktop', engine: 'google', vicinity: '' };
    const km = { volume: 2200, difficulty: 69, organic_ctr: 79, priority: 57 };
    expect(shape('moz_keyword_metrics', ok({ serp_query: serp, keyword_metrics: km, options: { include_intent: false } })).value).toEqual({ serp_query: serp, keyword_metrics: km });
    expect(
      shape('moz_keyword_metrics_multiple', ok({ results_by_serp_query: [{ serp_query: serp, keyword_metrics: km }], errors_by_serp_query: [{ serp_query: { ...serp, keyword: 'zzqq' }, error: { message: 'No data found for that query.', name: 'NotFoundError' } }] })).value,
    ).toEqual({ results: [{ keyword: 'domain authority', locale: 'en-US', keyword_metrics: km }], errors: [{ keyword: 'zzqq', locale: 'en-US', message: 'No data found for that query.' }] });
    const pending = { id: 'c3397e5a-ce31-42fb-8607-ed40487aea18', action: 'data.keyword.suggestion.list', status: 'pending', ttl: 120, result: null, error: null };
    expect(shape('moz_keyword_suggestions', ok({ async_call: pending })).value).toEqual({ async_call: pending });
    const done = { ...pending, status: 'complete', ttl: 20, result: { suggestions: [{ keyword: 'seo tools', relevance: 0.9 }], serp_query: serp, options: { strategy: 'default' }, page: { n: 0, limit: 20 } } };
    expect(shape('moz_get_async_result', ok({ async_call: done })).value).toEqual({ async_call: done });
    expect(shape('moz_list_locales', ok({ engine: 'google', locales: ['en-US', 'de-DE'] })).value).toEqual({ engine: 'google', locales: ['en-US', 'de-DE'] });
  });
});

const live = process.env.RUN_MOZ_LIVE ? describe : describe.skip;
live('moz adapter: live', () => {
  const realToken = process.env.MOZ_API_TOKEN;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  // One call only: ten failed logins in five minutes block the IP for 30 minutes.
  (realToken ? it.skip : it)('refuses a wrong token with 401 and JSON-RPC code -32651', async () => {
    await expect(call('moz_get_quota', {})).rejects.toMatchObject({ response: { status: 401, data: { error: { code: -32651 } } } });
  }, 30000);

  (realToken ? it : it.skip)('reads the quota and the locales and collects a free async job (no quota used)', async () => {
    const env = { MOZ_API_TOKEN: realToken! };
    const quota = shape('moz_get_quota', await call('moz_get_quota', {}, env)).value as any;
    expect(quota.quota.path).toBe('api.limits.data.rows');
    expect(typeof quota.quota.allotted).toBe('number');
    const locales = shape('moz_list_locales', await call('moz_list_locales', {}, env)).value as any;
    expect(locales.locales).toContain('en-US');
    // test.ping.async is Moz's free test of the async flow; its result is held back about 5 seconds.
    const started = await (mockedAxios.__actual as any).request({
      url: ENDPOINT,
      method: 'POST',
      headers: { 'x-moz-token': realToken, 'Content-Type': 'application/json' },
      data: { jsonrpc: '2.0', id: 'anythingmcp-test-ping-async-0001', method: 'test.ping.async', params: { data: { message: 'AnythingMCP' } } },
    });
    const id = started.data.result.async_call.id;
    let job: any;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      job = (shape('moz_get_async_result', await call('moz_get_async_result', { id }, env)).value as any).async_call;
      if (job.status === 'complete') break;
    }
    expect(job).toMatchObject({ id, status: 'complete', result: { message: 'AnythingMCP' } });
  }, 90000);
});
