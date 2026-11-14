import axios from 'axios';
import * as adapter from './epicentr.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Epicentr K Merchant API adapter.
 *
 * Static checks always run: the mp_ key as a Bearer token, every tool's
 * method and path against the operations of Epicentr's published OpenAPI 3.0
 * document (https://merchant-api.epicentrm.com.ua/swagger/swagger.yaml, saved
 * 2026-11-14 and listed below, path parameters normalised to {}), the
 * bracketed filter parameters of the order list, the write bodies, and which
 * tools install switched off. Payment links and payment settings are left
 * out; deprecated operations are not used.
 * https://merchant-api.epicentrm.com.ua/swagger/index.html
 *
 * Live checks run only with RUN_EPICENTR_LIVE=1. Without a key they confirm
 * the API refuses a wrong one; with EPICENTR_API_KEY they read the delivery
 * providers, one page of orders and the category tree. Reads only.
 *
 *   RUN_EPICENTR_LIVE=1 EPICENTR_API_KEY=mp_... npx jest src/adapters/intl/epicentr.live.spec.ts
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
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
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
const norm = (path: string) => path.replace(/\{[^}]+\}/g, '{}');

/** Current (not deprecated) operations of Epicentr's OpenAPI document (2026-11-14), path parameters as {}. */
const SPEC_OPERATIONS = [
  'POST /v1/offers',
  'GET /v1/offers/update-results/{}',
  'GET /v1/deliveries/shipment-providers',
  'GET /v3/deliveries/providers/{}/settlements',
  'GET /v3/deliveries/providers/{}/settlements/{}',
  'GET /v3/deliveries/providers/{}/settlements/{}/offices',
  'GET /v3/deliveries/providers/{}/settlements/{}/offices/{}',
  'GET /v3/deliveries/{}/invoices/{}',
  'GET /v2/deliveries/pickup-points/enabled',
  'DELETE /v1/oms/orders/{}/shipment-number',
  'PATCH /v1/oms/orders/{}/shipment-number',
  'PATCH /v1/oms/orders/{}/invoice-client-data',
  'POST /v2/oms/orders/{}/comments',
  'GET /v2/oms/orders/{}/comments',
  'GET /v2/oms/orders/{}/allowed-statuses',
  'POST /v2/oms/orders/{}/change-status/to/{}',
  'DELETE /v2/oms/orders/{}/items/{}',
  'GET /v2/oms/order-cancel-reasons/customer',
  'POST /v2/oms/orders/{}/payment/generate-url',
  'POST /v2/oms/orders/{}/call-status',
  'POST /v3/oms/orders/{}/client-data',
  'PUT /v3/oms/orders/{}/items/{}',
  'POST /v3/oms/orders/{}/items',
  'POST /v3/oms/orders/{}/shipping/{}',
  'POST /v3/orders/{}/comments',
  'GET /v4/oms/orders',
  'GET /v4/oms/orders/total',
  'POST /v4/oms/orders/{}/delivery-data/{}',
  'GET /v6/oms/orders/{}',
  'GET /v3/payments/payment-providers',
  'GET /v2/pim/attribute-sets',
  'GET /v2/pim/attribute-sets/{}/attributes/{}/options',
  'GET /v2/pim/categories',
  'GET /v1/billing/orders/{}/invoice',
];

/** Order statuses of the spec (enum of the change-status path parameter). */
const ORDER_STATUSES = [
  'new', 'confirmed_by_merchant', 'confirmed', 'sent', 'delivered', 'completed', 'closed', 'canceled',
  'returned', 'return_requested', 'canceled_by_merchant', 'completed_merchant_rejection', 'closed_merchant_rejection',
];

const ENV: Record<string, string> = { EPICENTR_API_KEY: `mp_${'6aa7deadcbba727e'.repeat(4)}` };
const ORDER = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const OFFER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

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
const ok = (status = 200) => mockedAxios.mockResolvedValueOnce({ status, data: {}, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const query = (req: { params?: Record<string, unknown>; paramsSerializer?: unknown }) =>
  typeof req.paramsSerializer === 'function'
    ? decodeURIComponent((req.paramsSerializer as (p: unknown) => string)(req.params ?? {}))
    : '';

describe('epicentr adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the mp_ key as a Bearer token to merchant-api', () => {
    expect(a.slug).toBe('epicentr');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('epicentr');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://merchant-api.epicentrm.com.ua');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{EPICENTR_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['EPICENTR_API_KEY']);
    expect(a.envVarMeta.EPICENTR_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta.EPICENTR_API_KEY.pattern!);
    expect(pattern.test(ENV.EPICENTR_API_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${ENV.EPICENTR_API_KEY}`, '6aa7deadcbba727e6aa7deadcbba727e', 'mp_short']) {
      expect(pattern.test(bad)).toBe(false);
    }
  });

  it('puts Authorization: Bearer mp_... on the call', async () => {
    ok();
    await call('epicentr_list_delivery_providers', {});
    const req = sent();
    expect(req.url).toBe('https://merchant-api.epicentrm.com.ua/v1/deliveries/shipment-providers');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.EPICENTR_API_KEY}`);
  });

  it('probes the delivery providers and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'epicentr_list_delivery_providers', params: {} });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to a current operation of the published Epicentr spec', () => {
    const spec = new Set(SPEC_OPERATIONS);
    for (const entry of a.tools) {
      expect(spec.has(`${entry.endpointMapping.method} ${norm(entry.endpointMapping.path)}`)).toBe(true);
    }
    const paths = a.tools.map((entry) => entry.endpointMapping.path);
    expect(paths.some((p) => p.includes('/payment'))).toBe(false);
    expect(paths.some((p) => p.includes('/payments/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('/v3/oms/orders') && !p.includes('{'))).toBe(false);
  });

  it('only sends order statuses the spec defines, cancellations through the switched-off tool', () => {
    const normal = tool('epicentr_change_order_status').parameters.properties!.status.enum as string[];
    const cancel = tool('epicentr_cancel_order').parameters.properties!.status.enum as string[];
    for (const value of [...normal, ...cancel]) expect(ORDER_STATUSES).toContain(value);
    for (const value of normal) expect(value).not.toMatch(/cancel|return|rejection/);
    expect(cancel).toEqual(expect.arrayContaining(['canceled_by_merchant', 'returned']));
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^epicentr_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('marks reads read-only and installs cancel, deletes and shipment creation switched off', () => {
    for (const entry of a.tools) {
      expect(annotationsOf(entry).readOnlyHint).toBe(entry.endpointMapping.method === 'GET');
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([
      'epicentr_cancel_order',
      'epicentr_create_shipment',
      'epicentr_delete_order_item',
      'epicentr_delete_shipment_number',
    ]);
    for (const entry of a.tools) {
      if (entry.endpointMapping.method === 'DELETE') expect(entry.enabled).toBe(false);
    }
  });

  it('names every tool in the instructions', () => {
    expect(a.instructions.startsWith('## Epicentr K')).toBe(true);
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions).toContain('mp-api.epicentrm.com.ua');
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists orders with the bracketed v4 filters and cursor', async () => {
    ok();
    await call('epicentr_list_orders', { status_codes: ['new', 'confirmed_by_merchant'], updated_from: '2026-11-01T00:00:00Z' });
    const req = sent();
    expect(req.url).toBe('https://merchant-api.epicentrm.com.ua/v4/oms/orders');
    expect(req.params).toEqual({
      'filter[statusCode][]': ['new', 'confirmed_by_merchant'],
      'filter[updatedAt][from]': '2026-11-01T00:00:00Z',
      'sort[]': ['-createdAt'],
      limit: 25,
    });
    expect(query(req)).toBe(
      'filter[statusCode][]=new&filter[statusCode][]=confirmed_by_merchant&filter[updatedAt][from]=2026-11-01T00:00:00Z&sort[]=-createdAt&limit=25',
    );

    ok();
    await call('epicentr_count_orders', { status_codes: ['new'] });
    expect(sent().url).toBe('https://merchant-api.epicentrm.com.ua/v4/oms/orders/total');
    expect(sent().params).toEqual({ 'filter[statusCode][]': ['new'] });

    ok();
    await call('epicentr_get_order', { order_id: ORDER });
    expect(sent().url).toBe(`https://merchant-api.epicentrm.com.ua/v6/oms/orders/${ORDER}`);
  });

  it('reads delivery directories with language and paging', async () => {
    ok();
    await call('epicentr_list_settlements', { delivery_provider: 'nova_poshta', title: 'Київ' });
    const req = sent();
    expect(req.url).toBe('https://merchant-api.epicentrm.com.ua/v3/deliveries/providers/nova_poshta/settlements');
    expect(req.params).toEqual({ 'filter[title]': 'Київ', offset: 0, limit: 25 });
    expect(header(req, 'accept-language')).toBe('uk');

    ok();
    await call('epicentr_list_offices', { delivery_provider: 'nova_poshta', settlement_id: ORDER });
    expect(sent().url).toBe(`https://merchant-api.epicentrm.com.ua/v3/deliveries/providers/nova_poshta/settlements/${ORDER}/offices`);
    expect(sent().params).toEqual({ 'filter[isActive]': 1, offset: 0, limit: 25 });

    ok();
    await call('epicentr_list_attribute_sets', { codes: ['abc', 'def'] });
    expect(query(sent())).toBe('filter[codes][]=abc&filter[codes][]=def&page=1');
  });

  it('builds the order write bodies as the spec documents them', async () => {
    ok(202);
    await call('epicentr_change_order_status', { order_id: ORDER, status: 'confirmed_by_merchant' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`https://merchant-api.epicentrm.com.ua/v2/oms/orders/${ORDER}/change-status/to/confirmed_by_merchant`);

    ok(202);
    await call('epicentr_cancel_order', {
      order_id: ORDER,
      reason_code: 'merchant_product_is_not_available',
      translation_key: 'order.merchant_cancel_reason.merchant_product_is_not_available',
    });
    expect(sent().url).toBe(`https://merchant-api.epicentrm.com.ua/v2/oms/orders/${ORDER}/change-status/to/canceled_by_merchant`);
    expect(sent().data).toEqual({
      reason_code: 'merchant_product_is_not_available',
      translationKey: 'order.merchant_cancel_reason.merchant_product_is_not_available',
    });

    ok(202);
    await call('epicentr_set_shipment_number', { order_id: ORDER, number: '20451234567891' });
    expect(String(sent().method).toUpperCase()).toBe('PATCH');
    expect(sent().url).toBe(`https://merchant-api.epicentrm.com.ua/v1/oms/orders/${ORDER}/shipment-number`);
    expect(sent().data).toEqual({ number: '20451234567891' });

    ok(201);
    await call('epicentr_add_order_comment', { order_id: ORDER, content: 'Відправлено' });
    expect(sent().url).toBe(`https://merchant-api.epicentrm.com.ua/v3/orders/${ORDER}/comments`);
    expect(sent().data).toEqual({ content: 'Відправлено' });

    ok(202);
    await call('epicentr_update_delivery_data', {
      order_id: ORDER,
      delivery_provider: 'nova_poshta',
      settlement_id: OFFER,
      office_id: OFFER,
      payment_provider: 'pay_on_delivery',
    });
    expect(sent().url).toBe(`https://merchant-api.epicentrm.com.ua/v4/oms/orders/${ORDER}/delivery-data/nova_poshta`);
    expect(sent().data).toEqual({ settlementId: OFFER, officeId: OFFER, paymentProvider: 'pay_on_delivery' });

    ok();
    await call('epicentr_update_order_item', { order_id: ORDER, offer_id: OFFER, quantity: 2 });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`https://merchant-api.epicentrm.com.ua/v3/oms/orders/${ORDER}/items/${OFFER}`);
    expect(sent().data).toEqual({ quantity: 2 });

    ok();
    await call('epicentr_update_client_data', {
      order_id: ORDER,
      first_name: 'Іван',
      last_name: 'Петренко',
      email: 'buyer@example.org',
      phone: '+380501234567',
      recipient: { firstName: 'Іван', lastName: 'Петренко', phone: '+380501234567' },
    });
    expect(sent().url).toBe(`https://merchant-api.epicentrm.com.ua/v3/oms/orders/${ORDER}/client-data`);
    expect(sent().data).toEqual({
      firstName: 'Іван',
      lastName: 'Петренко',
      email: 'buyer@example.org',
      phone: '+380501234567',
      recipient: { firstName: 'Іван', lastName: 'Петренко', phone: '+380501234567' },
    });
  });

  it('sends the offer batch and the shipment body unchanged', async () => {
    ok(201);
    const items = [{ sku: 'sku-1', availability: 'in_stock', prices: { price: 1299.99, oldPrice: 1499.99 } }];
    await call('epicentr_update_offers', { items });
    expect(sent().url).toBe('https://merchant-api.epicentrm.com.ua/v1/offers');
    expect(sent().data).toEqual({ items });

    ok(201);
    const sender = { name: 'Іван', lastName: 'Петренко', phone: '+380501234567', settlementId: OFFER, officeId: OFFER, provider: 'nova_poshta' };
    await call('epicentr_create_shipment', {
      order_id: ORDER,
      delivery_provider: 'nova_poshta',
      sender,
      parcels: [{ width: 30, height: 20, length: 40, weight: 2 }],
      delivery_payer: 'client',
      is_post_payment: false,
    });
    expect(sent().url).toBe(`https://merchant-api.epicentrm.com.ua/v3/oms/orders/${ORDER}/shipping/nova_poshta`);
    expect(sent().data).toEqual({
      sender,
      items: [{ width: 30, height: 20, length: 40, weight: 2 }],
      deliveryPayer: 'client',
      isPostPayment: false,
    });
  });
});

// Opt-in: RUN_EPICENTR_LIVE=1. The refusal check needs no account; the reads
// need EPICENTR_API_KEY. Nothing is written.
const live = process.env.RUN_EPICENTR_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Epicentr Merchant API: live', () => {
  it('refuses a wrong key', async () => {
    const response = await liveFetch.get('https://merchant-api.epicentrm.com.ua/v1/deliveries/shipment-providers', {
      headers: { Authorization: `Bearer mp_${'0'.repeat(32)}`, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads delivery providers, one page of orders and the category tree', async () => {
    const key = process.env.EPICENTR_API_KEY;
    if (!key) throw new Error('Set EPICENTR_API_KEY for the live check');
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    const base = 'https://merchant-api.epicentrm.com.ua';
    const providers = await liveFetch.get(`${base}/v1/deliveries/shipment-providers`, { headers, validateStatus: () => true });
    expect(providers.status).toBe(200);
    const orders = await liveFetch.get(`${base}/v4/oms/orders`, { headers, params: { limit: 5 }, validateStatus: () => true });
    expect(orders.status).toBe(200);
    expect(Array.isArray(orders.data.items)).toBe(true);
    const categories = await liveFetch.get(`${base}/v2/pim/categories`, { headers, params: { page: 1 }, validateStatus: () => true });
    expect(categories.status).toBe(200);
  });
});
