import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './ozon-performance.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Ozon Performance (advertising) adapter:
 *
 *   1. Static: always runs. Pins the token exchange (POST /api/client/token
 *      with client_id, client_secret and grant_type client_credentials as a
 *      JSON body, access_token valid 1800 seconds, sent as Bearer), every
 *      tool's method, URL, query and body through the real RestEngine, the
 *      read-only hints on the POST reads and report requests, the tools
 *      installed switched off, and the response mappings against payloads
 *      shaped like the official Performance API OpenAPI schema
 *      (docs.ozon.ru/api/performance, checked on 5 Nov 2026).
 *
 *   2. Live: skipped unless RUN_OZON_PERFORMANCE_LIVE=1.
 *      - Without credentials it asks for a token with a made-up client and
 *        expects 401:
 *          RUN_OZON_PERFORMANCE_LIVE=1 npx jest src/adapters/intl/ozon-performance.live.spec.ts
 *      - With OZON_PERFORMANCE_CLIENT_ID and OZON_PERFORMANCE_CLIENT_SECRET it
 *        gets a real token and runs the read tools with minimal arguments,
 *        including the asynchronous report flow for one campaign. No write
 *        tool is called.
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
  parameters: { properties?: Record<string, { default?: unknown; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping?: Record<string, unknown>; queryParams?: Record<string, unknown> };
  responseMapping?: { transform?: Record<string, unknown>; binary?: Record<string, unknown> };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  name: string;
  category: string;
  icon: string;
  region: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string; link?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api-performance.ozon.ru';
const CLIENT_ID = '12345678-1700000000000@advertising.performance.ozon.ru';
// Built at runtime so no literal looks like a real credential.
const SECRET = ['test', 'Secret', 'x'.repeat(24)].join('');
const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'AAAA'].join('.');
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
const env = (id = CLIENT_ID, secret = SECRET) => ({ OZON_PERFORMANCE_CLIENT_ID: id, OZON_PERFORMANCE_CLIENT_SECRET: secret });

const fakeBundle = async () => ({ token: FAKE_JWT, expiresAt: Date.now() + 1_800_000 });
const stubLogin = { getToken: fakeBundle, forceRelogin: fakeBundle } as unknown as LoginTokenService;
let login: LoginTokenService = stubLogin;
let creds = env();
const run = async (name: string, params: Record<string, unknown>) => {
  const { body } = await new RestEngine({} as OAuth2TokenService, login).executeWithMeta(
    { baseUrl: a.connector.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, creds), headers: a.connector.headers } as never,
    tool(name).endpointMapping as never,
    applySchemaDefaults(tool(name).parameters as never, params),
  );
  return body as any;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);
const sent = () => mockedAxios.mock.calls[0][0];

const SWITCHED_OFF = ['ozon_performance_activate_campaign', 'ozon_performance_remove_campaign_products'];
const WRITES = [
  'ozon_performance_add_campaign_products',
  'ozon_performance_update_campaign_bids',
  'ozon_performance_remove_campaign_products',
  'ozon_performance_deactivate_campaign',
  'ozon_performance_activate_campaign',
];
const C = '12345678';
const UUID = '3b7e7b07-5d5f-4a4f-9a51-3a3b3a3b3a3b';
// [tool, minimal arguments, method, path]
const TABLE: Array<[string, Record<string, unknown>, string, string]> = [
  ['ozon_performance_list_campaigns', {}, 'GET', '/api/client/campaign'],
  ['ozon_performance_list_campaign_objects', { campaign_id: C }, 'GET', `/api/client/campaign/${C}/objects`],
  ['ozon_performance_list_campaign_products', { campaign_id: C }, 'GET', `/api/client/campaign/${C}/v2/products`],
  ['ozon_performance_get_competitive_bids', { campaign_id: C, skus: ['987654321'] }, 'GET', `/api/client/campaign/${C}/products/bids/competitive`],
  ['ozon_performance_get_bid_limits', {}, 'GET', '/api/client/limits/list'],
  ['ozon_performance_list_cpo_products', {}, 'POST', '/api/client/campaign/search_promo/v2/products'],
  ['ozon_performance_get_daily_statistics', {}, 'GET', '/api/client/statistics/daily/json'],
  ['ozon_performance_get_expense_statistics', {}, 'GET', '/api/client/statistics/expense/json'],
  ['ozon_performance_get_cpc_campaign_statistics', {}, 'GET', '/api/client/statistics/campaign/product/json'],
  ['ozon_performance_request_campaign_report', { campaigns: [C], dateFrom: '2026-10-01', dateTo: '2026-10-31' }, 'POST', '/api/client/statistics'],
  ['ozon_performance_request_search_phrases_report', { campaigns: [C], dateFrom: '2026-10-01', dateTo: '2026-10-31' }, 'POST', '/api/client/statistics/phrases'],
  ['ozon_performance_get_report_status', { uuid: UUID }, 'GET', `/api/client/statistics/${UUID}`],
  ['ozon_performance_download_report', { uuid: UUID }, 'GET', '/api/client/statistics/report'],
  ['ozon_performance_list_api_reports', {}, 'GET', '/api/client/statistics/externallist'],
  ['ozon_performance_add_campaign_products', { campaign_id: C, bids: [{ sku: '987654321' }] }, 'POST', `/api/client/campaign/${C}/products`],
  ['ozon_performance_update_campaign_bids', { campaign_id: C, bids: [{ sku: '987654321', bid: '15000000' }] }, 'PUT', `/api/client/campaign/${C}/products`],
  ['ozon_performance_remove_campaign_products', { campaign_id: C, skus: ['987654321'] }, 'POST', `/api/client/campaign/${C}/products/delete`],
  ['ozon_performance_deactivate_campaign', { campaign_id: C }, 'POST', `/api/client/campaign/${C}/deactivate`],
  ['ozon_performance_activate_campaign', { campaign_id: C }, 'POST', `/api/client/campaign/${C}/activate`],
];
const READS = TABLE.filter(([n]) => !WRITES.includes(n));

describe('ozon-performance adapter: static spec conformance', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    login = stubLogin;
    creds = env();
  });

  it('is listed in the advertising category with the Ozon logo', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('ozon-performance');
    expect(a.name).toBe('Ozon Performance (Ads)');
    expect(a.icon).toBe('ozon');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('advertising');
  });

  it('exchanges the client ID and secret for a 30-minute bearer token at /api/client/token', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: `${BASE}/api/client/token`,
      loginMethod: 'POST',
      loginBody: { client_id: '${username}', client_secret: '${password}', grant_type: 'client_credentials' },
      username: '{{OZON_PERFORMANCE_CLIENT_ID}}',
      password: '{{OZON_PERFORMANCE_CLIENT_SECRET}}',
      tokenJsonPath: 'access_token',
      expiryJsonPath: 'expires_in',
      expiryFormat: 'ttl_seconds',
      tokenTTLSeconds: 1800,
      refreshOn401: true,
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
    });
    expect(a.connector.authConfig.proactiveRefreshSeconds).toBeLessThan(1800);
    expect(a.requiredEnvVars).toEqual(['OZON_PERFORMANCE_CLIENT_ID', 'OZON_PERFORMANCE_CLIENT_SECRET']);
    expect(a.envVarMeta.OZON_PERFORMANCE_CLIENT_SECRET.secret).toBe(true);
    for (const meta of Object.values(a.envVarMeta)) expect(meta.link).toBe('https://seller.ozon.ru/app/settings/api-keys?currentTab=performanceApi');
  });

  it('posts the documented JSON body and sends the token as Bearer', async () => {
    const auth = interpolateDeep(a.connector.authConfig, env()) as any;
    mockedAxios.mockResolvedValueOnce({ data: { access_token: FAKE_JWT, expires_in: 1800, token_type: 'Bearer' }, headers: {} });
    const bundle = await new LoginTokenService({} as any, config).getToken(auth);
    const req = sent();
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${BASE}/api/client/token`);
    expect(req.data).toEqual({ client_id: CLIENT_ID, client_secret: SECRET, grant_type: 'client_credentials' });
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(bundle.token).toBe(FAKE_JWT);
    expect(bundle.expiresAt - Date.now()).toBeLessThanOrEqual(1_800_000);
  });

  it('accepts a Performance client ID and refuses a Seller API client id', () => {
    const id = new RegExp(a.envVarMeta.OZON_PERFORMANCE_CLIENT_ID.pattern!);
    expect(id.test(CLIENT_ID)).toBe(true);
    for (const bad of ['1234567', 'name@example.com', ` ${CLIENT_ID}`, '']) expect(id.test(bad)).toBe(false);
    const secret = new RegExp(a.envVarMeta.OZON_PERFORMANCE_CLIENT_SECRET.pattern!);
    expect(secret.test(SECRET)).toBe(true);
    for (const bad of ['', 'short', `${SECRET} x`]) expect(secret.test(bad)).toBe(false);
  });

  it('probes with a one-row campaign list and explains the error codes', () => {
    expect(a.probe).toEqual({ tool: 'ozon_performance_list_campaigns', params: { page_size: 1 } });
    expect(a.connector.healthcheckPath).toBe('/api/client/limits/list');
    for (const status of ['401', '403', 'rate_limited']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('lists every tool in the URL table', () => {
    expect(TABLE.map(([n]) => n).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(TABLE)('%s sends %s %s with the bearer token', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(`${BASE}${path}`);
    expect(sent().headers.Authorization).toBe(`Bearer ${FAKE_JWT}`);
  });

  it('every tool is prefixed, unique, described, and every declared parameter reaches the request', () => {
    const names = new Set(a.tools.map((t) => t.name));
    expect(names.size).toBe(a.tools.length);
    for (const t of a.tools) {
      expect(t.name).toMatch(/^ozon_performance_[a-z_]+$/);
      expect(t.description.length).toBeGreaterThanOrEqual(80);
      const mapping = JSON.stringify(t.endpointMapping);
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        const used = mapping.includes(`"$${p}"`) || t.endpointMapping.path.includes(`{${p}}`);
        expect(`${t.name}:${p}:${used}`).toBe(`${t.name}:${p}:true`);
      }
    }
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(names.has(t.name)).toBe(false);
    }
  });

  it('reads and report requests are read-only; writes are not, and ask for confirmation', () => {
    for (const [name, , method] of READS) {
      expect(`${name}:${annotationsOf(tool(name)).readOnlyHint}`).toBe(`${name}:true`);
      if (method === 'POST') expect(tool(name).annotations).toEqual({ readOnlyHint: true });
      expect(tool(name).enabled).toBeUndefined();
    }
    for (const name of WRITES) {
      expect(`${name}:${annotationsOf(tool(name)).readOnlyHint}`).toBe(`${name}:false`);
      expect(tool(name).description).toMatch(/confirm/i);
    }
    expect(annotationsOf(tool('ozon_performance_update_campaign_bids')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('ozon_performance_remove_campaign_products')).destructiveHint).toBe(true);
  });

  it('installs starting a campaign and removing products switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${t.enabled === false}`).toBe(`${t.name}:${SWITCHED_OFF.includes(t.name)}`);
  });

  it('builds the queries and bodies the Performance API expects', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const req = async (name: string, params: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await run(name, params);
      return sent();
    };
    expect((await req('ozon_performance_list_campaigns', {})).params).toEqual({ page: 1, pageSize: 20 });
    expect((await req('ozon_performance_list_campaigns', { campaign_ids: ['1', '2'], adv_object_type: 'SKU', state: 'CAMPAIGN_STATE_RUNNING' })).params).toEqual({
      campaignIds: ['1', '2'],
      advObjectType: 'SKU',
      state: 'CAMPAIGN_STATE_RUNNING',
      page: 1,
      pageSize: 20,
    });
    // Arrays go out as repeated keys (campaignIds=1&campaignIds=2), the form grpc-gateway reads.
    const daily = await req('ozon_performance_get_daily_statistics', { campaign_ids: ['1', '2'], date_from: '2026-10-01', date_to: '2026-10-07' });
    expect(daily.params).toEqual({ campaignIds: ['1', '2'], dateFrom: '2026-10-01', dateTo: '2026-10-07' });
    expect(daily.paramsSerializer(daily.params)).toBe('campaignIds=1&campaignIds=2&dateFrom=2026-10-01&dateTo=2026-10-07');
    expect((await req('ozon_performance_get_daily_statistics', {})).params ?? {}).toEqual({});
    expect((await req('ozon_performance_get_competitive_bids', { campaign_id: C, skus: ['9'] })).params).toEqual({ skus: ['9'] });
    expect((await req('ozon_performance_download_report', { uuid: UUID })).params).toEqual({ UUID });
    expect((await req('ozon_performance_list_cpo_products', {})).data).toEqual({ page: 1, pageSize: 20 });
    expect((await req('ozon_performance_request_campaign_report', { campaigns: [C], dateFrom: '2026-10-01', dateTo: '2026-10-31', groupBy: 'DATE' })).data).toEqual({
      campaigns: [C],
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      groupBy: 'DATE',
    });
    expect((await req('ozon_performance_request_search_phrases_report', { campaigns: [C], dateFrom: '2026-10-01', dateTo: '2026-10-31' })).data).toEqual({
      campaigns: [C],
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
    });
    expect((await req('ozon_performance_update_campaign_bids', { campaign_id: C, bids: [{ sku: '9', bid: '15000000' }] })).data).toEqual({ bids: [{ sku: '9', bid: '15000000' }] });
    expect((await req('ozon_performance_add_campaign_products', { campaign_id: C, bids: [{ sku: '9' }] })).data).toEqual({ bids: [{ sku: '9' }] });
    expect((await req('ozon_performance_remove_campaign_products', { campaign_id: C, skus: ['9', '10'] })).data).toEqual({ sku: ['9', '10'] });
  });

  it('report requests need campaigns and both days; no other read needs more than its id', () => {
    const required: Record<string, string[] | undefined> = {
      ozon_performance_list_campaign_objects: ['campaign_id'],
      ozon_performance_list_campaign_products: ['campaign_id'],
      ozon_performance_get_competitive_bids: ['campaign_id', 'skus'],
      ozon_performance_request_campaign_report: ['campaigns', 'dateFrom', 'dateTo'],
      ozon_performance_request_search_phrases_report: ['campaigns', 'dateFrom', 'dateTo'],
      ozon_performance_get_report_status: ['uuid'],
      ozon_performance_download_report: ['uuid'],
    };
    for (const [name] of READS) expect(`${name}:${JSON.stringify(tool(name).parameters.required)}`).toBe(`${name}:${JSON.stringify(required[name])}`);
    const days = tool('ozon_performance_request_campaign_report').parameters.properties as Record<string, { maxItems?: number }>;
    expect(days.campaigns.maxItems).toBe(10);
  });

  it('every tool except the download has a valid responseMapping that selects', () => {
    for (const t of a.tools) {
      if (t.name === 'ozon_performance_download_report') {
        expect(t.responseMapping).toEqual({ binary: { maxBytes: 4194304 } });
        continue;
      }
      if (!t.responseMapping) {
        expect(WRITES).toContain(t.name);
        continue;
      }
      const tr = t.responseMapping.transform;
      expect(`${t.name}:${Boolean(tr && tr.select)}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${validateTransform(tr)}`).toBe(`${t.name}:null`);
    }
  });

  // Payloads shaped like the official OpenAPI schema (docs.ozon.ru/api/performance), trimmed.
  it('shapes campaigns, products, bids and limits', () => {
    const list = shape('ozon_performance_list_campaigns', {
      list: [
        {
          id: '12345678', paymentType: 'CPC', title: 'Кружки', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU', fromDate: '2026-10-01', toDate: '', dailyBudget: '500000000', budget: '0', weeklyBudget: '0',
          placement: 'PLACEMENT_SEARCH_AND_CATEGORY', productAutopilotStrategy: 'TARGET_BIDS', autopilot: { categoryId: '0', skuAddMode: 'PRODUCT_CAMPAIGN_SKU_ADD_MODE_UNKNOWN' }, autostopStatus: 'AUTOSTOP_STATUS_NONE', isAutocreated: false,
          createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', productCampaignMode: 'PRODUCT_CAMPAIGN_MODE_MANUAL',
        },
      ],
      total: '1',
    }).value as any;
    expect(list.campaigns[0]).toMatchObject({ id: '12345678', title: 'Кружки', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU', dailyBudget: '500000000' });
    expect(list.campaigns[0].autopilot).toBeUndefined();
    expect(shape('ozon_performance_list_campaign_objects', { list: [{ id: '987654321' }, { id: '987654322' }] }).value).toEqual({ objects: ['987654321', '987654322'] });
    expect(shape('ozon_performance_list_campaign_products', { products: [{ sku: '9', bid: '15000000', title: 'Кружка', stopWords: ['x'], phrases: [] }] }).value).toEqual({ products: [{ sku: '9', bid: '15000000', title: 'Кружка' }] });
    expect(shape('ozon_performance_get_competitive_bids', { campaignId: C, bids: [{ sku: '9', bid: '21000000' }] }).value).toEqual({ campaignId: C, bids: [{ sku: '9', bid: '21000000' }] });
    const limits = shape('ozon_performance_get_bid_limits', { limits: [{ objectType: 'SKU', paymentMethod: 'CPC', placement: 'CAMPAIGN_PLACEMENT_SEARCH_AND_CATEGORY', minBid: 3, maxBid: 300, categories: [{ category: 'Дом и сад', bid: 5 }] }] }).value as any;
    expect(limits.limits[0]).toEqual({ objectType: 'SKU', paymentMethod: 'CPC', placement: 'CAMPAIGN_PLACEMENT_SEARCH_AND_CATEGORY', minBid: 3, maxBid: 300, categories: [{ category: 'Дом и сад', bid: 5 }] });
    const cpo = shape('ozon_performance_list_cpo_products', {
      products: [{ sku: '9', sourceSku: 'SKU-1', title: 'Кружка', price: '990', bid: 7.5, bidPrice: '74.25', previousBid: { bid: 5, bidPrice: '49.5', updatedAt: 't' }, searchPromoStatus: true, isSearchPromoAvailable: true, visibilityIndex: '1.2', views: { thisWeek: '100', previousWeek: '80' }, imageUrl: 'https://cdn/x.jpg', hint: {} }],
      total: '1',
    }).value as any;
    expect(cpo.products[0]).toMatchObject({ sku: '9', sourceSku: 'SKU-1', bid: 7.5, bidPrice: '74.25', searchPromoStatus: true });
    expect(cpo.products[0].imageUrl).toBeUndefined();
    expect(cpo.total).toBe('1');
  });

  it('shapes statistics rows and the report flow', () => {
    const rows = [{ id: C, title: 'Кружки', date: '2026-10-01', views: '1000', clicks: '40', moneySpent: '120,50', avgBid: '3,01', orders: '2', ordersMoney: '1980' }];
    expect(shape('ozon_performance_get_daily_statistics', { rows }).value).toEqual({ rows });
    expect(shape('ozon_performance_get_expense_statistics', { rows: [{ id: C, date: '2026-10-01', title: 'Кружки', moneySpent: '120,50', bonusSpent: '0', prepaymentSpent: '120,50' }] }).value).toMatchObject({ rows: [{ id: C }] });
    expect(shape('ozon_performance_request_campaign_report', { UUID, vendor: false }).value).toEqual({ UUID, vendor: false });
    expect(shape('ozon_performance_request_search_phrases_report', { UUID }).value).toEqual({ UUID });
    const status = { UUID, state: 'OK', createdAt: 'a', updatedAt: 'b', request: { campaigns: [C], dateFrom: '2026-10-01', dateTo: '2026-10-31', groupBy: 'DATE' }, link: `/api/client/statistics/report?UUID=${UUID}`, kind: 'STATS' };
    expect(shape('ozon_performance_get_report_status', status).value).toEqual(status);
    const reports = shape('ozon_performance_list_api_reports', { items: [{ campaigns: [{ id: C, title: 'Кружки' }], meta: status, name: 'Статистика' }], total: '1' }).value as any;
    expect(reports.reports[0]).toEqual({ name: 'Статистика', campaigns: [{ id: C, title: 'Кружки' }], ...status });
    const campaign = shape('ozon_performance_deactivate_campaign', { id: C, title: 'Кружки', state: 'CAMPAIGN_STATE_INACTIVE', paymentType: 'CPC' }).value as any;
    expect(campaign).toMatchObject({ id: C, state: 'CAMPAIGN_STATE_INACTIVE' });
  });

  it('only points the model at tools that exist and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bozon_performance_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bozon_performance_[a-z_]+/g)])].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Ozon Performance (Ads)\n')).toBe(true);
    expect(a.instructions).toContain('**Out of scope**');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_OZON_PERFORMANCE_LIVE === '1' ? describe : describe.skip;
const HAVE_CREDS = Boolean(process.env.OZON_PERFORMANCE_CLIENT_ID && process.env.OZON_PERFORMANCE_CLIENT_SECRET);
const liveCreds = process.env.RUN_OZON_PERFORMANCE_LIVE === '1' && HAVE_CREDS ? describe : describe.skip;

live('ozon-performance adapter: live token endpoint with a made-up client', () => {
  beforeAll(() => mockedAxios.mockImplementation((cfg: unknown) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it('answers 401 for an unknown client', async () => {
    const auth = interpolateDeep(a.connector.authConfig, env(CLIENT_ID, 'not-a-real-secret-0000')) as any;
    await expect(new LoginTokenService({} as any, config).getToken(auth)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);
});

liveCreds('ozon-performance adapter: live reads with a service account', () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => (mockedAxios.__actual as any).request(cfg));
    login = new LoginTokenService({} as any, config);
    creds = env(process.env.OZON_PERFORMANCE_CLIENT_ID, process.env.OZON_PERFORMANCE_CLIENT_SECRET);
  });
  afterAll(() => mockedAxios.mockReset());
  const read = async (name: string, params: Record<string, unknown>) => {
    const out = shape(name, await run(name, params));
    expect(out.error).toBeUndefined();
    console.log(`${name}: ${Buffer.byteLength(JSON.stringify(out.value), 'utf8')} bytes shaped`);
    return out.value as any;
  };

  it('reads campaigns, limits and quick statistics', async () => {
    const list = await read('ozon_performance_list_campaigns', {});
    expect(Array.isArray(list.campaigns ?? [])).toBe(true);
    await read('ozon_performance_get_bid_limits', {});
    await read('ozon_performance_list_cpo_products', {});
    await read('ozon_performance_get_daily_statistics', {});
    await read('ozon_performance_get_expense_statistics', {});
    await read('ozon_performance_list_api_reports', {});
    const cpc = (list.campaigns ?? []).find((c: any) => c.advObjectType === 'SKU');
    if (cpc) {
      await read('ozon_performance_list_campaign_objects', { campaign_id: cpc.id });
      const products = await read('ozon_performance_list_campaign_products', { campaign_id: cpc.id });
      if (products.products?.length) await read('ozon_performance_get_competitive_bids', { campaign_id: cpc.id, skus: [products.products[0].sku] });
    }
  }, 120_000);

  it('orders a report for one campaign and polls its status', async () => {
    const list = await read('ozon_performance_list_campaigns', {});
    if (!list.campaigns?.length) return;
    const ordered = await read('ozon_performance_request_campaign_report', { campaigns: [list.campaigns[0].id], dateFrom: day(-7), dateTo: day(-1) });
    expect(typeof ordered.UUID).toBe('string');
    let status = await read('ozon_performance_get_report_status', { uuid: ordered.UUID });
    for (let i = 0; i < 20 && ['NOT_STARTED', 'IN_PROGRESS'].includes(status.state); i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      status = await read('ozon_performance_get_report_status', { uuid: ordered.UUID });
    }
    console.log(`report ${ordered.UUID}: ${status.state}`);
    if (status.state === 'OK') expect(typeof (await run('ozon_performance_download_report', { uuid: ordered.UUID }))).toBe('string');
  }, 180_000);
});
