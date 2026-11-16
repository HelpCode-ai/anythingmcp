import * as adapter from './tiki.json';
/**
 * Tiki Open API adapter.
 *
 * Static checks always run: the client-credentials token at
 * api.tiki.vn/sc/oauth2/token with HTTP Basic (in-house app), the
 * /integration/v2 and v2.1 routes of every tool against https://open.tiki.vn/docs/,
 * the confirmation bodies, and the switched-off dropship refusal and product
 * switch-off.
 *
 * Live checks run only with RUN_TIKI_LIVE=1 and TIKI_CLIENT_ID,
 * TIKI_CLIENT_SECRET set: they get a token and read the seller and one order.
 * Reads only.
 *
 *   RUN_TIKI_LIVE=1 TIKI_CLIENT_ID=... TIKI_CLIENT_SECRET=... npx jest src/adapters/intl/tiki.live.spec.ts
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
  "tiki_get_seller": [
    "GET",
    "/integration/v2/sellers/me"
  ],
  "tiki_list_seller_warehouses": [
    "GET",
    "/integration/v2/sellers/me/warehouses"
  ],
  "tiki_list_orders": [
    "GET",
    "/integration/v2/orders"
  ],
  "tiki_get_order": [
    "GET",
    "/integration/v2/orders/{code}"
  ],
  "tiki_list_seller_inventories": [
    "GET",
    "/integration/v2/seller-inventories"
  ],
  "tiki_get_shipping_label": [
    "GET",
    "/integration/v2/orders/{code}/{delivery_model}/labels"
  ],
  "tiki_list_products": [
    "GET",
    "/integration/v2.1/products"
  ],
  "tiki_get_product": [
    "GET",
    "/integration/v2.1/products/{product_id}"
  ],
  "tiki_find_product_by_sku": [
    "GET",
    "/integration/v2/products/findBy"
  ],
  "tiki_list_categories": [
    "GET",
    "/integration/v2/categories"
  ],
  "tiki_get_category_attributes": [
    "GET",
    "/integration/v2/categories/{category_id}/attributes"
  ],
  "tiki_list_brands": [
    "GET",
    "/integration/v2/brands"
  ],
  "tiki_list_tiki_warehouses": [
    "GET",
    "/integration/v2/warehouses/tiki"
  ],
  "tiki_list_product_requests": [
    "GET",
    "/integration/v2/requests"
  ],
  "tiki_get_tracking": [
    "GET",
    "/integration/v2/tracking/{track_id}"
  ],
  "tiki_confirm_available": [
    "POST",
    "/integration/v2/orders/{code}/confirm-available"
  ],
  "tiki_confirm_dropship": [
    "POST",
    "/integration/v2/orders/{code}/dropship/confirm-available"
  ],
  "tiki_update_seller_delivery": [
    "POST",
    "/integration/v2/orders/{code}/seller-delivery/update-delivery"
  ],
  "tiki_update_product": [
    "PUT",
    "/integration/v2.1/products/updateSku"
  ],
  "tiki_set_product_active": [
    "PUT",
    "/integration/v2.1/products/updateSku"
  ],
  "tiki_cancel_dropship": [
    "POST",
    "/integration/v2/orders/{code}/dropship/confirm-available"
  ]
};
const SWITCHED_OFF = [
  "tiki_cancel_dropship",
  "tiki_set_product_active"
];
const REQUIRED: Record<string, string[]> = {
  "tiki_get_seller": [],
  "tiki_list_seller_warehouses": [],
  "tiki_list_orders": [],
  "tiki_get_order": [
    "code"
  ],
  "tiki_list_seller_inventories": [
    "tiki_warehouse_codes"
  ],
  "tiki_get_shipping_label": [
    "code",
    "delivery_model"
  ],
  "tiki_list_products": [],
  "tiki_get_product": [
    "product_id"
  ],
  "tiki_find_product_by_sku": [
    "original_sku"
  ],
  "tiki_list_categories": [],
  "tiki_get_category_attributes": [
    "category_id"
  ],
  "tiki_list_brands": [
    "name"
  ],
  "tiki_list_tiki_warehouses": [],
  "tiki_list_product_requests": [],
  "tiki_get_tracking": [
    "track_id"
  ],
  "tiki_confirm_available": [
    "available_item_ids",
    "code",
    "seller_inventory_id"
  ],
  "tiki_confirm_dropship": [
    "code",
    "seller_inventory_id"
  ],
  "tiki_update_seller_delivery": [
    "code",
    "status"
  ],
  "tiki_update_product": [],
  "tiki_set_product_active": [
    "active"
  ],
  "tiki_cancel_dropship": [
    "code",
    "seller_inventory_id"
  ]
};
const PROBE = {
  "tool": "tiki_get_seller",
  "params": {}
};

describe('tiki adapter: static contract', () => {
  it('gets a client-credentials token with HTTP Basic and calls the integration API', () => {
    expect(a.slug).toBe('tiki');
    expect(a.region).toBe('intl');
    expect(a.connector.baseUrl).toBe('https://api.tiki.vn');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{TIKI_CLIENT_ID}}',
      clientSecret: '{{TIKI_CLIENT_SECRET}}',
      tokenUrl: 'https://api.tiki.vn/sc/oauth2/token',
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(a.envVarMeta.TIKI_CLIENT_SECRET.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.TIKI_CLIENT_ID.pattern!).test('7590139168389961')).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/integration\/v2(\.1)?\//);
    expect(a.instructions).toContain('basic header');
  });

  it('confirms with the documented bodies and keeps cancelling and switching off apart', () => {
    expect(tool('tiki_confirm_dropship').endpointMapping.bodyMapping).toEqual({ confirmation_status: 'seller_confirmed', seller_inventory_id: '$seller_inventory_id' });
    expect(tool('tiki_cancel_dropship').endpointMapping.bodyMapping).toEqual({ confirmation_status: 'seller_canceled', seller_inventory_id: '$seller_inventory_id' });
    expect(tool('tiki_update_product').endpointMapping.bodyMapping).not.toHaveProperty('active');
    expect(tool('tiki_get_shipping_label').endpointMapping.queryParams).toEqual({ format: 'html' });
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

const live = process.env.RUN_TIKI_LIVE === '1' ? describe : describe.skip;
live('tiki adapter: live reads', () => {
  it('gets a token and reads the seller and one page of orders', async () => {
    const basic = Buffer.from(`${process.env.TIKI_CLIENT_ID}:${process.env.TIKI_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://api.tiki.vn/sc/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    expect(tokenRes.status).toBe(200);
    const { access_token: token } = (await tokenRes.json()) as { access_token: string };
    for (const path of ['/integration/v2/sellers/me', '/integration/v2/orders?limit=1']) {
      const res = await fetch(`https://api.tiki.vn${path}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
    }
  });
});

