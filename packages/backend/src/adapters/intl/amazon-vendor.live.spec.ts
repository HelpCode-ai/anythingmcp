import axios from 'axios';
import * as adapter from './amazon-vendor.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Amazon Vendor Central adapter (Selling Partner API, vendor side).
 *
 * Static checks always run: the Login with Amazon refresh-token exchange into
 * the x-amz-access-token header (the same wiring as amazon-seller, without a
 * seller id), the region choice for the endpoint, every tool's method and
 * path against Amazon's published vendor models (vendorOrders,
 * vendorShipments, vendorInvoices, vendorTransactionStatus and the Direct
 * Fulfillment orders, shipping, inventory, payments and transactions models)
 * and the Reports API, the submit bodies, the guided setup, and which tools
 * install switched off (invoices and Direct Fulfillment label creation).
 * https://github.com/amzn/selling-partner-api-models
 *
 * Live checks run only with RUN_AMAZON_VENDOR_LIVE=1. Without credentials they
 * confirm Login with Amazon refuses made-up ones; with SPAPI_CLIENT_ID,
 * SPAPI_CLIENT_SECRET, SPAPI_REFRESH_TOKEN and SPAPI_ENDPOINT they exchange
 * the token and read one page of purchase orders. Reads only.
 *
 *   RUN_AMAZON_VENDOR_LIVE=1 SPAPI_CLIENT_ID=... SPAPI_CLIENT_SECRET=... \
 *     SPAPI_REFRESH_TOKEN=... SPAPI_ENDPOINT=https://sellingpartnerapi-eu.amazon.com \
 *     npx jest src/adapters/intl/amazon-vendor.live.spec.ts
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

const EU = 'https://sellingpartnerapi-eu.amazon.com';
const LWA = 'https://api.amazon.com/auth/o2/token';
// Built at runtime so no literal looks like a real credential.
const ENV: Record<string, string> = {
  SPAPI_CLIENT_ID: ['amzn1', 'application-oa2-client', 'a'.repeat(32)].join('.'),
  SPAPI_CLIENT_SECRET: ['amzn1', 'oa2-cs', 'v1', 'b'.repeat(40)].join('.'),
  SPAPI_REFRESH_TOKEN: ['Atzr', 'c'.repeat(40)].join('|'),
  SPAPI_ENDPOINT: EU,
  SPAPI_MARKETPLACE_ID: 'A1PA6795UKMFR9',
};
const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine(tokens, {} as LoginTokenService).execute(
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
  ['amazon_vendor_list_purchase_orders', 'GET', '/vendor/orders/v1/purchaseOrders', []],
  ['amazon_vendor_get_purchase_order', 'GET', '/vendor/orders/v1/purchaseOrders/{purchase_order_number}', ['purchase_order_number']],
  ['amazon_vendor_list_purchase_order_statuses', 'GET', '/vendor/orders/v1/purchaseOrdersStatus', []],
  ['amazon_vendor_submit_acknowledgements', 'POST', '/vendor/orders/v1/acknowledgements', ['acknowledgements']],
  ['amazon_vendor_submit_shipment_confirmations', 'POST', '/vendor/shipping/v1/shipmentConfirmations', ['shipment_confirmations']],
  ['amazon_vendor_list_shipments', 'GET', '/vendor/shipping/v1/shipments', []],
  ['amazon_vendor_list_transport_labels', 'GET', '/vendor/shipping/v1/transportLabels', []],
  ['amazon_vendor_submit_invoices', 'POST', '/vendor/payments/v1/invoices', ['invoices']],
  ['amazon_vendor_get_transaction_status', 'GET', '/vendor/transactions/v1/transactions/{transaction_id}', ['transaction_id']],
  ['amazon_vendor_list_df_orders', 'GET', '/vendor/directFulfillment/orders/2021-12-28/purchaseOrders', ['created_after', 'created_before']],
  ['amazon_vendor_get_df_order', 'GET', '/vendor/directFulfillment/orders/2021-12-28/purchaseOrders/{purchase_order_number}', ['purchase_order_number']],
  ['amazon_vendor_acknowledge_df_orders', 'POST', '/vendor/directFulfillment/orders/2021-12-28/acknowledgements', ['order_acknowledgements']],
  ['amazon_vendor_list_df_shipping_labels', 'GET', '/vendor/directFulfillment/shipping/2021-12-28/shippingLabels', ['created_after', 'created_before']],
  ['amazon_vendor_get_df_shipping_label', 'GET', '/vendor/directFulfillment/shipping/2021-12-28/shippingLabels/{purchase_order_number}', ['purchase_order_number']],
  ['amazon_vendor_request_df_shipping_labels', 'POST', '/vendor/directFulfillment/shipping/2021-12-28/shippingLabels', ['shipping_label_requests']],
  ['amazon_vendor_create_df_shipping_labels', 'POST', '/vendor/directFulfillment/shipping/2021-12-28/shippingLabels/{purchase_order_number}', ['purchase_order_number', 'selling_party', 'ship_from_party']],
  ['amazon_vendor_submit_df_shipment_confirmations', 'POST', '/vendor/directFulfillment/shipping/2021-12-28/shipmentConfirmations', ['shipment_confirmations']],
  ['amazon_vendor_list_df_packing_slips', 'GET', '/vendor/directFulfillment/shipping/2021-12-28/packingSlips', ['created_after', 'created_before']],
  ['amazon_vendor_get_df_packing_slip', 'GET', '/vendor/directFulfillment/shipping/2021-12-28/packingSlips/{purchase_order_number}', ['purchase_order_number']],
  ['amazon_vendor_list_df_customer_invoices', 'GET', '/vendor/directFulfillment/shipping/2021-12-28/customerInvoices', ['created_after', 'created_before']],
  ['amazon_vendor_update_df_inventory', 'POST', '/vendor/directFulfillment/inventory/v1/warehouses/{warehouse_id}/items', ['warehouse_id', 'selling_party_id', 'items']],
  ['amazon_vendor_submit_df_invoices', 'POST', '/vendor/directFulfillment/payments/v1/invoices', ['invoices']],
  ['amazon_vendor_get_df_transaction_status', 'GET', '/vendor/directFulfillment/transactions/2021-12-28/transactions/{transaction_id}', ['transaction_id']],
  ['amazon_vendor_create_report', 'POST', '/reports/2021-06-30/reports', ['report_type']],
  ['amazon_vendor_get_report', 'GET', '/reports/2021-06-30/reports/{report_id}', ['report_id']],
  ['amazon_vendor_download_report_document', 'GET', '/reports/2021-06-30/documents/{report_document_id}', ['report_document_id']],
];

describe('amazon-vendor adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('exchanges the Login with Amazon refresh token into x-amz-access-token, as amazon-seller does', () => {
    expect(a.slug).toBe('amazon-vendor');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('amazon-vendor');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{SPAPI_ENDPOINT}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'refresh_token',
      tokenUrl: LWA,
      clientId: '{{SPAPI_CLIENT_ID}}',
      clientSecret: '{{SPAPI_CLIENT_SECRET}}',
      refreshToken: '{{SPAPI_REFRESH_TOKEN}}',
      headerName: 'x-amz-access-token',
    });
    expect(a.connector.authConfig).toEqual(getAdapter('amazon-seller')!.connector.authConfig);
    expect(a.requiredEnvVars).toEqual(['SPAPI_CLIENT_ID', 'SPAPI_CLIENT_SECRET', 'SPAPI_REFRESH_TOKEN', 'SPAPI_ENDPOINT', 'SPAPI_MARKETPLACE_ID']);
    expect(a.requiredEnvVars).not.toContain('SPAPI_SELLER_ID');
    expect(JSON.stringify(a.tools)).not.toContain('SPAPI_SELLER_ID');
    expect(a.envVarMeta.SPAPI_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.SPAPI_REFRESH_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    for (const name of a.requiredEnvVars) expect([name, new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])]).toEqual([name, true]);
    expect(new RegExp(a.envVarMeta.SPAPI_REFRESH_TOKEN.pattern!).test(['Atza', 'c'.repeat(40)].join('|'))).toBe(false);
  });

  it('offers the three SP-API regions as the choices of the endpoint', () => {
    const meta = a.envVarMeta.SPAPI_ENDPOINT;
    expect(meta.options).toEqual([
      { value: 'https://sellingpartnerapi-na.amazon.com', label: 'North America' },
      { value: EU, label: 'Europe' },
      { value: 'https://sellingpartnerapi-fe.amazon.com', label: 'Far East' },
    ]);
    for (const option of meta.options!) expect(new RegExp(meta.pattern!).test(option.value)).toBe(true);
    for (const bad of ['https://sellingpartnerapi-eu.amazon.com/', 'https://example.com', 'sellingpartnerapi-eu.amazon.com']) {
      expect(new RegExp(meta.pattern!).test(bad)).toBe(false);
    }
  });

  it('guides the setup in four steps and asks for every variable once', () => {
    const guide = a.setupGuide!;
    expect(guide.effort).toBe('own_app');
    expect(guide.steps.map((step) => step.id)).toEqual(['developer-profile', 'create-app', 'authorize', 'region']);
    expect(guide.steps[0].confirm).toBeTruthy();
    expect(guide.steps.flatMap((step) => step.fields ?? [])).toEqual(a.requiredEnvVars);
    expect(guide.steps[3].fields).toEqual(['SPAPI_ENDPOINT', 'SPAPI_MARKETPLACE_ID']);
  });

  it('probes the purchase orders and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'amazon_vendor_list_purchase_orders', params: { limit: 1, include_details: 'false' } });
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
    for (const name of mine) expect(name).toMatch(/^amazon_vendor_[a-z0-9_]+$/);
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

  it('marks reads read-only and installs acknowledgements, confirmations, invoices and label creation switched off', () => {
    const READS: string[] = ['amazon_vendor_download_report_document', 'amazon_vendor_get_df_order', 'amazon_vendor_get_df_packing_slip', 'amazon_vendor_get_df_shipping_label', 'amazon_vendor_get_df_transaction_status', 'amazon_vendor_get_purchase_order', 'amazon_vendor_get_report', 'amazon_vendor_get_transaction_status', 'amazon_vendor_list_df_customer_invoices', 'amazon_vendor_list_df_orders', 'amazon_vendor_list_df_packing_slips', 'amazon_vendor_list_df_shipping_labels', 'amazon_vendor_list_purchase_order_statuses', 'amazon_vendor_list_purchase_orders', 'amazon_vendor_list_shipments', 'amazon_vendor_list_transport_labels'];
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, READS.includes(entry.name)]);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['amazon_vendor_acknowledge_df_orders', 'amazon_vendor_create_df_shipping_labels', 'amazon_vendor_request_df_shipping_labels', 'amazon_vendor_submit_acknowledgements', 'amazon_vendor_submit_df_invoices', 'amazon_vendor_submit_df_shipment_confirmations', 'amazon_vendor_submit_invoices', 'amazon_vendor_submit_shipment_confirmations']);
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

  it('keeps every path on a current vendor API version or the Reports API', () => {
    const prefixes = [
      '/vendor/orders/v1/',
      '/vendor/shipping/v1/',
      '/vendor/payments/v1/',
      '/vendor/transactions/v1/',
      '/vendor/directFulfillment/orders/2021-12-28/',
      '/vendor/directFulfillment/shipping/2021-12-28/',
      '/vendor/directFulfillment/inventory/v1/',
      '/vendor/directFulfillment/payments/v1/',
      '/vendor/directFulfillment/transactions/2021-12-28/',
      '/reports/2021-06-30/',
    ];
    for (const entry of a.tools) {
      expect([entry.name, prefixes.some((prefix) => entry.endpointMapping.path.startsWith(prefix))]).toEqual([entry.name, true]);
    }
    expect(tool('amazon_vendor_download_report_document').endpointMapping.download).toEqual({
      urlField: 'url',
      compressionField: 'compressionAlgorithm',
      format: 'auto',
      allowedHosts: ['amazonaws.com'],
      offset: '$offset',
      limit: '$limit',
      columns: '$columns',
      filterColumn: '$filter_column',
      filterValue: '$filter_value',
    });
  });

  it('lists purchase orders on the chosen region with the access token header', async () => {
    ok();
    await call('amazon_vendor_list_purchase_orders', { purchase_order_state: 'New', limit: 10 });
    const req = sent();
    expect(req.url).toBe(`${EU}/vendor/orders/v1/purchaseOrders`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'x-amz-access-token')).toBe('test-token');
    expect(header(req, 'Authorization')).toBeUndefined();
    expect(req.params).toEqual({ purchaseOrderState: 'New', limit: 10 });

    ok();
    await call('amazon_vendor_get_purchase_order', { purchase_order_number: '4Z32PABC' });
    expect(sent().url).toBe(`${EU}/vendor/orders/v1/purchaseOrders/4Z32PABC`);

    ok();
    await call('amazon_vendor_list_df_orders', { created_after: '2026-11-01T00:00:00Z', created_before: '2026-11-07T00:00:00Z', status: 'NEW' });
    expect(sent().url).toBe(`${EU}/vendor/directFulfillment/orders/2021-12-28/purchaseOrders`);
    expect(sent().params).toEqual({ createdAfter: '2026-11-01T00:00:00Z', createdBefore: '2026-11-07T00:00:00Z', status: 'NEW' });

    ok();
    await call('amazon_vendor_get_transaction_status', { transaction_id: '20190904190535-eef8cad8' });
    expect(sent().url).toBe(`${EU}/vendor/transactions/v1/transactions/20190904190535-eef8cad8`);

    ok();
    await call('amazon_vendor_get_df_transaction_status', { transaction_id: '20190904190535-eef8cad8' });
    expect(sent().url).toBe(`${EU}/vendor/directFulfillment/transactions/2021-12-28/transactions/20190904190535-eef8cad8`);
  });

  it('wraps the submissions in the body keys of the vendor models', async () => {
    const acknowledgements = [{ purchaseOrderNumber: '4Z32PABC', sellingParty: { partyId: 'API01' }, acknowledgementDate: '2026-11-02T10:00:00Z', items: [] }];
    ok(202);
    await call('amazon_vendor_submit_acknowledgements', { acknowledgements });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${EU}/vendor/orders/v1/acknowledgements`);
    expect(sent().data).toEqual({ acknowledgements });

    const confirmations = [{ shipmentIdentifier: 'SHIP-1', shipmentConfirmationType: 'Original' }];
    ok(202);
    await call('amazon_vendor_submit_shipment_confirmations', { shipment_confirmations: confirmations });
    expect(sent().url).toBe(`${EU}/vendor/shipping/v1/shipmentConfirmations`);
    expect(sent().data).toEqual({ shipmentConfirmations: confirmations });

    ok(202);
    await call('amazon_vendor_submit_invoices', { invoices: [{ invoiceType: 'Invoice', id: 'INV-1' }] });
    expect(sent().url).toBe(`${EU}/vendor/payments/v1/invoices`);
    expect(sent().data).toEqual({ invoices: [{ invoiceType: 'Invoice', id: 'INV-1' }] });

    const orderAcknowledgements = [{ purchaseOrderNumber: '2JK3S9VC', vendorOrderNumber: 'V-1' }];
    ok(202);
    await call('amazon_vendor_acknowledge_df_orders', { order_acknowledgements: orderAcknowledgements });
    expect(sent().url).toBe(`${EU}/vendor/directFulfillment/orders/2021-12-28/acknowledgements`);
    expect(sent().data).toEqual({ orderAcknowledgements });

    ok(202);
    await call('amazon_vendor_submit_df_shipment_confirmations', { shipment_confirmations: [{ purchaseOrderNumber: '2JK3S9VC' }] });
    expect(sent().url).toBe(`${EU}/vendor/directFulfillment/shipping/2021-12-28/shipmentConfirmations`);
    expect(sent().data).toEqual({ shipmentConfirmations: [{ purchaseOrderNumber: '2JK3S9VC' }] });

    const items = [{ vendorProductIdentifier: 'SKU-1', availableQuantity: { amount: 12, unitOfMeasure: 'Each' } }];
    ok(202);
    await call('amazon_vendor_update_df_inventory', { warehouse_id: 'W123', selling_party_id: 'API01', items });
    expect(sent().url).toBe(`${EU}/vendor/directFulfillment/inventory/v1/warehouses/W123/items`);
    expect(sent().data).toEqual({ inventory: { sellingParty: { partyId: 'API01' }, isFullUpdate: false, items } });

    ok(200);
    await call('amazon_vendor_create_df_shipping_labels', { purchase_order_number: '2JK3S9VC', selling_party: { partyId: 'API01' }, ship_from_party: { partyId: 'W123' } });
    expect(sent().url).toBe(`${EU}/vendor/directFulfillment/shipping/2021-12-28/shippingLabels/2JK3S9VC`);
    expect(sent().data).toEqual({ sellingParty: { partyId: 'API01' }, shipFromParty: { partyId: 'W123' } });
  });

  it('requests vendor reports for the marketplace of the connector', async () => {
    ok(202);
    await call('amazon_vendor_create_report', {
      report_type: 'GET_VENDOR_SALES_REPORT',
      data_start_time: '2026-11-01T00:00:00Z',
      data_end_time: '2026-11-07T23:59:59Z',
      report_options: { reportPeriod: 'WEEK', sellingProgram: 'RETAIL', distributorView: 'MANUFACTURING' },
    });
    expect(sent().url).toBe(`${EU}/reports/2021-06-30/reports`);
    expect(sent().data).toEqual({
      reportType: 'GET_VENDOR_SALES_REPORT',
      marketplaceIds: ['A1PA6795UKMFR9'],
      dataStartTime: '2026-11-01T00:00:00Z',
      dataEndTime: '2026-11-07T23:59:59Z',
      reportOptions: { reportPeriod: 'WEEK', sellingProgram: 'RETAIL', distributorView: 'MANUFACTURING' },
    });

    ok();
    await call('amazon_vendor_get_report', { report_id: '51013' });
    expect(sent().url).toBe(`${EU}/reports/2021-06-30/reports/51013`);
  });
});

// Opt-in: RUN_AMAZON_VENDOR_LIVE=1. The refusal check needs no account; the
// read needs the SP-API variables of a private vendor app. Nothing is written.
const live = process.env.RUN_AMAZON_VENDOR_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('amazon-vendor: live', () => {
  it('refuses made-up credentials at Login with Amazon', async () => {
    const response = await liveFetch.post(LWA, 'grant_type=refresh_token&refresh_token=Atzr%7Cnot-a-token&client_id=not-a-client&client_secret=not-a-secret', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
    });
    expect([400, 401]).toContain(response.status);
  });

  it('exchanges the refresh token and reads one page of purchase orders', async () => {
    const { SPAPI_CLIENT_ID: id, SPAPI_CLIENT_SECRET: secret, SPAPI_REFRESH_TOKEN: refresh, SPAPI_ENDPOINT: endpoint } = process.env;
    if (!id || !secret || !refresh || !endpoint) throw new Error('Set SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SPAPI_REFRESH_TOKEN and SPAPI_ENDPOINT for the live check');
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: id, client_secret: secret });
    const token = await liveFetch.post(LWA, form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const orders = await liveFetch.get(`${endpoint}/vendor/orders/v1/purchaseOrders`, {
      headers: { 'x-amz-access-token': token.data.access_token },
      params: { limit: 1, includeDetails: 'false' },
      validateStatus: () => true,
    });
    expect(orders.status).toBe(200);
  });
});
