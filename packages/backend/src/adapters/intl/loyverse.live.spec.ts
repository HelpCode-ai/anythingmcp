import * as adapter from './loyverse.json';

/**
 * Loyverse API v1.0 (developer.loyverse.com/docs, OpenAPI at developer.loyverse.com/docs/API-Reference__v1.0.yaml):
 * base https://api.loyverse.com/v1.0, Bearer personal access token, cursor paging (limit, cursor).
 * Live part (reads only: merchant, stores, receipts, items, inventory, customers):
 *   LOYVERSE_ACCESS_TOKEN=... RUN_LOYVERSE_LIVE=1 npx jest src/adapters/intl/loyverse
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
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
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
const PREFIX = 'loyverse_';

describe('loyverse adapter: static spec conformance', () => {
  it('authenticates with a Bearer personal access token against api.loyverse.com/v1.0', () => {
    expect(a.slug).toBe('loyverse');
    expect(a.region).toBe('intl');
    expect(a.requiredEnvVars).toEqual(['LOYVERSE_ACCESS_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.loyverse.com/v1.0');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{LOYVERSE_ACCESS_TOKEN}}' });
    expect(a.envVarMeta?.LOYVERSE_ACCESS_TOKEN.secret).toBe(true);
    const key = new RegExp(a.envVarMeta?.LOYVERSE_ACCESS_TOKEN.pattern as string);
    expect(key.test(['f0e1d2c3', 'b4a59687', '78695a4b'].join(''))).toBe(true);
    expect(key.test('Bearer abc')).toBe(false);
  });

  it('maps receipts, shifts and the catalog to the documented paths', () => {
    expect(tool('loyverse_get_merchant').endpointMapping).toEqual({ method: 'GET', path: '/merchant/' });
    expect(tool('loyverse_list_receipts').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/receipts',
      queryParams: { store_id: '$store_id', created_at_min: '$created_at_min', created_at_max: '$created_at_max', limit: '$limit', cursor: '$cursor' },
    });
    expect(tool('loyverse_get_receipt').endpointMapping.path).toBe('/receipts/{receipt_number}');
    expect(tool('loyverse_create_receipt').endpointMapping).toMatchObject({ method: 'POST', path: '/receipts', bodyMapping: { line_items: '$line_items', payments: '$payments', store_id: '$store_id' } });
    expect(tool('loyverse_refund_receipt').endpointMapping).toMatchObject({ method: 'POST', path: '/receipts/{receipt_number}/refund', bodyMapping: { line_items: '$line_items' } });
    expect(tool('loyverse_list_shifts').endpointMapping.queryParams).toMatchObject({ store_ids: '$store_ids' });
    expect(tool('loyverse_list_variants').endpointMapping.queryParams).toMatchObject({ sku: '$sku', items_ids: '$items_ids' });
    expect(tool('loyverse_list_modifiers').endpointMapping.queryParams).toMatchObject({ modifier_ids: '$modifier_ids' });
    for (const [n, p] of [['loyverse_save_item', '/items'], ['loyverse_save_variant', '/variants'], ['loyverse_save_category', '/categories'], ['loyverse_save_discount', '/discounts'], ['loyverse_save_tax', '/taxes'], ['loyverse_save_customer', '/customers']])
      expect(tool(n).endpointMapping).toMatchObject({ method: 'POST', path: p });
    expect(tool('loyverse_save_item').endpointMapping.bodyMapping).toMatchObject({ id: '$id', item_name: '$item_name', variants: '$variants' });
  });

  it('sets absolute stock levels and lists them per variant and store', () => {
    expect(tool('loyverse_set_inventory').endpointMapping).toEqual({ method: 'POST', path: '/inventory', bodyMapping: { inventory_levels: '$inventory_levels' } });
    expect(tool('loyverse_list_inventory').endpointMapping.queryParams).toMatchObject({ store_ids: '$store_ids', variant_ids: '$variant_ids' });
    expect(tool('loyverse_set_inventory').description).toMatch(/absolute/);
  });

  it('pages only the endpoints that document limit and cursor', () => {
    for (const n of ['loyverse_list_stores', 'loyverse_list_pos_devices', 'loyverse_list_payment_types', 'loyverse_list_discounts', 'loyverse_list_taxes'])
      expect(`${n}:${'cursor' in (tool(n).endpointMapping.queryParams ?? {})}`).toBe(`${n}:false`);
    for (const n of ['loyverse_list_receipts', 'loyverse_list_items', 'loyverse_list_customers', 'loyverse_list_inventory', 'loyverse_list_shifts'])
      expect(`${n}:${'cursor' in (tool(n).endpointMapping.queryParams ?? {})}`).toBe(`${n}:true`);
  });

  it('installs refunds and deletes switched off and marks them destructive', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual(['loyverse_delete_customer', 'loyverse_delete_item', 'loyverse_refund_receipt']);
    for (const n of off) expect(tool(n).annotations?.destructiveHint).toBe(true);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'DELETE')) expect(off).toContain(t.name);
    expect(a.instructions).toContain('**Switched off at install**: `loyverse_refund_receipt`, `loyverse_delete_item` and `loyverse_delete_customer`');
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
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
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_LOYVERSE_LIVE === '1' && process.env.LOYVERSE_ACCESS_TOKEN ? describe : describe.skip;
live('loyverse adapter: live (read-only)', () => {
  const base = 'https://api.loyverse.com/v1.0';
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${process.env.LOYVERSE_ACCESS_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the merchant, stores, receipts, items, inventory and customers', async () => {
    expect(typeof (await get('/merchant/')).id).toBe('string');
    expect(Array.isArray((await get('/stores')).stores)).toBe(true);
    for (const [p, k] of [['/receipts?limit=1', 'receipts'], ['/items?limit=1', 'items'], ['/inventory?limit=1', 'inventory_levels'], ['/customers?limit=1', 'customers']]) {
      const body = await get(p);
      expect(Array.isArray(body[k])).toBe(true);
    }
  }, 60_000);
});
