import axios from 'axios';
import * as adapter from './meta-ads.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Meta Ads adapter:
 *
 *   1. Static: always runs. Pins the bearer token on Graph API v26.0, the ad
 *      account variable in the account-level paths, the default field lists,
 *      the insights period and breakdown parameters, the form-encoded status
 *      and budget changes, every tool's method and URL, and which tools are
 *      read-only or spend-changing.
 *
 *   2. Live: skipped unless META_ADS_ACCESS_TOKEN is set (a system user
 *      token or a user token with ads_read). META_ADS_ACCOUNT_ID (act_...)
 *      defaults to the first ad account the token can reach:
 *
 *        META_ADS_ACCESS_TOKEN=EAA... [META_ADS_ACCOUNT_ID=act_...] \
 *          npx jest src/adapters/intl/meta-ads.live.spec.ts
 *
 *      Reads ad accounts, campaigns, ad sets, ads, creatives, custom
 *      audiences, the change history and insights at account and campaign
 *      level with a breakdown and daily rows.
 *
 *      META_ADS_LIVE_WRITE=1 (needs ads_management) creates a PAUSED test
 *      campaign without ad sets directly through the API, so nothing can
 *      deliver or spend; with the tools it raises its daily budget, switches
 *      it to ACTIVE and back to PAUSED, and deletes it in `finally`.
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
    bodyEncoding?: string;
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
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
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

// Built at run time so no literal here looks like a real token.
const TOKEN = 'EAA' + 'x'.repeat(40);
const ENV = { META_ADS_ACCESS_TOKEN: TOKEN, META_ADS_ACCOUNT_ID: 'act_123' };
const BASE = 'https://graph.facebook.com/v26.0';
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep({ ...a.connector.authConfig }, env), headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];
const WRITES = ['meta_ads_update_budget', 'meta_ads_update_status'];

describe('meta-ads adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified against the official API spec on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.name).toBe('Meta Ads');
    expect(a.prerequisites).toMatch(/ads_read/);
  });

  it('sends the token as a bearer header to Graph API v26.0', async () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{META_ADS_ACCESS_TOKEN}}' });
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.instructions).toContain('v26.0');
    mockedAxios.mockResolvedValue({ data: {} });
    await call('meta_ads_list_ad_accounts', {});
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // Never in the URL, where it would end up in logs.
    expect(JSON.stringify(sent().params)).not.toContain(TOKEN);
  });

  it('checks the token and the act_ account id', () => {
    expect(a.requiredEnvVars).toEqual(['META_ADS_ACCESS_TOKEN', 'META_ADS_ACCOUNT_ID']);
    const token = new RegExp(a.envVarMeta.META_ADS_ACCESS_TOKEN.pattern!);
    expect(token.test(TOKEN)).toBe(true);
    expect(token.test(`Bearer ${TOKEN}`)).toBe(false);
    const account = new RegExp(a.envVarMeta.META_ADS_ACCOUNT_ID.pattern!);
    expect(account.test('act_1234567890')).toBe(true);
    expect(account.test('1234567890')).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'META_ADS_ACCESS_TOKEN')!.secret).toBe(true);
  });

  it('probes with the ad account list, which needs no account id', () => {
    expect(a.probe).toEqual({ tool: 'meta_ads_list_ad_accounts', params: { limit: 5 } });
    expect(tool('meta_ads_list_ad_accounts').endpointMapping.path).toBe('/me/adaccounts');
    expect(a.connector.healthcheckPath).toBe('/me?fields=id,name');
  });

  it('prefixes every tool with meta_ads_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^meta_ads_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('reads everything except the two confirmed changes', () => {
    for (const t of a.tools) {
      const ann = annotationsOf(t);
      if (WRITES.includes(t.name)) {
        expect(`${t.name}:${ann.readOnlyHint}:${ann.destructiveHint}:${ann.idempotentHint}`).toBe(`${t.name}:false:true:false`);
        expect(t.description).toMatch(/confirm|wait for the user/i);
      } else {
        expect(`${t.name}:${t.endpointMapping.method}:${ann.readOnlyHint}`).toBe(`${t.name}:GET:true`);
      }
    }
  });

  it('asks for useful fields by default, since the Graph API returns only ids otherwise', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET')) {
      expect(`${t.name}:${typeof t.parameters.properties?.fields?.default}`).toBe(`${t.name}:string`);
      expect(t.endpointMapping.queryParams?.fields).toBe('$fields');
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmeta_ads_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmeta_ads_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(6);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['meta_ads_list_ad_accounts', {}, 'GET', `${BASE}/me/adaccounts`],
    ['meta_ads_get_ad_account', {}, 'GET', `${BASE}/act_123`],
    ['meta_ads_list_campaigns', {}, 'GET', `${BASE}/act_123/campaigns`],
    ['meta_ads_get_campaign', { campaign_id: '120' }, 'GET', `${BASE}/120`],
    ['meta_ads_list_ad_sets', {}, 'GET', `${BASE}/act_123/adsets`],
    ['meta_ads_list_campaign_ad_sets', { campaign_id: '120' }, 'GET', `${BASE}/120/adsets`],
    ['meta_ads_get_ad_set', { ad_set_id: '121' }, 'GET', `${BASE}/121`],
    ['meta_ads_list_ads', {}, 'GET', `${BASE}/act_123/ads`],
    ['meta_ads_list_ad_set_ads', { ad_set_id: '121' }, 'GET', `${BASE}/121/ads`],
    ['meta_ads_get_ad', { ad_id: '122' }, 'GET', `${BASE}/122`],
    ['meta_ads_get_account_insights', {}, 'GET', `${BASE}/act_123/insights`],
    ['meta_ads_get_insights', { object_id: '120' }, 'GET', `${BASE}/120/insights`],
    ['meta_ads_list_ad_creatives', {}, 'GET', `${BASE}/act_123/adcreatives`],
    ['meta_ads_get_ad_creative', { creative_id: '123' }, 'GET', `${BASE}/123`],
    ['meta_ads_list_custom_audiences', {}, 'GET', `${BASE}/act_123/customaudiences`],
    ['meta_ads_list_account_activities', {}, 'GET', `${BASE}/act_123/activities`],
    ['meta_ads_update_status', { object_id: '120', status: 'PAUSED' }, 'POST', `${BASE}/120`],
    ['meta_ads_update_budget', { object_id: '120', daily_budget: 2000 }, 'POST', `${BASE}/120`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url }));
  });

  it('builds the insights period from since and until, and passes breakdowns as given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('meta_ads_get_account_insights', { since: '2026-09-01', until: '2026-09-30', level: 'campaign', breakdowns: 'age,gender', time_increment: '1' });
    expect(sent().params).toEqual(expect.objectContaining({
      time_range: '{"since":"2026-09-01","until":"2026-09-30"}',
      level: 'campaign',
      breakdowns: 'age,gender',
      time_increment: '1',
      limit: 50,
    }));
    expect(sent().params.date_preset).toBeUndefined();
    mockedAxios.mockClear();
    // Half a range is no range: Meta then uses date_preset (default last_30d).
    await call('meta_ads_get_insights', { object_id: '120', since: '2026-09-01', date_preset: 'last_7d' });
    expect(sent().params.time_range).toBeUndefined();
    expect(sent().params.date_preset).toBe('last_7d');
  });

  it('changes status and budget with form fields only', async () => {
    mockedAxios.mockResolvedValue({ data: { success: true } });
    await call('meta_ads_update_status', { object_id: '120', status: 'PAUSED' });
    expect(sent().data).toBe('status=PAUSED');
    expect(tool('meta_ads_update_status').parameters.properties?.status).toEqual(expect.objectContaining({ enum: ['ACTIVE', 'PAUSED'] }));
    mockedAxios.mockClear();
    await call('meta_ads_update_budget', { object_id: '121', lifetime_budget: 50000 });
    expect(sent().data).toBe('lifetime_budget=50000');
  });
});

const LIVE_TOKEN = process.env.META_ADS_ACCESS_TOKEN;
const live = LIVE_TOKEN ? describe : describe.skip;

live('meta-ads adapter: live Marketing API', () => {
  const write = process.env.META_ADS_LIVE_WRITE === '1';
  // Account-level paths carry {{META_ADS_ACCOUNT_ID}}; until the account list
  // names one, the variable gets the given value or a stand-in.
  const env: Record<string, string> = {
    META_ADS_ACCESS_TOKEN: LIVE_TOKEN as string,
    META_ADS_ACCOUNT_ID: process.env.META_ADS_ACCOUNT_ID || 'act_0',
  };
  let currency = '';
  let minDailyBudget = 100;
  beforeAll(async () => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
    const accounts = await execute('meta_ads_list_ad_accounts', env, { limit: 25 });
    expect(Array.isArray(accounts.data)).toBe(true);
    const account = process.env.META_ADS_ACCOUNT_ID
      ? accounts.data.find((x: { id: string }) => x.id === process.env.META_ADS_ACCOUNT_ID)
      : accounts.data[0];
    expect(account).toBeDefined();
    env.META_ADS_ACCOUNT_ID = account.id;
    currency = account.currency;
    minDailyBudget = Number(account.min_daily_budget) || 100;
  }, 30_000);
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);

  it('reads the account, campaigns, ad sets, ads, creatives, audiences and history', async () => {
    const account = await run('meta_ads_get_ad_account');
    expect(account.id).toBe(env.META_ADS_ACCOUNT_ID);
    expect(account.currency).toBe(currency);
    const campaigns = await run('meta_ads_list_campaigns', { limit: 5 });
    expect(Array.isArray(campaigns.data)).toBe(true);
    const filtered = await run('meta_ads_list_campaigns', { effective_status: '["ACTIVE","PAUSED"]', limit: 5 });
    expect(Array.isArray(filtered.data)).toBe(true);
    if (campaigns.data.length) {
      const id = campaigns.data[0].id;
      expect((await run('meta_ads_get_campaign', { campaign_id: id })).id).toBe(id);
      const sets = await run('meta_ads_list_campaign_ad_sets', { campaign_id: id, limit: 5 });
      expect(Array.isArray(sets.data)).toBe(true);
    }
    const adSets = await run('meta_ads_list_ad_sets', { limit: 5 });
    expect(Array.isArray(adSets.data)).toBe(true);
    if (adSets.data.length) {
      const id = adSets.data[0].id;
      expect((await run('meta_ads_get_ad_set', { ad_set_id: id })).id).toBe(id);
      expect(Array.isArray((await run('meta_ads_list_ad_set_ads', { ad_set_id: id, limit: 5 })).data)).toBe(true);
    }
    const ads = await run('meta_ads_list_ads', { limit: 5 });
    expect(Array.isArray(ads.data)).toBe(true);
    if (ads.data.length) expect((await run('meta_ads_get_ad', { ad_id: ads.data[0].id })).id).toBe(ads.data[0].id);
    const creatives = await run('meta_ads_list_ad_creatives', { limit: 5 });
    expect(Array.isArray(creatives.data)).toBe(true);
    if (creatives.data.length) expect((await run('meta_ads_get_ad_creative', { creative_id: creatives.data[0].id })).id).toBe(creatives.data[0].id);
    // Custom audiences need the Custom Audience terms accepted; a refusal is still an API answer.
    await run('meta_ads_list_custom_audiences', { limit: 5 })
      .then((audiences) => expect(Array.isArray(audiences.data)).toBe(true))
      .catch((e: { response?: { data?: { error?: { code?: number } } } }) => expect(e.response?.data?.error?.code).toBeDefined());
    const history = await run('meta_ads_list_account_activities', { limit: 5 });
    expect(Array.isArray(history.data)).toBe(true);
  }, 120_000);

  it('reads insights for the account and a campaign, with levels, breakdowns and daily rows', async () => {
    const total = await run('meta_ads_get_account_insights', { date_preset: 'last_30d' });
    expect(Array.isArray(total.data)).toBe(true);
    const byCampaign = await run('meta_ads_get_account_insights', {
      date_preset: 'last_month',
      level: 'campaign',
      fields: 'campaign_id,campaign_name,impressions,clicks,spend',
      sort: 'spend_descending',
    });
    expect(Array.isArray(byCampaign.data)).toBe(true);
    const until = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const daily = await run('meta_ads_get_account_insights', { since, until, time_increment: '1', breakdowns: 'publisher_platform' });
    expect(Array.isArray(daily.data)).toBe(true);
    const campaigns = await run('meta_ads_list_campaigns', { limit: 1 });
    if (campaigns.data.length) {
      const one = await run('meta_ads_get_insights', { object_id: campaigns.data[0].id, date_preset: 'maximum', breakdowns: 'age,gender' });
      expect(Array.isArray(one.data)).toBe(true);
    }
  }, 120_000);

  (write ? it : it.skip)('changes the budget and status of a paused test campaign without ad sets and deletes it', async () => {
    const graph = (method: string, path: string, data?: Record<string, string>) =>
      mockedAxios.__actual({
        method,
        url: `${BASE}${path}`,
        data: data ? new URLSearchParams(data).toString() : undefined,
        headers: { Authorization: `Bearer ${LIVE_TOKEN}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    const budget = Math.max(minDailyBudget, 100) * 2;
    const created = await graph('POST', `/${env.META_ADS_ACCOUNT_ID}/campaigns`, {
      name: `AnythingMCP live spec ${new Date().toISOString()}`,
      objective: 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      special_ad_categories: '[]',
      daily_budget: String(budget),
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    });
    const id = created.data.id as string;
    try {
      const raised = await run('meta_ads_update_budget', { object_id: id, daily_budget: budget + 100 });
      expect(raised.success).toBe(true);
      expect(Number((await run('meta_ads_get_campaign', { campaign_id: id })).daily_budget)).toBe(budget + 100);
      // No ad sets, so nothing can deliver even while ACTIVE.
      expect((await run('meta_ads_update_status', { object_id: id, status: 'ACTIVE' })).success).toBe(true);
      expect((await run('meta_ads_get_campaign', { campaign_id: id, fields: 'status' })).status).toBe('ACTIVE');
      expect((await run('meta_ads_update_status', { object_id: id, status: 'PAUSED' })).success).toBe(true);
      expect((await run('meta_ads_get_campaign', { campaign_id: id, fields: 'status' })).status).toBe('PAUSED');
    } finally {
      const deleted = await graph('DELETE', `/${id}`);
      expect(deleted.data.success).toBe(true);
    }
  }, 120_000);
});
