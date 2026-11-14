import axios from 'axios';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import * as adapter from './walmart-marketplace.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Walmart Marketplace API adapter (US marketplace).
 *
 * Static checks always run: the client-credentials token call through
 * LOGIN_TOKEN (POST /v3/token with HTTP Basic, the form body
 * grant_type=client_credentials, WM_SVC.NAME and a fresh
 * WM_QOS.CORRELATION_ID), the token sent raw in WM_SEC.ACCESS_TOKEN with a new
 * correlation id on every call, every tool's method and path against the
 * Walmart US Marketplace API reference
 * (https://developer.walmart.com/us-marketplace/reference), the request
 * bodies of the writes, the nextCursor paging, and which tools install
 * switched off (cancellation, refunds, retiring items, bulk feeds). No tool
 * moves money unless a seller switches a refund tool on.
 *
 * Live checks run only with RUN_WALMART_MARKETPLACE_LIVE=1. Without
 * credentials they confirm the token endpoint refuses wrong credentials; with
 * WALMART_CLIENT_ID and WALMART_CLIENT_SECRET they sign in through the real
 * LoginTokenService and read orders, the item count and the ship nodes.
 * Reads only.
 *
 *   RUN_WALMART_MARKETPLACE_LIVE=1 WALMART_CLIENT_ID=... WALMART_CLIENT_SECRET=... \
 *     npx jest src/adapters/intl/walmart-marketplace.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; pattern?: string }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
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
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, any>; headers?: Record<string, string> };
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

const BASE = 'https://marketplace.walmartapis.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Built at runtime so no literal looks like a real credential.
const FAKE_SECRET = ['Wm', 'z'.repeat(30), '_-9'].join('');
const FAKE_TOKEN = ['eyJraWQiOiJ0ZXN0', 'x'.repeat(24)].join('.');
const ENV: Record<string, string> = {
  WALMART_CLIENT_ID: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
  WALMART_CLIENT_SECRET: FAKE_SECRET,
};
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
const stubLogin = (token = FAKE_TOKEN) => {
  const bundle = async () => ({ token, expiresAt: Date.now() + 900_000 });
  return { getToken: bundle, forceRelogin: bundle } as unknown as LoginTokenService;
};

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>, login: LoginTokenService = stubLogin()) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, login).execute(
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

// Every tool, its HTTP method and path, from the US Marketplace API reference.
const ROUTES: Record<string, string> = {
  walmart_marketplace_list_orders: 'GET /v3/orders',
  walmart_marketplace_list_released_orders: 'GET /v3/orders/released',
  walmart_marketplace_get_order: 'GET /v3/orders/{purchase_order_id}',
  walmart_marketplace_acknowledge_order: 'POST /v3/orders/{purchase_order_id}/acknowledge',
  walmart_marketplace_ship_order_line: 'POST /v3/orders/{purchase_order_id}/shipping',
  walmart_marketplace_cancel_order_line: 'POST /v3/orders/{purchase_order_id}/cancel',
  walmart_marketplace_refund_order_lines: 'POST /v3/orders/{purchase_order_id}/refund',
  walmart_marketplace_list_returns: 'GET /v3/returns',
  walmart_marketplace_refund_return: 'POST /v3/returns/{return_order_id}/refund',
  walmart_marketplace_list_items: 'GET /v3/items',
  walmart_marketplace_get_item: 'GET /v3/items/{id}',
  walmart_marketplace_search_my_catalog: 'POST /v3/items/catalog/search',
  walmart_marketplace_search_walmart_catalog: 'GET /v3/items/walmart/search',
  walmart_marketplace_count_items: 'GET /v3/items/count',
  walmart_marketplace_retire_item: 'DELETE /v3/items/{sku}',
  walmart_marketplace_get_inventory: 'GET /v3/inventory',
  walmart_marketplace_get_inventory_by_ship_node: 'GET /v3/inventories/{sku}',
  walmart_marketplace_update_inventory: 'PUT /v3/inventory',
  walmart_marketplace_get_wfs_inventory: 'GET /v3/wfs/inventory',
  walmart_marketplace_update_price: 'PUT /v3/price',
  walmart_marketplace_get_promotional_prices: 'GET /v3/promo/sku/{sku}',
  walmart_marketplace_submit_item_feed: 'POST /v3/feeds',
  walmart_marketplace_submit_price_feed: 'POST /v3/feeds',
  walmart_marketplace_list_feeds: 'GET /v3/feeds',
  walmart_marketplace_get_feed_status: 'GET /v3/feeds/{feed_id}',
  walmart_marketplace_request_report: 'POST /v3/reports/reportRequests',
  walmart_marketplace_list_report_requests: 'GET /v3/reports/reportRequests',
  walmart_marketplace_get_report_request: 'GET /v3/reports/reportRequests/{request_id}',
  walmart_marketplace_get_report_download_url: 'GET /v3/reports/downloadReport',
  walmart_marketplace_list_inbound_shipments: 'GET /v3/fulfillment/inbound-shipments',
  walmart_marketplace_list_inbound_shipment_items: 'GET /v3/fulfillment/inbound-shipment-items',
  walmart_marketplace_create_inbound_shipment_label: 'POST /v3/fulfillment/shipment-label',
  walmart_marketplace_list_ship_nodes: 'GET /v3/settings/shipping/shipnodes',
  walmart_marketplace_list_carrier_methods: 'GET /v3/settings/shipping/carriers',
  walmart_marketplace_list_shipping_templates: 'GET /v3/settings/shipping/templates',
  walmart_marketplace_get_lag_time: 'GET /v3/lagtime',
};
const SWITCHED_OFF = [
  'walmart_marketplace_cancel_order_line',
  'walmart_marketplace_refund_order_lines',
  'walmart_marketplace_refund_return',
  'walmart_marketplace_retire_item',
  'walmart_marketplace_submit_item_feed',
  'walmart_marketplace_submit_price_feed',
];

describe('walmart-marketplace adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in at /v3/token with LOGIN_TOKEN and sends the token raw in WM_SEC.ACCESS_TOKEN', () => {
    expect(a.slug).toBe('walmart-marketplace');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('walmart-marketplace');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toEqual({
      loginUrl: `${BASE}/v3/token`,
      loginMethod: 'POST',
      loginBasicAuth: true,
      username: '{{WALMART_CLIENT_ID}}',
      password: '{{WALMART_CLIENT_SECRET}}',
      loginBody: 'grant_type=client_credentials',
      loginHeaders: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'WM_SVC.NAME': 'AnythingMCP',
        'WM_QOS.CORRELATION_ID': '${uuid}',
      },
      tokenJsonPath: 'access_token',
      tokenTTLSeconds: 900,
      proactiveRefreshSeconds: 120,
      refreshOn401: true,
      headerName: 'WM_SEC.ACCESS_TOKEN',
      headerTemplate: '${token}',
      extraHeaders: { 'WM_SVC.NAME': 'AnythingMCP', 'WM_QOS.CORRELATION_ID': '${uuid}' },
    });
    expect(a.connector.headers).toMatchObject({ Accept: 'application/json' });
    expect(a.requiredEnvVars).toEqual(['WALMART_CLIENT_ID', 'WALMART_CLIENT_SECRET']);
    expect(a.envVarMeta.WALMART_CLIENT_ID).toMatchObject({ kind: 'credential' });
    expect(a.envVarMeta.WALMART_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true });
    for (const meta of Object.values(a.envVarMeta)) expect(meta.link).toMatch(/^https:\/\/developer\.walmart\.com\//);
    expect(new RegExp(a.envVarMeta.WALMART_CLIENT_ID.pattern!).test(ENV.WALMART_CLIENT_ID)).toBe(true);
    expect(new RegExp(a.envVarMeta.WALMART_CLIENT_SECRET.pattern!).test(ENV.WALMART_CLIENT_SECRET)).toBe(true);
    for (const bad of ['', 'has space here 123456']) expect(new RegExp(a.envVarMeta.WALMART_CLIENT_SECRET.pattern!).test(bad)).toBe(false);
  });

  it('posts grant_type=client_credentials as a form with Basic credentials and a fresh correlation id', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as any;
    mockedAxios.mockResolvedValueOnce({ data: { access_token: FAKE_TOKEN, token_type: 'Bearer', expires_in: 900 }, headers: {} });
    const bundle = await new LoginTokenService({} as PrismaService, config).getToken(auth);
    const login = sent();
    expect(String(login.method).toUpperCase()).toBe('POST');
    expect(login.url).toBe(`${BASE}/v3/token`);
    expect(login.data).toBe('grant_type=client_credentials');
    expect(String(login.data)).not.toContain(FAKE_SECRET);
    expect(login.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(login.headers.Accept).toBe('application/json');
    expect(login.headers.Authorization).toBe(`Basic ${Buffer.from(`${ENV.WALMART_CLIENT_ID}:${FAKE_SECRET}`).toString('base64')}`);
    expect(login.headers['WM_SVC.NAME']).toBe('AnythingMCP');
    expect(login.headers['WM_QOS.CORRELATION_ID']).toMatch(UUID_RE);
    expect(bundle.token).toBe(FAKE_TOKEN);
    expect(bundle.expiresAt - Date.now()).toBeLessThanOrEqual(900_000);
  });

  it('sends the token, the service name and a new correlation id on every call, and no Authorization header', async () => {
    ok();
    await call('walmart_marketplace_list_ship_nodes', {});
    const first = sent();
    ok();
    await call('walmart_marketplace_list_ship_nodes', {});
    const second = sent();
    for (const req of [first, second]) {
      expect(header(req, 'WM_SEC.ACCESS_TOKEN')).toBe(FAKE_TOKEN);
      expect(header(req, 'WM_SVC.NAME')).toBe('AnythingMCP');
      expect(header(req, 'WM_QOS.CORRELATION_ID')).toMatch(UUID_RE);
      expect(header(req, 'Accept')).toBe('application/json');
      expect(header(req, 'Authorization')).toBeUndefined();
    }
    expect(header(first, 'WM_QOS.CORRELATION_ID')).not.toBe(header(second, 'WM_QOS.CORRELATION_ID'));
  });

  it('probes the order list and explains 400, 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'walmart_marketplace_list_orders', params: { limit: 1 } });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to the documented method and path', () => {
    const actual = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(actual).toEqual(ROUTES);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^walmart_marketplace_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      const reads = used(entry);
      for (const arg of reads) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const arg of declared) expect(reads.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(60);
      for (const [name, prop] of Object.entries(entry.parameters.properties ?? {})) {
        expect(`${entry.name}.${name}: ${prop.description ?? ''}`.length).toBeGreaterThan(entry.name.length + name.length + 12);
      }
    }
  });

  it('marks reads read-only, installs cancellation, refunds, retiring and bulk feeds switched off', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET' || entry.name === 'walmart_marketplace_search_my_catalog';
      expect(`${entry.name}:${annotationsOf(entry).readOnlyHint}`).toBe(`${entry.name}:${read}`);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([...SWITCHED_OFF].sort());
    for (const entry of a.tools) {
      const p = entry.endpointMapping.path;
      if (/refund|cancel/.test(p) || entry.endpointMapping.method === 'DELETE' || (p === '/v3/feeds' && entry.endpointMapping.method === 'POST')) {
        expect(entry.enabled).toBe(false);
      }
      // No payments, settlement downloads or carrier-label purchases.
      expect(p).not.toMatch(/payment|recon|statement|shipping\/labels|carrier-label|carrier-rate/);
    }
  });

  it('names every tool and the setup facts in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(1500);
    for (const fact of ['US marketplace', 'Canada', 'Mexico', 'developer.walmart.com', 'API Keys', '15 minutes', '30 April 2027', 'Created, Acknowledged, Shipped, Delivered', 'Cancelled', 'per day']) {
      expect(a.instructions).toContain(fact);
    }
  });

  it('lists orders with Walmart query names and pages with nextCursor as given', async () => {
    ok();
    await call('walmart_marketplace_list_orders', { status: 'Created', created_start_date: '2026-11-01', limit: 50, product_info: true });
    expect(sent().url).toBe(`${BASE}/v3/orders`);
    expect(String(sent().method).toUpperCase()).toBe('GET');
    expect(sent().params).toEqual({ status: 'Created', createdStartDate: '2026-11-01', limit: 50, productInfo: true });

    ok();
    await call('walmart_marketplace_list_orders', {
      next_cursor: '?limit=10&hasMoreElements=true&soIndex=31&poIndex=10&partnerId=100009&sellerId=8&createdStartDate=2026-11-01',
    });
    expect(sent().url).toBe(`${BASE}/v3/orders`);
    expect(sent().params).toEqual({
      limit: '10',
      hasMoreElements: 'true',
      soIndex: '31',
      poIndex: '10',
      partnerId: '100009',
      sellerId: '8',
      createdStartDate: '2026-11-01',
    });

    ok();
    await call('walmart_marketplace_list_released_orders', {});
    expect(sent().url).toBe(`${BASE}/v3/orders/released`);
    expect(sent().params).toEqual({});

    ok();
    await call('walmart_marketplace_list_returns', { next_cursor: '?sellerId=151&limit=10&offset=10' });
    expect(sent().url).toBe(`${BASE}/v3/returns`);
    expect(sent().params).toEqual({ sellerId: '151', limit: '10', offset: '10' });
  });

  it('reads orders, items, inventory, prices, feeds, reports and settings on the documented paths', async () => {
    ok();
    await call('walmart_marketplace_get_order', { purchase_order_id: '1796277083022' });
    expect(sent().url).toBe(`${BASE}/v3/orders/1796277083022`);

    ok();
    await call('walmart_marketplace_get_item', { id: 'SKU/1 #A' });
    expect(sent().url).toBe(`${BASE}/v3/items/SKU%2F1%20%23A`);

    ok();
    await call('walmart_marketplace_list_items', { published_status: 'UNPUBLISHED', limit: 200, next_cursor: '*' });
    expect(sent().params).toEqual({ publishedStatus: 'UNPUBLISHED', limit: 200, nextCursor: '*' });

    ok();
    await call('walmart_marketplace_count_items', {});
    expect(sent().url).toBe(`${BASE}/v3/items/count`);
    expect(sent().params).toEqual({ status: 'ALL' });

    ok();
    await call('walmart_marketplace_search_walmart_catalog', { upc: '012345678905' });
    expect(sent().params).toEqual({ upc: '012345678905' });

    ok();
    await call('walmart_marketplace_search_my_catalog', {
      query: { field: 'productName', value: 'lamp*' },
      filters: [{ field: 'publishedStatus', op: 'equals', values: ['UNPUBLISHED'] }],
      limit: 20,
    });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().params).toEqual({ limit: 20 });
    expect(sent().data).toEqual({
      query: { field: 'productName', value: 'lamp*' },
      filters: [{ field: 'publishedStatus', op: 'equals', values: ['UNPUBLISHED'] }],
    });

    ok();
    await call('walmart_marketplace_get_inventory', { sku: 'A&B 1' });
    expect(sent().url).toBe(`${BASE}/v3/inventory`);
    expect(sent().params).toEqual({ sku: 'A&B 1' });
    expect(sent().paramsSerializer(sent().params)).toContain('sku=A%26B');

    ok();
    await call('walmart_marketplace_get_inventory_by_ship_node', { sku: 'SKU-1' });
    expect(sent().url).toBe(`${BASE}/v3/inventories/SKU-1`);

    ok();
    await call('walmart_marketplace_get_promotional_prices', { sku: 'SKU-1' });
    expect(sent().url).toBe(`${BASE}/v3/promo/sku/SKU-1`);

    ok();
    await call('walmart_marketplace_get_feed_status', { feed_id: '1234@AB' });
    expect(sent().url).toBe(`${BASE}/v3/feeds/1234%40AB`);
    expect(sent().params).toEqual({ includeDetails: true });

    ok();
    await call('walmart_marketplace_get_report_download_url', { request_id: 'req-1' });
    expect(sent().url).toBe(`${BASE}/v3/reports/downloadReport`);
    expect(sent().params).toEqual({ requestId: 'req-1' });

    ok();
    await call('walmart_marketplace_get_lag_time', { sku: 'SKU-1' });
    expect(sent().url).toBe(`${BASE}/v3/lagtime`);
    expect(sent().params).toEqual({ sku: 'SKU-1' });
  });

  it('builds the acknowledge, ship and cancel requests as Walmart documents them', async () => {
    ok();
    await call('walmart_marketplace_acknowledge_order', { purchase_order_id: '1796277083022' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/v3/orders/1796277083022/acknowledge`);
    expect(sent().data ?? {}).toEqual({});

    ok();
    await call('walmart_marketplace_ship_order_line', {
      purchase_order_id: '1796277083022',
      line_number: '1',
      ship_date_time: 1763116800000,
      carrier: 'UPS',
      tracking_number: '1Z97Y4430300463366',
    });
    expect(sent().url).toBe(`${BASE}/v3/orders/1796277083022/shipping`);
    expect(sent().data).toEqual({
      orderShipment: {
        orderLines: {
          orderLine: [
            {
              lineNumber: '1',
              orderLineStatuses: {
                orderLineStatus: [
                  {
                    status: 'Shipped',
                    statusQuantity: { unitOfMeasurement: 'EACH', amount: '1' },
                    trackingInfo: {
                      shipDateTime: 1763116800000,
                      carrierName: { carrier: 'UPS' },
                      methodCode: 'Standard',
                      trackingNumber: '1Z97Y4430300463366',
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    ok();
    await call('walmart_marketplace_cancel_order_line', {
      purchase_order_id: '1796277083022',
      line_number: '2',
      reason: 'SELLER_CANCEL_OUT_OF_STOCK',
    });
    expect(sent().url).toBe(`${BASE}/v3/orders/1796277083022/cancel`);
    expect(sent().data).toEqual({
      orderCancellation: {
        orderLines: {
          orderLine: [
            {
              lineNumber: '2',
              orderLineStatuses: {
                orderLineStatus: [
                  {
                    status: 'Cancelled',
                    cancellationReason: 'SELLER_CANCEL_OUT_OF_STOCK',
                    statusQuantity: { unitOfMeasurement: 'EACH', amount: '1' },
                  },
                ],
              },
            },
          ],
        },
      },
    });
  });

  it('builds the inventory, price, feed, report and label bodies as Walmart documents them', async () => {
    ok();
    await call('walmart_marketplace_update_inventory', { sku: 'SKU-1', amount: 12 });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/v3/inventory`);
    expect(sent().params).toEqual({ sku: 'SKU-1' });
    expect(sent().data).toEqual({ sku: 'SKU-1', quantity: { unit: 'EACH', amount: 12 } });

    ok();
    await call('walmart_marketplace_update_price', { sku: 'SKU-1', amount: 19.99 });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().data).toEqual({ sku: 'SKU-1', pricing: [{ currentPriceType: 'BASE', currentPrice: { currency: 'USD', amount: 19.99 } }] });

    const priceFeed = {
      MPItemFeedHeader: { businessUnit: 'WALMART_US', locale: 'en', version: '2.0.20240126-12_25_52-api' },
      MPItem: [{ 'Promo&Discount': { sku: 'SKU-1', price: 19.99 } }],
    };
    ok();
    await call('walmart_marketplace_submit_price_feed', { feed: priceFeed });
    expect(sent().url).toBe(`${BASE}/v3/feeds`);
    expect(sent().params).toEqual({ feedType: 'PRICE_AND_PROMOTION' });
    expect(sent().data).toEqual(priceFeed);

    ok();
    await call('walmart_marketplace_submit_item_feed', { feed_type: 'MP_MAINTENANCE', feed: { MPItemFeedHeader: { version: '5.0' }, MPItem: [] } });
    expect(sent().params).toEqual({ feedType: 'MP_MAINTENANCE' });
    expect(sent().data).toEqual({ MPItemFeedHeader: { version: '5.0' }, MPItem: [] });

    ok();
    await call('walmart_marketplace_request_report', { report_type: 'ITEM', exclude_columns: ['Shelf Name'] });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().params).toEqual({ reportType: 'ITEM', reportVersion: 'v1' });
    expect(sent().data).toEqual({ excludeColumns: ['Shelf Name'] });

    ok();
    await call('walmart_marketplace_refund_return', {
      return_order_id: '103738048909818825',
      customer_order_id: '1535274411287',
      refund_lines: [{ returnOrderLineNumber: 1, quantity: { unitOfMeasure: 'EA', measurementValue: 1 } }],
    });
    expect(sent().url).toBe(`${BASE}/v3/returns/103738048909818825/refund`);
    expect(sent().data).toEqual({
      customerOrderId: '1535274411287',
      refundLines: [{ returnOrderLineNumber: 1, quantity: { unitOfMeasure: 'EA', measurementValue: 1 } }],
    });

    ok();
    await call('walmart_marketplace_create_inbound_shipment_label', { shipment_id: 'SHIP-1', load_types: [{ loadType: 'BOX', count: 2 }] });
    expect(sent().url).toBe(`${BASE}/v3/fulfillment/shipment-label`);
    expect(sent().data).toEqual({ shipmentId: 'SHIP-1', labelSize: 'X4_6', labelFormat: 'PDF', loadTypes: [{ loadType: 'BOX', count: 2 }] });
    expect(header(sent(), 'Accept')).toContain('application/pdf');
  });
});

// Opt-in: RUN_WALMART_MARKETPLACE_LIVE=1. The refusal check needs no account;
// the reads need WALMART_CLIENT_ID and WALMART_CLIENT_SECRET. Nothing is written.
const live = process.env.RUN_WALMART_MARKETPLACE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('walmart-marketplace: live', () => {
  const wmHeaders = () => ({
    Accept: 'application/json',
    'WM_SVC.NAME': 'AnythingMCP',
    'WM_QOS.CORRELATION_ID': randomUUID(),
  });

  it('refuses wrong client credentials at the token endpoint', async () => {
    const response = await liveFetch.post(`${BASE}/v3/token`, 'grant_type=client_credentials', {
      headers: {
        ...wmHeaders(),
        Authorization: `Basic ${Buffer.from('not-a-client:not-a-secret').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      validateStatus: () => true,
    });
    expect([400, 401]).toContain(response.status);
  });

  it('signs in through LoginTokenService and reads orders, the item count and the ship nodes', async () => {
    const id = process.env.WALMART_CLIENT_ID;
    const secret = process.env.WALMART_CLIENT_SECRET;
    if (!id || !secret) throw new Error('Set WALMART_CLIENT_ID and WALMART_CLIENT_SECRET for the live check');
    mockedAxios.mockImplementation((cfg: unknown) => (liveFetch as unknown as (c: unknown) => Promise<unknown>)(cfg));
    const env = { WALMART_CLIENT_ID: id, WALMART_CLIENT_SECRET: secret };
    const login = new LoginTokenService(
      { connectorAuthCache: { findUnique: async () => null, upsert: async () => ({}) } } as unknown as PrismaService,
      config,
    );
    const bundle = await login.getToken(interpolateDeep(a.connector.authConfig, env) as never);
    expect(bundle.token.length).toBeGreaterThan(20);
    const token = { 'WM_SEC.ACCESS_TOKEN': bundle.token };
    for (const [path, params] of [
      ['/v3/orders', { limit: 1 }],
      ['/v3/items/count', { status: 'ALL' }],
      ['/v3/settings/shipping/shipnodes', {}],
    ] as const) {
      const response = await liveFetch.get(`${BASE}${path}`, { headers: { ...wmHeaders(), ...token }, params, validateStatus: () => true });
      expect(`${path} ${response.status}`).toBe(`${path} 200`);
    }
    mockedAxios.mockReset();
  });
});
