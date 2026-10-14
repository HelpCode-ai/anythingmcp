import axios from 'axios';
import * as adapter from './whop.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Whop adapter:
 *
 *   1. Static: always runs. Pins the Bearer auth on the v1 API, every tool's
 *      method, URL, query and body through the real RestEngine, checked
 *      against Whop's OpenAPI document (api.whop.com/api/v1/openapi.json,
 *      fetched 14 Oct 2026) and the official TypeScript SDK generated from it
 *      (whopio/whopsdk-typescript, src/api/resources/<resource>/client):
 *      plans are read from /variants (the /plans routes are a deprecated
 *      alias), a license key is looked up as a membership id, account-scoped
 *      lists carry account_id. Also the switched-off cancel and refund, and
 *      the response shaping that keeps secrets and card data out.
 *
 *   2. Live: skipped unless RUN_WHOP_LIVE=1. Without a key it checks that
 *      Whop refuses a wrong key with 401 on every route that needs one, finds
 *      no plan or user on the two public reads (a resource 404), and answers
 *      404 "Unrecognized request URL" on a made-up route. With WHOP_API_KEY and
 *      WHOP_ACCOUNT_ID it reads memberships, products, plans and payments.
 *      Nothing is ever cancelled or refunded by this spec.
 *
 *        RUN_WHOP_LIVE=1 WHOP_API_KEY=... WHOP_ACCOUNT_ID=biz_... npx jest src/adapters/intl/whop.live.spec.ts
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
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

const BASE = 'https://api.whop.com/api/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'whop_' + 'x'.repeat(40);
const ACCOUNT = 'biz_' + 'a'.repeat(14);
const ENV: Record<string, string> = { WHOP_API_KEY: FAKE_KEY, WHOP_ACCOUNT_ID: ACCOUNT };

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
const urlOf = (req: any) => (req.params && Object.keys(req.params).length ? `${req.url}?${new URLSearchParams(req.params).toString()}` : req.url);
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);

const OFF = ['whop_cancel_membership', 'whop_refund_payment'];

describe('whop adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor SDK and API spec on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('authenticates with the Account API key as Bearer on the v1 API', () => {
    expect(a.category).toBe('payments');
    expect(a.icon).toBe('whop');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{WHOP_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/memberships?first=1');
    expect(a.requiredEnvVars).toEqual(['WHOP_API_KEY', 'WHOP_ACCOUNT_ID']);
    const meta = describeAdapterEnvVars(a as never);
    expect(meta.find((m: any) => m.name === 'WHOP_API_KEY')).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.find((m: any) => m.name === 'WHOP_ACCOUNT_ID')).toMatchObject({ kind: 'setting', required: true });
  });

  it('accepts keys and biz_ ids and refuses pasted headers', () => {
    const key = new RegExp(a.envVarMeta.WHOP_API_KEY.pattern!);
    for (const ok of [FAKE_KEY, 'A'.repeat(43)]) expect(key.test(ok)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `, 'short']) expect(key.test(bad)).toBe(false);
    const biz = new RegExp(a.envVarMeta.WHOP_ACCOUNT_ID.pattern!);
    expect(biz.test(ACCOUNT)).toBe(true);
    for (const bad of ['prod_xxxxxxxxxxxx', 'biz_', ` ${ACCOUNT}`]) expect(biz.test(bad)).toBe(false);
  });

  it('probes with a one-membership list and explains 403 as a missing permission', () => {
    expect(a.probe).toEqual({ tool: 'whop_list_memberships', params: { first: 1 } });
    expect(a.verifyHints['403']).toMatch(/member:basic:read/);
  });

  it('prefixes every tool with whop_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^whop_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('is read-only except cancel and refund, which are destructive, switched off and ask to confirm', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(OFF);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const name of OFF) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tool(name).description).toMatch(/Installed switched off\. Confirm/);
    }
    // Cancelling must state the timing; refunding the full amount is the API's default.
    expect(tool('whop_cancel_membership').parameters.required).toEqual(['id', 'cancel_at_period_end']);
  });

  it('only points the model at tools that exist, explains key types and permissions, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bwhop_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bwhop_[a-z_]+/g), ...JSON.stringify(t.parameters).matchAll(/\bwhop_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    for (const part of ['Account API key', 'App API key', 'member:basic:read', 'payment:manage', 'membership:cancel', 'biz_', 'v5']) {
      expect(a.instructions).toContain(part);
    }
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('carries valid response mappings, none of them a maxBytes-only no-op', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      if (!tr) continue;
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const acct = `account_id=${ACCOUNT}`;
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['whop_get_account', {}, 'GET', `${BASE}/accounts/me`],
    ['whop_list_products', {}, 'GET', `${BASE}/products?${acct}&first=20`],
    ['whop_get_product', { id: 'prod_1' }, 'GET', `${BASE}/products/prod_1`],
    ['whop_list_plans', { product_id: 'prod_1' }, 'GET', `${BASE}/variants?${acct}&product_ids=prod_1&first=20`],
    ['whop_get_plan', { id: 'plan_1' }, 'GET', `${BASE}/variants/plan_1`],
    ['whop_list_memberships', { status: 'active' }, 'GET', `${BASE}/memberships?${acct}&status=active&first=20`],
    ['whop_get_membership', { id: 'mem_1' }, 'GET', `${BASE}/memberships/mem_1`],
    ['whop_validate_license_key', { license_key: 'ABCD-1234-EFGH' }, 'GET', `${BASE}/memberships/ABCD-1234-EFGH`],
    ['whop_cancel_membership', { id: 'mem_1', cancel_at_period_end: true }, 'POST', `${BASE}/memberships/mem_1/cancel`],
    ['whop_list_members', { query: 'ada' }, 'GET', `${BASE}/members?${acct}&query=ada&first=20`],
    ['whop_get_member', { id: 'mber_1' }, 'GET', `${BASE}/members/mber_1`],
    ['whop_get_user', { id: 'user_1' }, 'GET', `${BASE}/users/user_1?${acct}&include_balance=false`],
    ['whop_check_user_access', { user_id: 'user_1', resource_id: 'prod_1' }, 'GET', `${BASE}/users/user_1/access/prod_1`],
    ['whop_list_payments', { status: 'paid' }, 'GET', `${BASE}/payments?${acct}&status=paid&first=20`],
    ['whop_get_payment', { id: 'pay_1' }, 'GET', `${BASE}/payments/pay_1`],
    ['whop_refund_payment', { id: 'pay_1' }, 'POST', `${BASE}/payments/pay_1/refund`],
    ['whop_list_promo_codes', {}, 'GET', `${BASE}/promo_codes?${acct}&first=20`],
    ['whop_list_experiences', {}, 'GET', `${BASE}/experiences?${acct}&first=20`],
    ['whop_list_forum_posts', { experience_id: 'exp_1' }, 'GET', `${BASE}/forum_posts?experience_id=exp_1&first=20`],
    ['whop_list_webhooks', {}, 'GET', `${BASE}/webhooks?${acct}&first=20`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer key', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(urlOf(req)).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('cancels with the chosen timing and refunds all or a partial amount', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('whop_cancel_membership', { id: 'mem_1', cancel_at_period_end: true, reason: 'customer request' });
    expect(sent().data).toEqual({ cancel_at_period_end: true, reason: 'customer request' });
    mockedAxios.mockClear();
    await call('whop_refund_payment', { id: 'pay_1' });
    expect(sent().data ?? {}).toEqual({});
    mockedAxios.mockClear();
    await call('whop_refund_payment', { id: 'pay_1', partial_amount: 10.5 });
    expect(sent().data).toEqual({ partial_amount: 10.5 });
  });

  it('percent-encodes a license key in the path', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('whop_validate_license_key', { license_key: 'AB/CD 12' });
    expect(sent().url).toBe(`${BASE}/memberships/AB%2FCD%2012`);
  });

  const MEMBERSHIP = {
    id: 'mem_1',
    status: 'active',
    product: { id: 'prod_1', title: 'Pro Tools', logo_url: 'https://img' },
    product_id: 'prod_1',
    plan_id: 'plan_1',
    user_id: 'user_1',
    member_id: 'mber_1',
    account: { id: ACCOUNT, title: 'Acme', route: 'acme', logo_url: 'https://img' },
    initial_price: { amount: '0.00', currency: 'usd', decimals: 2, display_decimals: 2 },
    renewal_price: { amount: '29.00', currency: 'usd', decimals: 2, display_decimals: 2 },
    current_period_end: '2026-11-14T00:00:00Z',
    cancel_at_period_end: false,
    canceled_at: null,
    expires_at: null,
    most_recent_action: 'renewing_on',
    promo_code_id: null,
    license_key: 'ABCD-1234-EFGH',
    metadata: { hwid: 'machine-1' },
    created_at: '2026-10-14T00:00:00Z',
  };

  it('answers a license check with valid, status and the bound metadata', () => {
    expect(shape('whop_validate_license_key', MEMBERSHIP).value).toEqual({
      valid: true,
      status: 'active',
      membership_id: 'mem_1',
      product_id: 'prod_1',
      product: 'Pro Tools',
      plan_id: 'plan_1',
      user_id: 'user_1',
      member_id: 'mber_1',
      current_period_end: '2026-11-14T00:00:00Z',
      expires_at: null,
      cancel_at_period_end: false,
      metadata: { hwid: 'machine-1' },
    });
    for (const status of ['trialing', 'completed']) expect((shape('whop_validate_license_key', { ...MEMBERSHIP, status }).value as any).valid).toBe(true);
    for (const status of ['canceled', 'expired', 'past_due', 'paused', 'banned']) expect((shape('whop_validate_license_key', { ...MEMBERSHIP, status }).value as any).valid).toBe(false);
  });

  it('shapes memberships and payments compactly and keeps secrets and card data out', () => {
    const list = shape('whop_list_memberships', { data: [MEMBERSHIP], page_info: { end_cursor: 'c2', has_next_page: true } }).value as any;
    expect(list.page_info).toEqual({ end_cursor: 'c2', has_next_page: true });
    expect(list.memberships[0]).toMatchObject({ id: 'mem_1', status: 'active', product: 'Pro Tools', license_key: 'ABCD-1234-EFGH' });
    expect(list.memberships[0].account).toBeUndefined();

    const payment = {
      id: 'pay_1',
      status: 'paid',
      substatus: 'succeeded',
      total: { amount: '29.00', currency: 'usd' },
      currency: 'usd',
      client_secret: 'pi_secret',
      payment_instrument: { last4: '4242' },
      ip_address: '203.0.113.7',
      billing_address: { line1: 'x' },
      risk_signals: [],
      user: { id: 'user_1', username: 'ada' },
      created_at: 't',
    };
    const listed = shape('whop_list_payments', { data: [payment], page_info: { has_next_page: false } }).value as any;
    expect(listed.payments[0]).toEqual({ id: 'pay_1', status: 'paid', substatus: 'succeeded', total: { amount: '29.00', currency: 'usd' }, currency: 'usd', user_id: 'user_1', created_at: 't' });
    const one = JSON.stringify(shape('whop_get_payment', payment).value);
    expect(one).not.toMatch(/pi_secret|4242|203\.0\.113\.7|line1/);

    const hooks = JSON.stringify(shape('whop_list_webhooks', { data: [{ id: 'hook_1', url: 'https://x', webhook_secret: 'ws_secret', enabled: true }], page_info: {} }).value);
    expect(hooks).toContain('hook_1');
    expect(hooks).not.toContain('ws_secret');
  });
});

const live = process.env.RUN_WHOP_LIVE === '1' ? describe : describe.skip;
live('whop adapter: live', () => {
  const realEnv =
    process.env.WHOP_API_KEY && process.env.WHOP_ACCOUNT_ID ? { WHOP_API_KEY: process.env.WHOP_API_KEY, WHOP_ACCOUNT_ID: process.env.WHOP_ACCOUNT_ID } : undefined;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each<[string, Record<string, unknown>]>([
    ['whop_get_account', {}],
    ['whop_list_products', {}],
    ['whop_get_product', { id: 'prod_xxxxxxxxxxxx' }],
    ['whop_list_plans', {}],
    ['whop_list_memberships', {}],
    ['whop_get_membership', { id: 'mem_xxxxxxxxxxxxx' }],
    ['whop_validate_license_key', { license_key: 'AAAA-BBBB-CCCC' }],
    ['whop_cancel_membership', { id: 'mem_xxxxxxxxxxxxx', cancel_at_period_end: true }],
    ['whop_list_members', {}],
    ['whop_get_member', { id: 'mber_xxxxxxxxxxxx' }],
    ['whop_check_user_access', { user_id: 'user_xxxxxxxxxxxxx', resource_id: 'prod_xxxxxxxxxxxx' }],
    ['whop_list_payments', {}],
    ['whop_get_payment', { id: 'pay_xxxxxxxxxxxxx' }],
    ['whop_refund_payment', { id: 'pay_xxxxxxxxxxxxx' }],
    ['whop_list_promo_codes', {}],
    ['whop_list_experiences', {}],
    ['whop_list_forum_posts', { experience_id: 'exp_xxxxxxxxxxxxx' }],
    ['whop_list_webhooks', {}],
  ])('%s reaches a real route that refuses a wrong key with 401', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401, data: { error: { type: 'unauthorized' } } } });
  }, 30000);

  // Public reads need no key, so with a wrong key Whop looks the id up and
  // answers a resource 404, distinct from the "Unrecognized request URL" 404.
  it.each<[string, Record<string, unknown>, string]>([
    ['whop_get_user', { id: 'user_xxxxxxxxxxxxx' }, 'User not found'],
    ['whop_get_plan', { id: 'plan_xxxxxxxxxxxxx' }, 'Resource not found'],
  ])('%s reaches its public route: an unknown id is a resource 404', async (name, params, message) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 404, data: { error: { type: 'not_found', message } } } });
  }, 30000);

  it('answers 404 Unrecognized request URL on a made-up route', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/does-not-exist`, headers: { Authorization: `Bearer ${FAKE_KEY}`, 'User-Agent': 'AnythingMCP' } }),
    ).rejects.toMatchObject({ response: { status: 404, data: { error: { type: 'not_found' } } } });
  }, 30000);

  (realEnv ? it : it.skip)('reads memberships, products, plans and payments with a real key', async () => {
    const memberships = shape('whop_list_memberships', await call('whop_list_memberships', { first: 2 }, realEnv)).value as any;
    expect(Array.isArray(memberships.memberships)).toBe(true);
    expect(memberships.page_info).toEqual(expect.objectContaining({ has_next_page: expect.any(Boolean) }));
    const products = shape('whop_list_products', await call('whop_list_products', { first: 2 }, realEnv)).value as any;
    expect(Array.isArray(products.products)).toBe(true);
    const plans = shape('whop_list_plans', await call('whop_list_plans', { first: 2 }, realEnv)).value as any;
    expect(Array.isArray(plans.plans)).toBe(true);
    const payments = shape('whop_list_payments', await call('whop_list_payments', { first: 2 }, realEnv)).value as any;
    expect(Array.isArray(payments.payments)).toBe(true);
  }, 90000);
});
