import * as adapter from './shoptet.json';

/**
 * Shoptet REST API (api.docs.shoptet.com, OpenAPI in shoptet/developers): private API token in the
 * Shoptet-Private-API-Token header, api.myshoptet.com. Every tool was
 * checked read-only against live .cz and .sk shops on 22 Oct 2026.
 * Live part: SHOPTET_API_TOKEN=... RUN_SHOPTET_LIVE=1 npx jest src/adapters/intl/shoptet
 * (reads only: e-shop, one order page, order statuses).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  unlisted?: boolean;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
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
  return out;
};
const PREFIX = 'shoptet_';
const WRITES: string[] = [];

describe('shoptet adapter: static spec conformance', () => {

  it('sends the private API token in Shoptet-Private-API-Token to api.myshoptet.com', () => {
    expect(a.requiredEnvVars).toEqual(['SHOPTET_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.myshoptet.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Shoptet-Private-API-Token', apiKey: '{{SHOPTET_API_TOKEN}}' });
    expect(a.connector.headers?.['Content-Type']).toBe('application/json');
    expect(a.envVarMeta?.SHOPTET_API_TOKEN.secret).toBe(true);
    expect(a.category).toBe('e-commerce');
  });

  it('maps the documented read routes and page limits', () => {
    expect(tool('shoptet_list_orders').endpointMapping).toMatchObject({ method: 'GET', path: '/api/orders', queryParams: { statusId: '$statusId', creationTimeFrom: '$creationTimeFrom', page: '$page', itemsPerPage: '$itemsPerPage' } });
    expect((tool('shoptet_list_orders').parameters?.properties?.itemsPerPage as { maximum: number }).maximum).toBe(50);
    expect((tool('shoptet_list_credit_notes').parameters?.properties?.itemsPerPage as { maximum: number }).maximum).toBe(20);
    expect(tool('shoptet_get_order').endpointMapping).toMatchObject({ path: '/api/orders/{code}', queryParams: { include: '$include' } });
    expect(tool('shoptet_get_product_by_code').endpointMapping.path).toBe('/api/products/code/{code}');
    expect(tool('shoptet_list_order_statuses').endpointMapping.path).toBe('/api/orders/statuses');
    expect(tool('shoptet_list_stock_supplies').endpointMapping.path).toBe('/api/stocks/{stockId}/supplies');
  });

  it('is read-only', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated, the risky ones installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of WRITES) expect(tool(n).annotations?.readOnlyHint).toBe(false);
  });


  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.annotations?.readOnlyHint === false).toBe(false);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_SHOPTET_LIVE === '1' && process.env.SHOPTET_API_TOKEN ? describe : describe.skip;
live('shoptet adapter: live (read-only)', () => {
  const headers = { 'Shoptet-Private-API-Token': process.env.SHOPTET_API_TOKEN ?? '', 'Content-Type': 'application/json', Accept: 'application/json' };
  it('reads the e-shop, a page of orders and the order statuses', async () => {
    const eshop = (await (await fetch(`${a.connector.baseUrl}/api/eshop`, { headers })).json()) as { data: { contactInformation: { eshopId: number } } };
    expect(typeof eshop.data.contactInformation.eshopId).toBe('number');
    const orders = (await (await fetch(`${a.connector.baseUrl}/api/orders?itemsPerPage=1`, { headers })).json()) as { data: { paginator: { totalCount: number } } };
    expect(typeof orders.data.paginator.totalCount).toBe('number');
    const statuses = (await (await fetch(`${a.connector.baseUrl}/api/orders/statuses`, { headers })).json()) as { data: { statuses: unknown[] } };
    expect(statuses.data.statuses.length).toBeGreaterThan(0);
  }, 60_000);
});
