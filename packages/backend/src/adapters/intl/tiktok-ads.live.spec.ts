import axios from 'axios';
import * as adapter from './tiktok-ads.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import {
  assertNoResponseBodyError,
  describeErrorWhenProblems,
  ResponseBodyError,
} from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the TikTok Ads adapter:
 *
 *   1. Static: always runs. Pins the Access-Token header on the Marketing
 *      API v1.3 (production or sandbox host), the advertiser variable in
 *      every query and body, the JSON-in-query parameters, the report
 *      defaults, the errorWhen rules that turn TikTok's HTTP 200 error codes
 *      into errors, every tool's method and URL, and which tools change
 *      spend (all installed switched off).
 *
 *   2. Live: skipped unless TIKTOK_ADS_ACCESS_TOKEN and
 *      TIKTOK_ADS_ADVERTISER_ID are set. TIKTOK_ADS_API_HOST defaults to
 *      https://business-api.tiktok.com; use https://sandbox-ads.tiktok.com
 *      with a sandbox token:
 *
 *        TIKTOK_ADS_API_HOST=https://sandbox-ads.tiktok.com \
 *        TIKTOK_ADS_ACCESS_TOKEN=... TIKTOK_ADS_ADVERTISER_ID=... \
 *          npx jest src/adapters/intl/tiktok-ads.live.spec.ts
 *
 *      Reads the ad account, campaigns (also Smart+), ad groups, ads, a
 *      7-day report by campaign and by day, audiences, pixels, identities
 *      and the video library. With TIKTOK_ADS_APP_ID and
 *      TIKTOK_ADS_APP_SECRET it also lists the authorized ad accounts.
 *
 *      TIKTOK_ADS_LIVE_WRITE=1 with TIKTOK_ADS_TEST_CAMPAIGN_ID (a paused
 *      campaign with its own budget) pauses it again and sets its budget to
 *      the current value plus one and back. Only on the sandbox host it also
 *      switches the campaign on and off again, so a real account never
 *      starts spending.
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
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath?: string;
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
const rules = a.connector.config.errorWhen;
const statusOf = (body: unknown): number | null => {
  try {
    assertNoResponseBodyError(body, rules);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ResponseBodyError);
    return (e as ResponseBodyError).status;
  }
};

// Built at run time so no literal here looks like a real token or secret.
const TOKEN = 'a1b2c3d4'.repeat(5);
const SECRET = 'f0e1d2c3'.repeat(5);
const PROD = 'https://business-api.tiktok.com';
const SANDBOX = 'https://sandbox-ads.tiktok.com';
const ENV = {
  TIKTOK_ADS_API_HOST: PROD,
  TIKTOK_ADS_ACCESS_TOKEN: TOKEN,
  TIKTOK_ADS_ADVERTISER_ID: '7000000000000000001',
  TIKTOK_ADS_APP_ID: '7100000000000000002',
  TIKTOK_ADS_APP_SECRET: SECRET,
};
const BASE = `${PROD}/open_api/v1.3`;
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, env),
      headers: config.headers,
      errorWhen: rules,
    },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];
const WRITES = [
  'tiktok_ads_update_ad_group_budget',
  'tiktok_ads_update_ad_group_status',
  'tiktok_ads_update_ad_status',
  'tiktok_ads_update_campaign_budget',
  'tiktok_ads_update_campaign_status',
];

describe('tiktok-ads adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified live', () => {
    expect(a.unlisted).toBe(true);
    expect(a.name).toBe('TikTok Ads');
    expect(a.prerequisites).toMatch(/sandbox/i);
  });

  it('sends the pasted token in the Access-Token header, never in the URL', async () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Access-Token', apiKey: '{{TIKTOK_ADS_ACCESS_TOKEN}}' });
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    mockedAxios.mockResolvedValue({ data: { code: 0, data: {} } });
    await call('tiktok_ads_list_campaigns', {});
    expect(sent().headers['Access-Token']).toBe(TOKEN);
    expect(sent().headers.Authorization).toBeUndefined();
    expect(JSON.stringify(sent().params)).not.toContain(TOKEN);
  });

  it('reaches production or the sandbox through TIKTOK_ADS_API_HOST', async () => {
    expect(a.connector.baseUrl).toBe('{{TIKTOK_ADS_API_HOST}}/open_api/v1.3');
    const host = new RegExp(a.envVarMeta.TIKTOK_ADS_API_HOST.pattern!);
    expect(host.test(PROD)).toBe(true);
    expect(host.test(SANDBOX)).toBe(true);
    expect(host.test(`${PROD}/`)).toBe(false);
    expect(host.test(`${PROD}/open_api/v1.3`)).toBe(false);
    expect(host.test('https://ads.tiktok.com')).toBe(false);
    mockedAxios.mockResolvedValue({ data: { code: 0, data: {} } });
    await execute('tiktok_ads_get_advertiser_info', { ...ENV, TIKTOK_ADS_API_HOST: SANDBOX }, {});
    expect(sent().url).toBe(`${SANDBOX}/open_api/v1.3/advertiser/info/`);
    expect(a.instructions).toContain(SANDBOX);
  });

  it('checks the token, advertiser id and app credentials', () => {
    expect(a.requiredEnvVars).toEqual(['TIKTOK_ADS_API_HOST', 'TIKTOK_ADS_ACCESS_TOKEN', 'TIKTOK_ADS_ADVERTISER_ID']);
    expect(a.optionalEnvVars).toEqual(['TIKTOK_ADS_APP_ID', 'TIKTOK_ADS_APP_SECRET']);
    const token = new RegExp(a.envVarMeta.TIKTOK_ADS_ACCESS_TOKEN.pattern!);
    expect(token.test(TOKEN)).toBe(true);
    expect(token.test(`Bearer ${TOKEN}`)).toBe(false);
    expect(token.test(`"${TOKEN}"`)).toBe(false);
    const advertiser = new RegExp(a.envVarMeta.TIKTOK_ADS_ADVERTISER_ID.pattern!);
    expect(advertiser.test('7000000000000000001')).toBe(true);
    expect(advertiser.test('act_123456789')).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    for (const name of ['TIKTOK_ADS_ACCESS_TOKEN', 'TIKTOK_ADS_APP_SECRET']) {
      expect(described.find((d) => d.name === name)!.secret).toBe(true);
    }
    expect(described.find((d) => d.name === 'TIKTOK_ADS_API_HOST')!.kind).toBe('address');
  });

  it('probes with the ad account, which needs only the token', async () => {
    expect(a.probe).toEqual({ tool: 'tiktok_ads_get_advertiser_info' });
    mockedAxios.mockResolvedValue({ data: { code: 0, data: { list: [] } } });
    await call('tiktok_ads_get_advertiser_info', {});
    expect(sent().params).toEqual({ advertiser_ids: '["7000000000000000001"]' });
  });

  it('prefixes every tool with tiktok_ads_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^tiktok_ads_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only and installs every spend change switched off and destructive', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(WRITES);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
      expect(tool(name).description).toMatch(/get a yes from the user first/);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\btiktok_ads_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\btiktok_ads_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['tiktok_ads_list_authorized_advertisers', {}, 'GET', '/oauth2/advertiser/get/'],
    ['tiktok_ads_get_advertiser_info', {}, 'GET', '/advertiser/info/'],
    ['tiktok_ads_list_campaigns', {}, 'GET', '/campaign/get/'],
    ['tiktok_ads_list_smart_plus_campaigns', {}, 'GET', '/smart_plus/campaign/get/'],
    ['tiktok_ads_list_ad_groups', {}, 'GET', '/adgroup/get/'],
    ['tiktok_ads_list_ads', {}, 'GET', '/ad/get/'],
    ['tiktok_ads_get_report', { start_date: '2026-10-01', end_date: '2026-10-07' }, 'GET', '/report/integrated/get/'],
    ['tiktok_ads_list_custom_audiences', {}, 'GET', '/dmp/custom_audience/list/'],
    ['tiktok_ads_get_custom_audiences', { custom_audience_ids: '["1"]' }, 'GET', '/dmp/custom_audience/get/'],
    ['tiktok_ads_list_saved_audiences', {}, 'GET', '/dmp/saved_audience/list/'],
    ['tiktok_ads_list_pixels', {}, 'GET', '/pixel/list/'],
    ['tiktok_ads_get_pixel_event_stats', { pixel_ids: '["C1"]', start_date: '2026-10-01', end_date: '2026-10-07' }, 'GET', '/pixel/event/stats/'],
    ['tiktok_ads_get_videos', { video_ids: '["v1"]' }, 'GET', '/file/video/ad/info/'],
    ['tiktok_ads_search_videos', {}, 'GET', '/file/video/ad/search/'],
    ['tiktok_ads_get_images', { image_ids: '["i1"]' }, 'GET', '/file/image/ad/info/'],
    ['tiktok_ads_list_identities', {}, 'GET', '/identity/get/'],
    ['tiktok_ads_update_campaign_status', { campaign_ids: ['1'], operation_status: 'DISABLE' }, 'POST', '/campaign/status/update/'],
    ['tiktok_ads_update_ad_group_status', { adgroup_ids: ['2'], operation_status: 'DISABLE' }, 'POST', '/adgroup/status/update/'],
    ['tiktok_ads_update_ad_status', { ad_ids: ['3'], operation_status: 'DISABLE' }, 'POST', '/ad/status/update/'],
    ['tiktok_ads_update_campaign_budget', { campaign_id: '1', budget: 50 }, 'POST', '/campaign/update/'],
    ['tiktok_ads_update_ad_group_budget', { adgroup_id: '2', budget: 20 }, 'POST', '/adgroup/update/'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: { code: 0, data: {} } });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
  });

  it('puts the configured advertiser on every call except the ad account list', async () => {
    for (const t of a.tools) {
      const where = { ...(t.endpointMapping.queryParams ?? {}), ...(t.endpointMapping.bodyMapping ?? {}) };
      const text = JSON.stringify(where);
      if (t.name === 'tiktok_ads_list_authorized_advertisers') expect(text).not.toContain('ADVERTISER');
      else expect(text).toContain('{{TIKTOK_ADS_ADVERTISER_ID}}');
    }
  });

  it('lists the authorized ad accounts with the app id and secret TikTok wants there', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 0, data: { list: [] } } });
    await call('tiktok_ads_list_authorized_advertisers', {});
    expect(sent().params).toEqual({ app_id: '7100000000000000002', secret: SECRET });
  });

  it('sends lists and filters as JSON text and pages 50 at a time', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 0, data: {} } });
    await call('tiktok_ads_list_ad_groups', { filtering: '{"campaign_ids":["1800"]}', fields: '["adgroup_id","budget"]' });
    expect(sent().params).toEqual({
      advertiser_id: '7000000000000000001',
      filtering: '{"campaign_ids":["1800"]}',
      fields: '["adgroup_id","budget"]',
      page: 1,
      page_size: 50,
    });
  });

  it('runs a campaign report over a date range by default', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 0, data: { list: [] } } });
    await call('tiktok_ads_get_report', { start_date: '2026-10-01', end_date: '2026-10-07' });
    expect(sent().params).toEqual({
      advertiser_id: '7000000000000000001',
      report_type: 'BASIC',
      data_level: 'AUCTION_CAMPAIGN',
      dimensions: '["campaign_id"]',
      metrics: '["spend","impressions","clicks","ctr","cpc","cpm","reach","conversion","cost_per_conversion","conversion_rate"]',
      start_date: '2026-10-01',
      end_date: '2026-10-07',
      page: 1,
      page_size: 100,
    });
    for (const json of [tool('tiktok_ads_get_report').parameters.properties!.dimensions.default, tool('tiktok_ads_get_report').parameters.properties!.metrics.default]) {
      expect(Array.isArray(JSON.parse(String(json)))).toBe(true);
    }
    mockedAxios.mockClear();
    await call('tiktok_ads_get_report', { query_lifetime: true, data_level: 'AUCTION_AD', dimensions: '["ad_id"]', order_field: 'spend', order_type: 'DESC' });
    expect(sent().params).toEqual(expect.objectContaining({ query_lifetime: true, data_level: 'AUCTION_AD', dimensions: '["ad_id"]', order_field: 'spend', order_type: 'DESC' }));
    expect(sent().params.start_date).toBeUndefined();
  });

  it('builds the pixel date range as a JSON object', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 0, data: {} } });
    await call('tiktok_ads_get_pixel_event_stats', { pixel_ids: '["C1"]', start_date: '2026-10-01', end_date: '2026-10-07' });
    expect(sent().params.pixel_ids).toBe('["C1"]');
    expect(JSON.parse(sent().params.date_range)).toEqual({ start_date: '2026-10-01', end_date: '2026-10-07' });
  });

  it('sends status and budget changes as JSON bodies for the configured advertiser', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 0, data: {} } });
    await call('tiktok_ads_update_campaign_status', { campaign_ids: ['1', '2'], operation_status: 'DISABLE' });
    expect(sent().data).toEqual({ advertiser_id: '7000000000000000001', campaign_ids: ['1', '2'], operation_status: 'DISABLE' });
    mockedAxios.mockClear();
    await call('tiktok_ads_update_ad_status', { ad_ids: ['3'], operation_status: 'ENABLE' });
    expect(sent().data).toEqual({ advertiser_id: '7000000000000000001', ad_ids: ['3'], operation_status: 'ENABLE' });
    mockedAxios.mockClear();
    await call('tiktok_ads_update_ad_group_budget', { adgroup_id: '2', budget: 20.5 });
    expect(sent().data).toEqual({ advertiser_id: '7000000000000000001', adgroup_id: '2', budget: 20.5 });
    // Deleting is not offered: only ENABLE and DISABLE.
    for (const name of ['tiktok_ads_update_campaign_status', 'tiktok_ads_update_ad_group_status', 'tiktok_ads_update_ad_status']) {
      expect((tool(name).parameters.properties!.operation_status as { enum: string[] }).enum).toEqual(['ENABLE', 'DISABLE']);
    }
  });

  it('has well-formed errorWhen rules', () => {
    expect(describeErrorWhenProblems(rules)).toEqual([]);
  });

  it('turns TikTok\'s HTTP 200 error codes into errors with a fitting status', () => {
    expect(statusOf({ code: 0, message: 'OK', data: { list: [] } })).toBeNull();
    expect(statusOf({ code: '0', message: 'OK' })).toBeNull();
    expect(statusOf({ code: 40100, message: 'Too many requests' })).toBe(429);
    expect(statusOf({ code: 40104, message: 'Access token is null' })).toBe(401);
    expect(statusOf({ code: 40105, message: 'Access token is incorrect or has been revoked' })).toBe(401);
    expect(statusOf({ code: 40001, message: 'No permission to operate advertiser' })).toBe(403);
    expect(statusOf({ code: 40300, message: 'Permission error' })).toBe(403);
    expect(statusOf({ code: 40002, message: 'advertiser_id: Missing data for required field.' })).toBe(400);
    expect(statusOf({ code: 40400, message: 'Not found' })).toBe(404);
    expect(statusOf({ code: 50000, message: 'System error' })).toBe(502);
  });

  it('names the code and TikTok\'s message in the error', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 40105, message: 'Access token is incorrect or has been revoked.', request_id: 'r1' } });
    await expect(call('tiktok_ads_get_advertiser_info', {})).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('40105 Access token is incorrect'),
    });
  });

  it('documents the token exchange, sandbox and spend confirmation', () => {
    expect(a.instructions).toContain('/open_api/v1.3/oauth2/access_token/');
    expect(a.instructions).toContain('auth_code');
    expect(a.instructions).toMatch(/Changes spend money: confirm first/);
    expect(a.verifyHints.rate_limited).toContain('40100');
  });
});

const LIVE_TOKEN = process.env.TIKTOK_ADS_ACCESS_TOKEN;
const LIVE_ADVERTISER = process.env.TIKTOK_ADS_ADVERTISER_ID;
const live = LIVE_TOKEN && LIVE_ADVERTISER ? describe : describe.skip;

live('tiktok-ads adapter: live Marketing API', () => {
  const host = process.env.TIKTOK_ADS_API_HOST || PROD;
  const env: Record<string, string> = {
    TIKTOK_ADS_API_HOST: host,
    TIKTOK_ADS_ACCESS_TOKEN: LIVE_TOKEN as string,
    TIKTOK_ADS_ADVERTISER_ID: LIVE_ADVERTISER as string,
  };
  if (process.env.TIKTOK_ADS_APP_ID) env.TIKTOK_ADS_APP_ID = process.env.TIKTOK_ADS_APP_ID;
  if (process.env.TIKTOK_ADS_APP_SECRET) env.TIKTOK_ADS_APP_SECRET = process.env.TIKTOK_ADS_APP_SECRET;
  const write = process.env.TIKTOK_ADS_LIVE_WRITE === '1';
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  it('reads the ad account and, with the app credentials, the authorized accounts', async () => {
    const info = await run('tiktok_ads_get_advertiser_info');
    expect(info.code).toBe(0);
    expect(String(info.data.list[0].advertiser_id)).toBe(LIVE_ADVERTISER);
    if (env.TIKTOK_ADS_APP_ID && env.TIKTOK_ADS_APP_SECRET) {
      const all = await run('tiktok_ads_list_authorized_advertisers');
      expect(all.data.list.map((x: { advertiser_id: string }) => String(x.advertiser_id))).toContain(LIVE_ADVERTISER);
    }
  }, 60_000);

  it('reads campaigns, ad groups, ads and a 7-day report', async () => {
    const campaigns = await run('tiktok_ads_list_campaigns', { page_size: 5 });
    expect(campaigns.data.page_info).toBeDefined();
    expect((await run('tiktok_ads_list_smart_plus_campaigns', { page_size: 5 })).code).toBe(0);
    expect((await run('tiktok_ads_list_ad_groups', { page_size: 5 })).data.page_info).toBeDefined();
    const ads = await run('tiktok_ads_list_ads', { page_size: 5 });
    expect(ads.data.page_info).toBeDefined();
    const report = await run('tiktok_ads_get_report', { start_date: day(-7), end_date: day(-1), metrics: '["campaign_name","spend","impressions","clicks"]' });
    expect(Array.isArray(report.data.list)).toBe(true);
    const daily = await run('tiktok_ads_get_report', {
      data_level: 'AUCTION_ADVERTISER', dimensions: '["advertiser_id","stat_time_day"]', start_date: day(-7), end_date: day(-1), metrics: '["spend","impressions"]',
    });
    expect(Array.isArray(daily.data.list)).toBe(true);
    const videoId = ads.data.list?.find((x: { video_id?: string }) => x.video_id)?.video_id;
    if (videoId) expect((await run('tiktok_ads_get_videos', { video_ids: JSON.stringify([videoId]) })).code).toBe(0);
  }, 120_000);

  it('reads audiences, pixels, identities and the video library', async () => {
    expect((await run('tiktok_ads_list_custom_audiences', { page_size: 5 })).code).toBe(0);
    expect((await run('tiktok_ads_list_saved_audiences', { page_size: 5 })).code).toBe(0);
    const pixels = await run('tiktok_ads_list_pixels', { page_size: 5 });
    expect(pixels.code).toBe(0);
    const pixel = pixels.data.pixels?.[0];
    if (pixel) {
      const stats = await run('tiktok_ads_get_pixel_event_stats', { pixel_ids: JSON.stringify([String(pixel.pixel_id)]), start_date: day(-7), end_date: day(-1) });
      expect(stats.code).toBe(0);
    }
    expect((await run('tiktok_ads_list_identities', { page_size: 5 })).code).toBe(0);
    expect((await run('tiktok_ads_search_videos', { page_size: 5 })).code).toBe(0);
  }, 120_000);

  const campaignId = process.env.TIKTOK_ADS_TEST_CAMPAIGN_ID;
  (write && campaignId ? it : it.skip)('pauses the test campaign and changes its budget and back', async () => {
    const read = async () =>
      (await run('tiktok_ads_list_campaigns', { filtering: JSON.stringify({ campaign_ids: [campaignId] }) })).data.list[0];
    const before = await read();
    // Never start spending on a real account.
    expect(before.operation_status).toBe('DISABLE');
    expect((await run('tiktok_ads_update_campaign_status', { campaign_ids: [campaignId], operation_status: 'DISABLE' })).code).toBe(0);
    if (host === SANDBOX) {
      await run('tiktok_ads_update_campaign_status', { campaign_ids: [campaignId], operation_status: 'ENABLE' });
      await run('tiktok_ads_update_campaign_status', { campaign_ids: [campaignId], operation_status: 'DISABLE' });
      expect((await read()).operation_status).toBe('DISABLE');
    }
    if (before.budget_mode !== 'BUDGET_MODE_INFINITE') {
      const budget = Number(before.budget);
      try {
        await run('tiktok_ads_update_campaign_budget', { campaign_id: campaignId, budget: budget + 1 });
        expect(Number((await read()).budget)).toBe(budget + 1);
      } finally {
        await run('tiktok_ads_update_campaign_budget', { campaign_id: campaignId, budget });
      }
    }
  }, 120_000);
});
