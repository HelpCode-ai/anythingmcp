import axios from 'axios';
import * as adapter from './target-plus.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Target Plus marketplace adapter (sellers-v1, seller_orders-v1, item_taxonomies-v2).
 *
 * Target's own reference (plus.target.com/docs) needs a Partner Portal login.
 * The three OpenAPI documents are mirrored publicly in the generated-client
 * repository github.com/acksession/marketplace-api-clients; SPEC below lists
 * every operation of those documents (method, path under api.target.com, and
 * its query parameters), and every tool is checked against it.
 *
 * Static checks always run: the three auth headers (x-api-key, x-seller-id,
 * x-seller-token), the seller id from the connector variable in every seller
 * path, each tool's method, path and query names against SPEC, the write
 * bodies, the multipart report request, and which tools install switched off.
 * Orders use seller_orders-v1: the order calls of sellers-v1 are deprecated
 * since 29 February 2024.
 *
 * Live checks run only with RUN_TARGET_PLUS_LIVE=1. Without credentials they
 * confirm api.target.com refuses a made-up key; with TARGET_PLUS_API_KEY,
 * TARGET_PLUS_SELLER_ID and TARGET_PLUS_SELLER_TOKEN they read the
 * distribution centers, one page of orders and the shipping methods. Reads only.
 *
 *   RUN_TARGET_PLUS_LIVE=1 TARGET_PLUS_API_KEY=... TARGET_PLUS_SELLER_ID=... \
 *     TARGET_PLUS_SELLER_TOKEN=... npx jest src/adapters/intl/target-plus.live.spec.ts
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
    bodyEncoding?: string;
    headers?: Record<string, string>;
    exposeHeaders?: string[];
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

// Every operation of the three mirrored OpenAPI documents: "METHOD path" under
// https://api.target.com, with the query parameters each one declares.
const SPEC: Record<string, string[]> = {
  'GET /sellers/v1/protected_legalizations': ['page', 'per_page', 'sort', 'type', 'attribute_id'],
  'GET /sellers/v1/sellers/{seller_id}/distribution_centers': [],
  'GET /sellers/v1/sellers/{seller_id}/distribution_centers/{distribution_center_id}': [],
  'GET /sellers/v1/sellers/{seller_id}/distribution_centers/{distribution_center_id}/ship_nodes': [],
  'GET /sellers/v1/sellers/{seller_id}/distribution_centers/{distribution_center_id}/ship_nodes/{ship_node_id}': [],
  'GET /sellers/v1/sellers/{seller_id}/legalizations': ['page', 'per_page', 'sort', 'type'],
  'GET /sellers/v1/sellers/{seller_id}/prices/{product_id}': [],
  'PUT /sellers/v1/sellers/{seller_id}/prices/{product_id}': [],
  'GET /sellers/v1/sellers/{seller_id}/product_catalog_errors': ['after_id', 'createdDateSearch', 'lastModifiedDateSearch', 'listing_status', 'tcin', 'externalIds', 'error_severity', 'parentId'],
  'GET /sellers/v1/sellers/{seller_id}/product_logistics/{product_id}': [],
  'PUT /sellers/v1/sellers/{seller_id}/product_logistics/{product_id}': [],
  'GET /sellers/v1/sellers/{seller_id}/product_returns': ['order_id', 'order_number', 'tcin', 'page', 'per_page', 'sort'],
  'GET /sellers/v1/sellers/{seller_id}/product_returns/{product_return_id}': [],
  'GET /sellers/v1/sellers/{seller_id}/product_returns_search': ['order_id', 'order_number', 'return_order_number', 'tcin', 'license_plate', 'tracking_number', 'bill_of_lading', 'receiving_location_id', 'return_date', 'is_online', 'location_id', 'after_id', 'page', 'per_page', 'sort'],
  'POST /sellers/v1/sellers/{seller_id}/product_variation_update': [],
  'POST /sellers/v1/sellers/{seller_id}/products': [],
  'GET /sellers/v1/sellers/{seller_id}/products/{product_id}': ['expand', 'fields'],
  'PUT /sellers/v1/sellers/{seller_id}/products/{product_id}': [],
  'GET /sellers/v1/sellers/{seller_id}/products/{product_id}/quantities': [],
  'PUT /sellers/v1/sellers/{seller_id}/products/{product_id}/quantities/bulk': [],
  'GET /sellers/v1/sellers/{seller_id}/products/{product_id}/quantities/{distribution_center_id}': [],
  'PUT /sellers/v1/sellers/{seller_id}/products/{product_id}/quantities/{distribution_center_id}': [],
  'PUT /sellers/v1/sellers/{seller_id}/products/{product_id}/statuses/{product_status_id}': [],
  'PUT /sellers/v1/sellers/{seller_id}/products/{product_id}:unlist': [],
  'GET /sellers/v1/sellers/{seller_id}/products_catalog': ['expand', 'fields', 'last_modified', 'listing_status', 'tcin', 'external_id', 'after_id', 'per_page'],
  'GET /sellers/v1/sellers/{seller_id}/report_requests': ['type', 'format', 'created_by', 'page', 'per_page'],
  'POST /sellers/v1/sellers/{seller_id}/report_requests': [],
  'DELETE /sellers/v1/sellers/{seller_id}/report_requests/{report_request_id}': [],
  'GET /sellers/v1/sellers/{seller_id}/report_requests/{report_request_id}': [],
  'GET /sellers/v1/sellers/{seller_id}/return_disputes': ['case_id', 'return_order_number', 'order_id', 'judgement', 'dispute_reason', 'final_response', 'last_modified', 'page', 'per_page', 'sort'],
  'GET /sellers/v1/sellers/{seller_id}/return_disputes/{return_dispute_id}': [],
  'GET /sellers/v1/sellers/{seller_id}/return_policies': ['status'],
  'GET /seller_orders/v1/sellers/{seller_id}/order_addresses': ['page', 'per_page', 'sort'],
  'GET /seller_orders/v1/sellers/{seller_id}/order_addresses/{order_id}': [],
  'PUT /seller_orders/v1/sellers/{seller_id}/order_statuses/{order_id}': [],
  'GET /seller_orders/v1/sellers/{seller_id}/orders': ['q', 'order_status', 'ship_advice_number', 'order_number', 'tcin', 'order_date', 'requested_shipment_date', 'ship_node_id', 'page', 'per_page', 'sort'],
  'GET /seller_orders/v1/sellers/{seller_id}/orders/{order_id}': [],
  'POST /seller_orders/v1/sellers/{seller_id}/orders/{order_id}/bulk_fulfillments_create': [],
  'PUT /seller_orders/v1/sellers/{seller_id}/orders/{order_id}/bulk_fulfillments_update': [],
  'GET /seller_orders/v1/sellers/{seller_id}/orders/{order_id}/fulfillments': [],
  'PUT /seller_orders/v1/sellers/{seller_id}/orders/{order_id}/order_lines/{order_line_id}': [],
  'GET /seller_orders/v1/shipping_methods': ['page', 'per_page', 'sort'],
  'GET /item_taxonomies/v2/assignments': ['attribute_id', 'taxonomy_id', 'item_type_id', 'value_group_id', 'target', 'attribute_group', 'page', 'per_page', 'sort'],
  'GET /item_taxonomies/v2/assignments/{assignment_id}': [],
  'GET /item_taxonomies/v2/attribute_values': ['attribute_id', 'taxonomy_id', 'name', 'name_search_type', 'target', 'value_group_id', 'page', 'per_page', 'sort'],
  'GET /item_taxonomies/v2/attribute_values/{attribute_value_id}': [],
  'GET /item_taxonomies/v2/attributes': ['name', 'name_search_type', 'type', 'attribute_group', 'value_group_id', 'mapped_property', 'page', 'per_page', 'sort'],
  'GET /item_taxonomies/v2/attributes/{attribute_id}': [],
  'GET /item_taxonomies/v2/items': ['taxonomy_id', 'attribute_id', 'value_id', 'page', 'per_page'],
  'GET /item_taxonomies/v2/items/{tcin}': [],
  'GET /item_taxonomies/v2/taxonomies': ['name', 'name_search_type', 'type', 'target', 'replacement_id', 'id', 'parent_id', 'depth', 'status', 'page', 'per_page', 'sort'],
  'GET /item_taxonomies/v2/taxonomies/{taxonomy_id}': [],
  'GET /item_taxonomies/v2/value_groups': ['attribute_id', 'taxonomy_id', 'target', 'name', 'name_search_type', 'include_aliases', 'value_id', 'page', 'per_page', 'sort'],
  'GET /item_taxonomies/v2/value_groups/{value_group_id}': [],
};

// Request body properties the specs define for the write operations the tools use.
const BODY: Record<string, string[]> = {
  'POST /sellers/v1/sellers/{seller_id}/products': ['external_id', 'relationship_type', 'fields'],
  'PUT /sellers/v1/sellers/{seller_id}/products/{product_id}': ['external_id', 'relationship_type', 'fields'],
  'POST /sellers/v1/sellers/{seller_id}/product_variation_update': ['parent', 'children'],
  'PUT /sellers/v1/sellers/{seller_id}/prices/{product_id}': ['list_price', 'offer_price', 'map_price'],
  'PUT /sellers/v1/sellers/{seller_id}/products/{product_id}/quantities/{distribution_center_id}': ['quantity'],
  'PUT /sellers/v1/sellers/{seller_id}/products/{product_id}/quantities/bulk': ['quantities'],
  'PUT /sellers/v1/sellers/{seller_id}/product_logistics/{product_id}': ['fields'],
  'POST /sellers/v1/sellers/{seller_id}/report_requests': ['report_request'],
  'PUT /seller_orders/v1/sellers/{seller_id}/order_statuses/{order_id}': ['status'],
  'PUT /seller_orders/v1/sellers/{seller_id}/orders/{order_id}/order_lines/{order_line_id}': ['cancellation_reason', 'order_line_statuses'],
  'POST /seller_orders/v1/sellers/{seller_id}/orders/{order_id}/bulk_fulfillments_create': ['items'],
  'PUT /seller_orders/v1/sellers/{seller_id}/orders/{order_id}/bulk_fulfillments_update': ['items'],
};

const SELLER = '{{TARGET_PLUS_SELLER_ID}}';
const specKey = (entry: Tool) => `${entry.endpointMapping.method} ${entry.endpointMapping.path.split(SELLER).join('{seller_id}')}`;

const ENV: Record<string, string> = {
  TARGET_PLUS_API_KEY: 'k7Hq2Lm9Xp4Rt8Vw3Yz6Bc1Df5Gh0Jn',
  TARGET_PLUS_SELLER_ID: '5d9b63230b782d009720a6cb',
  TARGET_PLUS_SELLER_TOKEN: 'tok_0123456789abcdefABCDEF0123456789',
};
const BASE = 'https://api.target.com';
const SID = ENV.TARGET_PLUS_SELLER_ID;

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

describe('target-plus adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends x-api-key, x-seller-id and x-seller-token from the connector variables', () => {
    expect(a.slug).toBe('target-plus');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('target-plus');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'x-api-key',
      apiKey: '{{TARGET_PLUS_API_KEY}}',
      extraHeaders: {
        'x-seller-id': '{{TARGET_PLUS_SELLER_ID}}',
        'x-seller-token': '{{TARGET_PLUS_SELLER_TOKEN}}',
      },
    });
    expect(a.requiredEnvVars).toEqual(['TARGET_PLUS_API_KEY', 'TARGET_PLUS_SELLER_ID', 'TARGET_PLUS_SELLER_TOKEN']);
    expect(a.envVarMeta.TARGET_PLUS_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.TARGET_PLUS_SELLER_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.TARGET_PLUS_SELLER_ID).toMatchObject({ kind: 'setting' });
    for (const name of a.requiredEnvVars) {
      expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
      expect(new RegExp(a.envVarMeta[name].pattern!).test('')).toBe(false);
      expect(new RegExp(a.envVarMeta[name].pattern!).test('has a space in it 0123456789')).toBe(false);
    }
  });

  it('probes the distribution centers and explains 400, 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'target_plus_list_distribution_centers', params: {} });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to an operation of the Target specs, with documented query names and body fields', () => {
    for (const entry of a.tools) {
      const key = specKey(entry);
      expect([entry.name, key in SPEC]).toEqual([entry.name, true]);
      for (const q of Object.keys(entry.endpointMapping.queryParams ?? {})) expect([entry.name, q, SPEC[key].includes(q)]).toEqual([entry.name, q, true]);
      if (entry.endpointMapping.bodyMapping) {
        expect([entry.name, key in BODY]).toEqual([entry.name, true]);
        for (const b of Object.keys(entry.endpointMapping.bodyMapping)) expect([entry.name, b, BODY[key].includes(b)]).toEqual([entry.name, b, true]);
      }
      expect(entry.endpointMapping.path).not.toMatch(/^https?:/);
      if (entry.endpointMapping.path.includes('/sellers/{seller_id}') || entry.endpointMapping.path.includes('/sellers/{{')) {
        expect(entry.endpointMapping.path).toContain(`/sellers/${SELLER}/`);
      }
    }
  });

  it('uses seller_orders-v1 for orders and shipping methods, not the deprecated sellers-v1 order calls', () => {
    for (const entry of a.tools) {
      const path = entry.endpointMapping.path;
      expect(path.startsWith(`/sellers/v1/sellers/${SELLER}/order`)).toBe(false);
      expect(path).not.toBe('/sellers/v1/shipping_methods');
    }
    const orderTools = a.tools.filter((entry) => /order|fulfillment|shipping_method/.test(entry.name) && !entry.name.includes('report'));
    expect(orderTools.length).toBeGreaterThanOrEqual(10);
    for (const entry of orderTools) expect(entry.endpointMapping.path.startsWith('/seller_orders/v1/')).toBe(true);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    expect(a.tools.length).toBeGreaterThanOrEqual(30);
    for (const name of mine) expect(name).toMatch(/^target_plus_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [, p] of entry.endpointMapping.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) expect(entry.parameters.required).toContain(p);
      expect(entry.description.length).toBeGreaterThan(60);
    }
  });

  it('requires the documented ids and fields on the write tools', () => {
    expect(tool('target_plus_create_product').parameters.required).toEqual(['external_id', 'fields']);
    expect(tool('target_plus_update_product').parameters.required).toEqual(['product_id', 'external_id', 'relationship_type', 'fields']);
    expect(tool('target_plus_upsert_variation_family').parameters.required).toEqual(['parent', 'children']);
    expect(tool('target_plus_update_product_price').parameters.required).toEqual(['product_id', 'list_price']);
    expect(tool('target_plus_update_product_quantity').parameters.required).toEqual(['product_id', 'distribution_center_id', 'quantity']);
    expect(tool('target_plus_bulk_update_product_quantities').parameters.required).toEqual(['product_id', 'quantities']);
    expect(tool('target_plus_update_product_logistics').parameters.required).toEqual(['product_id', 'fields']);
    expect(tool('target_plus_create_order_fulfillments').parameters.required).toEqual(['order_id', 'items']);
    expect(tool('target_plus_update_order_fulfillments').parameters.required).toEqual(['order_id', 'items']);
    expect(tool('target_plus_update_order_line').parameters.required).toEqual(['order_id', 'order_line_id', 'order_line_statuses']);
    expect(tool('target_plus_create_report_request').parameters.required).toEqual(['type']);
    expect(tool('target_plus_get_catalog_item').parameters.required).toEqual(['tcin']);
  });

  it('marks reads read-only, installs unlisting, line cancellation and report termination switched off, and moves no money', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET';
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, read]);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['target_plus_terminate_report_request', 'target_plus_unlist_product', 'target_plus_update_order_line']);
    for (const entry of a.tools) {
      if (entry.endpointMapping.method === 'DELETE') expect(entry.enabled).toBe(false);
      if (/product_returns|return_disputes|return_policies/.test(entry.endpointMapping.path)) expect(entry.endpointMapping.method).toBe('GET');
    }
    // Sellers may only acknowledge through the status tool; REFUNDED and CANCELED are not offered.
    expect(tool('target_plus_update_order_status').parameters.properties!.status.enum).toEqual(['ACKNOWLEDGED_BY_SELLER']);
    const lineStatuses = JSON.stringify(tool('target_plus_update_order_line').parameters.properties!.order_line_statuses);
    expect(lineStatuses).not.toContain('REFUNDED');
  });

  it('names every tool in the instructions and states invite-only access and the official reference', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).toMatch(/^## Target Plus\n/);
    expect(a.instructions).toContain('invite-only');
    expect(a.instructions).toContain('https://plus.target.com/docs');
    expect(a.instructions).toContain('Business Info, Basic Info');
    expect(a.instructions).toContain('Partner Settings, API Tokens');
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists distribution centers with all three auth headers and the seller id in the path', async () => {
    ok(200, []);
    await call('target_plus_list_distribution_centers', {});
    const req = sent();
    expect(req.url).toBe(`${BASE}/sellers/v1/sellers/${SID}/distribution_centers`);
    expect(method()).toBe('GET');
    expect(header(req, 'x-api-key')).toBe(ENV.TARGET_PLUS_API_KEY);
    expect(header(req, 'x-seller-id')).toBe(SID);
    expect(header(req, 'x-seller-token')).toBe(ENV.TARGET_PLUS_SELLER_TOKEN);
    expect(header(req, 'Authorization')).toBeUndefined();
  });

  it('reads orders, addresses, fulfillments and shipping methods on the seller_orders-v1 paths', async () => {
    ok(200, []);
    await call('target_plus_list_orders', { order_status: ['RELEASED_FOR_SHIPMENT', 'ACKNOWLEDGED_BY_SELLER'], order_date: '2026-11-01T00:00:00Z/' });
    expect(sent().url).toBe(`${BASE}/seller_orders/v1/sellers/${SID}/orders`);
    expect(sent().params).toEqual({
      order_status: ['RELEASED_FOR_SHIPMENT', 'ACKNOWLEDGED_BY_SELLER'],
      order_date: '2026-11-01T00:00:00Z/',
      per_page: 50,
    });
    expect(header(sent(), 'x-seller-token')).toBe(ENV.TARGET_PLUS_SELLER_TOKEN);

    ok();
    await call('target_plus_get_order', { order_id: '1028521085032-1635740801' });
    expect(sent().url).toBe(`${BASE}/seller_orders/v1/sellers/${SID}/orders/1028521085032-1635740801`);

    ok();
    await call('target_plus_get_order_address', { order_id: '1028521085032-1635740801' });
    expect(sent().url).toBe(`${BASE}/seller_orders/v1/sellers/${SID}/order_addresses/1028521085032-1635740801`);

    ok(200, []);
    await call('target_plus_list_order_fulfillments', { order_id: '1028521085032-1635740801' });
    expect(sent().url).toBe(`${BASE}/seller_orders/v1/sellers/${SID}/orders/1028521085032-1635740801/fulfillments`);

    ok(200, []);
    await call('target_plus_list_shipping_methods', {});
    expect(sent().url).toBe(`${BASE}/seller_orders/v1/shipping_methods`);
    expect(sent().params).toEqual({ per_page: 100 });
  });

  it('acknowledges an order, ships with fulfillments and corrects them as the spec documents', async () => {
    ok();
    await call('target_plus_update_order_status', { order_id: '1028521085032-1635740801' });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/seller_orders/v1/sellers/${SID}/order_statuses/1028521085032-1635740801`);
    expect(sent().data).toEqual({ status: 'ACKNOWLEDGED_BY_SELLER' });

    const item = {
      order_line_number: '1',
      quantity: 2,
      shipped_date: '2026-11-14T15:30:00Z',
      shipping_method: 'UPSGround',
      tracking_number: '1Z2W4E840308076506',
    };
    ok(201);
    await call('target_plus_create_order_fulfillments', { order_id: '1028521085032-1635740801', items: [item] });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/seller_orders/v1/sellers/${SID}/orders/1028521085032-1635740801/bulk_fulfillments_create`);
    expect(sent().data).toEqual({ items: [item] });

    ok();
    await call('target_plus_update_order_fulfillments', { order_id: '1028521085032-1635740801', items: [{ id: '5f5ac90fdea83a53f25ea9ff', ...item }] });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/seller_orders/v1/sellers/${SID}/orders/1028521085032-1635740801/bulk_fulfillments_update`);
    expect(sent().data).toEqual({ items: [{ id: '5f5ac90fdea83a53f25ea9ff', ...item }] });

    ok();
    await call('target_plus_update_order_line', {
      order_id: '1028521085032-1635740801',
      order_line_id: '1',
      cancellation_reason: 'ITEM_NOT_AVAILABLE',
      order_line_statuses: [{ status: 'CANCELED', quantity: 1 }],
    });
    expect(sent().url).toBe(`${BASE}/seller_orders/v1/sellers/${SID}/orders/1028521085032-1635740801/order_lines/1`);
    expect(sent().data).toEqual({ cancellation_reason: 'ITEM_NOT_AVAILABLE', order_line_statuses: [{ status: 'CANCELED', quantity: 1 }] });
  });

  it('builds the product, price, stock and logistics requests on the sellers-v1 paths', async () => {
    const fields = [{ name: 'product_title', value: 'Oak side table' }];
    ok(201);
    await call('target_plus_create_product', { external_id: 'SKU-1', fields });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/sellers/v1/sellers/${SID}/products`);
    expect(sent().data).toEqual({ external_id: 'SKU-1', relationship_type: 'SA', fields });

    ok();
    await call('target_plus_list_products', { listing_status: 'APPROVED', after_id: 'abc123' });
    expect(sent().url).toBe(`${BASE}/sellers/v1/sellers/${SID}/products_catalog`);
    expect(sent().params).toEqual({ listing_status: 'APPROVED', after_id: 'abc123', per_page: 50 });

    ok();
    await call('target_plus_list_product_catalog_errors', { external_ids: ['SKU-1'], parent_id: 'p1', error_severity: 'CRITICAL' });
    expect(sent().params).toEqual({ externalIds: ['SKU-1'], parentId: 'p1', error_severity: 'CRITICAL' });

    ok(207);
    await call('target_plus_upsert_variation_family', {
      parent: { external_id: 'P-1', relationship_type: 'VAP', fields },
      children: [{ external_id: 'P-1-RED', relationship_type: 'VC', fields }],
    });
    expect(sent().url).toBe(`${BASE}/sellers/v1/sellers/${SID}/product_variation_update`);
    expect(sent().data).toEqual({
      parent: { external_id: 'P-1', relationship_type: 'VAP', fields },
      children: [{ external_id: 'P-1-RED', relationship_type: 'VC', fields }],
    });

    ok();
    await call('target_plus_unlist_product', { product_id: '5f5ac90fdea83a53f25ea9ff' });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/sellers/v1/sellers/${SID}/products/5f5ac90fdea83a53f25ea9ff:unlist`);

    ok();
    await call('target_plus_update_product_price', { product_id: 'p1', list_price: 24.99, offer_price: 19.99 });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/sellers/v1/sellers/${SID}/prices/p1`);
    expect(sent().data).toEqual({ list_price: 24.99, offer_price: 19.99 });

    ok();
    await call('target_plus_update_product_quantity', { product_id: 'p1', distribution_center_id: 'f7mzzr', quantity: 0 });
    expect(sent().url).toBe(`${BASE}/sellers/v1/sellers/${SID}/products/p1/quantities/f7mzzr`);
    expect(sent().data).toEqual({ quantity: 0 });

    ok(207);
    await call('target_plus_bulk_update_product_quantities', { product_id: 'p1', quantities: [{ distributionCenterId: 'f7mzzr', quantity: 12 }] });
    expect(sent().url).toBe(`${BASE}/sellers/v1/sellers/${SID}/products/p1/quantities/bulk`);
    expect(sent().data).toEqual({ quantities: [{ distributionCenterId: 'f7mzzr', quantity: 12 }] });

    ok();
    await call('target_plus_update_product_logistics', { product_id: 'p1', fields: [{ name: 'fulfillment.two_day_shipping_eligible', value: 'true' }] });
    expect(sent().url).toBe(`${BASE}/sellers/v1/sellers/${SID}/product_logistics/p1`);
    expect(sent().data).toEqual({ fields: [{ name: 'fulfillment.two_day_shipping_eligible', value: 'true' }] });
  });

  it('sends the report request as the multipart report_request JSON field', async () => {
    ok(201);
    await call('target_plus_create_report_request', { type: 'ORDERS', start_date: '2026-11-01T00:00:00Z', end_date: '2026-11-14T00:00:00Z' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/sellers/v1/sellers/${SID}/report_requests`);
    expect(String(header(sent(), 'content-type'))).toMatch(/^multipart\/form-data; boundary=/);
    const text = (sent().data as { getBuffer: () => Buffer }).getBuffer().toString('utf8');
    expect(text).toContain('name="report_request"');
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toEqual({ type: 'ORDERS', format: 'CSV', start_date: '2026-11-01T00:00:00Z', end_date: '2026-11-14T00:00:00Z' });

    ok(204, '');
    await call('target_plus_terminate_report_request', { report_request_id: 'r1' });
    expect(method()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/sellers/v1/sellers/${SID}/report_requests/r1`);
  });

  it('reads the taxonomy and legalizations on their own API paths', async () => {
    ok(200, []);
    await call('target_plus_list_taxonomies', { name: 'side tables', type: 'ITEM_TYPE' });
    expect(sent().url).toBe(`${BASE}/item_taxonomies/v2/taxonomies`);
    expect(sent().params).toEqual({ name: 'side tables', type: 'ITEM_TYPE', per_page: 50 });

    ok(200, []);
    await call('target_plus_list_attribute_assignments', { taxonomy_id: '12345' });
    expect(sent().url).toBe(`${BASE}/item_taxonomies/v2/assignments`);
    expect(sent().params).toEqual({ taxonomy_id: '12345', per_page: 100 });

    ok();
    await call('target_plus_get_catalog_item', { tcin: '81789642' });
    expect(sent().url).toBe(`${BASE}/item_taxonomies/v2/items/81789642`);

    ok(200, []);
    await call('target_plus_list_protected_legalizations', { type: 'BRAND' });
    expect(sent().url).toBe(`${BASE}/sellers/v1/protected_legalizations`);
  });
});

// Opt-in: RUN_TARGET_PLUS_LIVE=1. The refusal check needs no account; the reads
// need TARGET_PLUS_API_KEY, TARGET_PLUS_SELLER_ID and TARGET_PLUS_SELLER_TOKEN.
// Nothing is written.
const live = process.env.RUN_TARGET_PLUS_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('target-plus: live', () => {
  it('refuses a made-up API key', async () => {
    const response = await liveFetch.get(`${BASE}/sellers/v1/sellers/000000000000000000000000/distribution_centers`, {
      headers: { 'x-api-key': 'not-a-real-key', 'x-seller-id': '000000000000000000000000', 'x-seller-token': 'not-a-token', Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads distribution centers, one page of orders and the shipping methods', async () => {
    const key = process.env.TARGET_PLUS_API_KEY;
    const seller = process.env.TARGET_PLUS_SELLER_ID;
    const token = process.env.TARGET_PLUS_SELLER_TOKEN;
    if (!key || !seller || !token) throw new Error('Set TARGET_PLUS_API_KEY, TARGET_PLUS_SELLER_ID and TARGET_PLUS_SELLER_TOKEN for the live check');
    const headers = { 'x-api-key': key, 'x-seller-id': seller, 'x-seller-token': token, Accept: 'application/json' };
    const centers = await liveFetch.get(`${BASE}/sellers/v1/sellers/${seller}/distribution_centers`, { headers, validateStatus: () => true });
    expect(centers.status).toBe(200);
    expect(Array.isArray(centers.data)).toBe(true);
    const orders = await liveFetch.get(`${BASE}/seller_orders/v1/sellers/${seller}/orders`, {
      headers,
      params: { per_page: 5 },
      validateStatus: () => true,
    });
    expect(orders.status).toBe(200);
    const methods = await liveFetch.get(`${BASE}/seller_orders/v1/shipping_methods`, { headers, params: { per_page: 100 }, validateStatus: () => true });
    expect(methods.status).toBe(200);
  });
});
