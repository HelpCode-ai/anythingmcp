import * as adapter from './plentyone.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * PlentyONE (plentymarkets) REST API (developers.plentymarkets.com): POST /rest/login with an API user,
 * then Bearer. Built from a customer's hand-built Cloud connector (search variations, create item,
 * update variation) and checked read-only with its API user on 22 Oct 2026; that user has no order
 * or contact rights, so orders, order statuses and contacts follow the official reference only.
 * Live part: PLENTYONE_URL=https://pXXXXX.my.plentysystems.com PLENTYONE_USERNAME=... PLENTYONE_PASSWORD=...
 * RUN_PLENTYONE_LIVE=1 npx jest src/adapters/de/plentyone (reads only: webstores, variations, warehouses).
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
const PREFIX = 'plentyone_';
const WRITES: string[] = ["plentyone_create_item", "plentyone_update_variation"];
// Tool names of the customers' own connectors for this API on the Cloud (read 22 Oct 2026).
const HAND_BUILT: string[] = ["create_item", "create_item_text", "create_variation", "search_categories", "search_items", "search_variations", "update_item", "update_item_text", "update_variation"];

describe('plentyone adapter: static spec conformance', () => {

  it('signs in at /rest/login with the API user and sends the access token as Bearer', () => {
    expect(a.requiredEnvVars).toEqual(['PLENTYONE_URL', 'PLENTYONE_USERNAME', 'PLENTYONE_PASSWORD']);
    expect(a.connector.baseUrl).toBe('{{PLENTYONE_URL}}/rest');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: '{{PLENTYONE_URL}}/rest/login',
      loginMethod: 'POST',
      loginBody: { username: '${username}', password: '${password}' },
      username: '{{PLENTYONE_USERNAME}}',
      password: '{{PLENTYONE_PASSWORD}}',
      tokenJsonPath: 'access_token',
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
      refreshOn401: true,
    });
    expect(a.envVarMeta?.PLENTYONE_PASSWORD.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.PLENTYONE_URL.pattern as string).test('https://p72240.my.plentysystems.com')).toBe(true);
    expect(new RegExp(a.envVarMeta?.PLENTYONE_URL.pattern as string).test('https://p72240.my.plentysystems.com/rest')).toBe(false);
    expect(a.region).toBe('de');
  });

  it('maps the documented routes', () => {
    expect(tool('plentyone_search_orders').endpointMapping).toMatchObject({ method: 'GET', path: '/orders/search', queryParams: { statusId: '$statusId', createdAt: '$createdAt', page: '$page', itemsPerPage: '$itemsPerPage' } });
    expect(tool('plentyone_get_order').endpointMapping).toMatchObject({ path: '/orders/{orderId}', queryParams: { 'with[]': '$with' } });
    expect(tool('plentyone_search_variations').endpointMapping).toMatchObject({ path: '/items/variations', queryParams: { numberExact: '$numberExact', barcode: '$barcode', with: '$with' } });
    expect(tool('plentyone_get_warehouse_stock').endpointMapping.path).toBe('/stockmanagement/warehouses/{warehouseId}/stock');
    expect(tool('plentyone_create_item').endpointMapping).toMatchObject({ method: 'POST', path: '/items', bodyMapping: { variations: '$variations' } });
    expect(tool('plentyone_update_variation').endpointMapping).toMatchObject({ method: 'PUT', path: '/items/{itemId}/variations/{variationId}' });
  });

  it('keeps the price list definitions small (each repeats every country)', () => {
    const out = applyResponseTransform(
      { page: 1, totalsCount: 1, isLastPage: true, lastPageNumber: 1, entries: [{ id: 1, type: 'default', countries: new Array(277).fill({ countryId: 1 }), names: [{ nameExternal: 'Preis' }] }] },
      tool('plentyone_list_sales_prices').responseMapping as never,
    ).value as { entries: Record<string, unknown>[] };
    expect(out.entries[0]).toMatchObject({ id: 1, type: 'default' });
    expect(out.entries[0].countries).toBeUndefined();
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

  it('never reuses the tool names of hand-built Cloud connectors for the same API', () => {
    const names = new Set(a.tools.map((t) => t.name));
    for (const n of HAND_BUILT) expect(`${n}:${names.has(n)}`).toBe(`${n}:false`);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.annotations?.readOnlyHint === false).toBe(false);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_PLENTYONE_LIVE === '1' && process.env.PLENTYONE_URL && process.env.PLENTYONE_USERNAME && process.env.PLENTYONE_PASSWORD ? describe : describe.skip;
live('plentyone adapter: live (read-only)', () => {
  const base = (process.env.PLENTYONE_URL ?? '').replace(/\/$/, '');
  it('signs in and reads webstores, variations and warehouses', async () => {
    const login = (await (
      await fetch(`${base}/rest/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: process.env.PLENTYONE_USERNAME, password: process.env.PLENTYONE_PASSWORD }),
      })
    ).json()) as { access_token: string };
    expect(login.access_token).toBeTruthy();
    const headers = { Authorization: `Bearer ${login.access_token}`, Accept: 'application/json' };
    const stores = await (await fetch(`${base}/rest/webstores`, { headers })).json();
    expect(Array.isArray(stores)).toBe(true);
    const vars = (await (await fetch(`${base}/rest/items/variations?itemsPerPage=1`, { headers })).json()) as { totalsCount: number };
    expect(typeof vars.totalsCount).toBe('number');
    const wh = await (await fetch(`${base}/rest/stockmanagement/warehouses`, { headers })).json();
    expect(Array.isArray(wh)).toBe(true);
  }, 60_000);
});
