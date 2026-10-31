import * as adapter from './clover.json';

/**
 * Clover Platform REST API v3 (docs.clover.com/dev/reference, OpenAPI fragments per operation, index at docs.clover.com/dev/llms.txt):
 * base https://api.clover.com, https://api.eu.clover.com, https://api.la.clover.com or https://apisandbox.dev.clover.com (CLOVER_API_URL),
 * Bearer merchant API token, merchant id in the path, lists as {elements} paged with limit and offset.
 * Live part (reads only: merchant, items, orders, payments, customers):
 *   CLOVER_API_TOKEN=... CLOVER_MERCHANT_ID=... CLOVER_API_URL=https://apisandbox.dev.clover.com RUN_CLOVER_LIVE=1 npx jest src/adapters/intl/clover
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const ENV = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings (connector variables excluded).
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  for (const e of ENV) out.delete(e);
  return out;
};
const PREFIX = 'clover_';
const M = '/v3/merchants/{{CLOVER_MERCHANT_ID}}';

describe('clover adapter: static spec conformance', () => {
  it('authenticates with a Bearer API token against the regional host and puts the merchant id in the path', () => {
    expect(a.slug).toBe('clover');
    expect(a.region).toBe('intl');
    expect(a.requiredEnvVars).toEqual(['CLOVER_API_TOKEN', 'CLOVER_MERCHANT_ID', 'CLOVER_API_URL']);
    expect(a.connector.baseUrl).toBe('{{CLOVER_API_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{CLOVER_API_TOKEN}}' });
    expect(a.envVarMeta?.CLOVER_API_TOKEN.secret).toBe(true);
    const host = new RegExp(a.envVarMeta?.CLOVER_API_URL.pattern as string);
    for (const h of ['https://api.clover.com', 'https://api.eu.clover.com', 'https://api.la.clover.com', 'https://apisandbox.dev.clover.com']) expect(host.test(h)).toBe(true);
    expect(host.test('https://api.clover.com/')).toBe(false);
    expect(host.test('https://www.clover.com')).toBe(false);
    const mid = new RegExp(a.envVarMeta?.CLOVER_MERCHANT_ID.pattern as string);
    expect(mid.test('ABCDEFGHJKMNP')).toBe(true);
    expect(mid.test('abc')).toBe(false);
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.path.startsWith(M)}`).toBe(`${t.name}:true`);
  });

  it('maps inventory, stock and categories', () => {
    expect(tool('clover_list_items').endpointMapping).toMatchObject({ method: 'GET', path: `${M}/items`, queryParams: { filter: '$filter', expand: '$expand', limit: '$limit', offset: '$offset' } });
    expect(tool('clover_create_item').endpointMapping).toMatchObject({ method: 'POST', path: `${M}/items`, bodyMapping: { name: '$name', price: '$price' } });
    expect(tool('clover_create_item').parameters?.required).toEqual(['name', 'price']);
    expect(tool('clover_update_item').endpointMapping).toMatchObject({ method: 'POST', path: `${M}/items/{item_id}` });
    expect(tool('clover_update_item_stock').endpointMapping).toEqual({ method: 'PUT', path: `${M}/item_stocks/{item_id}`, bodyMapping: { quantity: '$quantity', stockAlertThreshold: '$stockAlertThreshold' } });
    expect(tool('clover_list_category_items').endpointMapping.path).toBe(`${M}/categories/{category_id}/items`);
    expect(tool('clover_list_tax_rates').endpointMapping.path).toBe(`${M}/tax_rates`);
    expect(tool('clover_list_modifier_groups').endpointMapping.path).toBe(`${M}/modifier_groups`);
  });

  it('maps orders, atomic orders, payments and refunds', () => {
    expect(tool('clover_list_orders').endpointMapping.queryParams).toMatchObject({ filter: '$filter', expand: '$expand' });
    expect(tool('clover_create_atomic_order').endpointMapping).toEqual({ method: 'POST', path: `${M}/atomic_order/orders`, bodyMapping: { orderCart: '$orderCart' } });
    expect(tool('clover_calculate_order').endpointMapping).toEqual({ method: 'POST', path: `${M}/atomic_order/checkouts`, bodyMapping: { orderCart: '$orderCart' } });
    expect(tool('clover_calculate_order').annotations?.readOnlyHint).toBe(true);
    expect(tool('clover_add_line_item').endpointMapping).toMatchObject({ method: 'POST', path: `${M}/orders/{order_id}/line_items` });
    expect(tool('clover_add_order_discount').endpointMapping).toMatchObject({ method: 'POST', path: `${M}/orders/{order_id}/discounts`, bodyMapping: { name: '$name', amount: '$amount', percentage: '$percentage' } });
    expect(tool('clover_list_payments').endpointMapping.path).toBe(`${M}/payments`);
    expect(tool('clover_list_order_payments').endpointMapping.path).toBe(`${M}/orders/{order_id}/payments`);
    expect(tool('clover_list_refunds').endpointMapping.path).toBe(`${M}/refunds`);
    expect(tool('clover_list_tenders').endpointMapping.path).toBe(`${M}/tenders`);
    expect(tool('clover_list_shifts').endpointMapping.path).toBe(`${M}/shifts`);
    expect(tool('clover_list_orders').parameters?.properties?.filter).toMatchObject({ type: 'array' });
  });

  it('has no tool that moves money and installs voids and deletes switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual(['clover_delete_customer', 'clover_delete_order', 'clover_void_line_item']);
    for (const n of off) expect(tool(n).annotations?.destructiveHint).toBe(true);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'DELETE')) expect(off).toContain(t.name);
    for (const t of a.tools) expect(`${t.name}:${/refund|charge|capture/.test(t.endpointMapping.path) && t.endpointMapping.method !== 'GET'}`).toBe(`${t.name}:false`);
    expect(a.instructions).toContain('**Switched off at install**: `clover_void_line_item`, `clover_delete_order` and `clover_delete_customer`');
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(`${t.name}:${r}:${props.includes(r)}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('keeps GET tools read-only', () => {
    for (const t of a.tools) if (t.endpointMapping.method === 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:false`);
  });

  it('probes with a read tool without required parameters and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    expect(a.connector.healthcheckPath).toBe(M);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_CLOVER_LIVE === '1' && process.env.CLOVER_API_TOKEN && process.env.CLOVER_MERCHANT_ID ? describe : describe.skip;
live('clover adapter: live (read-only)', () => {
  const base = `${process.env.CLOVER_API_URL || 'https://apisandbox.dev.clover.com'}/v3/merchants/${process.env.CLOVER_MERCHANT_ID}`;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${process.env.CLOVER_API_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the merchant, items, orders, payments and customers', async () => {
    expect((await get('')).id).toBe(process.env.CLOVER_MERCHANT_ID);
    for (const p of ['/items?limit=1', '/orders?limit=1', '/payments?limit=1', '/customers?limit=1', '/employees?limit=1']) {
      const body = await get(p);
      expect(Array.isArray(body.elements)).toBe(true);
    }
  }, 60_000);
});
