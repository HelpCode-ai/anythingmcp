import * as adapter from './ideasoft.json';
/**
 * IdeaSoft Admin API adapter.
 *
 * Static checks always run: the authorization-code sign-in at the shop's own
 * /panel/auth and /oauth/v2/token without PKCE, every route against IdeaSoft's
 * published Admin API reference (https://apidoc.ideasoft.dev/docs/admin-api),
 * the write bodies, and which tools install switched off (order cancel or
 * refund, product delete, refund request update). The undocumented shipment
 * actions are not used. No tool moves money while switched on.
 *
 * Live checks run only with RUN_IDEASOFT_LIVE=1, IDEASOFT_SHOP_DOMAIN and
 * IDEASOFT_ACCESS_TOKEN (a token from a finished sign-in): they read one
 * product. Reads only.
 *
 *   RUN_IDEASOFT_LIVE=1 IDEASOFT_SHOP_DOMAIN=... IDEASOFT_ACCESS_TOKEN=... \
 *     npx jest src/adapters/intl/ideasoft.live.spec.ts
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
  ideasoft_list_orders: ["GET", "/orders"],
  ideasoft_count_orders: ["GET", "/orders/count"],
  ideasoft_get_order: ["GET", "/orders/{order_id}"],
  ideasoft_update_order: ["PUT", "/orders/{order_id}"],
  ideasoft_cancel_order: ["PUT", "/orders/{order_id}"],
  ideasoft_list_order_items: ["GET", "/order_items"],
  ideasoft_list_order_details: ["GET", "/order_details"],
  ideasoft_list_order_notes: ["GET", "/order_user_notes"],
  ideasoft_add_order_note: ["POST", "/order_user_notes"],
  ideasoft_list_shipments: ["GET", "/shipments"],
  ideasoft_get_shipment: ["GET", "/shipments/{shipment_id}"],
  ideasoft_list_shipping_providers: ["GET", "/shipping_providers"],
  ideasoft_list_shipping_companies: ["GET", "/shipping_companies"],
  ideasoft_list_products: ["GET", "/products"],
  ideasoft_count_products: ["GET", "/products/count"],
  ideasoft_get_product: ["GET", "/products/{product_id}"],
  ideasoft_create_product: ["POST", "/products"],
  ideasoft_update_product: ["PUT", "/products/{product_id}"],
  ideasoft_delete_product: ["DELETE", "/products/{product_id}"],
  ideasoft_list_product_prices: ["GET", "/product_prices"],
  ideasoft_update_product_price: ["PUT", "/product_prices/{price_id}"],
  ideasoft_list_product_details: ["GET", "/product_details"],
  ideasoft_update_product_details: ["PUT", "/product_details/{detail_id}"],
  ideasoft_list_categories: ["GET", "/categories"],
  ideasoft_get_category: ["GET", "/categories/{category_id}"],
  ideasoft_list_brands: ["GET", "/brands"],
  ideasoft_get_brand: ["GET", "/brands/{brand_id}"],
  ideasoft_list_members: ["GET", "/members"],
  ideasoft_get_member: ["GET", "/members/{member_id}"],
  ideasoft_list_refund_requests: ["GET", "/order_refund_requests"],
  ideasoft_count_refund_requests: ["GET", "/order_refund_requests/count"],
  ideasoft_get_refund_request: ["GET", "/order_refund_requests/{refund_request_id}"],
  ideasoft_update_refund_request: ["PUT", "/order_refund_requests/{refund_request_id}"],
  ideasoft_list_payment_types: ["GET", "/payment_types"],
  ideasoft_list_currencies: ["GET", "/currencies"],
};
const SWITCHED_OFF = [
  "ideasoft_cancel_order",
  "ideasoft_delete_product",
  "ideasoft_update_refund_request"
];
const REQUIRED: Record<string, string[]> = {
  ideasoft_list_orders: [],
  ideasoft_count_orders: [],
  ideasoft_get_order: ["order_id"],
  ideasoft_update_order: ["order_id"],
  ideasoft_cancel_order: ["order_id", "status"],
  ideasoft_list_order_items: [],
  ideasoft_list_order_details: [],
  ideasoft_list_order_notes: [],
  ideasoft_add_order_note: ["note", "order_id"],
  ideasoft_list_shipments: [],
  ideasoft_get_shipment: ["shipment_id"],
  ideasoft_list_shipping_providers: [],
  ideasoft_list_shipping_companies: [],
  ideasoft_list_products: [],
  ideasoft_count_products: [],
  ideasoft_get_product: ["product_id"],
  ideasoft_create_product: ["currency", "name", "price1", "sku", "stock_amount"],
  ideasoft_update_product: ["product_id"],
  ideasoft_delete_product: ["product_id"],
  ideasoft_list_product_prices: [],
  ideasoft_update_product_price: ["price_id", "product_id", "type", "value"],
  ideasoft_list_product_details: [],
  ideasoft_update_product_details: ["detail_id", "details", "product_id", "sku"],
  ideasoft_list_categories: [],
  ideasoft_get_category: ["category_id"],
  ideasoft_list_brands: [],
  ideasoft_get_brand: ["brand_id"],
  ideasoft_list_members: [],
  ideasoft_get_member: ["member_id"],
  ideasoft_list_refund_requests: [],
  ideasoft_count_refund_requests: [],
  ideasoft_get_refund_request: ["refund_request_id"],
  ideasoft_update_refund_request: ["refund_request_id", "status"],
  ideasoft_list_payment_types: [],
  ideasoft_list_currencies: [],
};
const PROBE = {"tool": "ideasoft_list_products", "params": {"limit": 1}};
const PROBE_METHOD = "GET";

describe('ideasoft adapter: static contract', () => {
  it('signs in at the shop\'s own authorization and token URLs without PKCE', () => {
    expect(a.slug).toBe('ideasoft');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.baseUrl).toBe('https://{{IDEASOFT_SHOP_DOMAIN}}/admin-api');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{IDEASOFT_CLIENT_ID}}',
      clientSecret: '{{IDEASOFT_CLIENT_SECRET}}',
      authorizationUrl: 'https://{{IDEASOFT_SHOP_DOMAIN}}/panel/auth',
      tokenUrl: 'https://{{IDEASOFT_SHOP_DOMAIN}}/oauth/v2/token',
      pkce: false,
    });
    expect(a.requiredEnvVars).toEqual(['IDEASOFT_SHOP_DOMAIN', 'IDEASOFT_CLIENT_ID', 'IDEASOFT_CLIENT_SECRET']);
    expect(a.envVarMeta.IDEASOFT_CLIENT_SECRET.secret).toBe(true);
    const host = new RegExp(a.envVarMeta.IDEASOFT_SHOP_DOMAIN.pattern!);
    for (const good of ['magaza.myideasoft.com', 'www.example.com.tr']) expect(host.test(good)).toBe(true);
    for (const bad of ['https://magaza.myideasoft.com', 'magaza.myideasoft.com/admin-api']) expect(host.test(bad)).toBe(false);
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

  it('keeps cancellations, refunds and deletes switched off and leaves out the undocumented shipment actions', () => {
    expect(JSON.stringify(tool('ideasoft_update_order').parameters)).not.toMatch(/cancelled|refunded/);
    expect(tool('ideasoft_cancel_order').endpointMapping.bodyMapping).toEqual({ status: '$status' });
    for (const t of a.tools) {
      expect(t.endpointMapping.path).not.toMatch(/\/shipments\/(create|cancel)|generate-tracking-code|payments/);
      if (t.endpointMapping.method === 'DELETE') expect(t.enabled).toBe(false);
      if (t.endpointMapping.path.startsWith('/order_refund_requests') && t.endpointMapping.method !== 'GET') expect(t.enabled).toBe(false);
    }
    expect(tool('ideasoft_update_product').endpointMapping.bodyMapping).toMatchObject({ stockAmount: '$stock_amount', price1: '$price1', currency: '$currency' });
    expect(tool('ideasoft_add_order_note').endpointMapping.bodyMapping).toEqual({ note: '$note', order: { id: '$order_id' } });
  });

  it('caps every page at 100 rows', () => {
    for (const t of a.tools) {
      const limit = (t.parameters.properties ?? {}).limit as unknown as { maximum?: number } | undefined;
      if (limit) expect(limit.maximum).toBe(100);
    }
  });
});

const live = process.env.RUN_IDEASOFT_LIVE === '1' ? describe : describe.skip;
live('ideasoft adapter: live reads', () => {
  it('reads one product', async () => {
    const res = await fetch(`https://${process.env.IDEASOFT_SHOP_DOMAIN}/admin-api/products?limit=1`, {
      headers: { Authorization: `Bearer ${process.env.IDEASOFT_ACCESS_TOKEN}`, Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
