import axios from 'axios';
import { existsSync } from 'fs';
import { join } from 'path';
import * as adapter from './opencart-bridge.json';
import * as oc4104 from './__fixtures__/opencart-bridge/oc-4.1.0.4.json';
import * as oc4023 from './__fixtures__/opencart-bridge/oc-4.0.2.3.json';
import * as oc3051 from './__fixtures__/opencart-bridge/oc-3.0.5.1.json';
import * as oc3038 from './__fixtures__/opencart-bridge/oc-3.0.3.8.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { codeHint, providerErrorCode } from '../../mcp-server/error-hints';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * OpenCart Bridge: the read-only JSON API that the free "AnythingMCP Bridge"
 * extension adds to an OpenCart 3.0.x or 4.0.2+ shop
 * (repository anythingmcp-opencart, GPL-3.0-or-later).
 *
 * Every endpoint sits on one route, the same on OpenCart 3 and 4:
 *   <shop>/index.php?route=extension/anythingmcp_bridge/api&endpoint=<name>
 * authenticated with `Authorization: Bearer ocbridge_<64 hex>`.
 *
 * Static checks always run: auth, the shop URL and token patterns, every
 * tool's route, endpoint and arguments, read-only annotations, the hints for
 * the bridge's error codes, and the response mapping against real answers
 * captured from Docker test shops on OpenCart 4.1.0.4, 4.0.2.3, 3.0.5.1 and
 * 3.0.3.8 (__fixtures__/opencart-bridge, written by the extension's
 * dev/functional_test.py and dev/export_fixtures.py).
 *
 * Live checks run only with RUN_OPENCART_BRIDGE_LIVE=1 and a shop with the
 * extension installed. Reads only:
 *
 *   RUN_OPENCART_BRIDGE_LIVE=1 OPENCART_SHOP_URL=https://shop.example.com \
 *     OPENCART_BRIDGE_TOKEN=ocbridge_... npx jest src/adapters/intl/opencart-bridge.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; pattern?: string; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams: Record<string, string> };
  annotations?: Record<string, unknown>;
};
type Hint = string | { hint: string; field?: string };
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern: string; kind: string; secret: boolean }>;
  verifyHints: Record<string, Hint>;
  probe: { tool: string; params: Record<string, unknown> };
  setupGuide: { effort: string; steps: Array<{ id: string; fields?: string[]; body: string }> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
type Bundle = { opencart_version: string; responses: Record<string, any>; errors: Record<string, any> };
const FIXTURES = [oc4104, oc4023, oc3051, oc3038] as unknown as Bundle[];

const ROUTE = 'extension/anythingmcp_bridge/api';
const ENDPOINT_OF: Record<string, string> = {
  opencart_bridge_get_store_info: 'store',
  opencart_bridge_list_orders: 'orders',
  opencart_bridge_get_order: 'order',
  opencart_bridge_list_order_statuses: 'order_statuses',
  opencart_bridge_list_customers: 'customers',
  opencart_bridge_get_customer: 'customer',
  opencart_bridge_list_customer_groups: 'customer_groups',
  opencart_bridge_list_products: 'products',
  opencart_bridge_get_product: 'product',
  opencart_bridge_list_categories: 'categories',
  opencart_bridge_list_manufacturers: 'manufacturers',
  opencart_bridge_list_returns: 'returns',
  opencart_bridge_list_reviews: 'reviews',
  opencart_bridge_list_stock: 'stock',
  opencart_bridge_get_sales_summary: 'sales_summary',
};
const TOKEN = 'ocbridge_' + 'a1'.repeat(32);
const ENV = { OPENCART_SHOP_URL: 'https://shop.example.com/store', OPENCART_BRIDGE_TOKEN: TOKEN };

const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const hintText = (hint: Hint | undefined) => (typeof hint === 'string' ? hint : hint?.hint);
const call = (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: cfg.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, env), headers: cfg.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const answer = (data: unknown, status = 200) => mockedAxios.mockResolvedValueOnce({ status, data, headers: { 'content-type': 'application/json; charset=utf-8' } });

describe('opencart-bridge adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is a REST connector with a bearer token on the shop URL, and reuses the OpenCart logo', () => {
    expect(a.slug).toBe('opencart-bridge');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('opencart');
    expect(existsSync(join(__dirname, '../../../../frontend/public/logos/connectors/opencart.svg'))).toBe(true);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{OPENCART_SHOP_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{OPENCART_BRIDGE_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['OPENCART_SHOP_URL', 'OPENCART_BRIDGE_TOKEN']);
    expect(a.optionalEnvVars).toBeUndefined();
    expect(a.envVarMeta.OPENCART_SHOP_URL).toMatchObject({ kind: 'address', secret: false });
    expect(a.envVarMeta.OPENCART_BRIDGE_TOKEN).toMatchObject({ kind: 'credential', secret: true });
  });

  it('accepts shop URLs with a subfolder or a port and refuses http, index.php and query strings', () => {
    const url = new RegExp(a.envVarMeta.OPENCART_SHOP_URL.pattern);
    for (const good of ['https://shop.example.com', 'https://shop.example.com/', 'https://example.com/shop', 'https://example.com:8443/my-shop/store/', 'https://xn--bcher-kva.example']) {
      expect(url.test(good)).toBe(true);
    }
    for (const bad of [
      'http://shop.example.com',
      'shop.example.com',
      'https://example.com/index.php?route=extension/anythingmcp_bridge/api',
      'https://example.com/shop?x=1',
      'https://example.com/a b',
    ]) {
      expect(url.test(bad)).toBe(false);
    }
    const token = new RegExp(a.envVarMeta.OPENCART_BRIDGE_TOKEN.pattern);
    expect(token.test(TOKEN)).toBe(true);
    for (const bad of ['', 'ocbridge_short', TOKEN.toUpperCase(), `Bearer ${TOKEN}`, `${TOKEN} `]) expect(token.test(bad)).toBe(false);
  });

  it('has one read-only GET tool per bridge endpoint, on the shared route', () => {
    const endpoints = FIXTURES[0].responses.store.data.endpoints as string[];
    expect(a.tools.map((entry) => ENDPOINT_OF[entry.name]).sort()).toEqual([...endpoints].sort());
    for (const entry of a.tools) {
      expect(entry.enabled).toBeUndefined();
      expect(entry.endpointMapping.method).toBe('GET');
      expect(entry.endpointMapping.path).toBe('/index.php');
      expect(entry.endpointMapping.queryParams.route).toBe(ROUTE);
      expect(entry.endpointMapping.queryParams.endpoint).toBe(ENDPOINT_OF[entry.name]);
      expect(entry.annotations).toEqual({ readOnlyHint: true });
      expect(deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations }).readOnlyHint).toBe(true);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it sends', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^opencart_bridge_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      const declared = Object.keys(entry.parameters.properties ?? {});
      const sentArgs = Object.entries(entry.endpointMapping.queryParams)
        .filter(([key]) => key !== 'route' && key !== 'endpoint')
        .map(([key, value]) => {
          expect(value).toBe(`$${key}`);
          return key;
        });
      expect(sentArgs.sort()).toEqual([...declared].sort());
      for (const req of entry.parameters.required ?? []) expect(declared).toContain(req);
      for (const [name, prop] of Object.entries(entry.parameters.properties ?? {})) {
        expect(prop.description?.length).toBeGreaterThan(10);
        if (name === 'limit') expect(prop.maximum).toBe(100);
        expect(name).not.toBe('language');
      }
      expect(entry.description.length).toBeGreaterThan(80);
    }
    expect(tool('opencart_bridge_get_order').parameters.required).toEqual(['order_id']);
    expect(tool('opencart_bridge_get_customer').parameters.required).toEqual(['customer_id']);
    expect(tool('opencart_bridge_get_product').parameters.required).toEqual(['product_id']);
  });

  it('probes the store info and has hints for every refusal the bridge answers', () => {
    expect(a.probe).toEqual({ tool: 'opencart_bridge_get_store_info', params: {} });
    for (const key of ['401', '403', '404', 'rate_limited', 'missing_token', 'invalid_token', 'disabled', 'ip_not_allowed', 'not_configured', 'scope_disabled']) {
      expect(hintText(a.verifyHints[key])).toBeTruthy();
    }
    // The captured refusals carry exactly these codes, and each finds its hint.
    for (const bundle of FIXTURES) {
      for (const [code, body] of Object.entries(bundle.errors)) {
        expect(body.error.code).toBe(code);
        const found = providerErrorCode(JSON.stringify(body));
        if (code === 'rate_limited') continue; // a failure kind: answered by the "rate_limited" key
        expect(found).toBe(code);
        expect(hintText(codeHint(a.verifyHints, found))).toBeTruthy();
      }
    }
  });

  it('guides the setup in three steps and asks for both variables in the last', () => {
    expect(a.setupGuide.steps.map((step) => step.id)).toEqual(['install', 'token', 'connect']);
    expect(a.setupGuide.steps[2].fields).toEqual(['OPENCART_SHOP_URL', 'OPENCART_BRIDGE_TOKEN']);
    expect(a.setupGuide.steps[0].fields).toBeUndefined();
    expect(a.setupGuide.steps[1].fields).toBeUndefined();
  });

  it('names every tool in the instructions, explains the database connector, and keeps the text MDX-safe', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).toContain('OpenCart** database connector');
    expect(a.instructions).toContain('opencart_query');
    const outsideBackticks = (text: string) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, a.description, ...a.tools.map((entry) => entry.description), ...a.setupGuide.steps.map((step) => step.body)]) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/—/);
    }
  });

  it('calls the shop route with the bearer token, in a subfolder and with a trailing slash', async () => {
    answer(FIXTURES[0].responses.store);
    await call('opencart_bridge_get_store_info', {});
    const req = sent();
    expect(req.url).toBe('https://shop.example.com/store/index.php');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(header(req, 'User-Agent')).toBe('AnythingMCP');
    expect(req.params).toEqual({ route: ROUTE, endpoint: 'store' });
    expect(JSON.stringify(req.params)).not.toContain(TOKEN);

    answer(FIXTURES[0].responses.store);
    await call('opencart_bridge_get_store_info', {}, { ...ENV, OPENCART_SHOP_URL: 'https://shop.example.com/' });
    expect(sent().url).toBe('https://shop.example.com/index.php');
  });

  it('sends filters, paging defaults and ids as query parameters', async () => {
    answer(FIXTURES[0].responses.orders);
    await call('opencart_bridge_list_orders', { status_id: '2,3,5', date_from: '2026-11-01', date_to: '2026-11-15', customer: "O'Brien" });
    expect(sent().params).toEqual({
      route: ROUTE,
      endpoint: 'orders',
      status_id: '2,3,5',
      date_from: '2026-11-01',
      date_to: '2026-11-15',
      customer: "O'Brien",
      sort: 'date_added',
      order: 'desc',
      page: 1,
      limit: 20,
    });

    answer(FIXTURES[0].responses.order);
    await call('opencart_bridge_get_order', { order_id: 2 });
    expect(sent().params).toEqual({ route: ROUTE, endpoint: 'order', order_id: 2 });

    answer(FIXTURES[0].responses.stock);
    await call('opencart_bridge_list_stock', { max_quantity: 5, include_options: 1 });
    expect(sent().params).toEqual({ route: ROUTE, endpoint: 'stock', max_quantity: 5, include_options: 1, page: 1, limit: 20 });

    answer(FIXTURES[0].responses.sales_summary);
    await call('opencart_bridge_get_sales_summary', { date_from: '2026-10-01', date_to: '2026-11-16' });
    expect(sent().params).toEqual({ route: ROUTE, endpoint: 'sales_summary', date_from: '2026-10-01', date_to: '2026-11-16', group_by: 'day' });
  });
});

describe.each(FIXTURES.map((bundle) => [bundle.opencart_version, bundle] as const))('opencart-bridge: answers captured on OpenCart %s', (version, bundle) => {
  beforeEach(() => mockedAxios.mockReset());
  const r = bundle.responses;

  it('passes every captured answer through unchanged', async () => {
    const params: Record<string, Record<string, unknown>> = {
      opencart_bridge_get_order: { order_id: 2 },
      opencart_bridge_get_customer: { customer_id: 2 },
      opencart_bridge_get_product: { product_id: 40 },
    };
    for (const entry of a.tools) {
      const body = r[ENDPOINT_OF[entry.name]];
      expect(body).toBeDefined();
      answer(body);
      await expect(call(entry.name, params[entry.name] ?? {})).resolves.toEqual(body);
    }
  });

  it('store info names the version, languages and the sales statuses', () => {
    const store = r.store.data;
    expect(store.opencart_version).toBe(version);
    expect(store.bridge_version).toBe('1.0.0');
    expect(store.languages[0]).toEqual(expect.objectContaining({ language_id: expect.any(Number), code: 'en-gb' }));
    expect(store.complete_status_ids.length).toBeGreaterThan(0);
    expect(store.max_page_size).toBe(100);
  });

  it('list answers carry the fields the tool descriptions promise, with pagination', () => {
    const fields: Record<string, string[]> = {
      orders: ['order_id', 'invoice', 'customer_id', 'email', 'total', 'currency_code', 'order_status_id', 'status', 'payment_method', 'shipping_method', 'item_count', 'date_added', 'date_modified'],
      customers: ['customer_id', 'customer_group', 'firstname', 'lastname', 'email', 'telephone', 'newsletter', 'status', 'date_added'],
      products: ['product_id', 'model', 'sku', 'name', 'price', 'special', 'quantity', 'out_of_stock_status', 'status', 'manufacturer', 'image_url', 'date_modified'],
      categories: ['category_id', 'parent_id', 'name', 'path', 'status', 'product_count', 'seo_keyword'],
      manufacturers: ['manufacturer_id', 'name', 'image_url', 'product_count'],
      returns: ['return_id', 'order_id', 'product', 'quantity', 'return_reason', 'return_status', 'date_added'],
      reviews: ['review_id', 'product_id', 'product', 'author', 'rating', 'text', 'status', 'date_added'],
      stock: ['product_id', 'model', 'sku', 'name', 'quantity', 'subtract', 'minimum', 'status', 'option_stock'],
    };
    for (const [endpoint, keys] of Object.entries(fields)) {
      expect(r[endpoint].pagination).toEqual(expect.objectContaining({ page: 1, total: expect.any(Number) }));
      expect(r[endpoint].data.length).toBeGreaterThan(0);
      for (const key of keys) expect(r[endpoint].data[0]).toHaveProperty(key);
    }
    expect(r.orders.data.map((o: { order_id: number }) => o.order_id)).toEqual([5, 4, 3, 2, 1]);
  });

  it('an order has addresses, methods, lines with options, totals and history, and no card data', () => {
    const order = r.order.data;
    expect(order.shipping_address).toEqual(expect.objectContaining({ city: 'Dublin', country: 'Ireland' }));
    expect(order.payment_method).toEqual({ name: 'Cash On Delivery', code: expect.stringMatching(/^cod/) });
    expect(order.products.map((p: { product_id: number }) => p.product_id)).toEqual([43, 40]);
    expect(order.totals.map((t: { code: string }) => t.code)).toEqual(['sub_total', 'shipping', 'tax', 'total']);
    expect(order.history.length).toBe(2);
    expect(order.lastname).toBe("O'Brien");
    expect(r.order_without_customer_data.data).not.toHaveProperty('email');
    expect(r.order_without_customer_data.data).not.toHaveProperty('shipping_address');
  });

  it('a product has codes, descriptions, specials, SEO keywords and, on OpenCart 4, variants', () => {
    const product = r.product.data;
    expect(product.sku).toBe('IPH-001');
    expect(product.special).toBeCloseTo(90.9, 1);
    expect(product.descriptions[0]).toEqual(expect.objectContaining({ language_code: 'en-gb', name: 'iPhone' }));
    expect(product.seo_keywords.length).toBeGreaterThan(0);
    expect(product.images.length).toBeGreaterThan(0);
    expect(product.reviews).toEqual({ approved: 2, average_rating: 3.5 });
    expect(product.variants.map((v: { product_id: number }) => v.product_id)).toEqual(version.startsWith('4') ? [100] : []);
  });

  it('the customer has addresses and an order summary, the sales summary separates sales from cancellations', () => {
    expect(r.customer.data.addresses[0]).toEqual(expect.objectContaining({ city: 'Dublin', default: true }));
    expect(r.customer.data.order_summary.orders).toBe(1);
    const sales = r.sales_summary.data;
    expect(sales.totals.orders).toBe(4);
    expect(sales.status_source).toBe('shop_processing_and_complete');
    expect(sales.by_status.some((s: { order_status_id: number }) => s.order_status_id === 7)).toBe(true);
    expect(sales.top_products[0]).toEqual(expect.objectContaining({ product_id: 40, quantity: 3 }));
  });

  it('never carries a secret field of the shop', () => {
    const text = JSON.stringify(bundle);
    for (const secret of ['SECRET', '"password"', '"salt"', '"ip"', 'user_agent', 'custom_field', '4111111111111111', 'token_hash']) {
      expect(text).not.toContain(secret);
    }
  });
});

// Opt-in: RUN_OPENCART_BRIDGE_LIVE=1 with a shop that has the extension installed and enabled.
const live = process.env.RUN_OPENCART_BRIDGE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('opencart-bridge: live', () => {
  const shop = (process.env.OPENCART_SHOP_URL ?? '').replace(/\/+$/, '');
  const api = `${shop}/index.php`;

  it('refuses a call without a token', async () => {
    if (!shop) throw new Error('Set OPENCART_SHOP_URL for the live check');
    const response = await liveFetch.get(api, { params: { route: ROUTE, endpoint: 'store' }, validateStatus: () => true });
    expect([401, 403]).toContain(response.status);
    expect(response.data.error.code).toBeTruthy();
  });

  it('reads the store info and one page of orders', async () => {
    const token = process.env.OPENCART_BRIDGE_TOKEN;
    if (!shop || !token) throw new Error('Set OPENCART_SHOP_URL and OPENCART_BRIDGE_TOKEN for the live check');
    const headers = { Authorization: `Bearer ${token}` };
    const store = await liveFetch.get(api, { params: { route: ROUTE, endpoint: 'store' }, headers });
    expect(store.data.data.bridge_version).toBeTruthy();
    const orders = await liveFetch.get(api, { params: { route: ROUTE, endpoint: 'orders', limit: 5 }, headers });
    expect(Array.isArray(orders.data.data)).toBe(true);
  });
});
