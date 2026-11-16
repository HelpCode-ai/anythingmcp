import * as adapter from './whatnot.json';
/**
 * Whatnot Seller API adapter (REST v2).
 *
 * Static checks always run: the Bearer personal access token on
 * https://api.whatnot.com/seller-api/rest/v2, every route against Whatnot's
 * published OpenAPI description (https://developers.whatnot.com/whatnot-seller-api/openapi.json,
 * version 2.0.0), the inventory and tracking bodies, and that cancelling orders,
 * deleting products and requesting Whatnot shipping labels install switched off.
 *
 * Live checks run only with RUN_WHATNOT_LIVE=1 and WHATNOT_API_TOKEN set: they
 * read the current user and one page of orders and products. Reads only.
 *
 *   RUN_WHATNOT_LIVE=1 WHATNOT_API_TOKEN=... \
 *     npx jest src/adapters/intl/whatnot.live.spec.ts
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
  whatnot_get_current_user: ["GET", "/users/me"],
  whatnot_list_orders: ["GET", "/orders"],
  whatnot_get_order: ["GET", "/orders/{order_id}"],
  whatnot_list_order_items: ["GET", "/orders/{order_id}/items"],
  whatnot_get_order_item: ["GET", "/orders/{order_id}/items/{item_id}"],
  whatnot_cancel_order: ["POST", "/orders/{order_id}/cancel"],
  whatnot_list_products: ["GET", "/products"],
  whatnot_get_product: ["GET", "/products/{product_id}"],
  whatnot_create_product: ["POST", "/products"],
  whatnot_update_product: ["PATCH", "/products/{product_id}"],
  whatnot_delete_product: ["DELETE", "/products/{product_id}"],
  whatnot_list_product_variants: ["GET", "/products/{product_id}/variants"],
  whatnot_get_product_variant: ["GET", "/products/{product_id}/variants/{variant_id}"],
  whatnot_update_product_variants: ["PATCH", "/products/{product_id}/variants"],
  whatnot_set_inventory: ["POST", "/inventory/set"],
  whatnot_adjust_inventory: ["POST", "/inventory/adjust"],
  whatnot_get_product_merchandising: ["GET", "/merchandising/products/{product_id}"],
  whatnot_update_product_merchandising: ["POST", "/merchandising/products/{product_id}"],
  whatnot_list_product_shows: ["GET", "/merchandising/products/{product_id}/shows"],
  whatnot_list_shipments: ["GET", "/shipments"],
  whatnot_get_shipment: ["GET", "/shipments/{shipment_id}"],
  whatnot_list_shipment_items: ["GET", "/shipments/{shipment_id}/items"],
  whatnot_add_tracking_code: ["POST", "/shipments/add_tracking_code"],
  whatnot_generate_shipping_label: ["POST", "/shipments/{shipment_id}/generate_label"],
  whatnot_list_dimension_profiles: ["GET", "/shipping/dimension_profiles"],
  whatnot_list_shows: ["GET", "/shows"],
  whatnot_get_show: ["GET", "/shows/{show_id}"],
  whatnot_get_show_analytics: ["GET", "/analytics/shows/{show_id}"],
  whatnot_generate_report: ["POST", "/reports"],
  whatnot_list_reports: ["GET", "/reports"],
  whatnot_get_report: ["GET", "/reports/{report_id}"],
};
const SWITCHED_OFF = [
  "whatnot_cancel_order",
  "whatnot_delete_product",
  "whatnot_generate_shipping_label"
];
const REQUIRED: Record<string, string[]> = {
  whatnot_get_current_user: [],
  whatnot_list_orders: [],
  whatnot_get_order: ["order_id"],
  whatnot_list_order_items: ["order_id"],
  whatnot_get_order_item: ["item_id", "order_id"],
  whatnot_cancel_order: ["order_id", "reason"],
  whatnot_list_products: [],
  whatnot_get_product: ["product_id"],
  whatnot_create_product: ["category_id", "dimension_profile", "title"],
  whatnot_update_product: ["product_id"],
  whatnot_delete_product: ["product_id"],
  whatnot_list_product_variants: ["product_id"],
  whatnot_get_product_variant: ["product_id", "variant_id"],
  whatnot_update_product_variants: ["product_id", "variants"],
  whatnot_set_inventory: ["items"],
  whatnot_adjust_inventory: ["items"],
  whatnot_get_product_merchandising: ["product_id"],
  whatnot_update_product_merchandising: ["product_id"],
  whatnot_list_product_shows: ["product_id"],
  whatnot_list_shipments: [],
  whatnot_get_shipment: ["shipment_id"],
  whatnot_list_shipment_items: ["shipment_id"],
  whatnot_add_tracking_code: ["carrier", "order_item_ids", "tracking_code"],
  whatnot_generate_shipping_label: ["shipment_id"],
  whatnot_list_dimension_profiles: [],
  whatnot_list_shows: [],
  whatnot_get_show: ["show_id"],
  whatnot_get_show_analytics: ["show_id"],
  whatnot_generate_report: ["report_parameters"],
  whatnot_list_reports: [],
  whatnot_get_report: ["report_id"],
};
const PROBE = {"tool": "whatnot_get_current_user", "params": {}};
const PROBE_METHOD = "GET";

describe('whatnot adapter: static contract', () => {
  it('sends the personal access token as a Bearer token to the v2 REST API', () => {
    expect(a.slug).toBe('whatnot');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.whatnot.com/seller-api/rest/v2');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{WHATNOT_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['WHATNOT_API_TOKEN']);
    expect(a.envVarMeta.WHATNOT_API_TOKEN.secret).toBe(true);
    const token = new RegExp(a.envVarMeta.WHATNOT_API_TOKEN.pattern!);
    expect(token.test('wn_pat_tk_0123456789abcdef')).toBe(true);
    expect(token.test('Bearer wn_pat_tk_0123456789abcdef')).toBe(false);
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

  it('builds the inventory, variant, merchandising and tracking bodies from the documented fields', () => {
    expect(tool('whatnot_set_inventory').endpointMapping.bodyMapping).toEqual({ items: '$items' });
    expect(tool('whatnot_adjust_inventory').endpointMapping.bodyMapping).toEqual({ items: '$items' });
    expect(tool('whatnot_update_product_variants').endpointMapping.bodyMapping).toEqual({ variants: '$variants', allow_partial_updates: '$allow_partial_updates' });
    expect(tool('whatnot_add_tracking_code').endpointMapping.bodyMapping).toEqual({ order_item_ids: '$order_item_ids', tracking_code: '$tracking_code', carrier: '$carrier' });
    expect((tool('whatnot_create_product').endpointMapping.bodyMapping as Record<string, unknown>).category).toEqual({ id: '$category_id' });
    expect(tool('whatnot_cancel_order').endpointMapping.bodyMapping).toEqual({ reason: '$reason' });
    const shows = (tool('whatnot_update_product_merchandising').parameters.properties as unknown as Record<string, { properties?: Record<string, { enum?: string[] }> }>).shows;
    expect(shows.properties?.strategy.enum).toEqual(['ADD', 'REMOVE', 'REPLACE']);
    expect(JSON.stringify(a.tools.map((t) => t.endpointMapping.path))).not.toMatch(/users\/disconnect/);
  });
});

const live = process.env.RUN_WHATNOT_LIVE === '1' ? describe : describe.skip;
live('whatnot adapter: live reads', () => {
  it('reads the current user and one page of orders and products', async () => {
    const headers = { Authorization: `Bearer ${process.env.WHATNOT_API_TOKEN}`, Accept: 'application/json' };
    for (const path of ['/users/me', '/orders?limit=1', '/products?limit=1']) {
      const res = await fetch(`https://api.whatnot.com/seller-api/rest/v2${path}`, { headers });
      expect(res.status).toBe(200);
    }
  });
});
