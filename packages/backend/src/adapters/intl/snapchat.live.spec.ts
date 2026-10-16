import axios from 'axios';
import * as adapter from './snapchat.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Snapchat Ads adapter (Marketing API v1):
 *
 *   1. Static: always runs. Pins the OAuth settings (authorization code,
 *      client id and secret in the token request body, no PKCE because Snap
 *      does not document it, scope snapchat-marketing-api), every tool's
 *      method, URL, query and body through the real RestEngine, the JSON Patch
 *      that pauses or resumes a campaign, which tools change something and ask
 *      first, the budget change switched off, and the response shaping that
 *      unwraps Snap's sub_request envelopes.
 *      Checked on 15 Oct 2026 against the Snap Marketing API reference
 *      (developers.snap.com/api/marketing-api/Ads-API: authentication, user,
 *      organizations, ad accounts, campaigns, ad squads, ads, creatives,
 *      customer-list segments, measurement and API patterns). Snap publishes
 *      no OpenAPI document or official SDK for this API.
 *
 *   2. Live: skipped unless RUN_SNAPCHAT_LIVE=1. Snap checks the token before
 *      the route (a made-up route also answers 401), so a wrong token only
 *      proves the host and auth scheme, not the paths. With
 *      SNAPCHAT_ACCESS_TOKEN (a user token, valid one hour) it walks
 *      organizations, ad accounts, campaigns, ad squads, ads, creatives,
 *      audiences and stats read-only. SNAPCHAT_LIVE_WRITE=1 with
 *      SNAPCHAT_TEST_CAMPAIGN_ID sets that campaign's status to the value it
 *      already has (no change in delivery):
 *
 *        RUN_SNAPCHAT_LIVE=1 SNAPCHAT_ACCESS_TOKEN=... npx jest src/adapters/intl/snapchat.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; minimum?: number; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; headers?: Record<string, string>; queryParams?: Record<string, unknown>; bodyTemplate?: string };
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

const BASE = 'https://adsapi.snapchat.com/v1';
// Built at run time so nothing here looks like a real token.
const FAKE_TOKEN = ['0', 'test', 'x'.repeat(12)].join('.');
const call = (name: string, params: Record<string, unknown>, token = FAKE_TOKEN) =>
  new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: a.connector.headers },
    tool(name).endpointMapping as any,
    applySchemaDefaults(tool(name).parameters as any, params),
  ) as Promise<any>;
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

const ID = '22225ba6-7559-4000-9663-bace8adff5f2';
const C = '7c074b60-3ae7-4975-bc1d-5785cc0be2c8';
const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['snapchat_get_me', {}, 'GET', '/me'],
  ['snapchat_list_organizations', {}, 'GET', '/me/organizations'],
  ['snapchat_list_ad_accounts', { organization_id: ID }, 'GET', `/organizations/${ID}/adaccounts`],
  ['snapchat_get_ad_account', { ad_account_id: ID }, 'GET', `/adaccounts/${ID}`],
  ['snapchat_list_campaigns', { ad_account_id: ID }, 'GET', `/adaccounts/${ID}/campaigns`],
  ['snapchat_get_campaign', { campaign_id: C }, 'GET', `/campaigns/${C}`],
  ['snapchat_list_ad_squads', { campaign_id: C }, 'GET', `/campaigns/${C}/adsquads`],
  ['snapchat_get_ad_squad', { ad_squad_id: C }, 'GET', `/adsquads/${C}`],
  ['snapchat_list_ads', { ad_squad_id: C }, 'GET', `/adsquads/${C}/ads`],
  ['snapchat_get_ad', { ad_id: C }, 'GET', `/ads/${C}`],
  ['snapchat_list_creatives', { ad_account_id: ID }, 'GET', `/adaccounts/${ID}/creatives`],
  ['snapchat_get_creative', { creative_id: C }, 'GET', `/creatives/${C}`],
  ['snapchat_get_stats', { entity_type: 'campaigns', entity_id: C }, 'GET', `/campaigns/${C}/stats`],
  ['snapchat_list_audiences', { ad_account_id: ID }, 'GET', `/adaccounts/${ID}/segments`],
  ['snapchat_set_campaign_status', { ad_account_id: ID, campaign_id: C, status: 'PAUSED' }, 'PATCH', `/adaccounts/${ID}/campaigns/${C}`],
  ['snapchat_set_campaign_daily_budget', { ad_account_id: ID, campaign_id: C, daily_budget_micro: 50000000 }, 'PATCH', `/adaccounts/${ID}/campaigns/${C}`],
];

describe('snapchat adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('advertising');
    expect(a.icon).toBe('snapchat');
  });

  it('signs in through Snap OAuth with the secret in the body, no PKCE, scope snapchat-marketing-api', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{SNAPCHAT_CLIENT_ID}}',
      clientSecret: '{{SNAPCHAT_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.snapchat.com/login/oauth2/authorize',
      tokenUrl: 'https://accounts.snapchat.com/login/oauth2/access_token',
      tokenAuthMethod: 'client_secret_post',
      pkce: false,
      scopes: 'snapchat-marketing-api',
    });
    expect(needsBrowserAuthorization(a as never)).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/me');
    expect(a.probe).toEqual({ tool: 'snapchat_get_me' });
    expect(a.requiredEnvVars).toEqual(['SNAPCHAT_CLIENT_ID', 'SNAPCHAT_CLIENT_SECRET']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.SNAPCHAT_CLIENT_SECRET.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.SNAPCHAT_CLIENT_ID.pattern!).test('4c3f2a18-1c33-4a1b-8798-0123456789ab')).toBe(true);
    for (const key of ['401', '403', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/Organization Admin/);
    expect(a.instructions).toMatch(/no application or review by Snap is needed/);
    expect(a.instructions).toMatch(/micro-currency/);
    expect(a.prerequisites).toMatch(/Organization Admin/);
  });

  it('prefixes every tool with snapchat_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^snapchat_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('asks before every change, keeps the budget change off and marks reads read-only', () => {
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET';
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${!write}`);
      if (write) expect(`${t.name}:${/wait for their yes/.test(t.description)}`).toBe(`${t.name}:true`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['snapchat_set_campaign_daily_budget']);
    expect(tool('snapchat_set_campaign_status').description).toMatch(/starts spending/);
  });

  it('documents every tool, points only at real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bsnapchat_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bsnapchat_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.expression).toBeDefined();
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
  });

  it('pages lists with limit 50 to 1000 and cursor, as the API patterns page says', () => {
    for (const t of a.tools.filter((x) => x.parameters.properties?.limit)) {
      const limit = t.parameters.properties!.limit;
      expect(`${t.name}:${limit.minimum}-${limit.maximum}-${limit.default}`).toBe(`${t.name}:50-1000-50`);
      expect(t.endpointMapping.queryParams).toMatchObject({ limit: '$limit', cursor: '$cursor' });
    }
  });

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer token', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('builds the stats query with TOTAL and the core metrics by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('snapchat_get_stats', { entity_type: 'adaccounts', entity_id: ID });
    expect(sent().params).toEqual({ granularity: 'TOTAL', fields: 'impressions,swipes,spend' });
    mockedAxios.mockClear();
    await call('snapchat_get_stats', {
      entity_type: 'campaigns', entity_id: C, granularity: 'DAY', start_time: '2026-10-01T00:00:00', end_time: '2026-10-08T00:00:00',
      breakdown: 'adsquad', swipe_up_attribution_window: '7_DAY', omit_empty: true,
    });
    expect(sent().params).toEqual({
      granularity: 'DAY', fields: 'impressions,swipes,spend', start_time: '2026-10-01T00:00:00', end_time: '2026-10-08T00:00:00',
      breakdown: 'adsquad', swipe_up_attribution_window: '7_DAY', omit_empty: true,
    });
    mockedAxios.mockClear();
    await call('snapchat_list_campaigns', { ad_account_id: ID, cursor: 'abc' });
    expect(sent().params).toEqual({ limit: 50, cursor: 'abc' });
  });

  it('sends a JSON Patch that changes only the status or the daily budget', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('snapchat_set_campaign_status', { ad_account_id: ID, campaign_id: C, status: 'PAUSED' });
    expect(sent().headers['Content-Type']).toBe('application/json-patch+json');
    expect(sent().data).toEqual([{ op: 'replace', path: '/status', value: 'PAUSED' }]);
    mockedAxios.mockClear();
    await call('snapchat_set_campaign_daily_budget', { ad_account_id: ID, campaign_id: C, daily_budget_micro: 50000000 });
    expect(sent().headers['Content-Type']).toBe('application/json-patch+json');
    expect(sent().data).toEqual([{ op: 'add', path: '/daily_budget_micro', value: 50000000 }]);
  });

  it('unwraps the sub_request envelopes and keeps the next page link', () => {
    const campaigns = shape('snapchat_list_campaigns', {
      request_status: 'SUCCESS', request_id: 'r',
      paging: { next_link: `${BASE}/adaccounts/${ID}/campaigns?cursor=xyz&limit=50` },
      campaigns: [{ sub_request_status: 'SUCCESS', campaign: { id: C, name: 'Badger', ad_account_id: ID, status: 'ACTIVE', start_time: '2026-10-01T00:00:00.000Z', daily_budget_micro: 50000000, measurement_spec: { x: 1 } } }],
    });
    expect(campaigns).toEqual({
      request_status: 'SUCCESS',
      next_link: `${BASE}/adaccounts/${ID}/campaigns?cursor=xyz&limit=50`,
      campaigns: [{ id: C, name: 'Badger', ad_account_id: ID, status: 'ACTIVE', start_time: '2026-10-01T00:00:00.000Z', daily_budget_micro: 50000000 }],
    });
    expect(shape('snapchat_get_me', { request_status: 'SUCCESS', me: { id: 'u', email: 'a@b.c', display_name: 'A', organization_id: 'o', member_status: 'MEMBER', bitmoji: { avatar_id: 'x' } } }))
      .toEqual({ id: 'u', email: 'a@b.c', display_name: 'A', organization_id: 'o', member_status: 'MEMBER' });
    const orgs = shape('snapchat_list_organizations', {
      request_status: 'SUCCESS',
      organizations: [{ sub_request_status: 'SUCCESS', organization: { id: 'o', name: 'Org', type: 'ENTERPRISE', country: 'DE', address_line_1: 'x', ad_accounts: [{ id: ID, name: 'Main', currency: 'EUR', timezone: 'Europe/Berlin', status: 'ACTIVE', type: 'DIRECT', funding_source_ids: ['f'] }] } }],
    });
    expect(orgs.organizations[0]).toEqual({ id: 'o', name: 'Org', type: 'ENTERPRISE', country: 'DE', ad_accounts: [{ id: ID, name: 'Main', currency: 'EUR', timezone: 'Europe/Berlin', status: 'ACTIVE', type: 'DIRECT' }] });
    const stats = shape('snapchat_get_stats', { request_status: 'SUCCESS', request_id: 'r', total_stats: [{ sub_request_status: 'SUCCESS', total_stat: { id: C, type: 'CAMPAIGN', granularity: 'TOTAL', stats: { impressions: 10, swipes: 1, spend: 1230000 } } }] });
    expect(stats).toEqual({ request_status: 'SUCCESS', total_stats: [{ sub_request_status: 'SUCCESS', total_stat: { id: C, type: 'CAMPAIGN', granularity: 'TOTAL', stats: { impressions: 10, swipes: 1, spend: 1230000 } } }] });
    const patched = shape('snapchat_set_campaign_status', { request_status: 'ERROR', campaigns: [{ sub_request_status: 'ERROR', sub_request_error_reason: 'Error code: E1166, message: x', campaign: { id: C, name: 'Badger', status: 'ACTIVE' } }] });
    expect(patched.campaigns[0].sub_request_error_reason).toMatch(/E1166/);
  });
});

const live = process.env.RUN_SNAPCHAT_LIVE === '1' ? describe : describe.skip;
live('snapchat adapter: live', () => {
  const token = process.env.SNAPCHAT_ACCESS_TOKEN;
  const testCampaign = process.env.SNAPCHAT_TEST_CAMPAIGN_ID;
  const writes = !!token && !!testCampaign && process.env.SNAPCHAT_LIVE_WRITE === '1';
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each(table)('%s is refused with a wrong token (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('also answers a made-up route with 401: Snap checks the token first, so the 401s prove host and auth only', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ method: 'GET', url: `${BASE}/no-such-route`, headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (token ? it : it.skip)('walks organizations, ad accounts, campaigns, ad squads, ads, creatives, audiences and stats', async () => {
    const run = async (name: string, params: Record<string, unknown> = {}) => shape(name, await call(name, params, token));
    expect((await run('snapchat_get_me')).id).toBeTruthy();
    const orgs = await run('snapchat_list_organizations');
    const org = orgs.organizations[0];
    expect(org.id).toBeTruthy();
    const accounts = await run('snapchat_list_ad_accounts', { organization_id: org.id });
    const account = accounts.adaccounts[0];
    if (!account) return;
    expect((await run('snapchat_get_ad_account', { ad_account_id: account.id })).adaccount[0].id).toBe(account.id);
    const campaigns = await run('snapchat_list_campaigns', { ad_account_id: account.id });
    expect(Array.isArray(campaigns.campaigns)).toBe(true);
    expect(Array.isArray((await run('snapchat_list_creatives', { ad_account_id: account.id })).creatives)).toBe(true);
    expect(Array.isArray((await run('snapchat_list_audiences', { ad_account_id: account.id })).segments)).toBe(true);
    expect((await run('snapchat_get_stats', { entity_type: 'adaccounts', entity_id: account.id, fields: 'spend' })).request_status).toMatch(/success/i);
    const campaign = campaigns.campaigns[0];
    if (!campaign) return;
    expect((await run('snapchat_get_campaign', { campaign_id: campaign.id })).campaign[0].id).toBe(campaign.id);
    expect((await run('snapchat_get_stats', { entity_type: 'campaigns', entity_id: campaign.id })).request_status).toMatch(/success/i);
    const squads = await run('snapchat_list_ad_squads', { campaign_id: campaign.id });
    const squad = squads.adsquads[0];
    if (!squad) return;
    expect((await run('snapchat_get_ad_squad', { ad_squad_id: squad.id })).adsquad[0].id).toBe(squad.id);
    const ads = await run('snapchat_list_ads', { ad_squad_id: squad.id });
    if (ads.ads[0]) {
      expect((await run('snapchat_get_ad', { ad_id: ads.ads[0].id })).ad[0].id).toBe(ads.ads[0].id);
      if (ads.ads[0].creative_id) expect((await run('snapchat_get_creative', { creative_id: ads.ads[0].creative_id })).creative[0].id).toBe(ads.ads[0].creative_id);
    }
  }, 120000);

  (writes ? it : it.skip)('sets the test campaign status to the value it already has (no change in delivery)', async () => {
    const campaign = shape('snapchat_get_campaign', await call('snapchat_get_campaign', { campaign_id: testCampaign }, token)).campaign[0];
    const out = shape('snapchat_set_campaign_status', await call('snapchat_set_campaign_status', { ad_account_id: campaign.ad_account_id, campaign_id: campaign.id, status: campaign.status }, token));
    expect(out.campaigns[0].status).toBe(campaign.status);
  }, 60000);
});
