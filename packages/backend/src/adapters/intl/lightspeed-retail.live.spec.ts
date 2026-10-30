import * as adapter from './lightspeed-retail.json';

/**
 * Lightspeed Retail (X-Series) API, date version 2026-10 (x-series-api.lightspeedhq.com, OpenAPI fragments per operation, index at
 * x-series-api.lightspeedhq.com/llms.txt): base https://{domain_prefix}.retail.lightspeed.app/api/2026-10, Bearer personal token,
 * lists paged by version (after = version.max), search paged with offset.
 * Live part (reads only: retailer, outlets, products, sales search, customers):
 *   LIGHTSPEED_DOMAIN_PREFIX=mystore LIGHTSPEED_PERSONAL_TOKEN=... RUN_LIGHTSPEED_RETAIL_LIVE=1 npx jest src/adapters/intl/lightspeed-retail
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
const PREFIX = 'lightspeed_retail_';

describe('lightspeed-retail adapter: static spec conformance', () => {
  it('authenticates with a Bearer personal token against the store host and the 2026-10 version', () => {
    expect(a.slug).toBe('lightspeed-retail');
    expect(a.region).toBe('intl');
    expect(a.requiredEnvVars).toEqual(['LIGHTSPEED_DOMAIN_PREFIX', 'LIGHTSPEED_PERSONAL_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://{{LIGHTSPEED_DOMAIN_PREFIX}}.retail.lightspeed.app/api/2026-10');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{LIGHTSPEED_PERSONAL_TOKEN}}' });
    expect(a.envVarMeta?.LIGHTSPEED_PERSONAL_TOKEN.secret).toBe(true);
    const prefix = new RegExp(a.envVarMeta?.LIGHTSPEED_DOMAIN_PREFIX.pattern as string);
    expect(prefix.test('mystore')).toBe(true);
    expect(prefix.test('my-store2')).toBe(true);
    expect(prefix.test('https://mystore.retail.lightspeed.app')).toBe(false);
    expect(prefix.test('mystore.retail.lightspeed.app')).toBe(false);
  });

  it('maps store setup, catalog and product families', () => {
    expect(tool('lightspeed_retail_get_retailer').endpointMapping).toEqual({ method: 'GET', path: '/retailer' });
    expect(tool('lightspeed_retail_list_outlets').endpointMapping).toMatchObject({ method: 'GET', path: '/outlets', queryParams: { after: '$after', page_size: '$page_size' } });
    expect(tool('lightspeed_retail_list_products').endpointMapping.queryParams).toEqual({ after: '$after', page_size: '$page_size', sku: '$sku', 'includes[]': '$includes' });
    expect(tool('lightspeed_retail_create_product_family').endpointMapping).toMatchObject({ method: 'POST', path: '/product_families', bodyMapping: { name: '$name', classification: '$classification', products: '$products' } });
    expect(tool('lightspeed_retail_update_product_family').endpointMapping).toMatchObject({ method: 'PATCH', path: '/product_families/{family_id}' });
    expect(tool('lightspeed_retail_add_products_to_family').endpointMapping).toEqual({ method: 'POST', path: '/product_families/{family_id}/products', bodyMapping: { __raw: '$products' } });
    expect(tool('lightspeed_retail_update_product').endpointMapping).toMatchObject({ method: 'PATCH', path: '/products/{product_id}' });
    expect(tool('lightspeed_retail_get_product_family_of_product').endpointMapping.path).toBe('/products/{product_id}/family');
    expect(tool('lightspeed_retail_create_consignment').endpointMapping.bodyMapping).toMatchObject({ data: { name: '$name', type: '$type', outlet_id: '$outlet_id' } });
  });

  it('searches sales by date and marks POST reads read-only', () => {
    const search = tool('lightspeed_retail_search');
    expect(search.endpointMapping.path).toBe('/search');
    expect(search.parameters?.required).toEqual(['type']);
    expect(search.parameters?.properties?.type.enum).toEqual(['sales', 'products', 'customers']);
    expect(search.endpointMapping.queryParams).toMatchObject({ date_from: '$date_from', date_to: '$date_to', outlet_id: '$outlet_id', invoice_number: '$invoice_number', email: '$email', offset: '$offset' });
    for (const [n, p] of [['lightspeed_retail_list_inventory_levels', '/inventory_levels'], ['lightspeed_retail_list_inventory_records', '/inventory']]) {
      expect(tool(n).endpointMapping).toMatchObject({ method: 'POST', path: p });
      expect(tool(n).annotations?.readOnlyHint).toBe(true);
    }
  });

  it('records sales with the source block and creates stock adjustments', () => {
    expect(tool('lightspeed_retail_create_sale').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/sales',
      bodyMapping: { state: '$state', source: { author_id: '$user_id', register_id: '$register_id' }, line_items: '$line_items', payments: '$payments' },
    });
    expect(tool('lightspeed_retail_update_sale').endpointMapping).toMatchObject({ method: 'PUT', path: '/sales/{sale_id}' });
    expect(tool('lightspeed_retail_create_stock_adjustments').endpointMapping).toEqual({ method: 'POST', path: '/stock_adjustments', bodyMapping: { stock_adjustments: '$stock_adjustments' } });
    expect(tool('lightspeed_retail_get_gift_card').endpointMapping.path).toBe('/gift_cards/by_number/{card_number}');
  });

  it('installs returns and deletes switched off and marks them destructive', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual(['lightspeed_retail_delete_customer', 'lightspeed_retail_delete_product', 'lightspeed_retail_return_sale']);
    for (const n of off) expect(tool(n).annotations?.destructiveHint).toBe(true);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'DELETE')) expect(off).toContain(t.name);
    expect(tool('lightspeed_retail_return_sale').endpointMapping).toMatchObject({ method: 'POST', path: '/sales/{sale_id}/actions/return' });
    expect(a.instructions).toContain('**Switched off at install**: `lightspeed_retail_return_sale`, `lightspeed_retail_delete_product` and `lightspeed_retail_delete_customer`');
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
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_LIGHTSPEED_RETAIL_LIVE === '1' && process.env.LIGHTSPEED_PERSONAL_TOKEN && process.env.LIGHTSPEED_DOMAIN_PREFIX ? describe : describe.skip;
live('lightspeed-retail adapter: live (read-only)', () => {
  const base = `https://${process.env.LIGHTSPEED_DOMAIN_PREFIX}.retail.lightspeed.app/api/2026-10`;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${process.env.LIGHTSPEED_PERSONAL_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as { data?: unknown };
  };
  it('reads the retailer, outlets, products, sales and customers', async () => {
    expect((await get('/retailer')).data).toBeTruthy();
    for (const p of ['/outlets', '/products?page_size=1', '/customers?page_size=1', '/search?type=sales&page_size=1']) expect(Array.isArray((await get(p)).data)).toBe(true);
  }, 60_000);
});
