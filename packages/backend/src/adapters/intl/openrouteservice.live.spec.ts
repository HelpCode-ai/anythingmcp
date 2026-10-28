import * as adapter from './openrouteservice.json';

/**
 * openrouteservice by HeiGIT (giscience.github.io/openrouteservice/api-reference), current host
 * api.heigit.org (api.openrouteservice.org is being retired in November 2026): raw key in Authorization.
 * Every tool was checked with a free key on 22 Oct 2026 (all compute-only).
 * Live part: OPENROUTESERVICE_API_KEY=... RUN_OPENROUTESERVICE_LIVE=1 npx jest src/adapters/intl/openrouteservice
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
const PREFIX = 'openrouteservice_';
const WRITES: string[] = [];

describe('openrouteservice adapter: static spec conformance', () => {

  it('sends the raw key in Authorization to the current HeiGIT host', () => {
    expect(a.requiredEnvVars).toEqual(['OPENROUTESERVICE_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.heigit.org');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{OPENROUTESERVICE_API_KEY}}' });
    expect(a.envVarMeta?.OPENROUTESERVICE_API_KEY.secret).toBe(true);
    expect(a.category).toBe('maps');
  });

  it('maps the service paths of api.heigit.org', () => {
    expect(tool('openrouteservice_geocode').endpointMapping).toMatchObject({ method: 'GET', path: '/pelias/v1/search', queryParams: { text: '$text', 'boundary.country': '$country' } });
    expect(tool('openrouteservice_reverse_geocode').endpointMapping.queryParams).toMatchObject({ 'point.lat': '$lat', 'point.lon': '$lon' });
    expect(tool('openrouteservice_directions').endpointMapping).toMatchObject({ method: 'POST', path: '/openrouteservice/v2/directions/{profile}', bodyMapping: { coordinates: '$coordinates' } });
    expect(tool('openrouteservice_matrix').endpointMapping.path).toBe('/openrouteservice/v2/matrix/{profile}');
    expect(tool('openrouteservice_isochrones').endpointMapping.headers).toEqual({ Accept: 'application/geo+json, application/json' });
    expect(tool('openrouteservice_optimize_routes').endpointMapping.path).toBe('/vroom/v0');
    expect(tool('openrouteservice_find_pois').endpointMapping).toMatchObject({ path: '/openpoiservice/v0/pois', bodyMapping: { request: 'pois' } });
    for (const t of a.tools) expect(t.endpointMapping.path).not.toContain('openrouteservice.org');
  });

  it('computes only: every POST is marked read-only', () => {
    for (const t of a.tools) if (t.endpointMapping.method === 'POST') expect(t.annotations).toEqual({ readOnlyHint: true });
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

const live = process.env.RUN_OPENROUTESERVICE_LIVE === '1' && process.env.OPENROUTESERVICE_API_KEY ? describe : describe.skip;
live('openrouteservice adapter: live (read-only)', () => {
  const headers = { Authorization: process.env.OPENROUTESERVICE_API_KEY ?? '', Accept: 'application/json', 'Content-Type': 'application/json' };
  it('geocodes and routes between two points in Freiburg', async () => {
    const geo = (await (await fetch(`${a.connector.baseUrl}/pelias/v1/search?text=Freiburg&size=1`, { headers })).json()) as { features: unknown[] };
    expect(geo.features.length).toBe(1);
    const route = (await (
      await fetch(`${a.connector.baseUrl}/openrouteservice/v2/directions/driving-car`, { method: 'POST', headers, body: JSON.stringify({ coordinates: [[7.8421, 47.999], [7.8494, 47.9959]] }) })
    ).json()) as { routes: Array<{ summary: { distance: number } }> };
    expect(route.routes[0].summary.distance).toBeGreaterThan(0);
  }, 60_000);
});
