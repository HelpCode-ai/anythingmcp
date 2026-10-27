import * as adapter from './droppery.json';

/**
 * Droppery webshop API (platform.droppery.io/api/v1/webshop, Bearer token). Routes
 * checked read-only on 19 Oct 2026: GET /product (start, size at most 100, answers
 * data and total), GET /product/{id}, GET /order/{id} with the Droppery order id.
 * Live part: DROPPERY_API_TOKEN=... RUN_DROPPERY_LIVE=1 npx jest src/adapters/nl/droppery
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
const PREFIX = 'droppery_';
const WRITES: string[] = [];

describe('droppery adapter: static spec conformance', () => {
  it('sends a Bearer token to platform.droppery.io/api/v1/webshop', () => {
    expect(a.requiredEnvVars).toEqual(['DROPPERY_API_TOKEN']);
    expect(a.region).toBe('nl');
    expect(a.connector.baseUrl).toBe('https://platform.droppery.io/api/v1/webshop');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{DROPPERY_API_TOKEN}}' });
  });

  it('is read-only: three GET tools', () => {
    expect(a.tools.map((t) => `${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`)).toEqual([
      'droppery_browse_products GET /product',
      'droppery_get_product GET /product/{product_id}',
      'droppery_get_order_details GET /order/{order_id}',
    ]);
  });

  it('pages products with start and size (Droppery refuses size over 100) and cuts the rows', () => {
    const t = tool('droppery_browse_products');
    expect(t.endpointMapping.queryParams).toEqual({ start: '$start', size: '$size' });
    expect((t.parameters?.properties?.size as { maximum: number }).maximum).toBe(100);
    const sel = (t.responseMapping as { transform: { select: { total: string; data: { $from: string; $select: Record<string, string> } } } }).transform.select;
    expect(sel.total).toBe('$.total');
    expect(sel.data.$from).toBe('$.data[*]');
    expect(Object.keys(sel.data.$select)).toEqual(expect.arrayContaining(['id', 'sku', 'ean', 'stock', 'supplier_price_excl']));
    expect(Object.keys(sel.data.$select)).not.toContain('long_description');
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

const live = process.env.RUN_DROPPERY_LIVE === '1' && process.env.DROPPERY_API_TOKEN ? describe : describe.skip;
live('droppery adapter: live (read-only)', () => {
  it('lists one product and refuses a page size over 100', async () => {
    const headers = { Authorization: `Bearer ${process.env.DROPPERY_API_TOKEN}`, Accept: 'application/json' };
    const ok = (await (await fetch(`${a.connector.baseUrl}/product?start=0&size=1`, { headers })).json()) as { data: unknown[]; total: number };
    expect(ok.data.length).toBe(1);
    expect(ok.total).toBeGreaterThan(0);
    const tooBig = await fetch(`${a.connector.baseUrl}/product?start=0&size=101`, { headers });
    expect(tooBig.status).toBe(422);
  }, 60_000);
});
