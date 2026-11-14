import axios from 'axios';
import * as adapter from './kasta.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Kasta Hub API adapter (supplier API of kasta.ua).
 *
 * Static checks always run: the raw token in the Authorization header (no
 * Bearer), every tool's method and path against the operations of Kasta's
 * published OpenAPI 2.0 document (https://hub.kasta.ua/api-docs.json, saved
 * 2026-11-14 and listed below), the status bodies sent to
 * /api/orders/send-status, the price, stock and supplier-order bodies, and
 * which tools install switched off. BNPL overrides, fiscal (RRO) receipts and
 * the transaction export are left out on purpose.
 * https://hub.kasta.ua/api-docs/index.html
 *
 * Live checks run only with RUN_KASTA_LIVE=1. Without a token they confirm
 * the Hub refuses a wrong one; with KASTA_TOKEN they read one page of
 * products, the category tree and the contracts. Reads only.
 *
 *   RUN_KASTA_LIVE=1 KASTA_TOKEN=... npx jest src/adapters/intl/kasta.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
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
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; link?: string }>;
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

/** Every operation of Kasta's OpenAPI document (hub.kasta.ua/api-docs.json, 2026-11-14). */
const SPEC_OPERATIONS = [
  'GET /api/bnpl/product-overrides/list',
  'POST /api/bnpl/product-overrides/update',
  'GET /api/carriers/np/shipping-label/download',
  'POST /api/carriers/up/shipping-label-kasta',
  'GET /api/carriers/up/shipping-label/download',
  'GET /api/orders/list',
  'GET /api/orders/return-form',
  'POST /api/orders/rro/add',
  'POST /api/orders/send-status',
  'POST /api/orders/set-rro',
  'GET /api/organization-account/contracts',
  'GET /api/organization-account/transactions/export-xls',
  'GET /api/products/list',
  'POST /api/products/set-available/barcode',
  'POST /api/products/set-available/hub-sku',
  'POST /api/products/set-available/id',
  'POST /api/products/update',
  'POST /api/products/update-acceptance-date',
  'POST /api/products/update-docflow-code',
  'POST /api/products/update-nomenclature',
  'POST /api/products/update-price',
  'POST /api/products/update-price/id',
  'POST /api/products/update-price/legacy',
  'POST /api/products/update-stock',
  'POST /api/products/update-stock/id',
  'POST /api/products/update-stock/legacy',
  'POST /api/products/update-uktzed',
  'GET /api/supplier-content/category/all',
  'GET /api/supplier-content/category/details',
  'POST /api/supplier-content/submit/image',
  'POST /api/supplier-content/submit/products',
  'GET /api/supplier-order',
  'POST /api/supplier-order/approve',
  'GET /api/supplier-order/cover-letter',
  'POST /api/supplier-order/create',
  'POST /api/supplier-order/delivery',
  'GET /api/supplier-order/future-supplier-order',
  'GET /api/supplier-order/list',
];

/** Statuses /api/orders/send-status accepts (the x-oneOf variants of its body). */
const SEND_STATUS_VARIANTS = [
  'SentToDelivery', 'DeliveryAddressChanged', 'Packed', 'ReceivedAtSelfDelivery', 'CancellationDenied',
  'CorrectionDenied', 'ConfirmedBySupplier', 'PaymentReceived', 'Refunded', 'ReturnArrived',
  'AnnouncedForDelivery', 'Cancelled', 'AtLocation', 'Corrected', 'Delivered',
];

const ENV: Record<string, string> = { KASTA_TOKEN: 'kst_0123456789abcdef0123456789abcdef' };
const UUID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

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

describe('kasta adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the Kasta Hub token as the raw Authorization header', () => {
    expect(a.slug).toBe('kasta');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('kasta');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://hub.kasta.ua');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{KASTA_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['KASTA_TOKEN']);
    expect(a.envVarMeta.KASTA_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.KASTA_TOKEN.link).toMatch(/^https:\/\/hub\.kasta\.ua\//);
    const pattern = new RegExp(a.envVarMeta.KASTA_TOKEN.pattern!);
    expect(pattern.test(ENV.KASTA_TOKEN)).toBe(true);
    for (const bad of ['', 'Bearer kst_0123456789abcdef', 'short']) expect(pattern.test(bad)).toBe(false);
  });

  it('puts the token itself in Authorization, without Bearer', async () => {
    ok();
    await call('kasta_list_products', {});
    const req = sent();
    expect(req.url).toBe('https://hub.kasta.ua/api/products/list');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe(ENV.KASTA_TOKEN);
  });

  it('probes the product list and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'kasta_list_products', params: {} });
    expect(tool('kasta_list_products').parameters.required ?? []).toEqual([]);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['403']).toContain('invalid-token-forbidden');
    expect(a.verifyHints['403']).toContain('not-allow-this-handler');
  });

  it('maps every tool to an operation of the published Kasta spec', () => {
    const spec = new Set(SPEC_OPERATIONS);
    for (const entry of a.tools) {
      expect(spec.has(`${entry.endpointMapping.method} ${entry.endpointMapping.path}`)).toBe(true);
    }
    const paths = a.tools.map((entry) => entry.endpointMapping.path);
    for (const left of ['/api/bnpl/', '/rro', 'set-rro', 'export-xls']) {
      expect(paths.some((p) => p.includes(left))).toBe(false);
    }
  });

  it('sends only status values the send-status body defines', () => {
    for (const entry of a.tools.filter((t) => t.endpointMapping.path === '/api/orders/send-status')) {
      const status = entry.endpointMapping.bodyMapping!.status as string;
      const allowed = status === '$status' ? (entry.parameters.properties!.status.enum ?? []) : [status];
      expect(allowed.length).toBeGreaterThan(0);
      for (const value of allowed) expect(SEND_STATUS_VARIANTS).toContain(value);
      expect(entry.parameters.required).toEqual(expect.arrayContaining(['uuid', 'order_id']));
    }
    const statuses = a.tools
      .filter((t) => t.endpointMapping.path === '/api/orders/send-status')
      .flatMap((t) => {
        const s = t.endpointMapping.bodyMapping!.status as string;
        return s === '$status' ? (t.parameters.properties!.status.enum ?? []) : [s];
      });
    expect(statuses).not.toContain('Refunded');
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^kasta_[a-z0-9_]+$/);
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

  it('marks reads read-only and installs cancellation, correction, return and supplier-order creation switched off', () => {
    for (const entry of a.tools) {
      expect(annotationsOf(entry).readOnlyHint).toBe(entry.endpointMapping.method === 'GET');
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([
      'kasta_accept_return',
      'kasta_cancel_order',
      'kasta_correct_order',
      'kasta_create_supplier_order',
    ]);
    expect(tool('kasta_cancel_order').endpointMapping.bodyMapping!.status).toBe('Cancelled');
    expect(tool('kasta_correct_order').endpointMapping.bodyMapping!.status).toBe('Corrected');
    expect(tool('kasta_accept_return').endpointMapping.bodyMapping!.status).toBe('ReturnArrived');
  });

  it('names every tool in the instructions', () => {
    expect(a.instructions.startsWith('## Kasta')).toBe(true);
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions).toContain('Marketplace');
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('reads orders with repeated status and order_id parameters', async () => {
    ok();
    await call('kasta_list_orders', { cursor: 'd55vi9', status: ['Created', 'CancellationRequested'], limit: 100 });
    const req = sent();
    expect(req.url).toBe('https://hub.kasta.ua/api/orders/list');
    expect(req.params).toEqual({ cursor: 'd55vi9', status: ['Created', 'CancellationRequested'], limit: 100 });
    expect(query(req)).toBe('cursor=d55vi9&status=Created&status=CancellationRequested&limit=100');

    ok();
    await call('kasta_download_novaposhta_label', { ttn: ['20451234567891', '10011643788'], type: '100x100' });
    expect(sent().url).toBe('https://hub.kasta.ua/api/carriers/np/shipping-label/download');
    expect(query(sent())).toBe('ttn=20451234567891&ttn=10011643788&type=100x100');

    ok();
    await call('kasta_get_category_details', { kind_id: 299, affiliation_id: 11904 });
    expect(sent().url).toBe('https://hub.kasta.ua/api/supplier-content/category/details');
    expect(sent().params).toEqual({ kind_id: 299, affiliation_id: 11904 });

    ok();
    await call('kasta_get_supplier_order', { uuid: '05ef6f23-adbe-4448-b798-432440503741' });
    expect(sent().url).toBe('https://hub.kasta.ua/api/supplier-order');
    expect(sent().params).toEqual({ uuid: '05ef6f23-adbe-4448-b798-432440503741' });
  });

  it('builds the order status bodies as Kasta documents them', async () => {
    ok();
    await call('kasta_send_order_status', { uuid: UUID, order_id: 'S5LFR5Z', status: 'ConfirmedBySupplier' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe('https://hub.kasta.ua/api/orders/send-status');
    expect(sent().data).toEqual({ uuid: UUID, order_id: 'S5LFR5Z', status: 'ConfirmedBySupplier' });

    ok();
    await call('kasta_pack_order', { uuid: UUID, order_id: 'S5LFR5Z', amount: 118, items: [{ line_id: 43935, quantity: 1 }] });
    expect(sent().data).toEqual({
      uuid: UUID,
      order_id: 'S5LFR5Z',
      status: 'Packed',
      amount: 118,
      items: [{ line_id: 43935, quantity: 1 }],
    });

    ok();
    await call('kasta_send_tracking_number', {
      uuid: UUID,
      order_id: 'S5LFR5Z',
      number: '20451234567891',
      courier_service: 'novaposhta',
    });
    expect(sent().data).toEqual({
      uuid: UUID,
      order_id: 'S5LFR5Z',
      status: 'AnnouncedForDelivery',
      number: '20451234567891',
      courier_service: 'novaposhta',
    });

    ok();
    await call('kasta_cancel_order', { uuid: UUID, order_id: 'S5LFR5Z', reason: 'MissingFromTheSupplier' });
    expect(sent().data).toEqual({ uuid: UUID, order_id: 'S5LFR5Z', status: 'Cancelled', reason: 'MissingFromTheSupplier' });
  });

  it('sends price, stock and visibility batches as items arrays', async () => {
    ok();
    await call('kasta_update_stock_by_id', { items: [{ unique_sku_id: 'SKU-1', stock: 5 }] });
    expect(sent().url).toBe('https://hub.kasta.ua/api/products/update-stock/id');
    expect(sent().data).toEqual({ items: [{ unique_sku_id: 'SKU-1', stock: 5 }] });

    ok();
    await call('kasta_update_prices_by_barcode', { items: [{ barcode: '1234567890123', supplier_price: 200, old_price: 1000 }] });
    expect(sent().url).toBe('https://hub.kasta.ua/api/products/update-price');
    expect(sent().data).toEqual({ items: [{ barcode: '1234567890123', supplier_price: 200, old_price: 1000 }] });

    ok();
    await call('kasta_set_product_visibility_by_barcode', { items: [{ barcode: '1234567890123' }], available: false });
    expect(sent().url).toBe('https://hub.kasta.ua/api/products/set-available/barcode');
    expect(sent().data).toEqual({ items: [{ barcode: '1234567890123' }], available: false });

    ok();
    await call('kasta_update_nomenclature', { match_by: 'barcode', items: [{ barcode: '1234567890123', nomenclature: 'Сукня' }] });
    expect(sent().data).toEqual({ type: 'barcode', items: [{ barcode: '1234567890123', nomenclature: 'Сукня' }] });
  });

  it('builds the catalog and supplier-order bodies', async () => {
    ok();
    await call('kasta_submit_products', {
      kind_id: 299,
      affiliation_id: 11904,
      products: [{ code: 'MI20777', brand: 'Nike', color: 'Белый', size: '38', name_uk: 'Білизна', images: ['p'], characteristics: [], stock: 0 }],
    });
    expect(sent().url).toBe('https://hub.kasta.ua/api/supplier-content/submit/products');
    expect(sent().data).toMatchObject({ kind_id: 299, affiliation_id: 11904, update: false, data: [expect.objectContaining({ code: 'MI20777' })] });

    ok();
    await call('kasta_upload_image', { url: 'https://example.org/1.jpeg' });
    expect(sent().data).toEqual({ url: 'https://example.org/1.jpeg' });

    ok();
    await call('kasta_add_supplier_order_delivery', {
      uuid: '05ef6f23-adbe-4448-b798-432440503741',
      delivery_service: 'novaposhta',
      delivery_date: '2026-11-20T10:00:00',
      delivery_info: [{ tracking_number: '20451234567891', cargo_size: 2 }],
    });
    expect(sent().url).toBe('https://hub.kasta.ua/api/supplier-order/delivery');
    expect(sent().data).toEqual({
      uuid: '05ef6f23-adbe-4448-b798-432440503741',
      data: {
        delivery_service: 'novaposhta',
        delivery_date: '2026-11-20T10:00:00',
        delivery_info: [{ tracking_number: '20451234567891', cargo_size: 2 }],
      },
    });

    ok();
    await call('kasta_create_ukrposhta_label', { order_id: 'S5LFR5Z' });
    expect(sent().url).toBe('https://hub.kasta.ua/api/carriers/up/shipping-label-kasta');
    expect(sent().data).toEqual({ order_id: 'S5LFR5Z' });
  });
});

// Opt-in: RUN_KASTA_LIVE=1. The refusal check needs no account; the reads
// need KASTA_TOKEN. Nothing is written.
const live = process.env.RUN_KASTA_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Kasta Hub: live', () => {
  it('refuses a wrong token', async () => {
    const response = await liveFetch.get('https://hub.kasta.ua/api/products/list', {
      headers: { Authorization: 'not-a-real-kasta-token-000000', Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads products, the category tree and the contracts', async () => {
    const token = process.env.KASTA_TOKEN;
    if (!token) throw new Error('Set KASTA_TOKEN for the live check');
    const headers = { Authorization: token, Accept: 'application/json' };
    const products = await liveFetch.get('https://hub.kasta.ua/api/products/list', { headers, validateStatus: () => true });
    expect(products.status).toBe(200);
    expect(Array.isArray(products.data.items)).toBe(true);
    const categories = await liveFetch.get('https://hub.kasta.ua/api/supplier-content/category/all', { headers, validateStatus: () => true });
    expect(categories.status).toBe(200);
    expect(Array.isArray(categories.data.items)).toBe(true);
    const contracts = await liveFetch.get('https://hub.kasta.ua/api/organization-account/contracts', { headers, validateStatus: () => true });
    expect(contracts.status).toBe(200);
  });
});
