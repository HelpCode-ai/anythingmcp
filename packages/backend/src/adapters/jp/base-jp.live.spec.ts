import * as adapter from './base-jp.json';
/**
 * BASE API v2 adapter (thebase.com, Japan).
 *
 * Static checks always run: the Personal Access Token as a bearer token, every
 * tool's method and path against https://apiv2.thebase.com/docs/reference.md,
 * the JSON bodies of order search, dispatch, stock and item edits, and the
 * switched-off cancellation and visibility switch.
 *
 * Live checks run only with RUN_BASE_JP_LIVE=1 and BASE_ACCESS_TOKEN set: they
 * read the user and one item. Reads only.
 *
 *   RUN_BASE_JP_LIVE=1 BASE_ACCESS_TOKEN=... npx jest src/adapters/jp/base-jp.live.spec.ts
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
  "base_jp_get_user": [
    "GET",
    "/api/user"
  ],
  "base_jp_list_items": [
    "GET",
    "/api/items"
  ],
  "base_jp_get_item": [
    "GET",
    "/api/items/{item_id}"
  ],
  "base_jp_list_item_variations": [
    "GET",
    "/api/items/{item_id}/variations"
  ],
  "base_jp_list_item_categories": [
    "GET",
    "/api/item_categories"
  ],
  "base_jp_search_orders": [
    "POST",
    "/api/orders/search"
  ],
  "base_jp_get_order": [
    "GET",
    "/api/orders/{unique_key}"
  ],
  "base_jp_list_delivery_companies": [
    "GET",
    "/api/delivery_companies"
  ],
  "base_jp_dispatch_order": [
    "POST",
    "/api/orders/{unique_key}/dispatch"
  ],
  "base_jp_update_shop_memo": [
    "PUT",
    "/api/orders/{unique_key}/shop_memo"
  ],
  "base_jp_set_stock": [
    "PUT",
    "/api/items/{item_id}/stock"
  ],
  "base_jp_update_item": [
    "POST",
    "/api/items/{item_id}"
  ],
  "base_jp_set_item_visibility": [
    "PUT",
    "/api/items/{item_id}/visibility"
  ],
  "base_jp_cancel_order": [
    "POST",
    "/api/orders/{unique_key}/cancel"
  ]
};
const SWITCHED_OFF = [
  "base_jp_cancel_order",
  "base_jp_set_item_visibility"
];
const REQUIRED: Record<string, string[]> = {
  "base_jp_get_user": [],
  "base_jp_list_items": [],
  "base_jp_get_item": [
    "item_id"
  ],
  "base_jp_list_item_variations": [
    "item_id"
  ],
  "base_jp_list_item_categories": [],
  "base_jp_search_orders": [],
  "base_jp_get_order": [
    "unique_key"
  ],
  "base_jp_list_delivery_companies": [],
  "base_jp_dispatch_order": [
    "order_line_ids",
    "unique_key"
  ],
  "base_jp_update_shop_memo": [
    "text",
    "unique_key"
  ],
  "base_jp_set_stock": [
    "count",
    "item_id"
  ],
  "base_jp_update_item": [
    "item_id"
  ],
  "base_jp_set_item_visibility": [
    "item_id",
    "visible"
  ],
  "base_jp_cancel_order": [
    "order_line_ids",
    "unique_key"
  ]
};
const PROBE = {
  "tool": "base_jp_get_user",
  "params": {}
};

describe('base-jp adapter: static contract', () => {
  it('sends the Personal Access Token as a bearer token to the v2 API', () => {
    expect(a.slug).toBe('base-jp');
    expect(a.region).toBe('jp');
    expect(a.connector.baseUrl).toBe('https://apiv2.thebase.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{BASE_ACCESS_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['BASE_ACCESS_TOKEN']);
    expect(a.envVarMeta.BASE_ACCESS_TOKEN.secret).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/api\//);
  });

  it('dispatches by order line and keeps cancelling and hiding apart', () => {
    expect(tool('base_jp_dispatch_order').endpointMapping.bodyMapping).toEqual({
      order_line_ids: '$order_line_ids',
      delivery_company_id: '$delivery_company_id',
      tracking_number: '$tracking_number',
      comment: '$comment',
    });
    expect(tool('base_jp_set_stock').endpointMapping.bodyMapping).toEqual({ variation_id: '$variation_id', count: '$count' });
    expect(tool('base_jp_update_item').endpointMapping.bodyMapping).not.toHaveProperty('visible');
    expect(tool('base_jp_search_orders').annotations?.readOnlyHint).toBe(true);
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

const live = process.env.RUN_BASE_JP_LIVE === '1' ? describe : describe.skip;
live('base-jp adapter: live reads', () => {
  it('reads the user and one page of items with the token', async () => {
    for (const path of ['/api/user', '/api/items?limit=1']) {
      const res = await fetch(`https://apiv2.thebase.com${path}`, { headers: { Authorization: `Bearer ${process.env.BASE_ACCESS_TOKEN}` } });
      expect(res.status).toBe(200);
    }
  });
});

