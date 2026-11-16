import axios from 'axios';
import * as adapter from './shopline.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * SHOPLINE adapter: the Admin REST API (Open API) of myshopline.com stores, v20260901.
 *
 * Static checks always run: the store handle and API version in the base URL,
 * the private app token as a bearer header, every tool's method and path
 * against developer.shopline.com (list and create on the doubled
 * products/products.json path, single products without it), the wrapped
 * request bodies (order, product, variant, fulfillment), the link header for
 * cursor paging, and that nothing installs switched off because no tool
 * cancels or refunds. https://developer.shopline.com/docs/apps/api-instructions-for-use/rest-admin-api/overview
 *
 * Live checks run only with RUN_SHOPLINE_LIVE=1. With SHOPLINE_HANDLE alone they
 * confirm that SHOPLINE refuses a wrong token; with SHOPLINE_ACCESS_TOKEN as
 * well they count products and read one order page. Reads only.
 *
 *   RUN_SHOPLINE_LIVE=1 SHOPLINE_HANDLE=... SHOPLINE_ACCESS_TOKEN=... \
 *     npx jest src/adapters/intl/shopline.live.spec.ts
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
    bodyTemplate?: string;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; options?: { value: string }[] }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: { errorWhen?: unknown };
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
  walk(m.bodyTemplate ?? '');
  walk(m.headers ?? {});
  out.delete('loginToken');
  return out;
};

const ENV: Record<string, string> = {
  SHOPLINE_HANDLE: 'open001',
  SHOPLINE_ACCESS_TOKEN: 'eyJhbGciOiJIUzUxMiJ9.eyJzdG9yZUlkIjoiMSJ9.c2lnbmF0dXJlLXZhbHVl',
};
const BASE = 'https://open001.myshopline.com/admin/openapi/v20260901';

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: cfg.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: cfg.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const EXPECTED: Record<string, [string, string]> = {
  shopline_list_orders: ['GET', '/orders.json'],
  shopline_count_orders: ['GET', '/orders/count.json'],
  shopline_update_order: ['PUT', '/orders/{order_id}.json'],
  shopline_list_order_fulfillments: ['GET', '/orders/{order_id}/fulfillments.json'],
  shopline_create_fulfillment: ['POST', '/orders/{order_id}/fulfillments.json'],
  shopline_update_fulfillment_tracking: ['POST', '/fulfillments/{order_id}/{fulfillment_id}/update_tracking.json'],
  shopline_list_order_transactions: ['POST', '/transactions/query.json'],
  shopline_list_order_refunds: ['GET', '/orders/{order_id}/refunds.json'],
  shopline_list_products: ['GET', '/products/products.json'],
  shopline_get_product: ['GET', '/products/{product_id}.json'],
  shopline_count_products: ['GET', '/products/count.json'],
  shopline_update_product: ['PUT', '/products/{product_id}.json'],
  shopline_list_product_variants: ['GET', '/products/{product_id}/variants.json'],
  shopline_update_variant: ['PUT', '/products/variants/{variant_id}.json'],
  shopline_list_customers: ['GET', '/v2/customers.json'],
  shopline_get_customer: ['GET', '/customers/v2/{customer_id}.json'],
  shopline_search_customers: ['GET', '/customers/v2/search.json'],
  shopline_list_customer_orders: ['GET', '/customers/{customer_id}/orders.json'],
  shopline_list_locations: ['GET', '/locations/list.json'],
  shopline_get_inventory_items: ['GET', '/inventory_items.json'],
  shopline_get_inventory_levels: ['GET', '/inventory_levels.json'],
  shopline_set_inventory: ['POST', '/inventory_levels/set.json'],
  shopline_adjust_inventory: ['POST', '/inventory_levels/adjust.json'],
};

describe('shopline adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('calls the store handle on API version v20260901 with the private app token as bearer', () => {
    expect(a.slug).toBe('shopline');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('shopline');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://{{SHOPLINE_HANDLE}}.myshopline.com/admin/openapi/v20260901');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SHOPLINE_ACCESS_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['SHOPLINE_HANDLE', 'SHOPLINE_ACCESS_TOKEN']);
    expect(a.envVarMeta.SHOPLINE_ACCESS_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    for (const name of a.requiredEnvVars) {
      const pattern = new RegExp(a.envVarMeta[name].pattern!);
      expect([name, pattern.test(ENV[name])]).toEqual([name, true]);
      for (const bad of ['', 'Bearer abc.def.ghi', 'https://open001.myshopline.com']) expect([name, bad, pattern.test(bad)]).toEqual([name, bad, false]);
    }
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const entry of a.tools) {
      const [method, path] = EXPECTED[entry.name];
      expect([entry.name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([entry.name, method, path]);
    }
  });

  it('declares a cheap probe and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({'tool': 'shopline_count_products', 'params': {}});
    expect(tool(a.probe.tool).endpointMapping).toBeTruthy();
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^shopline_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const param of Object.values(entry.parameters.properties ?? {})) expect(param.description).toBeTruthy();
      expect(entry.description.length).toBeGreaterThan(60);
    }
  });

  it('marks reads read-only and installs only no tool switched off', () => {
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, entry.endpointMapping.method === 'GET' || entry.name === 'shopline_list_order_transactions']);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([]);
  });

  it('names every tool in the instructions and keeps texts MDX-safe', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    const outsideTicks = (s: string) => s.replace(/`[^`]*`/g, '');
    expect(outsideTicks(a.instructions)).not.toMatch(/[{}<]/);
    for (const entry of a.tools) {
      expect(outsideTicks(entry.description)).not.toMatch(/[{}<]/);
      for (const param of Object.values(entry.parameters.properties ?? {})) expect(outsideTicks(param.description ?? '')).not.toMatch(/[{}<]/);
    }
  });

  it('reads orders with the bearer token and exposes the link header for page_info paging', async () => {
    ok({ orders: [] });
    await call('shopline_list_orders', { financial_status: 'paid', limit: 100 });
    const req = sent();
    expect(req.url).toBe(`${BASE}/orders.json`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.SHOPLINE_ACCESS_TOKEN}`);
    expect(req.params).toEqual({ status: 'any', financial_status: 'paid', limit: 100 });
    for (const name of ['shopline_list_orders', 'shopline_list_products', 'shopline_list_customers', 'shopline_search_customers']) {
      expect((tool(name).endpointMapping as unknown as { exposeHeaders?: string[] }).exposeHeaders).toEqual(['link']);
    }
  });

  it('uses the doubled path only for the product list and single paths for one product', async () => {
    ok({ product: {} });
    await call('shopline_get_product', { product_id: '16057850264845250791280282' });
    expect(sent().url).toBe(`${BASE}/products/16057850264845250791280282.json`);
    ok({ products: [] });
    await call('shopline_list_products', {});
    expect(sent().url).toBe(`${BASE}/products/products.json`);
    expect(sent().params).toEqual({ limit: 50 });
  });

  it('wraps write bodies in order, product, variant and fulfillment objects', async () => {
    ok({});
    await call('shopline_update_order', { order_id: '21057850264845250791280282', tags: 'vip,gift' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().data).toEqual({ order: { tags: 'vip,gift' } });

    ok({});
    await call('shopline_update_product', { product_id: '16057850264845250791280282', status: 'draft', tags: ['a', 'b'] });
    expect(sent().data).toEqual({ product: { status: 'draft', tags: ['a', 'b'] } });

    ok({});
    await call('shopline_update_variant', { variant_id: '18057850264845250791280282', price: '19.90' });
    expect(sent().url).toBe(`${BASE}/products/variants/18057850264845250791280282.json`);
    expect(sent().data).toEqual({ variant: { price: '19.90' } });

    ok({});
    await call('shopline_create_fulfillment', { order_id: '21057850264845250791280282', tracking_number: '1Z999', tracking_company: 'UPS' });
    expect(sent().url).toBe(`${BASE}/orders/21057850264845250791280282/fulfillments.json`);
    expect(sent().data).toEqual({ fulfillment: { tracking_number: '1Z999', tracking_company: 'UPS', notify_customer: false } });
  });

  it('sets and adjusts inventory with flat bodies', async () => {
    ok({});
    await call('shopline_set_inventory', { inventory_item_id: '1001', location_id: '2002', available: 7 });
    expect(sent().url).toBe(`${BASE}/inventory_levels/set.json`);
    expect(sent().data).toEqual({ inventory_item_id: '1001', location_id: '2002', available: 7 });
    ok({});
    await call('shopline_adjust_inventory', { inventory_item_id: '1001', location_id: '2002', available_adjustment: -2 });
    expect(sent().data).toEqual({ inventory_item_id: '1001', location_id: '2002', available_adjustment: -2 });
  });
});

// Opt-in: RUN_SHOPLINE_LIVE=1. The refusal check needs SHOPLINE_HANDLE; the
// reads need SHOPLINE_ACCESS_TOKEN too. Nothing is written.
const live = process.env.RUN_SHOPLINE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('shopline: live', () => {
  const base = `https://${process.env.SHOPLINE_HANDLE}.myshopline.com/admin/openapi/v20260901`;

  it('refuses a wrong token', async () => {
    if (!process.env.SHOPLINE_HANDLE) throw new Error('Set SHOPLINE_HANDLE for the live check');
    const response = await liveFetch.get(`${base}/products/count.json`, {
      headers: { Authorization: 'Bearer not.a-real.token', 'Content-Type': 'application/json; charset=utf-8' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('counts products and reads one order page', async () => {
    const token = process.env.SHOPLINE_ACCESS_TOKEN;
    if (!process.env.SHOPLINE_HANDLE || !token) throw new Error('Set SHOPLINE_HANDLE and SHOPLINE_ACCESS_TOKEN');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };
    const count = await liveFetch.get(`${base}/products/count.json`, { headers, validateStatus: () => true });
    expect(count.status).toBe(200);
    const orders = await liveFetch.get(`${base}/orders.json`, { headers, params: { status: 'any', limit: 1 }, validateStatus: () => true });
    expect(orders.status).toBe(200);
    expect(Array.isArray(orders.data.orders)).toBe(true);
  });
});
