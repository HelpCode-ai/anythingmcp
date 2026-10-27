import * as adapter from './bricobravo.json';

/**
 * BricoBravo Seller Hub API (sellerhub.bricobravo.com/api, its own Laravel API, not
 * Mirakl): the token goes in the sh-token header. No public reference; routes were
 * checked read-only on 19 Oct 2026 (GET /orders, GET /orders/{id}, PATCH
 * /orders/{id}/shipped answers 405 to GET with "Supported methods: PATCH").
 * Live part: BRICOBRAVO_API_TOKEN=... RUN_BRICOBRAVO_LIVE=1 npx jest src/adapters/it/bricobravo
 */

type Tool = {
  name: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; bodyEncoding?: string };
  annotations?: { readOnlyHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers?: Record<string, string> };
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
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  return out;
};
const PREFIX = 'bricobravo_';
const WRITES: string[] = ["bricobravo_mark_shipped"];

describe('bricobravo adapter: static spec conformance', () => {
  it('sends the token in sh-token to sellerhub.bricobravo.com/api', () => {
    expect(a.requiredEnvVars).toEqual(['BRICOBRAVO_API_TOKEN']);
    expect(a.region).toBe('it');
    expect(a.connector.baseUrl).toBe('https://sellerhub.bricobravo.com/api');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'sh-token', apiKey: '{{BRICOBRAVO_API_TOKEN}}' });
  });

  it('lists every order by default and filters by compact date-times', () => {
    const t = tool('bricobravo_search_orders');
    expect(t.endpointMapping).toMatchObject({ method: 'GET', path: '/orders' });
    expect((t.parameters?.properties?.all as { default: boolean }).default).toBe(true);
    const re = new RegExp((t.parameters?.properties?.start_datetime as { pattern: string }).pattern);
    expect(re.test('20261001000000')).toBe(true);
    expect(re.test('2026-10-01')).toBe(false);
    expect(tool('bricobravo_get_order_details').endpointMapping.path).toBe('/orders/{order_id}');
  });

  it('confirms shipment with PATCH /orders/{id}/shipped and BricoBravo courier codes', () => {
    const t = tool('bricobravo_mark_shipped');
    expect(t.endpointMapping).toMatchObject({ method: 'PATCH', path: '/orders/{order_id}/shipped', bodyMapping: { courier: '$courier', tracking_number: '$tracking_number', tracking_url: '$tracking_url' } });
    expect((t.parameters?.properties?.courier as { enum: string[] }).enum).toEqual(expect.arrayContaining(['brt-it', 'gls-italy', 'poste-italiane', 'other']));
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

  it('writes are installed switched off and annotated; reads are not switched off', () => {
    const writes = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) expect(t.annotations?.readOnlyHint).toBe(false);
      else {
        expect(t.enabled).toBeUndefined();
        if (t.endpointMapping.method !== 'GET') expect(t.annotations?.readOnlyHint).toBe(true);
      }
    }
  });


  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(WRITES).not.toContain(a.probe.tool);
    tool(a.probe.tool);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).not.toMatch(/—/);
  });
});

const live = process.env.RUN_BRICOBRAVO_LIVE === '1' && process.env.BRICOBRAVO_API_TOKEN ? describe : describe.skip;
live('bricobravo adapter: live (read-only)', () => {
  it('lists orders with data and pagination', async () => {
    const res = await fetch(`${a.connector.baseUrl}/orders?all=true&per_page=1`, { headers: { 'sh-token': process.env.BRICOBRAVO_API_TOKEN as string, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; pagination: { total_data: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.pagination.total_data).toBe('number');
  }, 60_000);
});
