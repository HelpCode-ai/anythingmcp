import * as adapter from './erli.json';
/**
 * Erli Marketplace API (Shop API) adapter.
 *
 * Static checks always run: the bearer API key, the environment choice, every
 * route against Erli's published OpenAPI document
 * (https://erli.pl/svc/shop-api/doc/swagger.json), the market header, the
 * top-level array body of the tracking call, the write bodies, and which tools
 * install switched off (archive, cancel, parcel delete). No tool buys Erli
 * labels or moves money.
 *
 * Live checks run only with RUN_ERLI_LIVE=1 and ERLI_API_KEY set: they read
 * the shop and one page of products. Reads only.
 *
 *   RUN_ERLI_LIVE=1 ERLI_API_KEY=... npx jest src/adapters/pl/erli.live.spec.ts
 */
type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: unknown;
  headers?: Record<string, string>;
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
  selfHostOnly?: boolean;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; label?: string; help?: string; options?: { value: string; label: string }[] }>;
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
  } else if (Array.isArray(value)) {
    value.forEach((item) => refs(item, out));
  } else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => refs(item, out));
  }
  return out;
};
const outsideBackticks = (text: string): string => text.replace(/`[^`]*`/g, '');

const ROUTES: Record<string, [string, string]> = {
  erli_get_shop: ["GET", "/me"],
  erli_search_products: ["POST", "/products/_search"],
  erli_get_product: ["GET", "/products/{external_id}"],
  erli_get_product_discount: ["GET", "/products/{external_id}/discount"],
  erli_search_orders: ["POST", "/orders/_search"],
  erli_get_order: ["GET", "/orders/{order_id}"],
  erli_list_order_changes: ["POST", "/orders/changes/_search"],
  erli_list_product_changes: ["POST", "/products/changes/_search"],
  erli_get_external_parcel: ["GET", "/shipping/external/{parcel_id}"],
  erli_list_delivery_price_lists: ["GET", "/delivery/priceLists"],
  erli_get_delivery_price_lists_details: ["GET", "/delivery/priceListsDetails"],
  erli_list_delivery_methods: ["GET", "/dictionaries/deliveryMethods"],
  erli_list_delivery_vendors: ["GET", "/dictionaries/deliveryVendors"],
  erli_list_shipping_methods: ["GET", "/dictionaries/shippingMethods"],
  erli_search_categories: ["POST", "/dictionaries/category/_search"],
  erli_list_category_attributes: ["POST", "/dictionaries/attributes/_search"],
  erli_list_attribute_values: ["POST", "/dictionaries/attributeValues/_search"],
  erli_list_terms: ["GET", "/dictionaries/{kind}"],
  erli_estimate_commission: ["POST", "/commissions/_estimate"],
  erli_create_product: ["POST", "/products/{external_id}"],
  erli_update_product: ["PATCH", "/products/{external_id}"],
  erli_archive_product: ["PATCH", "/products/{external_id}"],
  erli_create_product_discount: ["POST", "/products/{external_id}/discount"],
  erli_update_order_status: ["PATCH", "/orders/{order_id}/status"],
  erli_cancel_order: ["PATCH", "/orders/{order_id}/status"],
  erli_set_order_external_id: ["PATCH", "/orders/{order_id}"],
  erli_add_tracking: ["POST", "/shipping/external"],
  erli_update_external_parcel: ["PATCH", "/shipping/external/{parcel_id}"],
  erli_delete_external_parcel: ["DELETE", "/shipping/external/{parcel_id}"],
  erli_mark_order_changes_read: ["POST", "/orders/changes/mark-read"],
  erli_mark_product_changes_read: ["POST", "/products/changes/mark-read"],
};
const SWITCHED_OFF = [
  "erli_archive_product",
  "erli_cancel_order",
  "erli_delete_external_parcel"
];
const REQUIRED: Record<string, string[]> = {
  erli_get_shop: [],
  erli_search_products: [],
  erli_get_product: ["external_id"],
  erli_get_product_discount: ["external_id"],
  erli_search_orders: [],
  erli_get_order: ["order_id"],
  erli_list_order_changes: [],
  erli_list_product_changes: [],
  erli_get_external_parcel: ["parcel_id"],
  erli_list_delivery_price_lists: [],
  erli_get_delivery_price_lists_details: [],
  erli_list_delivery_methods: [],
  erli_list_delivery_vendors: [],
  erli_list_shipping_methods: [],
  erli_search_categories: [],
  erli_list_category_attributes: ["category_id"],
  erli_list_attribute_values: ["category_id"],
  erli_list_terms: ["kind"],
  erli_estimate_commission: ["category_id", "unit_price"],
  erli_create_product: ["dispatch_days", "external_id", "images", "name", "price", "stock"],
  erli_update_product: ["external_id"],
  erli_archive_product: ["external_id"],
  erli_create_product_discount: ["external_id", "new_price", "restore_at", "start_at"],
  erli_update_order_status: ["order_id", "status"],
  erli_cancel_order: ["order_id"],
  erli_set_order_external_id: ["external_order_id", "order_id"],
  erli_add_tracking: ["order_id", "vendor"],
  erli_update_external_parcel: ["parcel_id", "vendor"],
  erli_delete_external_parcel: ["parcel_id"],
  erli_mark_order_changes_read: [],
  erli_mark_product_changes_read: [],
};
const PROBE = {"tool": "erli_get_shop", "params": {}};
const PROBE_METHOD = "GET";

describe('erli adapter: static contract', () => {
  it('sends the API key as a bearer token to the chosen environment', () => {
    expect(a.slug).toBe('erli');
    expect(a.region).toBe('pl');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.baseUrl).toBe('{{ERLI_API_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{ERLI_API_KEY}}' });
    expect(a.envVarMeta.ERLI_API_URL.options?.map((o) => o.value)).toEqual(['https://erli.pl/svc/shop-api', 'https://sandbox.erli.dev/svc/shop-api']);
    expect(a.envVarMeta.ERLI_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.ERLI_API_KEY.pattern!).test('abcd1234:efgh5678ijkl9012')).toBe(true);
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

  it('keeps parameter patterns compilable', () => {
    for (const t of a.tools) {
      for (const d of Object.values(t.parameters.properties ?? {})) if (d.pattern) expect(() => new RegExp(d.pattern as string)).not.toThrow();
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
      }
    }
    expect(outsideBackticks(a.instructions)).not.toMatch(/[{}<]/);
    expect(outsideBackticks(a.description)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });

  it('describes every variable and probes with a cheap read', () => {
    for (const v of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[v]).toMatchObject({ label: expect.any(String), kind: expect.any(String), help: expect.any(String) });
    }
    expect(a.probe).toEqual(PROBE);
    expect(tool(a.probe.tool).endpointMapping.method).toBe(PROBE_METHOD);
    for (const status of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[status]).toBeDefined();
  });

  it('sends the market as a header, one parcel as a top-level array, and constant bodies for archive and cancel', () => {
    expect(tool('erli_get_product').endpointMapping.headers).toEqual({ 'X-ERLI-MARKET': '$market' });
    expect(tool('erli_add_tracking').endpointMapping.bodyMapping).toEqual([
      { orderId: '$order_id', vendor: '$vendor', trackingNumber: '$tracking_number', status: '$status', typeId: '$type_id' },
    ]);
    expect(tool('erli_archive_product').endpointMapping.bodyMapping).toEqual({ archived: true });
    expect(tool('erli_cancel_order').endpointMapping.bodyMapping).toEqual({ status: 'canceled' });
    expect(JSON.stringify(tool('erli_update_order_status').parameters)).not.toContain('canceled');
    expect(JSON.stringify(tool('erli_update_product').endpointMapping.bodyMapping)).not.toContain('archived');
    expect(a.tools.map((t) => t.endpointMapping.path).join(' ')).not.toMatch(/shipping\/parcels|payments|billing/);
  });

  it('marks the POST searches read-only', () => {
    for (const name of ['erli_search_products', 'erli_search_orders', 'erli_list_order_changes', 'erli_list_product_changes', 'erli_search_categories', 'erli_estimate_commission']) {
      expect(tool(name).annotations).toEqual({ readOnlyHint: true });
    }
  });
});

const live = process.env.RUN_ERLI_LIVE === '1' ? describe : describe.skip;
live('erli adapter: live reads', () => {
  it('reads the shop and one page of products', async () => {
    const headers = { Authorization: `Bearer ${process.env.ERLI_API_KEY}`, Accept: 'application/json', 'Content-Type': 'application/json' };
    const me = await fetch('https://erli.pl/svc/shop-api/me', { headers });
    expect(me.status).toBe(200);
    const products = await fetch('https://erli.pl/svc/shop-api/products/_search', { method: 'POST', headers, body: JSON.stringify({ pagination: { limit: 1 } }) });
    expect(products.status).toBe(200);
  });
});
