import * as adapter from './wish.json';
/**
 * Wish Marketplace API v3 adapter.
 *
 * Static checks always run: the Bearer access token on https://merchant.wish.com/api/v3,
 * every route against Wish's live OpenAPI description (Wish Marketplace V3 API 3.0.65,
 * served to https://merchant.wish.com/documentation/api/v3/reference), the fulfillment
 * body, and that refunds and product deletes install switched off.
 *
 * Wish renews tokens only with GET requests to /api/v3/oauth/refresh_token (a POST answers
 * 405), so the adapter takes a 30-day access token rather than the OAuth2 grant.
 *
 * Live checks run only with RUN_WISH_LIVE=1 and WISH_ACCESS_TOKEN set: they test the token
 * and read one order and one product. Reads only.
 *
 *   RUN_WISH_LIVE=1 WISH_ACCESS_TOKEN=... npx jest src/adapters/intl/wish.live.spec.ts
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
  wish_test_token: ["GET", "/oauth/test"],
  wish_get_account_details: ["GET", "/merchant/account_details"],
  wish_list_orders: ["GET", "/orders"],
  wish_get_order: ["GET", "/orders/{order_id}"],
  wish_list_shipping_carriers: ["GET", "/orders/shipping_carriers"],
  wish_fulfill_order: ["PUT", "/orders/{order_id}/tracking"],
  wish_list_refund_reasons: ["GET", "/orders/{order_id}/refund_reasons"],
  wish_refund_order: ["PUT", "/orders/{order_id}/refund"],
  wish_list_products: ["GET", "/products"],
  wish_get_product: ["GET", "/products/{product_id}"],
  wish_create_product: ["POST", "/products"],
  wish_update_product: ["PUT", "/products/{product_id}"],
  wish_delete_product: ["DELETE", "/products/{product_id}"],
  wish_create_variation: ["POST", "/products/{product_id}/variations"],
  wish_get_categories: ["GET", "/products/categories"],
  wish_get_category: ["GET", "/products/categories/{category_id}"],
  wish_get_category_attributes: ["GET", "/products/attributes"],
  wish_get_product_rating: ["GET", "/ratings/products/{product_id}"],
  wish_list_tickets: ["GET", "/tickets"],
  wish_get_ticket: ["GET", "/tickets/{ticket_id}"],
  wish_reply_to_ticket: ["POST", "/tickets/{ticket_id}/replies"],
  wish_update_ticket: ["PUT", "/tickets/{ticket_id}"],
  wish_list_penalties: ["GET", "/penalties"],
  wish_get_shipping_settings: ["GET", "/merchant/shipping_settings"],
  wish_list_warehouses: ["GET", "/merchant/warehouses"],
};
const SWITCHED_OFF = [
  "wish_delete_product",
  "wish_refund_order"
];
const REQUIRED: Record<string, string[]> = {
  wish_test_token: [],
  wish_get_account_details: [],
  wish_list_orders: [],
  wish_get_order: ["order_id"],
  wish_list_shipping_carriers: ["order_type"],
  wish_fulfill_order: ["order_id", "origin_country", "shipping_provider", "tracking_number"],
  wish_list_refund_reasons: ["order_id"],
  wish_refund_order: ["order_id", "refund_reason"],
  wish_list_products: [],
  wish_get_product: ["product_id"],
  wish_create_product: ["category_id", "default_shipping_prices", "description", "main_image_url", "name", "parent_sku", "variations"],
  wish_update_product: ["product_id"],
  wish_delete_product: ["product_id"],
  wish_create_variation: ["inventories", "price", "product_id", "sku"],
  wish_get_categories: [],
  wish_get_category: ["category_id"],
  wish_get_category_attributes: ["category_id"],
  wish_get_product_rating: ["product_id"],
  wish_list_tickets: [],
  wish_get_ticket: ["ticket_id"],
  wish_reply_to_ticket: ["message", "ticket_id"],
  wish_update_ticket: ["state", "ticket_id"],
  wish_list_penalties: [],
  wish_get_shipping_settings: [],
  wish_list_warehouses: [],
};
const PROBE = {"tool": "wish_test_token", "params": {}};
const PROBE_METHOD = "GET";

describe('wish adapter: static contract', () => {
  it('sends the access token as a Bearer token to the v3 API', () => {
    expect(a.slug).toBe('wish');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://merchant.wish.com/api/v3');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{WISH_ACCESS_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['WISH_ACCESS_TOKEN']);
    expect(a.envVarMeta.WISH_ACCESS_TOKEN.secret).toBe(true);
    const token = new RegExp(a.envVarMeta.WISH_ACCESS_TOKEN.pattern!);
    expect(token.test('3d6e2d71bc464e42bfbdb081afb73c1e')).toBe(true);
    expect(token.test('Bearer 3d6e2d71bc464e42bfbdb081afb73c1e')).toBe(false);
    expect(a.instructions).toMatch(/30 days/);
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

  it('ships with carrier, tracking number and origin country, and refunds only from a switched-off tool', () => {
    expect(tool('wish_fulfill_order').endpointMapping.bodyMapping).toEqual({
      shipping_provider: '$shipping_provider',
      tracking_number: '$tracking_number',
      origin_country: '$origin_country',
      ship_note: '$ship_note',
    });
    expect(tool('wish_refund_order').enabled).toBe(false);
    expect((tool('wish_create_product').endpointMapping.bodyMapping as Record<string, unknown>).main_image).toEqual({ url: '$main_image_url' });
    for (const t of a.tools) if (t.endpointMapping.method === 'DELETE') expect(t.enabled).toBe(false);
  });
});

const live = process.env.RUN_WISH_LIVE === '1' ? describe : describe.skip;
live('wish adapter: live reads', () => {
  it('tests the token and reads one order and one product', async () => {
    const headers = { Authorization: `Bearer ${process.env.WISH_ACCESS_TOKEN}`, Accept: 'application/json' };
    for (const path of ['/oauth/test', '/orders?limit=1', '/products?limit=1']) {
      const res = await fetch(`https://merchant.wish.com/api/v3${path}`, { headers });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { code: number }).code).toBe(0);
    }
  });
});
