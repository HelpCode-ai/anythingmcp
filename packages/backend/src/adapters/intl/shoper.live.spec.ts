import * as adapter from './shoper.json';
import { serializeRepeatedParams } from '../../connectors/engines/rest.engine';

/**
 * Shoper REST API (developers.shoper.pl/docs, OpenAPI at /openapi/openapi.yml):
 * token from POST https://<shop>/webapi/rest/auth with HTTP Basic (WebAPI administrator
 * login and password, or an app's client_id and client_secret), Bearer token on
 * https://<shop>/webapi/rest/...; lists answer {count, pages, page, list}, filters[field][op]=value.
 * Live part: SHOPER_SHOP_HOST=myshop.shoparena.pl SHOPER_API_LOGIN=... SHOPER_API_PASSWORD=... RUN_SHOPER_LIVE=1 npx jest src/adapters/intl/shoper
 * (reads only: orders, order products, products, statuses).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { maximum?: number; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
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
const PREFIX = 'shoper_';
const WRITES = ['shoper_update_order_status', 'shoper_update_product_stock'];

describe('shoper adapter: static spec conformance', () => {
  it('signs in at /webapi/rest/auth with HTTP Basic and calls the shop host', () => {
    expect(a.requiredEnvVars).toEqual(['SHOPER_SHOP_HOST', 'SHOPER_API_LOGIN', 'SHOPER_API_PASSWORD']);
    expect(a.connector.baseUrl).toBe('https://{{SHOPER_SHOP_HOST}}/webapi/rest');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{SHOPER_API_LOGIN}}',
      clientSecret: '{{SHOPER_API_PASSWORD}}',
      tokenUrl: 'https://{{SHOPER_SHOP_HOST}}/webapi/rest/auth',
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(a.envVarMeta?.SHOPER_API_PASSWORD.secret).toBe(true);
    const host = new RegExp(a.envVarMeta?.SHOPER_SHOP_HOST.pattern as string);
    expect(host.test('myshop.shoparena.pl')).toBe(true);
    expect(host.test('https://myshop.shoparena.pl')).toBe(false);
    expect(host.test('myshop.shoparena.pl/webapi/rest')).toBe(false);
  });

  it('maps the documented resources with page, limit, order and filters', () => {
    const lists: Record<string, string> = {
      shoper_list_orders: '/orders',
      shoper_list_order_products: '/order-products',
      shoper_list_products: '/products',
      shoper_list_product_stocks: '/product-stocks',
      shoper_list_categories: '/categories',
      shoper_list_customers: '/users',
      shoper_list_statuses: '/statuses',
      shoper_list_shippings: '/shippings',
      shoper_list_payments: '/payments',
      shoper_list_parcels: '/parcels',
    };
    for (const [n, path] of Object.entries(lists)) {
      expect(tool(n).endpointMapping).toEqual({ method: 'GET', path, queryParams: { filters: '$filters', order: '$order', page: '$page', limit: '$limit' } });
      expect(tool(n).parameters?.properties?.limit).toMatchObject({ maximum: 50, default: 50 });
    }
    expect(tool('shoper_get_order').endpointMapping).toEqual({ method: 'GET', path: '/orders/{order_id}' });
    expect(tool('shoper_get_product').endpointMapping.path).toBe('/products/{product_id}');
    expect(tool('shoper_get_product_stock').endpointMapping.path).toBe('/product-stocks/{stock_id}');
    expect(tool('shoper_get_customer').endpointMapping.path).toBe('/users/{user_id}');
    expect(tool('shoper_get_category_tree').endpointMapping).toEqual({ method: 'GET', path: '/categories-tree' });
  });

  it('sends filters in the PHP bracket form Shoper documents', () => {
    const qs = decodeURIComponent(
      serializeRepeatedParams({ filters: { date: { '>=': '2026-10-01 00:00:00' }, status_id: { in: [2, 3] }, is_paid: 1 }, order: '-date', limit: 50 }),
    );
    expect(qs).toBe('filters[date][>=]=2026-10-01+00:00:00&filters[status_id][in][0]=2&filters[status_id][in][1]=3&filters[is_paid]=1&order=-date&limit=50');
  });

  it('maps the two writes; the status change, which can e-mail the customer, is switched off', () => {
    expect(tool('shoper_update_order_status').endpointMapping).toEqual({ method: 'PUT', path: '/orders/{order_id}', bodyMapping: { status_id: '$status_id' } });
    expect(tool('shoper_update_order_status').enabled).toBe(false);
    expect(tool('shoper_update_product_stock').endpointMapping).toEqual({ method: 'PUT', path: '/product-stocks/{stock_id}', bodyMapping: { stock: '$stock', warehouses: '$warehouses' } });
    expect(tool('shoper_update_product_stock').enabled).toBeUndefined();
    for (const n of WRITES) expect(tool(n).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const t of a.tools) expect(t.endpointMapping.method).not.toBe('DELETE');
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated; every other tool is a GET', () => {
    const writes = a.tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) continue;
      expect(`${t.name}:${t.endpointMapping.method}:${t.enabled}`).toBe(`${t.name}:GET:undefined`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_SHOPER_LIVE === '1' && process.env.SHOPER_SHOP_HOST && process.env.SHOPER_API_LOGIN && process.env.SHOPER_API_PASSWORD ? describe : describe.skip;
live('shoper adapter: live (read-only)', () => {
  const base = `https://${process.env.SHOPER_SHOP_HOST}/webapi/rest`;
  it('gets a token and reads orders, order products, products and statuses', async () => {
    const basic = Buffer.from(`${process.env.SHOPER_API_LOGIN}:${process.env.SHOPER_API_PASSWORD}`).toString('base64');
    const tokenRes = await fetch(`${base}/auth`, { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
    expect(tokenRes.status).toBe(200);
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const headers = { Authorization: `Bearer ${access_token}`, Accept: 'application/json' };
    const orders = (await (await fetch(`${base}/orders?limit=5&order=-date`, { headers })).json()) as { count: string | number; list: Array<{ order_id: string }> };
    expect(Array.isArray(orders.list)).toBe(true);
    if (orders.list.length) {
      const items = (await (await fetch(`${base}/order-products?filters[order_id]=${orders.list[0].order_id}`, { headers })).json()) as { list: Array<{ order_id: string }> };
      for (const i of items.list) expect(String(i.order_id)).toBe(String(orders.list[0].order_id));
    }
    const products = (await (await fetch(`${base}/products?limit=5`, { headers })).json()) as { list: unknown[] };
    expect(Array.isArray(products.list)).toBe(true);
    const statuses = (await (await fetch(`${base}/statuses`, { headers })).json()) as { list: Array<{ status_id: string }> };
    expect(statuses.list.length).toBeGreaterThan(0);
  }, 60_000);
});
