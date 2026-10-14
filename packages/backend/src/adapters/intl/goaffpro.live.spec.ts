import axios from 'axios';
import * as adapter from './goaffpro.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the GoAffPro adapter:
 *
 *   1. Static: always runs. Pins the x-goaffpro-access-token header and every
 *      tool's method, URL, query and body through the real RestEngine, checked
 *      against GoAffPro's admin OpenAPI document (api.goaffpro.com/docs/admin,
 *      read 13 Oct 2026): the required `fields` list on the list endpoints,
 *      rewards and payouts sent as one-element arrays, and the nested coupon
 *      and commission objects sent only when given.
 *
 *   2. Live: skipped unless RUN_GOAFFPRO_LIVE=1. Without a token it checks
 *      that GoAffPro refuses a wrong one with 403 on real routes (GoAffPro
 *      checks the token before the route, so a made-up path also answers 403).
 *      With GOAFFPRO_ACCESS_TOKEN it reads one affiliate, one order and the
 *      pending payouts (nothing is changed):
 *
 *        RUN_GOAFFPRO_LIVE=1 GOAFFPRO_ACCESS_TOKEN=... npx jest src/adapters/intl/goaffpro.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  region: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params: Record<string, unknown> };
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

const BASE = 'https://api.goaffpro.com/v1/admin';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'gap-test-' + 'x'.repeat(24);
const ENV: Record<string, string> = { GOAFFPRO_ACCESS_TOKEN: FAKE_TOKEN };

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

describe('goaffpro adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until it has been run against a real store', () => {
    expect(a.unlisted).toBe(true);
    expect(a.region).toBe('intl');
    expect(a.icon).toBe('goaffpro');
  });

  it('sends the store token in x-goaffpro-access-token, on the admin API', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-goaffpro-access-token', apiKey: '{{GOAFFPRO_ACCESS_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/affiliates?fields=id&limit=1');
    expect(a.requiredEnvVars).toEqual(['GOAFFPRO_ACCESS_TOKEN']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'GOAFFPRO_ACCESS_TOKEN', kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.GOAFFPRO_ACCESS_TOKEN.pattern!);
    expect(pattern.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `${FAKE_TOKEN} `, 'short']) expect(pattern.test(bad)).toBe(false);
  });

  it('probes with a one-affiliate list and explains the 403', () => {
    expect(a.probe).toEqual({ tool: 'goaffpro_list_affiliates', params: { fields: 'id', limit: 1 } });
    expect(a.verifyHints['403']).toMatch(/API Keys/);
  });

  it('prefixes every tool and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^goaffpro_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('ships the deletes switched off, marks GETs read-only and asks for confirmation on writes', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(['goaffpro_delete_affiliate', 'goaffpro_delete_order']);
    for (const t of a.tools) {
      const readOnly = annotationsOf(t).readOnlyHint === true;
      expect(`${t.name}:${readOnly}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
      if (!readOnly) expect(t.description).toMatch(/confirmation/);
    }
  });

  it('gives every list endpoint that requires fields a default list', () => {
    for (const t of a.tools) {
      if (t.endpointMapping.queryParams?.fields === undefined) continue;
      expect(t.parameters.required).toContain('fields');
      expect(typeof t.parameters.properties!.fields.default).toBe('string');
    }
  });

  it('only points the model at tools that exist, describes every parameter and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgoaffpro_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgoaffpro_[a-z_]+/g)]),
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

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['goaffpro_list_affiliates', {}, 'GET', `${BASE}/affiliates`],
    ['goaffpro_search_affiliates', { keyword: 'anna' }, 'GET', `${BASE}/affiliates/search`],
    ['goaffpro_get_affiliate_commissions', { id: 42 }, 'GET', `${BASE}/affiliates/42/commissions`],
    ['goaffpro_list_affiliate_coupons', { id: 42 }, 'GET', `${BASE}/affiliates/42/coupons`],
    ['goaffpro_list_affiliate_referral_codes', { id: 42 }, 'GET', `${BASE}/affiliates/42/referral_codes`],
    ['goaffpro_list_orders', {}, 'GET', `${BASE}/orders`],
    ['goaffpro_list_rewards', {}, 'GET', `${BASE}/rewards`],
    ['goaffpro_list_payouts', {}, 'GET', `${BASE}/payments`],
    ['goaffpro_list_pending_payouts', {}, 'GET', `${BASE}/payments/pending`],
    ['goaffpro_list_payout_requests', {}, 'GET', `${BASE}/payments/requests`],
    ['goaffpro_list_transactions', {}, 'GET', `${BASE}/transactions`],
    ['goaffpro_list_traffic', {}, 'GET', `${BASE}/traffic`],
    ['goaffpro_list_coupons', {}, 'GET', `${BASE}/coupons`],
    ['goaffpro_list_groups', {}, 'GET', `${BASE}/groups`],
    ['goaffpro_create_affiliate', { email: 'anna@example.com' }, 'POST', `${BASE}/affiliates`],
    ['goaffpro_update_affiliate', { id: 42, status: 'approved' }, 'PATCH', `${BASE}/affiliates/42`],
    ['goaffpro_delete_affiliate', { id: 42 }, 'DELETE', `${BASE}/affiliates/42`],
    ['goaffpro_add_affiliate_coupon', { id: 42, coupon_code: 'ANNA10' }, 'POST', `${BASE}/affiliates/42/coupons`],
    ['goaffpro_add_order', { number: '#1001', total: 59.9, affiliate_id: '42' }, 'POST', `${BASE}/orders`],
    ['goaffpro_update_order', { id: '555', status: 'approved' }, 'PATCH', `${BASE}/orders/555`],
    ['goaffpro_delete_order', { id: '555' }, 'DELETE', `${BASE}/orders/555`],
    ['goaffpro_give_reward', { affiliate_id: 42, amount: 10, type: 'target_bonus' }, 'POST', `${BASE}/rewards`],
    ['goaffpro_record_payout', { affiliate_id: '42', amount: 120 }, 'POST', `${BASE}/payments`],
    ['goaffpro_update_payout_request', { id: '9', status: 'paid' }, 'PATCH', `${BASE}/payments/requests/9`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the store token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers['x-goaffpro-access-token']).toBe(FAKE_TOKEN);
  });

  it('asks for a default field list and passes the filters through', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('goaffpro_list_affiliates', { status: 'pending' });
    expect(sent().params).toEqual({ fields: 'id,name,email,ref_code,coupon,status,created_at', status: 'pending', limit: 100 });
    mockedAxios.mockClear();
    await call('goaffpro_list_orders', { affiliate_id: '42', status: 'new', since_id: '900' });
    expect(sent().params).toEqual({ fields: 'id,number,total,subtotal,commission,affiliate_id,status,created_at', affiliate_id: '42', status: 'new', since_id: '900', limit: 100 });
    mockedAxios.mockClear();
    await call('goaffpro_search_affiliates', { keyword: 'anna' });
    expect(sent().params).toEqual({ keyword: 'anna', in: 'name,email,ref_code', operator: 'contains', fields: 'id,name,email,ref_code,coupon,status,created_at', limit: 25 });
  });

  it('sends nested coupon and commission objects only when given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('goaffpro_create_affiliate', { email: 'anna@example.com', name: 'Anna', status: 'approved' });
    expect(sent().data).toEqual({ email: 'anna@example.com', status: 'approved', name: 'Anna' });
    mockedAxios.mockClear();
    await call('goaffpro_update_affiliate', { id: 42, commission: { type: 'percentage', amount: 15, on: 'order' } });
    expect(sent().data).toEqual({ commission: { type: 'percentage', amount: 15, on: 'order' } });
    mockedAxios.mockClear();
    await call('goaffpro_add_affiliate_coupon', { id: 42, coupon_code: 'ANNA10' });
    expect(sent().data).toEqual({ coupon: { code: 'ANNA10' } });
  });

  it('sends orders, rewards and payouts in the documented shapes', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('goaffpro_add_order', { number: '#1001', total: 59.9, ref_code: 'anna' });
    expect(sent().data).toEqual({ order: { number: '#1001', total: 59.9 }, ref_code: 'anna' });
    mockedAxios.mockClear();
    await call('goaffpro_give_reward', { affiliate_id: 42, amount: 10, type: 'target_bonus', metadata: 'Q3 target' });
    expect(sent().data).toEqual({ rewards: [{ affiliate_id: 42, amount: 10, type: 'target_bonus', status: 'approved', metadata: 'Q3 target' }] });
    mockedAxios.mockClear();
    await call('goaffpro_record_payout', { affiliate_id: '42', amount: 120, payment_method: 'paypal' });
    expect(sent().data).toEqual({ payments: [{ affiliate_id: '42', amount: 120, payment_method: 'paypal' }] });
    mockedAxios.mockClear();
    await call('goaffpro_update_order', { id: '555', status: 'rejected' });
    expect(sent().data).toEqual({ status: 'rejected' });
  });
});

const live = process.env.RUN_GOAFFPRO_LIVE === '1' ? describe : describe.skip;
live('goaffpro adapter: live', () => {
  const realToken = process.env.GOAFFPRO_ACCESS_TOKEN;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['goaffpro_list_affiliates', { fields: 'id', limit: 1 }],
    ['goaffpro_list_orders', { limit: 1 }],
    ['goaffpro_list_pending_payouts', {}],
    ['goaffpro_list_transactions', { limit: 1 }],
  ])('%s: GoAffPro refuses a wrong token with 403', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 403 } });
  }, 30000);

  (realToken ? it : it.skip)('reads one affiliate, one order and the pending payouts', async () => {
    const env = { GOAFFPRO_ACCESS_TOKEN: realToken! };
    const affiliates = await call('goaffpro_list_affiliates', { limit: 1 }, env);
    expect(Array.isArray(affiliates.affiliates)).toBe(true);
    const orders = await call('goaffpro_list_orders', { limit: 1 }, env);
    expect(Array.isArray(orders.orders)).toBe(true);
    const pending = await call('goaffpro_list_pending_payouts', {}, env);
    expect(pending).toBeDefined();
  }, 60000);
});
