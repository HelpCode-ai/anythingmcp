import axios from 'axios';
import FormData from 'form-data';
import * as adapter from './manomano.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { fetchOutbound } from '../../common/outbound-fetch.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the ManoMano Seller (Partners API) adapter:
 *
 *   1. Static: always runs. Pins the x-api-key and x-thirdparty-name headers,
 *      the seller contract id on every call (query string or body, as a
 *      number), every tool's method and URL (checked against ManoMano's
 *      published Postman documentation at manomano.dev), the bodies of the
 *      writes, and which tools write.
 *
 *   2. Live: skipped unless RUN_MANOMANO_LIVE=1 and the credentials are set.
 *      Reads only: orders, offers, invoice requests, competitiveness.
 *
 *        RUN_MANOMANO_LIVE=1 MANOMANO_API_KEY=... MANOMANO_SELLER_CONTRACT_ID=... \
 *          npx jest src/adapters/fr/manomano.live.spec.ts
 *
 *      Nothing here accepts, ships or refunds an order or changes an offer:
 *      those act on real customers and live listings.
 */

jest.mock('../../common/outbound-fetch.util', () => ({
  ...jest.requireActual('../../common/outbound-fetch.util'),
  fetchOutbound: jest.fn(),
}));
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
const mockedFetchOutbound = fetchOutbound as jest.MockedFunction<typeof fetchOutbound>;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyTemplate?: string;
    bodyEncoding?: string;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  icon: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
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

const BASE = 'https://partnersapi.manomano.com';
// Built at run time so no literal here looks like a real key.
const KEY = ['u4EAhgEx', 'MQSuUmjM', '0zxP8GIC'].join('');
const ENV = { MANOMANO_API_KEY: KEY, MANOMANO_SELLER_CONTRACT_ID: '110841' };

// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, env),
      headers: config.headers,
    },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];
const header = (cfg: { headers: Record<string, string> }, name: string) =>
  Object.entries(cfg.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const formText = (form: FormData) => form.getBuffer().toString('utf8');

const WRITES = [
  'manomano_accept_order',
  'manomano_refund_order',
  'manomano_refuse_order',
  'manomano_ship_order',
  'manomano_unfreeze_offers',
  'manomano_update_offers',
  'manomano_upload_order_document',
  'manomano_upsert_offers',
];
// Searches ManoMano exposes over POST; they change nothing.
const POST_READS = ['manomano_get_offer_competitiveness', 'manomano_list_competitiveness_changes', 'manomano_search_products_by_ean'];

describe('manomano adapter: static spec conformance', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedFetchOutbound.mockReset();
  });

  it('is unlisted until it has been run against a real seller account', () => {
    expect(a.unlisted).toBe(true);
    expect(a.name).toBe('ManoMano');
    expect(a.region).toBe('fr');
    expect(a.icon).toBe('manomano');
  });

  it('sends the key in x-api-key and identifies itself in x-thirdparty-name', async () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-api-key', apiKey: '{{MANOMANO_API_KEY}}' });
    expect(a.connector.baseUrl).toBe(BASE);
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('manomano_list_orders', {});
    expect(header(sent(), 'x-api-key')).toBe(KEY);
    expect(header(sent(), 'x-thirdparty-name')).toBe('AnythingMCP');
    expect(JSON.stringify(sent().params)).not.toContain(KEY);
    expect(sent().url).not.toContain(KEY);
  });

  it('checks the key and the contract id and keeps the key secret', () => {
    expect(a.requiredEnvVars).toEqual(['MANOMANO_API_KEY', 'MANOMANO_SELLER_CONTRACT_ID']);
    expect(a.optionalEnvVars).toBeUndefined();
    const key = new RegExp(a.envVarMeta.MANOMANO_API_KEY.pattern!);
    expect(key.test(KEY)).toBe(true);
    expect(key.test(`"${KEY}"`)).toBe(false);
    const contract = new RegExp(a.envVarMeta.MANOMANO_SELLER_CONTRACT_ID.pattern!);
    expect(contract.test('110841')).toBe(true);
    expect(contract.test('110841, 110842')).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'MANOMANO_API_KEY')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'MANOMANO_SELLER_CONTRACT_ID')!.secret).toBe(false);
  });

  it('probes with the order list and health-checks a call that needs no contract id', () => {
    expect(a.probe).toEqual({ tool: 'manomano_list_orders' });
    expect(tool('manomano_list_orders').parameters.required).toBeUndefined();
    // healthcheckPath is not interpolated, so it must not depend on {{VAR}}.
    expect(a.connector.healthcheckPath).not.toContain('{{');
    expect(a.connector.healthcheckPath.startsWith('/api/v1/products/brands?')).toBe(true);
  });

  it('prefixes every tool with manomano_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^manomano_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only (POST searches included), asks for confirmation on every write and installs the full upsert switched off', () => {
    for (const t of a.tools) {
      const reads = t.endpointMapping.method === 'GET' || POST_READS.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${reads}`);
    }
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET' && !POST_READS.includes(t.name)).map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/get a yes from the user first/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['manomano_upsert_offers']);
  });

  it('sends the seller contract id on every call, as a number in JSON bodies', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const inQuery = m.queryParams?.seller_contract_id === '{{MANOMANO_SELLER_CONTRACT_ID}}';
      const inBody = (m.bodyTemplate ?? '').includes('"seller_contract_id": {{MANOMANO_SELLER_CONTRACT_ID}}');
      expect(`${t.name}:${inQuery || inBody}`).toBe(`${t.name}:true`);
    }
  });

  it('encodes path ids, so an order reference cannot reach another route', async () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('{'))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('manomano_get_order', { order_reference: '../refunds' });
    expect(sent().url).toBe(`${BASE}/orders/v1/orders/..%2Frefunds`);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmanomano_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmanomano_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const products = [{ seller_sku: 'DO01234', quantity: 2 }];
  // [tool, args, method, path] — each checked against manomano.dev.
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['manomano_list_orders', {}, 'GET', '/orders/v1/orders'],
    ['manomano_get_order', { order_reference: 'M2022080713464' }, 'GET', '/orders/v1/orders/M2022080713464'],
    ['manomano_accept_order', { order_reference: 'M2022080713464' }, 'POST', '/orders/v1/accept-orders'],
    ['manomano_refuse_order', { order_reference: 'M2022080713464' }, 'POST', '/orders/v1/refuse-orders'],
    ['manomano_ship_order', { order_reference: 'M1', carrier: 'UPS', tracking_number: '1Z', tracking_url: 'https://ups.com/t/1Z', products }, 'POST', '/orders/v1/shippings'],
    ['manomano_refund_order', { order_reference: 'M1', products, refund_reason: 'NO_STOCK' }, 'POST', '/orders/v1/refunds'],
    ['manomano_list_offers', {}, 'GET', '/api/v1/offer-information/offers'],
    ['manomano_update_offers', { items: [{ sku: 'ABC', stock: { quantity: 3 } }] }, 'PATCH', '/api/v2/offer-information/offers'],
    ['manomano_unfreeze_offers', { skus: ['ABC'], fields: ['PRICE'] }, 'PATCH', '/api/v1/offer-information/offers-unfreeze'],
    ['manomano_upsert_offers', { offers: [{ sku: 'ABC', stock: 1, pricing: { price_vat_included: 9.9 }, shipping: {}, packaging: {} }] }, 'PUT', '/api/v1/offers'],
    ['manomano_get_offer_competitiveness', { skus: ['ABC'] }, 'POST', '/api/v1/competitiveness/offers/search'],
    ['manomano_list_competitiveness_changes', { updated_at_from: '2026-10-01T00:00:00Z', updated_at_to: '2026-10-07T00:00:00Z' }, 'POST', '/api/v1/competitiveness/offers/search'],
    ['manomano_search_products_by_ean', { products: [{ ean: '8425608304725', locale: 'es_ES' }] }, 'POST', '/product-catalog/seller-catalog/api/v1/products/ean/search'],
    ['manomano_list_fulfillment_stock', {}, 'GET', '/mano-fulfillment/catalog/v1/offers/stock'],
    ['manomano_list_invoice_requests', {}, 'GET', '/api/v1/invoice-requests'],
    ['manomano_get_order_documents', { order_reference: 'M260269216655' }, 'GET', '/api/v1/orders/M260269216655/documents'],
    ['manomano_upload_order_document', { order_reference: 'M260269216655', document_type: 'INVOICE', file_url: 'https://files.example.com/M260269216655.pdf' }, 'POST', '/api/v1/orders/M260269216655/documents'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s %s', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    mockedFetchOutbound.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: Buffer.from('%PDF-1.4\n'),
      finalUrl: String(params.file_url ?? ''),
    } as any);
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
  });

  it('lists orders 20 at a time from page 1 with the contract id and the filters', async () => {
    mockedAxios.mockResolvedValue({ data: { content: [] } });
    await call('manomano_list_orders', { status: 'PENDING', created_at_start: '2026-10-01T00:00:00Z' });
    expect(sent().params).toEqual({ seller_contract_id: '110841', status: 'PENDING', created_at_start: '2026-10-01T00:00:00Z', page: 1, limit: 20 });
    expect(tool('manomano_list_orders').parameters.properties!.limit.maximum).toBe(50);
  });

  it('accepts and refuses one order with the bulk body ManoMano expects', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('manomano_accept_order', { order_reference: 'M2022080713464' });
    expect(sent().data).toEqual([{ order_reference: 'M2022080713464', seller_contract_id: 110841 }]);
    mockedAxios.mockClear();
    await call('manomano_refuse_order', { order_reference: 'M2022080713464' });
    expect(sent().data).toEqual([{ order_reference: 'M2022080713464', seller_contract_id: 110841 }]);
  });

  it('ships one parcel with its carrier, tracking and products', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('manomano_ship_order', {
      order_reference: 'M2022080713464',
      carrier: 'UPS',
      tracking_number: '1Z1594AB5789012374',
      tracking_url: 'https://www.ups.com/mobile/track?trackingNumber=1Z1594AB5789012374',
      products,
    });
    expect(sent().data).toEqual([
      {
        order_reference: 'M2022080713464',
        seller_contract_id: 110841,
        carrier: 'UPS',
        tracking_number: '1Z1594AB5789012374',
        tracking_url: 'https://www.ups.com/mobile/track?trackingNumber=1Z1594AB5789012374',
        products,
      },
    ]);
  });

  it('refunds with the reason and does not refund shipping unless asked', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('manomano_refund_order', { order_reference: 'M1', products, refund_reason: 'CUSTOMER_CANCEL' });
    expect(sent().data).toEqual([{ order_reference: 'M1', seller_contract_id: 110841, products, refund_reason: 'CUSTOMER_CANCEL', refund_shipping_fees: false }]);
    expect(tool('manomano_refund_order').parameters.properties!.refund_reason.enum).toEqual(['NO_STOCK', 'CUSTOMER_CANCEL']);
  });

  it('keeps a quote in a value from breaking the JSON body', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('manomano_accept_order', { order_reference: 'M1", "seller_contract_id": 1, "x": "' });
    expect(sent().data).toEqual([{ order_reference: 'M1", "seller_contract_id": 1, "x": "', seller_contract_id: 110841 }]);
  });

  it('updates price and stock wrapped in content with the contract id', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const items = [{ sku: 'ABC-1234', price: { price_vat_included: 90.87, frozen_price: false }, stock: { quantity: 20 } }];
    await call('manomano_update_offers', { items });
    expect(sent().data).toEqual({ content: [{ seller_contract_id: 110841, items }] });
  });

  it('unfreezes the given fields of the given SKUs', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('manomano_unfreeze_offers', { skus: ['sku_1', 'sku_2'], fields: ['PRICE', 'STOCK'] });
    expect(sent().data).toEqual({ seller_contract_id: 110841, skus: ['sku_1', 'sku_2'], fields: ['PRICE', 'STOCK'] });
  });

  it('upserts offers as a bare array of at most 20, with the contract id in the query', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const offers = [{ sku: 'PROD-001', ean: '978020137962', stock: 0, pricing: { price_vat_included: 532.36 }, shipping: { display_weight: 2.5 }, packaging: { min_quantity: 1, increment: 5 } }];
    await call('manomano_upsert_offers', { offers });
    expect(sent().data).toEqual(offers);
    expect(sent().params).toEqual({ seller_contract_id: '110841' });
    expect(tool('manomano_upsert_offers').parameters.properties!.offers.maxItems).toBe(20);
  });

  it('searches competitiveness either by SKUs or by a full date range, never both', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('manomano_get_offer_competitiveness', { skus: ['sku1', 'sku2'] });
    expect(sent().data).toEqual({ filters: { seller_contract_id: 110841, skus: ['sku1', 'sku2'] }, page: 1, limit: 50 });
    mockedAxios.mockClear();
    await call('manomano_list_competitiveness_changes', { updated_at_from: '2025-07-01T10:00:00Z', updated_at_to: '2025-07-07T11:30:00Z' });
    expect(sent().data).toEqual({ filters: { seller_contract_id: 110841, updated_at_from: '2025-07-01T10:00:00Z', updated_at_to: '2025-07-07T11:30:00Z' }, page: 1, limit: 50 });
  });

  it('looks up EANs with the array of ean and locale pairs', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const lookups = [{ ean: '8425608304725', locale: 'es_ES' }, { ean: '05905481330675', locale: 'de_DE' }];
    await call('manomano_search_products_by_ean', { products: lookups });
    expect(sent().data).toEqual(lookups);
    expect(sent().params).toEqual({ seller_contract_id: '110841' });
  });

  it('uploads the invoice PDF fetched from the URL as the file part', async () => {
    mockedAxios.mockResolvedValue({ data: { content: { document_id: 'd1' } } });
    mockedFetchOutbound.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: Buffer.from('%PDF-1.4 invoice'),
      finalUrl: 'https://files.example.com/M260269216655.pdf',
    } as any);
    await call('manomano_upload_order_document', { order_reference: 'M260269216655', document_type: 'INVOICE', file_url: 'https://files.example.com/M260269216655.pdf' });
    expect(mockedFetchOutbound).toHaveBeenCalledWith('https://files.example.com/M260269216655.pdf', expect.any(Object));
    expect(sent().data).toBeInstanceOf(FormData);
    const text = formText(sent().data);
    expect(text).toMatch(/name="file"; filename="M260269216655.pdf"/);
    expect(text).toContain('%PDF-1.4 invoice');
    expect(text).toMatch(/name="document_type"\r\n\r\nINVOICE/);
    expect(String(header(sent(), 'content-type'))).toMatch(/^multipart\/form-data; boundary=/);
    expect(sent().params).toEqual({ seller_contract_id: '110841' });
  });

  it('documents setup, one install per contract, the order workflow and freezing', () => {
    expect(a.instructions).toContain('Settings > API keys');
    expect(a.instructions).toMatch(/one install covers one contract/i);
    expect(a.instructions).toContain('PENDING');
    expect(a.instructions).toMatch(/frozen/);
    expect(a.prerequisites).toMatch(/One install per contract/);
    expect(a.verifyHints['401']).toContain('MANOMANO_API_KEY');
  });
});

const LIVE = process.env.RUN_MANOMANO_LIVE === '1' && !!process.env.MANOMANO_API_KEY && !!process.env.MANOMANO_SELLER_CONTRACT_ID;

(LIVE ? describe : describe.skip)('manomano adapter: live Partners API (reads only)', () => {
  const env: Record<string, string> = {
    MANOMANO_API_KEY: process.env.MANOMANO_API_KEY as string,
    MANOMANO_SELLER_CONTRACT_ID: process.env.MANOMANO_SELLER_CONTRACT_ID as string,
  };
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  it('answers the health check', async () => {
    const res = await mockedAxios.__actual.get(`${BASE}${a.connector.healthcheckPath}`, {
      headers: { 'x-api-key': env.MANOMANO_API_KEY, 'x-thirdparty-name': 'AnythingMCP', Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
  }, 60_000);

  it('reads orders of the last 30 days and one order in full', async () => {
    const orders = await run('manomano_list_orders', { created_at_start: daysAgo(30), limit: 5 });
    expect(Array.isArray(orders.content)).toBe(true);
    if (orders.content[0]) {
      const one = await run('manomano_get_order', { order_reference: orders.content[0].order_reference });
      expect(one.content.order_reference).toBe(orders.content[0].order_reference);
    }
  }, 120_000);

  it('reads offers, competitiveness and invoice requests', async () => {
    const offers = await run('manomano_list_offers', { limit: 5 });
    expect(Array.isArray(offers.content)).toBe(true);
    if (offers.content[0]) await run('manomano_get_offer_competitiveness', { skus: [offers.content[0].sku], limit: 5 });
    await run('manomano_list_invoice_requests');
  }, 120_000);
});
