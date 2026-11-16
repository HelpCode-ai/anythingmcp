import * as adapter from './color-me-shop.json';
/**
 * Color Me Shop API adapter (GMO Pepabo, Japan).
 *
 * Static checks always run: the OAuth authorization code flow at
 * api.shop-pro.jp (client secret in the body, space-separated scopes), every
 * tool's method and path against the official OpenAPI spec
 * (https://api.shop-pro.jp/v1/spec/open_api.json), the sale, mail, product and
 * variant bodies, and the switched-off cancellation and display switch.
 *
 * Live checks run only with RUN_COLOR_ME_SHOP_LIVE=1 and COLORME_ACCESS_TOKEN
 * set (a token from an authorized private app): they read the shop and one
 * order. Reads only.
 *
 *   RUN_COLOR_ME_SHOP_LIVE=1 COLORME_ACCESS_TOKEN=... npx jest src/adapters/jp/color-me-shop.live.spec.ts
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
  "color_me_shop_get_shop": [
    "GET",
    "/v1/shop"
  ],
  "color_me_shop_list_sales": [
    "GET",
    "/v1/sales"
  ],
  "color_me_shop_get_sale": [
    "GET",
    "/v1/sales/{sale_id}"
  ],
  "color_me_shop_get_sales_stat": [
    "GET",
    "/v1/sales/stat"
  ],
  "color_me_shop_list_customers": [
    "GET",
    "/v1/customers"
  ],
  "color_me_shop_get_customer": [
    "GET",
    "/v1/customers/{customer_id}"
  ],
  "color_me_shop_list_products": [
    "GET",
    "/v1/products"
  ],
  "color_me_shop_get_product": [
    "GET",
    "/v1/products/{product_id}"
  ],
  "color_me_shop_list_product_variants": [
    "GET",
    "/v1/products/{product_id}/variants"
  ],
  "color_me_shop_list_stocks": [
    "GET",
    "/v1/stocks"
  ],
  "color_me_shop_list_categories": [
    "GET",
    "/v1/categories"
  ],
  "color_me_shop_list_payments": [
    "GET",
    "/v1/payments"
  ],
  "color_me_shop_list_deliveries": [
    "GET",
    "/v1/deliveries"
  ],
  "color_me_shop_list_reviews": [
    "GET",
    "/v1/reviews"
  ],
  "color_me_shop_update_sale_delivery": [
    "PUT",
    "/v1/sales/{sale_id}"
  ],
  "color_me_shop_set_sale_paid": [
    "PUT",
    "/v1/sales/{sale_id}"
  ],
  "color_me_shop_send_sale_mail": [
    "POST",
    "/v1/sales/{sale_id}/mails"
  ],
  "color_me_shop_update_product": [
    "PUT",
    "/v1/products/{product_id}"
  ],
  "color_me_shop_update_variant": [
    "PUT",
    "/v1/products/{product_id}/variants/{variant_id}"
  ],
  "color_me_shop_set_product_display": [
    "PUT",
    "/v1/products/{product_id}"
  ],
  "color_me_shop_cancel_sale": [
    "PUT",
    "/v1/sales/{sale_id}/cancel"
  ]
};
const SWITCHED_OFF = [
  "color_me_shop_cancel_sale",
  "color_me_shop_set_product_display"
];
const REQUIRED: Record<string, string[]> = {
  "color_me_shop_get_shop": [],
  "color_me_shop_list_sales": [],
  "color_me_shop_get_sale": [
    "sale_id"
  ],
  "color_me_shop_get_sales_stat": [],
  "color_me_shop_list_customers": [],
  "color_me_shop_get_customer": [
    "customer_id"
  ],
  "color_me_shop_list_products": [],
  "color_me_shop_get_product": [
    "product_id"
  ],
  "color_me_shop_list_product_variants": [
    "product_id"
  ],
  "color_me_shop_list_stocks": [],
  "color_me_shop_list_categories": [],
  "color_me_shop_list_payments": [],
  "color_me_shop_list_deliveries": [],
  "color_me_shop_list_reviews": [],
  "color_me_shop_update_sale_delivery": [
    "delivery_id",
    "sale_id"
  ],
  "color_me_shop_set_sale_paid": [
    "paid",
    "sale_id"
  ],
  "color_me_shop_send_sale_mail": [
    "sale_id",
    "type"
  ],
  "color_me_shop_update_product": [
    "product_id"
  ],
  "color_me_shop_update_variant": [
    "product_id",
    "variant_id"
  ],
  "color_me_shop_set_product_display": [
    "display_state",
    "product_id"
  ],
  "color_me_shop_cancel_sale": [
    "sale_id"
  ]
};
const PROBE = {
  "tool": "color_me_shop_get_shop",
  "params": {}
};

describe('color-me-shop adapter: static contract', () => {
  it('signs in with OAuth at api.shop-pro.jp and calls the v1 API', () => {
    expect(a.slug).toBe('color-me-shop');
    expect(a.region).toBe('jp');
    expect(a.connector.baseUrl).toBe('https://api.shop-pro.jp');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{COLORME_CLIENT_ID}}',
      clientSecret: '{{COLORME_CLIENT_SECRET}}',
      authorizationUrl: 'https://api.shop-pro.jp/oauth/authorize',
      tokenUrl: 'https://api.shop-pro.jp/oauth/token',
      tokenAuthMethod: 'client_secret_post',
      scopes: 'read_products write_products read_sales write_sales',
    });
    expect(a.envVarMeta.COLORME_CLIENT_SECRET.secret).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/v1\//);
  });

  it('wraps the writes in the documented resource keys and keeps hiding and cancelling apart', () => {
    expect(tool('color_me_shop_update_sale_delivery').endpointMapping.bodyMapping).toEqual({
      sale: { sale_deliveries: [{ id: '$delivery_id', slip_number: '$slip_number', delivered: '$delivered' }] },
    });
    expect(tool('color_me_shop_send_sale_mail').endpointMapping.bodyMapping).toEqual({ mail: { type: '$type' } });
    expect(tool('color_me_shop_cancel_sale').endpointMapping.method).toBe('PUT');
    expect((tool('color_me_shop_update_product').endpointMapping.bodyMapping as { product: Record<string, unknown> }).product).not.toHaveProperty('display_state');
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

const live = process.env.RUN_COLOR_ME_SHOP_LIVE === '1' ? describe : describe.skip;
live('color-me-shop adapter: live reads', () => {
  it('reads the shop and one page of orders with an access token', async () => {
    for (const path of ['/v1/shop', '/v1/sales?limit=1']) {
      const res = await fetch(`https://api.shop-pro.jp${path}`, { headers: { Authorization: `Bearer ${process.env.COLORME_ACCESS_TOKEN}` } });
      expect(res.status).toBe(200);
    }
  });
});

