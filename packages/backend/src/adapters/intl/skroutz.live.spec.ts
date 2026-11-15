import axios from 'axios';
import * as adapter from './skroutz.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Skroutz Merchants API adapter (Marketplace / Smart Cart, Fulfilled by
 * Skroutz, Products API and CPS orders).
 *
 * Static checks always run: the Accept media type, the three tokens (the
 * marketplace token on every marketplace tool, the Products API token on the
 * product batch tools, the CPS token on the CPS tools), every tool's method
 * and path against developer.skroutz.gr, the request bodies, and which tools
 * install switched off. No tool moves money.
 * https://developer.skroutz.gr/smart_cart/orders_api
 *
 * Live checks run only with RUN_SKROUTZ_LIVE=1. Without a token they confirm
 * that Skroutz refuses a wrong token on the demo order; with SKROUTZ_API_TOKEN
 * they read the demo order DEMO-OPEN and the demo return DEMO-RETURN, which
 * hold no real data. Reads only.
 *
 *   RUN_SKROUTZ_LIVE=1 SKROUTZ_API_TOKEN=... npx jest src/adapters/intl/skroutz.live.spec.ts
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
    bodyEncoding?: string;
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
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
  SKROUTZ_API_TOKEN: 'mkt-token-0123456789abcdef',
  SKROUTZ_PRODUCTS_TOKEN: 'prd-token-0123456789abcdef',
  SKROUTZ_CPS_TOKEN: 'cps-token-0123456789abcdef',
};
const ACCEPT = 'application/vnd.skroutz+json; version=3.0';
const BASE = 'https://api.skroutz.gr';

const call = (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: cfg.baseUrl, authType: a.connector.authType, headers: cfg.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200) => mockedAxios.mockResolvedValueOnce({ status, data: { success: true }, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const EXPECTED: Record<string, [string, string]> = {
  skroutz_get_order: ['GET', '/merchants/ecommerce/orders/{order_code}'],
  skroutz_accept_order: ['POST', '/merchants/ecommerce/orders/{order_code}/accept'],
  skroutz_reject_order: ['POST', '/merchants/ecommerce/orders/{order_code}/reject'],
  skroutz_reschedule_order_pickup: ['POST', '/merchants/ecommerce/orders/{order_code}/reschedule_pickup'],
  skroutz_relocate_order_pickup: ['POST', '/merchants/ecommerce/orders/{order_code}/relocate_pickup'],
  skroutz_set_order_ready: ['POST', '/merchants/ecommerce/orders/{order_code}/set_as_ready'],
  skroutz_set_order_not_ready: ['POST', '/merchants/ecommerce/orders/{order_code}/set_as_not_ready'],
  skroutz_update_tracking_details: ['POST', '/merchants/ecommerce/orders/{order_code}/tracking_details'],
  skroutz_request_preorder_voucher: ['POST', '/merchants/ecommerce/orders/{order_code}/request_voucher'],
  skroutz_upload_invoice: ['POST', '/merchants/ecommerce/orders/{order_code}/invoices'],
  skroutz_upload_credit_invoice: ['POST', '/merchants/ecommerce/orders/{order_code}/credit_invoices'],
  skroutz_file_compensation_request: ['POST', '/merchants/ecommerce/orders/{order_code}/compensation_requests'],
  skroutz_get_return: ['GET', '/merchants/ecommerce/returns/{return_code}'],
  skroutz_handle_return: ['POST', '/merchants/ecommerce/returns/{return_code}/handle'],
  skroutz_submit_service_inspection: ['POST', '/merchants/ecommerce/returns/{return_code}/service_inspection'],
  skroutz_list_fbs_products: ['GET', '/merchants/ecommerce/fbs/products'],
  skroutz_list_fbs_purchase_orders: ['GET', '/merchants/ecommerce/fbs/purchase_orders'],
  skroutz_list_fbs_purchase_order_items: ['GET', '/merchants/ecommerce/fbs/purchase_orders/{purchase_order_code}/line_items'],
  skroutz_create_fbs_purchase_order: ['POST', '/merchants/ecommerce/fbs/purchase_orders'],
  skroutz_list_fbs_suppliers: ['GET', '/merchants/ecommerce/fbs/suppliers'],
  skroutz_create_fbs_supplier: ['POST', '/merchants/ecommerce/fbs/suppliers'],
  skroutz_update_fbs_supplier: ['PATCH', '/merchants/ecommerce/fbs/suppliers/{supplier_id}'],
  skroutz_validate_product_updates: ['POST', '/merchants/products/batch/validations'],
  skroutz_update_products: ['POST', '/merchants/products/batch'],
  skroutz_get_product_update_status: ['GET', '/merchants/products/batch/{batch_id}/status'],
  skroutz_get_cps_order: ['GET', '/merchants/cps/orders/{order_code}'],
  skroutz_reject_cps_order: ['POST', '/merchants/cps/orders/{order_code}/reject'],
};

describe('skroutz adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('calls api.skroutz.gr with the version 3.0 media type and three bearer tokens', () => {
    expect(a.slug).toBe('skroutz');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('skroutz');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.headers).toMatchObject({ Accept: ACCEPT });
    expect(a.connector.headers?.Authorization).toBeUndefined();
    expect(a.requiredEnvVars).toEqual(['SKROUTZ_API_TOKEN']);
    expect(a.optionalEnvVars).toEqual(['SKROUTZ_PRODUCTS_TOKEN', 'SKROUTZ_CPS_TOKEN']);
    for (const name of [...a.requiredEnvVars, ...a.optionalEnvVars!]) {
      const meta = a.envVarMeta[name];
      expect(meta).toMatchObject({ kind: 'credential', secret: true });
      const pattern = new RegExp(meta.pattern!);
      expect(pattern.test(ENV[name])).toBe(true);
      for (const bad of ['', 'Bearer abcdefghijklmnop', 'short']) expect(pattern.test(bad)).toBe(false);
    }
  });

  it('sends the right token on each tool', () => {
    for (const entry of a.tools) {
      const path = entry.endpointMapping.path;
      const expected = path.startsWith('/merchants/products/')
        ? 'Bearer ${SKROUTZ_PRODUCTS_TOKEN}'
        : path.startsWith('/merchants/cps/')
          ? 'Bearer ${SKROUTZ_CPS_TOKEN}'
          : 'Bearer ${SKROUTZ_API_TOKEN}';
      expect(entry.endpointMapping.headers).toEqual({ Authorization: expected });
    }
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const entry of a.tools) {
      const [method, path] = EXPECTED[entry.name];
      expect([entry.name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([entry.name, method, path]);
    }
  });

  it('probes the demo order and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'skroutz_get_order', params: { order_code: 'DEMO-OPEN' } });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^skroutz_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const param of Object.values(entry.parameters.properties ?? {})) expect(param.description).toBeTruthy();
      expect(entry.description.length).toBeGreaterThan(60);
    }
  });

  it('marks reads read-only, installs money-related writes switched off', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET' || entry.name === 'skroutz_validate_product_updates';
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, read]);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(
      [
        'skroutz_create_fbs_purchase_order',
        'skroutz_file_compensation_request',
        'skroutz_handle_return',
        'skroutz_reject_cps_order',
        'skroutz_reject_order',
        'skroutz_submit_service_inspection',
        'skroutz_update_products',
      ].sort(),
    );
  });

  it('names every tool in the instructions and keeps descriptions MDX-safe', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const outsideTicks = (s: string) => s.replace(/`[^`]*`/g, '');
    expect(outsideTicks(a.instructions)).not.toMatch(/[{}<]/);
    for (const entry of a.tools) {
      expect(outsideTicks(entry.description)).not.toMatch(/[{}<]/);
      for (const param of Object.values(entry.parameters.properties ?? {})) expect(outsideTicks(param.description ?? '')).not.toMatch(/[{}<]/);
    }
  });

  it('uploads invoices and service reports as multipart files from a link', () => {
    expect(tool('skroutz_upload_invoice').endpointMapping).toMatchObject({
      bodyEncoding: 'form-data',
      bodyMapping: { invoice_file: { __file: '$invoice_file_url' } },
    });
    expect(tool('skroutz_upload_credit_invoice').endpointMapping).toMatchObject({
      bodyEncoding: 'form-data',
      bodyMapping: { credit_invoice_file: { __file: '$credit_invoice_file_url' } },
    });
    expect(tool('skroutz_submit_service_inspection').endpointMapping).toMatchObject({
      bodyEncoding: 'form-data',
      bodyMapping: { item: '$item', option: '$option', service_report_file: { __file: '$service_report_file_url' } },
    });
  });

  it('reads an order with the marketplace token and the media type', async () => {
    ok();
    await call('skroutz_get_order', { order_code: 'DEMO-OPEN', action_options: 1 });
    const req = sent();
    expect(req.url).toBe(`${BASE}/merchants/ecommerce/orders/DEMO-OPEN`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.SKROUTZ_API_TOKEN}`);
    expect(header(req, 'Accept')).toBe(ACCEPT);
    expect(req.params).toEqual({ action_options: 1 });
  });

  it('builds the accept, reject, reschedule and tracking bodies as Skroutz documents them', async () => {
    ok();
    await call('skroutz_accept_order', { order_code: '191128-1234567', pickup_location: 'YlpD0KROym', pickup_window: '20191204T1000-20191204T1200', number_of_parcels: 1 });
    expect(sent().url).toBe(`${BASE}/merchants/ecommerce/orders/191128-1234567/accept`);
    expect(sent().data).toEqual({ pickup_location: 'YlpD0KROym', pickup_window: '20191204T1000-20191204T1200', number_of_parcels: 1 });

    ok();
    await call('skroutz_reject_order', { order_code: 'DEMO-OPEN', line_items: [{ id: 'jn231kb12u', reason_id: 2 }, { id: 'opaoe8M3pZ', reason_id: 4, available_quantity: 1 }] });
    expect(sent().data).toEqual({ line_items: [{ id: 'jn231kb12u', reason_id: 2 }, { id: 'opaoe8M3pZ', reason_id: 4, available_quantity: 1 }] });

    ok();
    await call('skroutz_reject_order', { order_code: 'DEMO-OPEN', rejection_reason_other: 'Store closed' });
    expect(sent().data).toEqual({ rejection_reason_other: 'Store closed' });

    ok();
    await call('skroutz_reschedule_order_pickup', { order_code: 'DEMO-ACCEPTED', reschedule_date: '2026-09-25' });
    expect(sent().url).toBe(`${BASE}/merchants/ecommerce/orders/DEMO-ACCEPTED/reschedule_pickup`);
    expect(sent().data).toEqual({ reschedule_date: '2026-09-25' });

    ok();
    await call('skroutz_update_tracking_details', { order_code: 'DEMO-OPEN', tracking_details: [{ courier: 'acs', tracking_code: '224085551' }] });
    expect(sent().data).toEqual({ tracking_details: [{ courier: 'acs', tracking_code: '224085551' }] });

    ok();
    await call('skroutz_set_order_ready', { order_code: '260225-123456' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/merchants/ecommerce/orders/260225-123456/set_as_ready`);
  });

  it('builds the return, FBS and CPS bodies', async () => {
    ok();
    await call('skroutz_handle_return', { return_code: 'DEMO-RETURN-REVIEW', option: 'not_faulty', comment: 'Works as specified.' });
    expect(sent().url).toBe(`${BASE}/merchants/ecommerce/returns/DEMO-RETURN-REVIEW/handle`);
    expect(sent().data).toEqual({ option: 'not_faulty', comment: 'Works as specified.' });

    ok();
    await call('skroutz_create_fbs_purchase_order', {
      expected_date: '2022-09-22',
      supplier_id: 'z0VGVY3M1m',
      line_items: [{ product_uid: '52781', expected_quantity: 8, keep_serial_numbers: true, has_expiration_date: false, storage_conditions: 2 }],
    });
    expect(sent().data).toEqual({
      expected_date: '2022-09-22',
      supplier_id: 'z0VGVY3M1m',
      line_items: [{ product_uid: '52781', expected_quantity: 8, keep_serial_numbers: true, has_expiration_date: false, storage_conditions: 2 }],
    });

    ok();
    await call('skroutz_update_fbs_supplier', { supplier_id: 'abcdefgh', address: 'Another Address', email: 'new@example.gr' });
    expect(String(sent().method).toUpperCase()).toBe('PATCH');
    expect(sent().url).toBe(`${BASE}/merchants/ecommerce/fbs/suppliers/abcdefgh`);
    expect(sent().data).toEqual({ address: 'Another Address', email: 'new@example.gr' });

    ok();
    await call('skroutz_list_fbs_products', {});
    expect(sent().url).toBe(`${BASE}/merchants/ecommerce/fbs/products`);
    expect(sent().params).toEqual({ page: 1 });

    ok();
    await call('skroutz_reject_cps_order', { order_code: '1234567', reason: 'other', comment: 'Closed' });
    expect(sent().url).toBe(`${BASE}/merchants/cps/orders/1234567/reject`);
    expect(header(sent(), 'Authorization')).toBe(`Bearer ${ENV.SKROUTZ_CPS_TOKEN}`);
    expect(sent().data).toEqual({ reason: { name: 'other', comment: 'Closed' } });
  });

  it('sends product batches with the Products API token', async () => {
    const data = [{ product_id: 'ABC123', quantity: 10, enabled: true, price: 2999 }];
    ok();
    await call('skroutz_validate_product_updates', { data });
    expect(sent().url).toBe(`${BASE}/merchants/products/batch/validations`);
    expect(header(sent(), 'Authorization')).toBe(`Bearer ${ENV.SKROUTZ_PRODUCTS_TOKEN}`);
    expect(sent().data).toEqual({ data });

    ok();
    await call('skroutz_update_products', { data });
    expect(sent().url).toBe(`${BASE}/merchants/products/batch`);
    expect(sent().data).toEqual({ data });

    ok();
    await call('skroutz_get_product_update_status', { batch_id: '6a9810dcd4ff840001bf0f32' });
    expect(sent().url).toBe(`${BASE}/merchants/products/batch/6a9810dcd4ff840001bf0f32/status`);
  });

  it('leaves the Authorization header out when an optional token is not set', async () => {
    ok();
    await call('skroutz_get_cps_order', { order_code: '1234567' }, { SKROUTZ_API_TOKEN: ENV.SKROUTZ_API_TOKEN });
    expect(header(sent(), 'Authorization')).toBeUndefined();
  });
});

// Opt-in: RUN_SKROUTZ_LIVE=1. The refusal check needs no account; the demo
// reads need SKROUTZ_API_TOKEN. Nothing is written.
const live = process.env.RUN_SKROUTZ_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('skroutz: live', () => {
  it('refuses a wrong token on the demo order', async () => {
    const response = await liveFetch.get(`${BASE}/merchants/ecommerce/orders/DEMO-OPEN`, {
      headers: { Accept: ACCEPT, Authorization: 'Bearer not-a-real-token-123' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads the demo order and the demo return', async () => {
    const token = process.env.SKROUTZ_API_TOKEN;
    if (!token) throw new Error('Set SKROUTZ_API_TOKEN for the live check');
    const headers = { Accept: ACCEPT, Authorization: `Bearer ${token}` };
    const order = await liveFetch.get(`${BASE}/merchants/ecommerce/orders/DEMO-OPEN`, { headers, validateStatus: () => true });
    expect(order.status).toBe(200);
    expect(order.data.order.code).toBe('DEMO-OPEN');
    const ret = await liveFetch.get(`${BASE}/merchants/ecommerce/returns/DEMO-RETURN`, { headers, validateStatus: () => true });
    expect(ret.status).toBe(200);
  });
});
