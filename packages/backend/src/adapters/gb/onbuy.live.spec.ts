import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import * as adapter from './onbuy.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * OnBuy API v2 adapter (OnCommerce).
 *
 * Static checks always run: the login call (secret key and consumer key as a
 * form, a 15-minute token that OnBuy binds to the caller's address and that
 * travels as a bare Authorization header), the site id on every call that
 * takes one, every tool's method and path against OnBuy's published Postman
 * collection, the write bodies, and which tools install switched off (cancel,
 * refund and listing deletion).
 * https://docs.api.onbuy.com/
 *
 * Live checks run only with RUN_ONBUY_LIVE=1. Without credentials they confirm
 * OnBuy refuses made-up keys; with ONBUY_CONSUMER_KEY and ONBUY_SECRET_KEY they
 * sign in through LoginTokenService and read the sites. Reads only.
 *
 *   RUN_ONBUY_LIVE=1 ONBUY_CONSUMER_KEY=... ONBUY_SECRET_KEY=... \
 *     npx jest src/adapters/gb/onbuy.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
    download?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
type GuideStep = { id: string; fields?: string[]; values?: Array<{ label: string; value: string }>; confirm?: string };
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; advanced?: boolean; example?: string; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  setupGuide?: { effort: string; minutes: number; steps: GuideStep[] };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: { errorWhen?: Array<Record<string, unknown>> };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  walk(m.download ?? {});
  return out;
};
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

const BASE = 'https://api.onbuy.com/v2';
// Built at runtime so no literal looks like a real credential.
const FAKE_SECRET = ['sk', 'z'.repeat(30)].join('_');
const FAKE_TOKEN = ['4E7D', 'A'.repeat(20), 'fCA4'].join('-');
const ENV: Record<string, string> = {
  ONBUY_CONSUMER_KEY: ['ck', 'y'.repeat(30)].join('_'),
  ONBUY_SECRET_KEY: FAKE_SECRET,
  ONBUY_SITE_ID: '2000',
};
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
const stubLogin = (token = FAKE_TOKEN) => {
  const bundle = async () => ({ token, expiresAt: Date.now() + 900_000 });
  return { getToken: bundle, forceRelogin: bundle } as unknown as LoginTokenService;
};

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, stubLogin()).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200, data: unknown = {}) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// Every tool with its method, its path below the base URL and its required arguments,
// as the vendor documents them.
const EXPECTED: Array<[string, string, string, string[]]> = [
  ['onbuy_list_sites', 'GET', '/sites', []],
  ['onbuy_list_orders', 'GET', '/orders', []],
  ['onbuy_get_order', 'GET', '/orders/{order_id}', ['order_id']],
  ['onbuy_dispatch_orders', 'PUT', '/orders/dispatch', ['orders']],
  ['onbuy_update_tracking', 'PUT', '/dispatches/tracking', ['dispatches']],
  ['onbuy_cancel_orders', 'PUT', '/orders/cancel', ['orders']],
  ['onbuy_refund_orders', 'PUT', '/orders/refund', ['orders']],
  ['onbuy_list_listings', 'GET', '/listings', []],
  ['onbuy_create_listing', 'POST', '/products/{opc}/listings', ['opc', 'listings']],
  ['onbuy_update_listings', 'PUT', '/listings/by-sku', ['listings']],
  ['onbuy_delete_listings', 'DELETE', '/listings/by-sku', ['skus']],
  ['onbuy_check_winning', 'GET', '/listings/check-winning', ['skus']],
  ['onbuy_search_products', 'GET', '/products', ['query']],
  ['onbuy_create_product', 'POST', '/products', ['category_id', 'product_name', 'description', 'product_codes']],
  ['onbuy_list_queues', 'GET', '/queues', []],
  ['onbuy_get_queue', 'GET', '/queues/{queue_id}', ['queue_id']],
  ['onbuy_list_categories', 'GET', '/categories', []],
  ['onbuy_get_category_features', 'GET', '/categories/{category_id}/features', ['category_id']],
  ['onbuy_search_brands', 'GET', '/brands', ['name']],
  ['onbuy_list_carriers', 'GET', '/carriers', []],
  ['onbuy_list_conditions', 'GET', '/conditions', []],
  ['onbuy_list_commission_tiers', 'GET', '/commission-tiers', []],
  ['onbuy_list_delivery_options', 'GET', '/sellers/deliveries', []],
];

describe('onbuy adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('logs in with the consumer key and the secret key for a 15-minute token', () => {
    expect(a.slug).toBe('onbuy');
    expect(a.region).toBe('gb');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('onbuy');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toEqual({
      loginUrl: `${BASE}/auth/request-token`,
      loginMethod: 'POST',
      loginHeaders: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      loginBody: { secret_key: '${password}', consumer_key: '${username}' },
      username: '{{ONBUY_CONSUMER_KEY}}',
      password: '{{ONBUY_SECRET_KEY}}',
      tokenJsonPath: 'access_token',
      expiryJsonPath: 'expires_at',
      expiryFormat: 'unix',
      tokenTTLSeconds: 900,
      proactiveRefreshSeconds: 120,
      refreshOn401: true,
      headerName: 'Authorization',
      headerTemplate: '${token}',
    });
    expect(a.requiredEnvVars).toEqual(['ONBUY_CONSUMER_KEY', 'ONBUY_SECRET_KEY', 'ONBUY_SITE_ID']);
    expect(a.envVarMeta.ONBUY_SECRET_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.ONBUY_SITE_ID).toMatchObject({ kind: 'setting', example: '2000' });
    for (const name of a.requiredEnvVars) expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
    for (const bad of ['', 'uk', '2000 ']) expect(new RegExp(a.envVarMeta.ONBUY_SITE_ID.pattern!).test(bad)).toBe(false);
  });

  it('posts both keys as form fields and keeps the token for at most 15 minutes', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as any;
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    mockedAxios.mockResolvedValueOnce({ data: { access_token: FAKE_TOKEN, expires_at: expiresAt }, headers: {} });
    const bundle = await new LoginTokenService({} as PrismaService, config).getToken(auth);
    const login = sent();
    expect(String(login.method).toUpperCase()).toBe('POST');
    expect(login.url).toBe(`${BASE}/auth/request-token`);
    expect(login.data).toEqual({ secret_key: FAKE_SECRET, consumer_key: ENV.ONBUY_CONSUMER_KEY });
    expect(login.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(login.headers.Authorization).toBeUndefined();
    expect(bundle.token).toBe(FAKE_TOKEN);
    expect(bundle.expiresAt).toBe(expiresAt * 1000);
  });

  it('sends the site id on every call that takes one', () => {
    const withoutSite = ['onbuy_list_sites', 'onbuy_search_brands'];
    for (const entry of a.tools) {
      const m = entry.endpointMapping;
      const site = m.method === 'GET' ? m.queryParams?.site_id : m.bodyMapping?.site_id;
      expect([entry.name, site]).toEqual([entry.name, withoutSite.includes(entry.name) ? undefined : '{{ONBUY_SITE_ID}}']);
    }
  });

  it('probes the site list and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'onbuy_list_sites', params: { limit: 1 } });
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('exposes every tool on the documented method and path, with its required arguments', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(EXPECTED.map(([name]) => name));
    for (const [name, method, path, required] of EXPECTED) {
      const entry = tool(name);
      expect([name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([name, method, path]);
      expect(entry.parameters.required ?? []).toEqual(required);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^onbuy_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, schema] of Object.entries(entry.parameters.properties ?? {})) expect([param, Boolean(schema.description)]).toEqual([param, true]);
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('marks reads read-only and installs cancel, refund and listing deletion switched off', () => {
    const READS: string[] = ['onbuy_check_winning', 'onbuy_get_category_features', 'onbuy_get_order', 'onbuy_get_queue', 'onbuy_list_carriers', 'onbuy_list_categories', 'onbuy_list_commission_tiers', 'onbuy_list_conditions', 'onbuy_list_delivery_options', 'onbuy_list_listings', 'onbuy_list_orders', 'onbuy_list_queues', 'onbuy_list_sites', 'onbuy_search_brands', 'onbuy_search_products'];
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, READS.includes(entry.name)]);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['onbuy_cancel_orders', 'onbuy_delete_listings', 'onbuy_refund_orders']);
    for (const name of off) expect(tool(name).description).toContain('Installed switched off');
  });

  it('names every tool in the instructions and keeps the texts safe for the website', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const texts = [a.description, a.instructions, ...a.tools.flatMap((entry) => [entry.description, ...Object.values(entry.parameters.properties ?? {}).map((p) => p.description ?? '')])];
    for (const text of texts) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/—/);
    }
  });

  it('lists orders awaiting dispatch with the bare token and the site id', async () => {
    ok();
    await call('onbuy_list_orders', {});
    const req = sent();
    expect(req.url).toBe(`${BASE}/orders`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe(FAKE_TOKEN);
    expect(req.params).toEqual({ site_id: '2000', 'filter[status]': 'awaiting_dispatch', limit: 50, offset: 0 });

    ok();
    await call('onbuy_get_order', { order_id: 'T58ZSDG' });
    expect(sent().url).toBe(`${BASE}/orders/T58ZSDG`);
    expect(sent().params).toEqual({ site_id: '2000' });

    ok();
    await call('onbuy_list_listings', { sku: 'EXP-143-33S', in_stock: 1 });
    expect(sent().url).toBe(`${BASE}/listings`);
    expect(sent().params).toEqual({ site_id: '2000', 'filter[sku]': 'EXP-143-33S', 'filter[in_stock]': 1, limit: 50, offset: 0 });

    ok();
    await call('onbuy_search_products', { query: '5008187637403', field: 'product_code' });
    expect(sent().url).toBe(`${BASE}/products`);
    expect(sent().params).toEqual({ site_id: '2000', 'filter[query]': '5008187637403', 'filter[field]': 'product_code', limit: 20, offset: 0 });

    ok();
    await call('onbuy_check_winning', { skus: ['SKU-1', 'SKU-2'] });
    expect(sent().url).toBe(`${BASE}/listings/check-winning`);
    expect(sent().params).toEqual({ site_id: '2000', 'skus[]': ['SKU-1', 'SKU-2'] });
  });

  it('builds the dispatch, tracking, listing, cancel and refund bodies as OnBuy documents them', async () => {
    const orders = [{ order_id: 'TBDWSH', tracking: { supplier_name: 'Royal Mail', number: 'JW257202249GB' } }];
    ok();
    await call('onbuy_dispatch_orders', { orders });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/orders/dispatch`);
    expect(sent().data).toEqual({ site_id: '2000', orders });

    const dispatches = [{ dispatch_id: '049003c5-2baf-4bfd-83e8-84cacca94bb3', onbuy_carrier_code: 'OCC-MHUBGIUW4UH9ES5I6D', tracking_number: 'JW257202249GB' }];
    ok();
    await call('onbuy_update_tracking', { dispatches });
    expect(sent().url).toBe(`${BASE}/dispatches/tracking`);
    expect(sent().data).toEqual({ site_id: '2000', dispatches });

    ok();
    await call('onbuy_update_listings', { listings: [{ sku: 'EXP-143-33S', price: 14.83, stock: 88 }] });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/listings/by-sku`);
    expect(sent().data).toEqual({ site_id: '2000', listings: [{ sku: 'EXP-143-33S', price: 14.83, stock: 88 }] });

    ok();
    await call('onbuy_create_listing', { opc: 'PN8JV6', listings: { new: { sku: 'SKU-1', price: 19.99, stock: 5 } } });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/products/PN8JV6/listings`);
    expect(sent().data).toEqual({ site_id: '2000', opc: 'PN8JV6', listings: { new: { sku: 'SKU-1', price: 19.99, stock: 5 } } });

    ok();
    await call('onbuy_delete_listings', { skus: ['SKU-1'] });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/listings/by-sku`);
    expect(sent().data).toEqual({ site_id: '2000', skus: ['SKU-1'] });

    ok();
    await call('onbuy_cancel_orders', { orders: [{ order_id: 'T9R7V', order_cancellation_reason_id: 1 }] });
    expect(sent().url).toBe(`${BASE}/orders/cancel`);
    expect(sent().data).toEqual({ site_id: '2000', orders: [{ order_id: 'T9R7V', order_cancellation_reason_id: 1 }] });

    ok();
    await call('onbuy_refund_orders', { orders: [{ order_id: 'TD6CMG', order_refund_reason_id: 2 }] });
    expect(sent().url).toBe(`${BASE}/orders/refund`);
    expect(sent().data).toEqual({ site_id: '2000', orders: [{ order_id: 'TD6CMG', order_refund_reason_id: 2 }] });
  });
});

// Opt-in: RUN_ONBUY_LIVE=1. The refusal check needs no account; the read needs
// ONBUY_CONSUMER_KEY and ONBUY_SECRET_KEY. Nothing is written.
const live = process.env.RUN_ONBUY_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('onbuy: live', () => {
  it('refuses made-up keys at the token call', async () => {
    const response = await liveFetch.post(`${BASE}/auth/request-token`, 'secret_key=not-a-secret&consumer_key=not-a-key', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect([400, 401, 403]).toContain(response.status);
  });

  it('signs in through LoginTokenService and reads the sites', async () => {
    const consumer = process.env.ONBUY_CONSUMER_KEY;
    const secret = process.env.ONBUY_SECRET_KEY;
    if (!consumer || !secret) throw new Error('Set ONBUY_CONSUMER_KEY and ONBUY_SECRET_KEY for the live check');
    const env = { ONBUY_CONSUMER_KEY: consumer, ONBUY_SECRET_KEY: secret, ONBUY_SITE_ID: process.env.ONBUY_SITE_ID ?? '2000' };
    mockedAxios.mockImplementation((request: unknown) => (liveFetch as unknown as (r: unknown) => Promise<unknown>)(request));
    const login = new LoginTokenService({} as PrismaService, config);
    const bundle = await login.getToken(interpolateDeep(a.connector.authConfig, env) as never);
    expect(bundle.token).toBeTruthy();
    const sites = await liveFetch.get(`${BASE}/sites`, { headers: { Authorization: bundle.token, Accept: 'application/json' }, validateStatus: () => true });
    expect(sites.status).toBe(200);
    expect(Array.isArray(sites.data.results)).toBe(true);
  });
});
