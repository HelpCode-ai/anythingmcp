import * as adapter from './blibli.json';
/**
 * Blibli Seller API adapter.
 *
 * Static checks always run: HTTP Basic with the API client id and key, the
 * Api-Seller-Key header, the store parameters Blibli requires on every call
 * (requestId, storeId 10001, channelId, username, storeCode,
 * businessPartnerCode), every tool's method and path against the operations
 * published at https://seller-api.blibli.com (service 66, version 2.74.0), the
 * filter bodies, and the switched-off cancellation, buyable switch and archive.
 *
 * Live checks run only with RUN_BLIBLI_LIVE=1 and the six BLIBLI_* variables
 * set: they read the store. Reads only.
 *
 *   RUN_BLIBLI_LIVE=1 BLIBLI_CLIENT_ID=... BLIBLI_CLIENT_KEY=... BLIBLI_SELLER_KEY=... \
 *     BLIBLI_STORE_CODE=... BLIBLI_USERNAME=... BLIBLI_CHANNEL_ID=... \
 *     npx jest src/adapters/intl/blibli.live.spec.ts
 */
type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: unknown;
  headers?: Record<string, string>;
  bodyEncoding?: string;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; pattern?: string }>; required?: string[] };
  endpointMapping: Mapping;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; label?: string; help?: string; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string): Tool => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const pathParams = (path: string): string[] => [...path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map((m) => m[1]);
const refs = (value: unknown, out: Set<string> = new Set<string>()): Set<string> => {
  if (typeof value === 'string') {
    if (/^\$\w+$/.test(value)) out.add(value.slice(1));
    for (const m of value.matchAll(/\$\{(\w+)\}/g)) out.add(m[1]);
  } else if (Array.isArray(value)) {
    value.forEach((item) => refs(item, out));
  } else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => refs(item, out));
  }
  return out;
};
const outsideBackticks = (text: string): string => text.replace(/`[^`]*`/g, '');

const ROUTES: Record<string, [string, string]> = {
  "blibli_list_orders": [
    "POST",
    "/proxy/seller/v1/orders/packages/filter"
  ],
  "blibli_get_order_item": [
    "GET",
    "/proxy/seller/v1/orders/items/{order_item_id}"
  ],
  "blibli_get_combine_shipping": [
    "GET",
    "/proxy/mta/api/businesspartner/v1/order/getCombineShipping"
  ],
  "blibli_get_shipping_label": [
    "GET",
    "/proxy/seller/v1/orders/{package_id}/shippingLabel"
  ],
  "blibli_list_cancellation_reasons": [
    "GET",
    "/proxy/seller/v1/orders/items/cancellations/reasons"
  ],
  "blibli_list_returns": [
    "GET",
    "/proxy/mta/api/businesspartner/v1/order/getReturnedOrderSummary"
  ],
  "blibli_get_return": [
    "GET",
    "/proxy/mta/api/businesspartner/v1/order/getReturnedOrderDetail"
  ],
  "blibli_list_products": [
    "POST",
    "/proxy/seller/v1/products/filter"
  ],
  "blibli_get_product": [
    "GET",
    "/proxy/seller/v1/products/{product_sku}"
  ],
  "blibli_list_product_variants": [
    "POST",
    "/proxy/seller/v1/products/{product_sku}/variants/filter"
  ],
  "blibli_get_store": [
    "GET",
    "/proxy/seller/v1/stores"
  ],
  "blibli_list_pickup_points": [
    "POST",
    "/proxy/seller/v1/stores/pickup-points/filter"
  ],
  "blibli_list_logistics": [
    "GET",
    "/proxy/seller/v1/logistics"
  ],
  "blibli_list_brands": [
    "GET",
    "/proxy/mta/api/businesspartner/v2/product/getBrands"
  ],
  "blibli_get_category_tree": [
    "GET",
    "/proxy/mta/api/businesspartner/v1/product/getCategory"
  ],
  "blibli_create_package": [
    "POST",
    "/proxy/mta/api/businesspartner/v1/order/createPackage"
  ],
  "blibli_fulfill_regular": [
    "POST",
    "/proxy/seller/v1/orders/regular/{package_id}/fulfill"
  ],
  "blibli_update_dropship_awb": [
    "PUT",
    "/proxy/seller/v1/orders/dropship/{package_id}"
  ],
  "blibli_update_stock": [
    "PUT",
    "/proxy/seller/v1/products/{blibli_sku}/stock"
  ],
  "blibli_update_price": [
    "PUT",
    "/proxy/seller/v1/products/{blibli_sku}"
  ],
  "blibli_set_buyable": [
    "PUT",
    "/proxy/seller/v1/products/{blibli_sku}"
  ],
  "blibli_cancel_order_item": [
    "POST",
    "/proxy/seller/v1/orders/items/{order_item_id}/cancellations"
  ],
  "blibli_archive_products": [
    "POST",
    "/proxy/seller/v1/products/statuses/archive"
  ]
};
const SWITCHED_OFF = [
  "blibli_archive_products",
  "blibli_cancel_order_item",
  "blibli_set_buyable"
];
const REQUIRED: Record<string, string[]> = {
  "blibli_list_orders": [],
  "blibli_get_order_item": [
    "order_item_id"
  ],
  "blibli_get_combine_shipping": [
    "order_item_id"
  ],
  "blibli_get_shipping_label": [
    "package_id"
  ],
  "blibli_list_cancellation_reasons": [],
  "blibli_list_returns": [],
  "blibli_get_return": [
    "order_item_no",
    "order_no",
    "return_id"
  ],
  "blibli_list_products": [],
  "blibli_get_product": [
    "product_sku"
  ],
  "blibli_list_product_variants": [
    "product_sku"
  ],
  "blibli_get_store": [],
  "blibli_list_pickup_points": [],
  "blibli_list_logistics": [],
  "blibli_list_brands": [],
  "blibli_get_category_tree": [],
  "blibli_create_package": [
    "order_item_ids"
  ],
  "blibli_fulfill_regular": [
    "package_id"
  ],
  "blibli_update_dropship_awb": [
    "awb_no",
    "package_id"
  ],
  "blibli_update_stock": [
    "available_stock",
    "blibli_sku",
    "pickup_point_code"
  ],
  "blibli_update_price": [
    "blibli_sku",
    "pickup_point_code",
    "regular_price",
    "sale_price"
  ],
  "blibli_set_buyable": [
    "blibli_sku",
    "buyable",
    "pickup_point_code"
  ],
  "blibli_cancel_order_item": [
    "order_item_id",
    "quantity",
    "reason"
  ],
  "blibli_archive_products": [
    "product_skus"
  ]
};
const PROBE = {
  "tool": "blibli_get_store",
  "params": {}
};

describe('blibli adapter: static contract', () => {
  it('sends the API client as HTTP Basic, the seller key as a header and the store parameters on every call', () => {
    expect(a.slug).toBe('blibli');
    expect(a.region).toBe('intl');
    expect(a.connector.baseUrl).toBe('https://api.blibli.com/v2');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{BLIBLI_CLIENT_ID}}', password: '{{BLIBLI_CLIENT_KEY}}' });
    expect(a.connector.headers!['Api-Seller-Key']).toBe('{{BLIBLI_SELLER_KEY}}');
    expect(a.envVarMeta.BLIBLI_CLIENT_KEY.secret).toBe(true);
    expect(a.envVarMeta.BLIBLI_SELLER_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.BLIBLI_STORE_CODE.pattern!).test('TOQ-15126')).toBe(true);
    expect(new RegExp(a.envVarMeta.BLIBLI_STORE_CODE.pattern!).test('https://seller.blibli.com')).toBe(false);
    for (const t of a.tools) {
      expect(t.endpointMapping.path).toMatch(/^\/proxy\/(seller|mta)\//);
      expect(t.endpointMapping.queryParams).toMatchObject({
        storeId: '10001',
        channelId: '{{BLIBLI_CHANNEL_ID}}',
        username: '{{BLIBLI_USERNAME}}',
        storeCode: '{{BLIBLI_STORE_CODE}}',
        businessPartnerCode: '{{BLIBLI_STORE_CODE}}',
      });
      expect(String(t.endpointMapping.queryParams!.requestId)).toMatch(/^anythingmcp-/);
    }
  });

  it('builds the filter bodies Blibli documents', () => {
    expect(tool('blibli_list_orders').endpointMapping.bodyMapping).toMatchObject({
      filter: { orderItemStatuses: '$statuses', statusFPDateRange: '$fp_date_range' },
      paging: { page: '$page', size: '$size' },
    });
    expect(tool('blibli_update_price').endpointMapping.bodyMapping).toEqual({ price: { regular: '$regular_price', sale: '$sale_price' }, sellerSku: '$seller_sku' });
    expect(tool('blibli_update_stock').endpointMapping.bodyMapping).toEqual({ availableStock: '$available_stock' });
    expect(tool('blibli_update_price').endpointMapping.bodyMapping).not.toHaveProperty('buyable');
  });

  it('pins the method and path of every tool', () => {
    const actual: Record<string, [string, string]> = {};
    for (const t of a.tools) actual[t.name] = [t.endpointMapping.method, t.endpointMapping.path];
    expect(actual).toEqual(ROUTES);
  });

  it('installs exactly the risky tools switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
  });

  it('wires every parameter into the request and requires every path parameter', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = refs([m.queryParams ?? {}, m.bodyMapping ?? {}, m.headers ?? {}]);
      for (const p of pathParams(m.path)) used.add(p);
      for (const p of Object.keys(t.parameters.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of pathParams(m.path)) expect(`${t.name}:${p}:${(t.parameters.required ?? []).includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const r of t.parameters.required ?? []) expect(`${t.name}:${r}:${r in (t.parameters.properties ?? {})}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('pins the required parameters of every tool', () => {
    const actual: Record<string, string[]> = {};
    for (const t of a.tools) actual[t.name] = [...(t.parameters.required ?? [])].sort();
    expect(actual).toEqual(REQUIRED);
  });

  it('marks reads as read-only and never marks a write read-only', () => {
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
  });

  it('names every tool in the instructions, prefixes it with the slug and keeps the text MDX-safe', () => {
    const prefix = `${a.slug.replace(/-/g, '_')}_`;
    for (const t of a.tools) {
      expect(t.name.startsWith(prefix)).toBe(true);
      expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
      expect(outsideBackticks(t.description)).not.toMatch(/[{}<]/);
      for (const [p, d] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${Boolean(d.description)}`).toBe(`${t.name}.${p}:true`);
        expect(outsideBackticks(d.description ?? '')).not.toMatch(/[{}<]/);
        if (d.pattern) expect(() => new RegExp(d.pattern!)).not.toThrow();
      }
    }
    expect(outsideBackticks(a.instructions)).not.toMatch(/[{}<]/);
    expect(outsideBackticks(a.description)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });

  it('describes every variable and probes with a cheap read', () => {
    for (const v of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[v]).toMatchObject({ label: expect.any(String), kind: expect.any(String), help: expect.any(String) });
      if (a.envVarMeta[v].pattern) expect(() => new RegExp(a.envVarMeta[v].pattern!)).not.toThrow();
    }
    expect(a.probe).toEqual(PROBE);
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    expect(tool(a.probe.tool).annotations?.readOnlyHint).toBe(true);
    for (const status of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[status]).toBeDefined();
  });
});

const live = process.env.RUN_BLIBLI_LIVE === '1' ? describe : describe.skip;
live('blibli adapter: live reads', () => {
  it('reads the store with the client and seller keys', async () => {
    const q = new URLSearchParams({
      requestId: `anythingmcp-live-${Date.now()}`,
      storeId: '10001',
      channelId: process.env.BLIBLI_CHANNEL_ID ?? '',
      username: process.env.BLIBLI_USERNAME ?? '',
      storeCode: process.env.BLIBLI_STORE_CODE ?? '',
      businessPartnerCode: process.env.BLIBLI_STORE_CODE ?? '',
    });
    const basic = Buffer.from(`${process.env.BLIBLI_CLIENT_ID}:${process.env.BLIBLI_CLIENT_KEY}`).toString('base64');
    const res = await fetch(`https://api.blibli.com/v2/proxy/seller/v1/stores?${q}`, {
      headers: { Authorization: `Basic ${basic}`, 'Api-Seller-Key': process.env.BLIBLI_SELLER_KEY ?? '', Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
  });
});

