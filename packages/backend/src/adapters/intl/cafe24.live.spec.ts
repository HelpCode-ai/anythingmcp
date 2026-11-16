import * as adapter from './cafe24.json';
/**
 * Cafe24 Admin API adapter.
 *
 * Static checks always run: the OAuth authorization code flow at the mall's
 * own cafe24api.com host (HTTP Basic at the token endpoint, scopes joined with
 * commas), the pinned X-Cafe24-Api-Version header, every tool's method and
 * path against https://apidocs.cafe24.com/en/docs/admin/, the shop_no and
 * request envelope of the writes, and the switched-off product display switch.
 * No tool cancels, refunds or moves money.
 *
 * Live checks run only with RUN_CAFE24_LIVE=1 and CAFE24_MALL_ID,
 * CAFE24_ACCESS_TOKEN set (a token from an authorized app): they read the store
 * and count the products. Reads only.
 *
 *   RUN_CAFE24_LIVE=1 CAFE24_MALL_ID=... CAFE24_ACCESS_TOKEN=... npx jest src/adapters/intl/cafe24.live.spec.ts
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
  "cafe24_get_store": [
    "GET",
    "/store"
  ],
  "cafe24_list_shops": [
    "GET",
    "/shops"
  ],
  "cafe24_get_dashboard": [
    "GET",
    "/dashboard"
  ],
  "cafe24_list_orders": [
    "GET",
    "/orders"
  ],
  "cafe24_count_orders": [
    "GET",
    "/orders/count"
  ],
  "cafe24_get_order": [
    "GET",
    "/orders/{order_id}"
  ],
  "cafe24_list_order_items": [
    "GET",
    "/orders/{order_id}/items"
  ],
  "cafe24_get_order_receivers": [
    "GET",
    "/orders/{order_id}/receivers"
  ],
  "cafe24_list_order_shipments": [
    "GET",
    "/orders/{order_id}/shipments"
  ],
  "cafe24_get_claim": [
    "GET",
    "/{claim_type}/{claim_code}"
  ],
  "cafe24_list_products": [
    "GET",
    "/products"
  ],
  "cafe24_count_products": [
    "GET",
    "/products/count"
  ],
  "cafe24_get_product": [
    "GET",
    "/products/{product_no}"
  ],
  "cafe24_list_variants": [
    "GET",
    "/products/{product_no}/variants"
  ],
  "cafe24_get_inventory": [
    "GET",
    "/products/{product_no}/variants/{variant_code}/inventories"
  ],
  "cafe24_list_categories": [
    "GET",
    "/categories"
  ],
  "cafe24_list_carriers": [
    "GET",
    "/carriers"
  ],
  "cafe24_search_customers": [
    "GET",
    "/customersprivacy"
  ],
  "cafe24_list_boards": [
    "GET",
    "/boards"
  ],
  "cafe24_list_board_articles": [
    "GET",
    "/boards/{board_no}/articles"
  ],
  "cafe24_create_shipment": [
    "POST",
    "/orders/{order_id}/shipments"
  ],
  "cafe24_update_shipment": [
    "PUT",
    "/orders/{order_id}/shipments/{shipping_code}"
  ],
  "cafe24_update_order_status": [
    "PUT",
    "/orders/{order_id}"
  ],
  "cafe24_update_product": [
    "PUT",
    "/products/{product_no}"
  ],
  "cafe24_update_variant": [
    "PUT",
    "/products/{product_no}/variants/{variant_code}"
  ],
  "cafe24_update_inventory": [
    "PUT",
    "/products/{product_no}/variants/{variant_code}/inventories"
  ],
  "cafe24_add_board_comment": [
    "POST",
    "/boards/{board_no}/articles/{article_no}/comments"
  ],
  "cafe24_set_product_display": [
    "PUT",
    "/products/{product_no}"
  ]
};
const SWITCHED_OFF = [
  "cafe24_set_product_display"
];
const REQUIRED: Record<string, string[]> = {
  "cafe24_get_store": [],
  "cafe24_list_shops": [],
  "cafe24_get_dashboard": [],
  "cafe24_list_orders": [],
  "cafe24_count_orders": [],
  "cafe24_get_order": [
    "order_id"
  ],
  "cafe24_list_order_items": [
    "order_id"
  ],
  "cafe24_get_order_receivers": [
    "order_id"
  ],
  "cafe24_list_order_shipments": [
    "order_id"
  ],
  "cafe24_get_claim": [
    "claim_code",
    "claim_type"
  ],
  "cafe24_list_products": [],
  "cafe24_count_products": [],
  "cafe24_get_product": [
    "product_no"
  ],
  "cafe24_list_variants": [
    "product_no"
  ],
  "cafe24_get_inventory": [
    "product_no",
    "variant_code"
  ],
  "cafe24_list_categories": [],
  "cafe24_list_carriers": [],
  "cafe24_search_customers": [],
  "cafe24_list_boards": [],
  "cafe24_list_board_articles": [
    "board_no"
  ],
  "cafe24_create_shipment": [
    "order_id",
    "shipping_company_code",
    "status",
    "tracking_no"
  ],
  "cafe24_update_shipment": [
    "order_id",
    "shipping_code"
  ],
  "cafe24_update_order_status": [
    "order_id",
    "process_status"
  ],
  "cafe24_update_product": [
    "product_no"
  ],
  "cafe24_update_variant": [
    "product_no",
    "variant_code"
  ],
  "cafe24_update_inventory": [
    "product_no",
    "variant_code"
  ],
  "cafe24_add_board_comment": [
    "article_no",
    "board_no",
    "content",
    "password",
    "writer"
  ],
  "cafe24_set_product_display": [
    "product_no"
  ]
};
const PROBE = {
  "tool": "cafe24_get_store",
  "params": {}
};

describe('cafe24 adapter: static contract', () => {
  it('signs in per mall with OAuth and calls the admin API with a pinned version', () => {
    expect(a.slug).toBe('cafe24');
    expect(a.region).toBe('intl');
    expect(a.connector.baseUrl).toBe('https://{{CAFE24_MALL_ID}}.cafe24api.com/api/v2/admin');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toMatchObject({
      clientId: '{{CAFE24_CLIENT_ID}}',
      clientSecret: '{{CAFE24_CLIENT_SECRET}}',
      authorizationUrl: 'https://{{CAFE24_MALL_ID}}.cafe24api.com/api/v2/oauth/authorize',
      tokenUrl: 'https://{{CAFE24_MALL_ID}}.cafe24api.com/api/v2/oauth/token',
      tokenAuthMethod: 'client_secret_basic',
    });
    const scopes = String(a.connector.authConfig.scopes).split(',');
    for (const s of ['mall.read_order', 'mall.write_order', 'mall.read_product', 'mall.write_product', 'mall.read_store']) expect(scopes).toContain(s);
    expect(a.connector.headers!['X-Cafe24-Api-Version']).toMatch(/^20[0-9]{2}-[0-9]{2}-01$/);
    expect(a.envVarMeta.CAFE24_CLIENT_SECRET.secret).toBe(true);
    const mall = new RegExp(a.envVarMeta.CAFE24_MALL_ID.pattern!);
    expect(mall.test('myshop')).toBe(true);
    expect(mall.test('myshop.cafe24.com')).toBe(false);
  });

  it('wraps every write in shop_no and request, and keeps hiding a product apart', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method !== 'GET')) {
      const body = t.endpointMapping.bodyMapping as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['request', 'shop_no']);
    }
    expect((tool('cafe24_update_product').endpointMapping.bodyMapping as { request: Record<string, unknown> }).request).not.toHaveProperty('display');
    expect((tool('cafe24_create_shipment').endpointMapping.bodyMapping as { request: Record<string, unknown> }).request).toEqual({
      tracking_no: '$tracking_no',
      shipping_company_code: '$shipping_company_code',
      status: '$status',
      order_item_code: '$order_item_codes',
    });
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

const live = process.env.RUN_CAFE24_LIVE === '1' ? describe : describe.skip;
live('cafe24 adapter: live reads', () => {
  it('reads the store and counts the products with an access token', async () => {
    const base = `https://${process.env.CAFE24_MALL_ID}.cafe24api.com/api/v2/admin`;
    for (const path of ['/store', '/products/count']) {
      const res = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${process.env.CAFE24_ACCESS_TOKEN}`, 'X-Cafe24-Api-Version': '2026-09-01' },
      });
      expect(res.status).toBe(200);
    }
  });
});

