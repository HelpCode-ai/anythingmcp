import axios from 'axios';
import * as adapter from './vtex.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * VTEX adapter: OMS, Catalog, Pricing, Logistics and Master Data v1.
 *
 * Static checks always run: the account and environment in the host, the app
 * key and token headers on every call (also on the Pricing host
 * api.vtex.com/<account>), every tool's method and path against VTEX's
 * published OpenAPI specs (github.com/vtex/openapi-schemas), the request
 * bodies, the Master Data REST-Range header, and which tools install switched
 * off (cancel, invoice, invoice tracking). No tool moves money while switched on.
 * https://developers.vtex.com/docs/api-reference
 *
 * Live checks run only with RUN_VTEX_LIVE=1. With VTEX_ACCOUNT_NAME alone they
 * confirm that VTEX refuses a wrong key; with VTEX_APP_KEY and VTEX_APP_TOKEN
 * as well they read one order page and the warehouses. Reads only.
 *
 *   RUN_VTEX_LIVE=1 VTEX_ACCOUNT_NAME=... VTEX_APP_KEY=... VTEX_APP_TOKEN=... \
 *     npx jest src/adapters/intl/vtex.live.spec.ts
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
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
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
  return out;
};

const ENV: Record<string, string> = {
  VTEX_ACCOUNT_NAME: 'mystore',
  VTEX_ENVIRONMENT: 'vtexcommercestable',
  VTEX_APP_KEY: 'vtexappkey-mystore-ABCDEF',
  VTEX_APP_TOKEN: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJ',
};
const BASE = 'https://mystore.vtexcommercestable.com.br';
const PRICING = 'https://api.vtex.com/mystore/pricing';

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
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
const ok = (data: unknown = {}, status = 200) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const EXPECTED: Record<string, [string, string]> = {
  vtex_list_orders: ['GET', '/api/oms/pvt/orders'],
  vtex_get_order: ['GET', '/api/oms/pvt/orders/{order_id}'],
  vtex_get_order_group: ['GET', '/api/oms/pvt/orders/order-group/{order_group}'],
  vtex_start_handling_order: ['POST', '/api/oms/pvt/orders/{order_id}/start-handling'],
  vtex_add_order_interaction: ['POST', '/api/oms/pvt/orders/{order_id}/interactions'],
  vtex_get_order_conversation: ['GET', '/api/oms/pvt/orders/{order_id}/conversation-message'],
  vtex_get_payment_transaction: ['GET', '/api/oms/pvt/orders/{order_id}/payment-transaction'],
  vtex_update_tracking_status: ['PUT', '/api/oms/pvt/orders/{order_id}/invoice/{invoice_number}/tracking'],
  vtex_cancel_order: ['POST', '/api/oms/pvt/orders/{order_id}/cancel'],
  vtex_invoice_order: ['POST', '/api/oms/pvt/orders/{order_id}/invoice'],
  vtex_update_invoice_tracking: ['PATCH', '/api/oms/pvt/orders/{order_id}/invoice/{invoice_number}'],
  vtex_list_product_and_sku_ids: ['GET', '/api/catalog_system/pvt/products/GetProductAndSkuIds'],
  vtex_get_product: ['GET', '/api/catalog/pvt/product/{product_id}'],
  vtex_get_product_by_ref_id: ['GET', '/api/catalog_system/pvt/products/productgetbyrefid/{ref_id}'],
  vtex_list_product_skus: ['GET', '/api/catalog_system/pvt/sku/stockkeepingunitByProductId/{product_id}'],
  vtex_get_sku: ['GET', '/api/catalog_system/pvt/sku/stockkeepingunitbyid/{sku_id}'],
  vtex_get_sku_by_ref_id: ['GET', '/api/catalog/pvt/stockkeepingunit'],
  vtex_get_sku_by_ean: ['GET', '/api/catalog_system/pvt/sku/stockkeepingunitbyean/{ean}'],
  vtex_search_products: ['GET', '/api/catalog_system/pub/products/search'],
  vtex_get_category_tree: ['GET', '/api/catalog_system/pub/category/tree/{levels}'],
  vtex_list_brands: ['GET', '/api/catalog_system/pvt/brand/list'],
  vtex_get_price: ['GET', 'https://api.vtex.com/{{VTEX_ACCOUNT_NAME}}/pricing/prices/{sku_id}'],
  vtex_get_computed_price: ['GET', 'https://api.vtex.com/{{VTEX_ACCOUNT_NAME}}/pricing/prices/{sku_id}/computed/{price_table_id}'],
  vtex_list_price_tables: ['GET', 'https://api.vtex.com/{{VTEX_ACCOUNT_NAME}}/pricing/tables'],
  vtex_update_price: ['PUT', 'https://api.vtex.com/{{VTEX_ACCOUNT_NAME}}/pricing/prices/{sku_id}'],
  vtex_get_sku_inventory: ['GET', '/api/logistics/pvt/inventory/skus/{sku_id}'],
  vtex_update_sku_inventory: ['PUT', '/api/logistics/pvt/inventory/skus/{sku_id}/warehouses/{warehouse_id}'],
  vtex_list_warehouses: ['GET', '/api/logistics/pvt/configuration/warehouses'],
  vtex_list_docks: ['GET', '/api/logistics/pvt/configuration/docks'],
  vtex_list_shipping_policies: ['GET', '/api/logistics/pvt/shipping-policies'],
  vtex_search_customers: ['GET', '/api/dataentities/CL/search'],
  vtex_get_customer: ['GET', '/api/dataentities/CL/documents/{customer_id}'],
  vtex_update_customer: ['PATCH', '/api/dataentities/CL/documents/{customer_id}'],
  vtex_search_documents: ['GET', '/api/dataentities/{acronym}/search'],
};

describe('vtex adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('puts account and environment in the host and sends the app key and token headers', () => {
    expect(a.slug).toBe('vtex');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('vtex');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://{{VTEX_ACCOUNT_NAME}}.{{VTEX_ENVIRONMENT}}.com.br');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'X-VTEX-API-AppKey',
      apiKey: '{{VTEX_APP_KEY}}',
      extraHeaders: { 'X-VTEX-API-AppToken': '{{VTEX_APP_TOKEN}}' },
    });
    expect(a.requiredEnvVars).toEqual(['VTEX_ACCOUNT_NAME', 'VTEX_ENVIRONMENT', 'VTEX_APP_KEY', 'VTEX_APP_TOKEN']);
    expect(a.envVarMeta.VTEX_ENVIRONMENT.options?.map((o) => o.value)).toEqual(['vtexcommercestable', 'vtexcommercebeta']);
    expect(a.envVarMeta.VTEX_APP_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    for (const name of ['VTEX_ACCOUNT_NAME', 'VTEX_APP_KEY', 'VTEX_APP_TOKEN']) {
      const pattern = new RegExp(a.envVarMeta[name].pattern!);
      expect([name, pattern.test(ENV[name])]).toEqual([name, true]);
      for (const bad of ['', 'has space here', 'https://mystore.myvtex.com']) expect([name, bad, pattern.test(bad)]).toEqual([name, bad, false]);
    }
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const entry of a.tools) {
      const [method, path] = EXPECTED[entry.name];
      expect([entry.name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([entry.name, method, path]);
    }
  });

  it('probes one order page and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'vtex_list_orders', params: { per_page: 1 } });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^vtex_[a-z0-9_]+$/);
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

  it('marks reads read-only and installs cancel, invoice and invoice tracking switched off', () => {
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, entry.endpointMapping.method === 'GET']);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['vtex_cancel_order', 'vtex_invoice_order', 'vtex_update_invoice_tracking']);
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

  it('lists orders on the account host with both credential headers', async () => {
    ok({ list: [], paging: { total: 0 } });
    await call('vtex_list_orders', { f_status: 'ready-for-handling', per_page: 100 });
    const req = sent();
    expect(req.url).toBe(`${BASE}/api/oms/pvt/orders`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'X-VTEX-API-AppKey')).toBe(ENV.VTEX_APP_KEY);
    expect(header(req, 'X-VTEX-API-AppToken')).toBe(ENV.VTEX_APP_TOKEN);
    expect(req.params).toEqual({ f_status: 'ready-for-handling', page: 1, per_page: 100 });
  });

  it('reads and writes prices on api.vtex.com with the same credentials', async () => {
    ok({ itemId: '1' });
    await call('vtex_get_price', { sku_id: '2001773' });
    expect(sent().url).toBe(`${PRICING}/prices/2001773`);
    expect(header(sent(), 'X-VTEX-API-AppToken')).toBe(ENV.VTEX_APP_TOKEN);

    ok({}, 204);
    await call('vtex_update_price', { sku_id: '2001773', base_price: 49.9, list_price: 59.9 });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${PRICING}/prices/2001773`);
    expect(sent().data).toEqual({ basePrice: 49.9, listPrice: 59.9 });
  });

  it('builds the order, inventory and customer write bodies as VTEX documents them', async () => {
    ok({}, 204);
    await call('vtex_start_handling_order', { order_id: '1172452900788-01' });
    expect(sent().url).toBe(`${BASE}/api/oms/pvt/orders/1172452900788-01/start-handling`);

    ok({});
    await call('vtex_cancel_order', { order_id: '1172452900788-01', reason: 'Unexpected stock shortage' });
    expect(sent().data).toEqual({ reason: 'Unexpected stock shortage' });

    ok({});
    await call('vtex_update_tracking_status', {
      order_id: '1172452900788-01',
      invoice_number: '000030711',
      is_delivered: false,
      events: [{ city: 'Rio de Janeiro', state: 'RJ', description: 'Collected', date: '2026-06-23' }],
    });
    expect(sent().url).toBe(`${BASE}/api/oms/pvt/orders/1172452900788-01/invoice/000030711/tracking`);
    expect(sent().data).toEqual({ isDelivered: false, events: [{ city: 'Rio de Janeiro', state: 'RJ', description: 'Collected', date: '2026-06-23' }] });

    ok({});
    await call('vtex_update_sku_inventory', { sku_id: '25', warehouse_id: 'store-warehouse', quantity: 202 });
    expect(sent().url).toBe(`${BASE}/api/logistics/pvt/inventory/skus/25/warehouses/store-warehouse`);
    expect(sent().data).toEqual({ quantity: 202, unlimitedQuantity: false, leadTime: '00.00:00:00' });

    ok({});
    await call('vtex_update_customer', { customer_id: 'b818cbda-e489-11e6-94f4-0ac138d2d42e', fields: { phone: '+12025550195' } });
    expect(String(sent().method).toUpperCase()).toBe('PATCH');
    expect(sent().data).toEqual({ phone: '+12025550195' });
  });

  it('pages Master Data searches with the REST-Range header', async () => {
    ok([]);
    await call('vtex_search_customers', { email: 'clark.kent@example.com' });
    expect(sent().url).toBe(`${BASE}/api/dataentities/CL/search`);
    expect(header(sent(), 'REST-Range')).toBe('resources=0-50');
    expect(sent().params).toMatchObject({ email: 'clark.kent@example.com' });

    ok([]);
    await call('vtex_search_documents', { acronym: 'AD', where: 'userId=abc', range_start: 100, range_end: 200 });
    expect(sent().url).toBe(`${BASE}/api/dataentities/AD/search`);
    expect(header(sent(), 'REST-Range')).toBe('resources=100-200');
    expect(sent().params).toEqual({ _where: 'userId=abc', _fields: '_all' });
  });
});

// Opt-in: RUN_VTEX_LIVE=1. The refusal check needs only VTEX_ACCOUNT_NAME; the
// reads need VTEX_APP_KEY and VTEX_APP_TOKEN. Nothing is written.
const live = process.env.RUN_VTEX_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('vtex: live', () => {
  const account = process.env.VTEX_ACCOUNT_NAME;
  const host = `https://${account}.vtexcommercestable.com.br`;

  it('refuses a wrong key', async () => {
    if (!account) throw new Error('Set VTEX_ACCOUNT_NAME for the live check');
    const response = await liveFetch.get(`${host}/api/oms/pvt/orders`, {
      headers: { 'X-VTEX-API-AppKey': 'vtexappkey-wrong-XXXXXX', 'X-VTEX-API-AppToken': 'NOTAREALTOKEN0123456789' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads one order page and the warehouses', async () => {
    const key = process.env.VTEX_APP_KEY;
    const token = process.env.VTEX_APP_TOKEN;
    if (!account || !key || !token) throw new Error('Set VTEX_ACCOUNT_NAME, VTEX_APP_KEY and VTEX_APP_TOKEN');
    const headers = { 'X-VTEX-API-AppKey': key, 'X-VTEX-API-AppToken': token, Accept: 'application/json' };
    const orders = await liveFetch.get(`${host}/api/oms/pvt/orders`, { headers, params: { per_page: 1 }, validateStatus: () => true });
    expect(orders.status).toBe(200);
    expect(Array.isArray(orders.data.list)).toBe(true);
    const warehouses = await liveFetch.get(`${host}/api/logistics/pvt/configuration/warehouses`, { headers, validateStatus: () => true });
    expect(warehouses.status).toBe(200);
  });
});
