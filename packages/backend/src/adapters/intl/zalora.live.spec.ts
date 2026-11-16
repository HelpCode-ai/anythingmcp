import * as adapter from './zalora.json';
/**
 * ZALORA Seller Center API v2 adapter.
 *
 * Static checks always run: the client-credentials token at the country's
 * Seller Center (HTTP Basic), the v2 routes of every tool against
 * https://sellercenter-api.zalora.com.ph/doc, the bracketed array filters, the
 * JSON bodies of the status changes, and the switched-off cancellation, failed
 * delivery, return approval and price deactivation. No tool buys labels or
 * moves money.
 *
 * Live checks run only with RUN_ZALORA_LIVE=1 and ZALORA_DOMAIN,
 * ZALORA_CLIENT_ID, ZALORA_CLIENT_SECRET set: they get a token and read the
 * order counters and one product. Reads only.
 *
 *   RUN_ZALORA_LIVE=1 ZALORA_DOMAIN=zalora.sg ZALORA_CLIENT_ID=... ZALORA_CLIENT_SECRET=... \
 *     npx jest src/adapters/intl/zalora.live.spec.ts
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
  "zalora_list_orders": [
    "GET",
    "/v2/orders"
  ],
  "zalora_get_order": [
    "GET",
    "/v2/orders/{order_id}"
  ],
  "zalora_get_order_counters": [
    "GET",
    "/v2/orders-counters"
  ],
  "zalora_list_order_items": [
    "GET",
    "/v2/order-items"
  ],
  "zalora_get_order_history": [
    "GET",
    "/v2/order/{order_id}/history"
  ],
  "zalora_get_order_item_returns": [
    "GET",
    "/v2/order-items/returns"
  ],
  "zalora_list_shipment_providers": [
    "GET",
    "/v2/orders-shipment-providers"
  ],
  "zalora_list_failure_reasons": [
    "GET",
    "/v2/orders-failure-reasons"
  ],
  "zalora_print_document": [
    "POST",
    "/v2/orders/print-preview-document"
  ],
  "zalora_list_products": [
    "GET",
    "/v2/products"
  ],
  "zalora_list_product_sets": [
    "GET",
    "/v2/product-sets"
  ],
  "zalora_list_product_set_products": [
    "GET",
    "/v2/product-set/{product_set_id}/products"
  ],
  "zalora_get_product_stock": [
    "GET",
    "/v2/stock/product/{product_id}"
  ],
  "zalora_get_product_set_stock": [
    "GET",
    "/v2/stock/product-set/{product_set_id}"
  ],
  "zalora_get_product_set_prices": [
    "GET",
    "/v2/product-set/{product_set_id}/prices"
  ],
  "zalora_list_brands": [
    "GET",
    "/v2/brands"
  ],
  "zalora_get_category_tree": [
    "GET",
    "/v2/category/tree"
  ],
  "zalora_get_category_attributes": [
    "GET",
    "/v2/category/{category_id}/attributes"
  ],
  "zalora_get_seller": [
    "GET",
    "/v2/seller"
  ],
  "zalora_set_ready_to_ship": [
    "POST",
    "/v2/orders/statuses/set-to-ready-to-ship"
  ],
  "zalora_set_packed_by_marketplace": [
    "POST",
    "/v2/orders/statuses/set-to-packed-by-marketplace"
  ],
  "zalora_set_shipped": [
    "POST",
    "/v2/orders/statuses/set-to-shipped"
  ],
  "zalora_set_delivered": [
    "POST",
    "/v2/orders/statuses/set-to-delivered"
  ],
  "zalora_update_tracking_code": [
    "POST",
    "/v2/order-item/{order_item_id}/tracking-code"
  ],
  "zalora_update_shipping_provider": [
    "POST",
    "/v2/order-item/{order_item_id}/shipping-provider"
  ],
  "zalora_update_stock": [
    "PUT",
    "/v2/stock/product"
  ],
  "zalora_update_price": [
    "PUT",
    "/v2/product/{product_id}/prices/{country}"
  ],
  "zalora_set_price_status": [
    "PUT",
    "/v2/product/{product_id}/prices/{country}/status"
  ],
  "zalora_cancel_order_items": [
    "POST",
    "/v2/orders/statuses/set-to-cancelled"
  ],
  "zalora_set_delivery_failed": [
    "POST",
    "/v2/orders/statuses/set-to-delivery-failed"
  ],
  "zalora_approve_return": [
    "POST",
    "/v2/orders/statuses/set-to-return-approved"
  ]
};
const SWITCHED_OFF = [
  "zalora_approve_return",
  "zalora_cancel_order_items",
  "zalora_set_delivery_failed",
  "zalora_set_price_status"
];
const REQUIRED: Record<string, string[]> = {
  "zalora_list_orders": [],
  "zalora_get_order": [
    "order_id"
  ],
  "zalora_get_order_counters": [],
  "zalora_list_order_items": [],
  "zalora_get_order_history": [
    "order_id"
  ],
  "zalora_get_order_item_returns": [
    "order_item_ids"
  ],
  "zalora_list_shipment_providers": [],
  "zalora_list_failure_reasons": [],
  "zalora_print_document": [
    "document_type",
    "order_ids"
  ],
  "zalora_list_products": [],
  "zalora_list_product_sets": [],
  "zalora_list_product_set_products": [
    "product_set_id"
  ],
  "zalora_get_product_stock": [
    "product_id"
  ],
  "zalora_get_product_set_stock": [
    "product_set_id"
  ],
  "zalora_get_product_set_prices": [
    "product_set_id"
  ],
  "zalora_list_brands": [],
  "zalora_get_category_tree": [],
  "zalora_get_category_attributes": [
    "category_id"
  ],
  "zalora_get_seller": [],
  "zalora_set_ready_to_ship": [
    "order_items"
  ],
  "zalora_set_packed_by_marketplace": [
    "delivery_type",
    "order_items"
  ],
  "zalora_set_shipped": [
    "order_item_ids"
  ],
  "zalora_set_delivered": [
    "order_item_ids"
  ],
  "zalora_update_tracking_code": [
    "order_item_id",
    "tracking_code"
  ],
  "zalora_update_shipping_provider": [
    "order_item_id",
    "shipping_provider"
  ],
  "zalora_update_stock": [
    "items"
  ],
  "zalora_update_price": [
    "country",
    "product_id"
  ],
  "zalora_set_price_status": [
    "country",
    "product_id",
    "status"
  ],
  "zalora_cancel_order_items": [
    "order_item_ids",
    "reason"
  ],
  "zalora_set_delivery_failed": [
    "order_item_ids",
    "reason"
  ],
  "zalora_approve_return": [
    "order_item_ids"
  ]
};
const PROBE = {
  "tool": "zalora_get_order_counters",
  "params": {}
};

describe('zalora adapter: static contract', () => {
  it('gets a client-credentials token at the country Seller Center and calls the v2 API there', () => {
    expect(a.slug).toBe('zalora');
    expect(a.region).toBe('intl');
    expect(a.connector.baseUrl).toBe('https://sellercenter-api.{{ZALORA_DOMAIN}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{ZALORA_CLIENT_ID}}',
      clientSecret: '{{ZALORA_CLIENT_SECRET}}',
      tokenUrl: 'https://sellercenter.{{ZALORA_DOMAIN}}/oauth/client-credentials',
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(a.requiredEnvVars).toEqual(['ZALORA_DOMAIN', 'ZALORA_CLIENT_ID', 'ZALORA_CLIENT_SECRET']);
    expect(a.envVarMeta.ZALORA_CLIENT_SECRET.secret).toBe(true);
    const domains = a.envVarMeta.ZALORA_DOMAIN.options!.map((o) => o.value);
    expect(domains).toEqual(['zalora.sg', 'zalora.com.my', 'zalora.co.id', 'zalora.com.ph', 'zalora.com.hk']);
    const pattern = new RegExp(a.envVarMeta.ZALORA_DOMAIN.pattern!);
    for (const d of domains) expect(pattern.test(d)).toBe(true);
    for (const bad of ['https://zalora.sg', 'zalora.com.sg', 'sellercenter-api.zalora.sg']) expect(pattern.test(bad)).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/v2\//);
  });

  it('sends array filters in the bracket form and the stock list as the whole body', () => {
    expect(tool('zalora_list_orders').endpointMapping.queryParams).toMatchObject({ 'orderNumbers[]': '$order_numbers', limit: '$limit', offset: '$offset' });
    expect(tool('zalora_list_order_items').endpointMapping.queryParams).toMatchObject({ 'orderIds[]': '$order_ids', 'status[]': '$status' });
    expect(tool('zalora_update_stock').endpointMapping.bodyMapping).toEqual({ __raw: '$items' });
    expect(tool('zalora_set_ready_to_ship').endpointMapping.bodyMapping).toMatchObject({ orderItems: '$order_items', trackingNumber: '$tracking_number' });
    expect(tool('zalora_update_price').endpointMapping.bodyMapping).not.toHaveProperty('status');
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

const live = process.env.RUN_ZALORA_LIVE === '1' ? describe : describe.skip;
live('zalora adapter: live reads', () => {
  it('gets a token and reads the order counters and one page of products', async () => {
    const domain = process.env.ZALORA_DOMAIN ?? 'zalora.sg';
    const basic = Buffer.from(`${process.env.ZALORA_CLIENT_ID}:${process.env.ZALORA_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://sellercenter.${domain}/oauth/client-credentials`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    expect(tokenRes.status).toBe(200);
    const { access_token: token } = (await tokenRes.json()) as { access_token: string };
    for (const path of ['/v2/orders-counters', '/v2/products?limit=1&offset=0']) {
      const res = await fetch(`https://sellercenter-api.${domain}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      expect(res.status).toBe(200);
    }
  });
});

