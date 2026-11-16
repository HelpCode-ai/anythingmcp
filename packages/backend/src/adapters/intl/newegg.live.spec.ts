import axios from 'axios';
import * as adapter from './newegg.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Newegg Marketplace API adapter (Newegg.com).
 *
 * Static checks always run: the two static headers (the API key as
 * Authorization without a scheme, the secret key as SecretKey), the seller ID
 * as the sellerid query parameter of every call, every tool's method and path
 * against Newegg's developer documentation, the search and write bodies
 * (Newegg's reads are PUT or POST requests with a body), and which tools
 * install switched off (order cancellation and RMA processing). No tool
 * requests a shipping label or issues a refund.
 * https://developer.newegg.com/newegg_marketplace_api/
 *
 * Live checks run only with RUN_NEWEGG_LIVE=1. Without credentials they
 * confirm Newegg refuses made-up keys; with NEWEGG_API_KEY, NEWEGG_SECRET_KEY
 * and NEWEGG_SELLER_ID they read the seller status. Reads only.
 *
 *   RUN_NEWEGG_LIVE=1 NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_SELLER_ID=... \
 *     npx jest src/adapters/intl/newegg.live.spec.ts
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

const BASE = 'https://api.newegg.com/marketplace';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['7', 'a'.repeat(31)].join('');
const FAKE_SECRET = ['1B6B', 'c'.repeat(28)].join('-');
const ENV: Record<string, string> = {
  NEWEGG_API_KEY: FAKE_KEY,
  NEWEGG_SECRET_KEY: FAKE_SECRET,
  NEWEGG_SELLER_ID: 'A006',
};

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

// Every tool with its method, its path below the base URL and its required arguments,
// as the vendor documents them.
const EXPECTED: Array<[string, string, string, string[]]> = [
  ['newegg_get_seller_status', 'GET', '/sellermgmt/seller/accountstatus', []],
  ['newegg_list_orders', 'PUT', '/ordermgmt/order/orderinfo', []],
  ['newegg_get_orders', 'PUT', '/ordermgmt/order/orderinfo', ['order_numbers']],
  ['newegg_get_order_status', 'GET', '/ordermgmt/orderstatus/orders/{order_number}', ['order_number']],
  ['newegg_ship_order', 'PUT', '/ordermgmt/orderstatus/orders/{order_number}', ['order_number', 'packages']],
  ['newegg_cancel_order', 'PUT', '/ordermgmt/orderstatus/orders/{order_number}', ['order_number', 'reason_code']],
  ['newegg_confirm_orders_downloaded', 'POST', '/ordermgmt/orderstatus/orders/confirmation', ['order_numbers']],
  ['newegg_list_shipping_carriers', 'GET', '/ordermgmt/order/shipping-carriers', []],
  ['newegg_get_item_inventory', 'PUT', '/contentmgmt/item/international/inventory', ['item_value']],
  ['newegg_get_batch_inventory', 'POST', '/contentmgmt/item/international/inventorylist', ['item_values']],
  ['newegg_get_item_price', 'PUT', '/contentmgmt/item/international/price', ['item_value']],
  ['newegg_update_item_inventory', 'POST', '/contentmgmt/item/international/inventory', ['item_value', 'inventory']],
  ['newegg_update_item_price', 'POST', '/contentmgmt/item/international/price', ['item_value', 'prices']],
  ['newegg_list_rmas', 'PUT', '/servicemgmt/rma/rmainfo', []],
  ['newegg_receive_rma', 'POST', '/servicemgmt/rma/updaterma', ['rma_number']],
  ['newegg_list_courtesy_refunds', 'PUT', '/servicemgmt/courtesyrefund/info', []],
  ['newegg_request_order_list_report', 'POST', '/reportmgmt/report/submitrequest', ['status']],
  ['newegg_request_settlement_summary_report', 'POST', '/reportmgmt/report/submitrequest', ['date_from', 'date_to']],
  ['newegg_request_inventory_report', 'POST', '/reportmgmt/report/submitrequest', []],
  ['newegg_request_price_report', 'POST', '/reportmgmt/report/submitrequest', []],
  ['newegg_get_report_status', 'PUT', '/reportmgmt/report/status', ['request_ids']],
  ['newegg_get_report_result', 'PUT', '/reportmgmt/report/result', ['request_id', 'operation_type']],
];

describe('newegg adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the API key and the secret key as two static headers', () => {
    expect(a.slug).toBe('newegg');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('newegg');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'Authorization',
      apiKey: '{{NEWEGG_API_KEY}}',
      extraHeaders: { SecretKey: '{{NEWEGG_SECRET_KEY}}' },
    });
    expect(a.connector.headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(a.requiredEnvVars).toEqual(['NEWEGG_API_KEY', 'NEWEGG_SECRET_KEY', 'NEWEGG_SELLER_ID']);
    expect(a.envVarMeta.NEWEGG_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.NEWEGG_SECRET_KEY).toMatchObject({ kind: 'credential', secret: true });
    for (const name of a.requiredEnvVars) expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
    for (const bad of ['', 'has space', 'A/06']) expect(new RegExp(a.envVarMeta.NEWEGG_SELLER_ID.pattern!).test(bad)).toBe(false);
  });

  it('adds the seller ID to every call and keeps every path lower case', () => {
    for (const entry of a.tools) {
      expect([entry.name, entry.endpointMapping.queryParams?.sellerid]).toEqual([entry.name, '{{NEWEGG_SELLER_ID}}']);
      expect(entry.endpointMapping.path.replace(/\{\w+\}/g, '')).toBe(entry.endpointMapping.path.replace(/\{\w+\}/g, '').toLowerCase());
      expect(entry.endpointMapping.path).not.toContain('/b2b/');
      expect(entry.endpointMapping.path).not.toContain('/can/');
    }
  });

  it('probes the seller status and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'newegg_get_seller_status', params: {} });
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
    for (const name of mine) expect(name).toMatch(/^newegg_[a-z0-9_]+$/);
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

  it('marks the PUT and POST searches read-only and installs cancellation and RMA processing switched off', () => {
    const READS: string[] = ['newegg_get_batch_inventory', 'newegg_get_item_inventory', 'newegg_get_item_price', 'newegg_get_order_status', 'newegg_get_orders', 'newegg_get_report_result', 'newegg_get_report_status', 'newegg_get_seller_status', 'newegg_list_courtesy_refunds', 'newegg_list_orders', 'newegg_list_rmas', 'newegg_list_shipping_carriers'];
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, READS.includes(entry.name)]);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['newegg_cancel_order', 'newegg_receive_rma']);
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

  it('buys no shipping label and issues no refund', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).not.toContain('shippinglabel');
      expect(entry.endpointMapping.path).not.toContain('newrma');
      expect(JSON.stringify(entry.endpointMapping.bodyMapping ?? {})).not.toContain('IssueCourtesyRefund');
      if (entry.endpointMapping.path.includes('courtesyrefund')) expect(annotationsOf(entry).readOnlyHint).toBe(true);
    }
  });

  it('reads the seller status with both keys in the headers and the seller ID in the query', async () => {
    ok();
    await call('newegg_get_seller_status', {});
    const req = sent();
    expect(req.url).toBe(`${BASE}/sellermgmt/seller/accountstatus`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.params).toEqual({ sellerid: 'A006', version: '307' });
    expect(header(req, 'Authorization')).toBe(FAKE_KEY);
    expect(header(req, 'SecretKey')).toBe(FAKE_SECRET);
    expect(header(req, 'Accept')).toBe('application/json');
  });

  it('searches orders with a PUT request and Newegg\'s request envelope', async () => {
    ok();
    await call('newegg_list_orders', { status: 0, order_date_from: '2026-11-01' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/ordermgmt/order/orderinfo`);
    expect(sent().params).toEqual({ sellerid: 'A006', version: '315' });
    expect(sent().data).toEqual({
      OperationType: 'GetOrderInfoRequest',
      RequestBody: { PageIndex: 1, PageSize: 100, RequestCriteria: { Status: 0, OrderDateFrom: '2026-11-01', OrderDownloaded: 0 } },
    });

    ok();
    await call('newegg_get_orders', { order_numbers: [159243598] });
    expect(sent().data).toEqual({
      OperationType: 'GetOrderInfoRequest',
      RequestBody: { PageIndex: 1, PageSize: 100, RequestCriteria: { OrderNumberList: { OrderNumber: [159243598] } } },
    });

    ok();
    await call('newegg_get_order_status', { order_number: 159243598 });
    expect(String(sent().method).toUpperCase()).toBe('GET');
    expect(sent().url).toBe(`${BASE}/ordermgmt/orderstatus/orders/159243598`);
    expect(sent().params).toEqual({ sellerid: 'A006', version: '304' });
  });

  it('ships and cancels through the order status call with Action 2 and Action 1', async () => {
    const packages = [
      { TrackingNumber: '1Z999', ShipCarrier: 'UPS', ShipService: 'Ground', ItemList: { Item: [{ SellerPartNumber: 'SKU-1', ShippedQty: 1 }] } },
    ];
    ok();
    await call('newegg_ship_order', { order_number: 159243598, packages });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/ordermgmt/orderstatus/orders/159243598`);
    expect(sent().params).toEqual({ sellerid: 'A006' });
    expect(sent().data).toEqual({
      Action: '2',
      Value: { Shipment: { Header: { SellerID: 'A006', SONumber: 159243598 }, PackageList: { Package: packages } } },
    });

    ok();
    await call('newegg_cancel_order', { order_number: 159243598, reason_code: '24' });
    expect(sent().url).toBe(`${BASE}/ordermgmt/orderstatus/orders/159243598`);
    expect(sent().data).toEqual({ Action: '1', Value: '24' });

    ok();
    await call('newegg_confirm_orders_downloaded', { order_numbers: [159243598] });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/ordermgmt/orderstatus/orders/confirmation`);
    expect(sent().data).toEqual({ OperationType: 'OrderConfirmationRequest', RequestBody: { DownloadedOrderList: { OrderNumber: [159243598] } } });
  });

  it('reads and updates inventory and price per item on the international item paths', async () => {
    ok();
    await call('newegg_get_item_inventory', { item_value: 'SKU-1' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/contentmgmt/item/international/inventory`);
    expect(sent().data).toEqual({ Type: 1, Value: 'SKU-1', WarehouseList: { WarehouseLocation: ['USA'] } });

    ok();
    await call('newegg_get_batch_inventory', { item_values: ['SKU-1', 'SKU-2'] });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/contentmgmt/item/international/inventorylist`);
    expect(sent().data).toEqual({ Type: 1, Values: ['SKU-1', 'SKU-2'] });

    ok();
    await call('newegg_get_item_price', { item_value: '9SIA0060884598', id_type: 0 });
    expect(sent().url).toBe(`${BASE}/contentmgmt/item/international/price`);
    expect(sent().data).toEqual({ Type: 0, Value: '9SIA0060884598', CountryList: { CountryCode: ['USA'] } });

    ok();
    await call('newegg_update_item_inventory', { item_value: 'SKU-1', inventory: [{ WarehouseLocation: 'USA', AvailableQuantity: 5 }] });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/contentmgmt/item/international/inventory`);
    expect(sent().data).toEqual({ Type: 1, Value: 'SKU-1', InventoryList: { Inventory: [{ WarehouseLocation: 'USA', AvailableQuantity: 5 }] } });

    ok();
    await call('newegg_update_item_price', { item_value: 'SKU-1', prices: [{ CountryCode: 'USA', Currency: 'USD', SellingPrice: 19.99 }] });
    expect(sent().url).toBe(`${BASE}/contentmgmt/item/international/price`);
    expect(sent().data).toEqual({ Type: 1, Value: 'SKU-1', PriceList: { Price: [{ CountryCode: 'USA', Currency: 'USD', SellingPrice: 19.99 }] } });
  });

  it('requests, follows and reads reports', async () => {
    ok();
    await call('newegg_request_settlement_summary_report', { date_from: '2026-10-01', date_to: '2026-10-31' });
    expect(sent().url).toBe(`${BASE}/reportmgmt/report/submitrequest`);
    expect(sent().data).toEqual({
      OperationType: 'SettlementSummaryReportRequest',
      RequestBody: { SettlementSummaryReportCriteria: { RequestType: 'SETTLEMENT_SUMMARY_REPORT', DateFrom: '2026-10-01', DateTo: '2026-10-31' } },
    });

    ok();
    await call('newegg_get_report_status', { request_ids: ['2PQBYWH4V68ZP'] });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/reportmgmt/report/status`);
    expect(sent().data).toEqual({
      OperationType: 'GetReportStatusRequest',
      RequestBody: { GetRequestStatus: { RequestIDList: { RequestID: ['2PQBYWH4V68ZP'] }, MaxCount: 100 } },
    });

    ok();
    await call('newegg_get_report_result', { request_id: '2PQBYWH4V68ZP', operation_type: 'OrderListReportRequest' });
    expect(sent().url).toBe(`${BASE}/reportmgmt/report/result`);
    expect(sent().params).toEqual({ sellerid: 'A006', version: '306' });
    expect(sent().data).toEqual({ OperationType: 'OrderListReportRequest', RequestBody: { RequestID: '2PQBYWH4V68ZP', PageInfo: { PageSize: 100, PageIndex: 1 } } });

    ok();
    await call('newegg_list_rmas', { keywords_type: 2, keywords_value: '159243598' });
    expect(sent().url).toBe(`${BASE}/servicemgmt/rma/rmainfo`);
    expect(sent().params).toEqual({ sellerid: 'A006', version: '309' });
    expect(sent().data).toEqual({
      OperationType: 'GetRMAInfoRequest',
      RequestBody: { PageInfo: { PageIndex: 1, PageSize: 100 }, KeywordsType: 2, KeywordsValue: '159243598', Status: 0 },
    });
  });
});

// Opt-in: RUN_NEWEGG_LIVE=1. The refusal check needs no account; the read
// needs the three variables. Nothing is written.
const live = process.env.RUN_NEWEGG_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('newegg: live', () => {
  it('refuses made-up keys', async () => {
    const response = await liveFetch.get(`${BASE}/sellermgmt/seller/accountstatus`, {
      params: { sellerid: 'A006' },
      headers: { Authorization: 'not-a-key', SecretKey: 'not-a-secret', Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect([400, 401, 403]).toContain(response.status);
  });

  it('reads the seller status', async () => {
    const key = process.env.NEWEGG_API_KEY;
    const secret = process.env.NEWEGG_SECRET_KEY;
    const seller = process.env.NEWEGG_SELLER_ID;
    if (!key || !secret || !seller) throw new Error('Set NEWEGG_API_KEY, NEWEGG_SECRET_KEY and NEWEGG_SELLER_ID for the live check');
    const response = await liveFetch.get(`${BASE}/sellermgmt/seller/accountstatus`, {
      params: { sellerid: seller, version: '307' },
      headers: { Authorization: key, SecretKey: secret, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(response.data.SellerID).toBe(seller);
  });
});
