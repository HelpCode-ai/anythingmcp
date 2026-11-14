import axios from 'axios';
import * as adapter from './about-you.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * ABOUT YOU Seller Center API adapter (v1).
 *
 * Static checks always run: the API key in the X-API-Key header, every tool's
 * method and path against ABOUT YOU's published OpenAPI file
 * (https://partner.aboutyou.com/api/v1/openapi.json; the paths there, not the
 * ones of the rate-limit table), the write bodies, the repeated query
 * parameters, and which tools install switched off (cancel, return, status
 * changes that take products offline, delete).
 * https://docs.partner.aboutyou.com/api/getting-started
 *
 * Live checks run only with RUN_ABOUT_YOU_LIVE=1. Without a key they confirm
 * the API refuses a wrong one; with ABOUT_YOU_API_KEY (a sandbox key is fine)
 * they read countries and one page of orders. Reads only.
 *
 *   RUN_ABOUT_YOU_LIVE=1 ABOUT_YOU_API_KEY=... \
 *     npx jest src/adapters/intl/about-you.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    bodyEncoding?: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
type EnvMeta = {
  label?: string;
  pattern?: string;
  patternMessage?: string;
  kind?: string;
  secret?: boolean;
  link?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
};
type Adapter = {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, EnvMeta>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  prerequisites: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const a = adapter as unknown as Adapter;
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
// The website renders descriptions and instructions as MDX: braces and angle
// brackets are only safe inside backticks.
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

const BASE = 'https://partner.aboutyou.com/api/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['ay', 'k'.repeat(30), '42'].join('_');
const ENV: Record<string, string> = { ABOUT_YOU_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
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
const ok = (status = 200, data: unknown = {}) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const method = () => String(sent().method).toUpperCase();

// Every tool with its HTTP method and path, as documented by the vendor.
const ROUTES: Record<string, string> = {
  about_you_list_orders: 'GET /orders/',
  about_you_list_carriers: 'GET /orders/carriers/',
  about_you_ship_order_items: 'POST /orders/ship',
  about_you_cancel_order_items: 'POST /orders/cancel',
  about_you_return_order_items: 'POST /orders/return',
  about_you_get_order_invoices: 'GET /orders/{order_number}/invoices',
  about_you_get_delivery_document: 'GET /orders/{order_number}/delivery_document',
  about_you_list_products: 'GET /products/',
  about_you_list_rejected_products: 'GET /products/rejected',
  about_you_upsert_products: 'POST /products/',
  about_you_publish_product: 'PUT /products/status',
  about_you_update_product_status: 'PUT /products/status',
  about_you_update_stock: 'PUT /products/stocks',
  about_you_update_prices: 'PUT /products/prices',
  about_you_delete_product: 'DELETE /products/{sku}',
  about_you_list_categories: 'GET /categories/',
  about_you_list_category_attribute_groups: 'GET /categories/{category_id}/attribute-groups',
  about_you_list_brands: 'GET /brands/',
  about_you_list_countries: 'GET /countries/',
  about_you_get_batch_result: 'GET /results/{result_type}',
  about_you_list_reports: 'GET /reports/',
  about_you_download_report: 'GET /reports/{report_id}/download',
  about_you_list_webhooks: 'GET /webhooks/',
};
const SWITCHED_OFF = [
  'about_you_cancel_order_items',
  'about_you_return_order_items',
  'about_you_update_product_status',
  'about_you_delete_product',
];

describe('about-you adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the API key in X-API-Key against partner.aboutyou.com/api/v1', async () => {
    expect(a.slug).toBe('about-you');
    expect(a.name).toBe('ABOUT YOU');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('about-you');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-Key', apiKey: '{{ABOUT_YOU_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['ABOUT_YOU_API_KEY']);
    expect(a.envVarMeta.ABOUT_YOU_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.ABOUT_YOU_API_KEY.link).toMatch(/^https:\/\/docs\.partner\.aboutyou\.com\//);
    const pattern = new RegExp(a.envVarMeta.ABOUT_YOU_API_KEY.pattern!);
    expect(pattern.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', 'short', 'X-API-Key: abcdefghijklmnopqrstuvwxyz']) expect(pattern.test(bad)).toBe(false);

    ok();
    await call('about_you_list_countries', {});
    expect(sent().url).toBe(`${BASE}/countries/`);
    expect(method()).toBe('GET');
    expect(header(sent(), 'X-API-Key')).toBe(FAKE_KEY);
    expect(header(sent(), 'Authorization')).toBeUndefined();
    expect(header(sent(), 'Accept')).toBe('application/json');
  });

  it('probes the country list and explains 400, 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'about_you_list_countries', params: {} });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to the documented method and path', () => {
    const actual = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(actual).toEqual(ROUTES);
    expect(a.tools).toHaveLength(23);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^about_you_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      const reads = used(entry);
      for (const arg of reads) expect(`${entry.name}:${arg}:${declared.has(arg) || envNames.has(arg)}`).toBe(`${entry.name}:${arg}:true`);
      for (const arg of declared) expect(`${entry.name}:${arg}:${reads.has(arg)}`).toBe(`${entry.name}:${arg}:true`);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(80);
      for (const [name, prop] of Object.entries(entry.parameters.properties ?? {})) {
        expect(`${entry.name}.${name}: ${prop.description ?? ''}`.length).toBeGreaterThan(entry.name.length + name.length + 12);
      }
    }
  });

  it('keeps braces and angle brackets inside backticks and uses no em dash', () => {
    const texts = [a.description, a.instructions, a.prerequisites, ...a.tools.map((entry) => entry.description)];
    for (const text of texts) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/—/);
    }
  });

  it('marks reads read-only and installs cancel, return, status changes and delete switched off', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET';
      expect(`${entry.name}:${annotationsOf(entry).readOnlyHint}`).toBe(`${entry.name}:${read}`);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([...SWITCHED_OFF].sort());
    for (const entry of a.tools) {
      const { method: verb, path } = entry.endpointMapping;
      if (/\/orders\/(cancel|return)$/.test(path) || verb === 'DELETE') expect(entry.enabled).toBe(false);
      // Webhooks are read only: no subscription is created, changed or removed.
      if (path.startsWith('/webhooks')) expect(verb).toBe('GET');
    }
    // Publishing one style stays on; the tool that can set inactive or draft is off.
    expect(tool('about_you_publish_product').enabled).not.toBe(false);
    expect(tool('about_you_publish_product').endpointMapping.bodyMapping).toEqual({ items: [{ style_key: '$style_key', status: 'published' }] });
    expect(tool('about_you_update_product_status').enabled).toBe(false);
  });

  it('names every tool and the setup facts in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.startsWith('## ABOUT YOU\n')).toBe(true);
    expect(a.instructions.length).toBeGreaterThanOrEqual(1500);
    for (const fact of ['Admin', 'API Keys', '+ Add', 'X-API-Key', 'Sandbox', 'batchRequestId', '7 days', 'next_cursor', 'dropshipping', 'fulfillment_by_marketplace', 'X-RateLimit-Remaining']) {
      expect(a.instructions).toContain(fact);
    }
  });

  it('lists orders with repeated order numbers and the default page size', async () => {
    ok();
    await call('about_you_list_orders', { order_status: 'open', order_numbers: ['AY-1001', 'AY-1002'] });
    expect(sent().url).toBe(`${BASE}/orders/`);
    expect(method()).toBe('GET');
    expect(sent().params).toEqual({ order_number: ['AY-1001', 'AY-1002'], order_status: 'open', per_page: 20 });
    expect(sent().paramsSerializer(sent().params)).toContain('order_number=AY-1001&order_number=AY-1002');

    ok();
    await call('about_you_list_orders', { cursor: 'b3BhcXVl', per_page: 100, fulfillment_type: 'dropshipping' });
    expect(sent().params).toEqual({ cursor: 'b3BhcXVl', per_page: 100, fulfillment_type: 'dropshipping' });
  });

  it('reads products, categories, batch results and documents on the OpenAPI paths', async () => {
    ok();
    await call('about_you_list_products', { skus: ['MY-SKU-1'], status: 'active', with: 'problems' });
    expect(sent().url).toBe(`${BASE}/products/`);
    expect(sent().params).toEqual({ sku: ['MY-SKU-1'], status: 'active', with: 'problems', per_page: 20 });

    ok();
    await call('about_you_list_category_attribute_groups', { category_id: 20201, with: 'optional' });
    expect(sent().url).toBe(`${BASE}/categories/20201/attribute-groups`);
    expect(sent().params).toEqual({ with: 'optional' });

    ok();
    await call('about_you_list_categories', { query: 'Sneaker' });
    expect(sent().url).toBe(`${BASE}/categories/`);
    expect(sent().params).toEqual({ query: 'Sneaker', page: 1, per_page: 20 });

    ok();
    await call('about_you_get_batch_result', { result_type: 'ship-orders', batch_request_id: '123e4567-e89b-12d3-a456-426614174000' });
    expect(sent().url).toBe(`${BASE}/results/ship-orders`);
    expect(sent().params).toEqual({ batch_request_id: '123e4567-e89b-12d3-a456-426614174000' });
    expect(tool('about_you_get_batch_result').parameters.properties!.result_type.enum).toEqual([
      'products',
      'status',
      'stocks',
      'prices',
      'ship-orders',
      'cancel-orders',
      'return-orders',
    ]);

    ok();
    await call('about_you_get_order_invoices', { order_number: 'AY-1001' });
    expect(sent().url).toBe(`${BASE}/orders/AY-1001/invoices`);
    expect(sent().params).toEqual({});

    ok();
    await call('about_you_get_delivery_document', { order_number: 'AY-1001' });
    expect(sent().url).toBe(`${BASE}/orders/AY-1001/delivery_document`);

    ok();
    await call('about_you_download_report', { report_id: 77 });
    expect(sent().url).toBe(`${BASE}/reports/77/download`);
  });

  it('builds the ship, stock, price and publish bodies as the OpenAPI file documents them', async () => {
    const shipment = { order_items: [1234567], carrier_key: 'DHL_STD_NATIONAL', shipment_tracking_key: '00340434161094042557', return_tracking_key: '00340434161094042564' };
    ok();
    await call('about_you_ship_order_items', { items: [shipment] });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/orders/ship`);
    expect(sent().data).toEqual({ items: [shipment] });

    ok();
    await call('about_you_update_stock', { items: [{ sku: 'MY-SKU-2', quantity: 0 }] });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/products/stocks`);
    expect(sent().data).toEqual({ items: [{ sku: 'MY-SKU-2', quantity: 0 }] });

    const price = { sku: 'MY-SKU-2', price: { country_code: 'DE', currency: 'EUR', retail_price: 49.99, sale_price: 39.99 } };
    ok();
    await call('about_you_update_prices', { items: [price] });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/products/prices`);
    expect(sent().data).toEqual({ items: [price] });

    ok();
    await call('about_you_publish_product', { style_key: 'EDT1110-5' });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/products/status`);
    expect(sent().data).toEqual({ items: [{ style_key: 'EDT1110-5', status: 'published' }] });
  });

  it('builds the switched-off cancel, return and delete requests', async () => {
    ok();
    await call('about_you_cancel_order_items', { items: [{ id: 1234567 }] });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/orders/cancel`);
    expect(sent().data).toEqual({ items: [{ id: 1234567 }] });

    ok();
    await call('about_you_return_order_items', { items: [{ order_items: [1234567], return_tracking_key: 'RT-1' }] });
    expect(sent().url).toBe(`${BASE}/orders/return`);
    expect(sent().data).toEqual({ items: [{ order_items: [1234567], return_tracking_key: 'RT-1' }] });

    ok();
    await call('about_you_delete_product', { sku: 'MY SKU/2' });
    expect(method()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/products/MY%20SKU%2F2`);
  });
});

// Opt-in: RUN_ABOUT_YOU_LIVE=1. The refusal check needs no account; the reads
// need ABOUT_YOU_API_KEY (production or sandbox). Nothing is written.
const live = process.env.RUN_ABOUT_YOU_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('ABOUT YOU: live', () => {
  it('refuses a wrong API key', async () => {
    const response = await liveFetch.get(`${BASE}/countries/`, {
      headers: { 'X-API-Key': 'not-a-real-key', Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads the countries and one page of orders', async () => {
    const key = process.env.ABOUT_YOU_API_KEY;
    if (!key) throw new Error('Set ABOUT_YOU_API_KEY for the live check');
    const headers = { 'X-API-Key': key, Accept: 'application/json' };
    const countries = await liveFetch.get(`${BASE}/countries/`, { headers, validateStatus: () => true });
    expect(countries.status).toBe(200);
    expect(Array.isArray(countries.data.countries)).toBe(true);
    const orders = await liveFetch.get(`${BASE}/orders/`, { headers, params: { per_page: 1 }, validateStatus: () => true });
    expect(orders.status).toBe(200);
    expect(Array.isArray(orders.data.items)).toBe(true);
    expect(orders.data.pagination).toBeDefined();
  });
});
