import * as adapter from './fr-company-data.json';

/**
 * French company open data, no key: API Recherche d'entreprises (recherche-entreprises.api.gouv.fr,
 * OpenAPI at /openapi.json), BODACC and BALO on DILA's Opendatasoft portals (Explore API v2.1) and the
 * DGE ratios dataset on data.economie.gouv.fr. Built from a customer's hand-built BODACC connector
 * (notices by SIREN); every tool was called live from the Cloud on 22 Oct 2026.
 * Live part: RUN_FR_COMPANY_DATA_LIVE=1 npx jest src/adapters/fr/fr-company-data
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
const PREFIX = 'fr_company_';
const WRITES: string[] = [];
// Tool names of the customers' own connectors for this API on the Cloud (read 22 Oct 2026).
const HAND_BUILT: string[] = ["bodacc_par_siren"];

describe('fr-company-data adapter: static spec conformance', () => {

  it('is keyless and reads official open data hosts only', () => {
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.baseUrl).toBe('https://recherche-entreprises.api.gouv.fr');
    expect(a.region).toBe('fr');
    const hosts = new Set(a.tools.map((t) => (t.endpointMapping.path.startsWith('http') ? new URL(t.endpointMapping.path).host : new URL(a.connector.baseUrl).host)));
    expect([...hosts].sort()).toEqual(['bodacc-datadila.opendatasoft.com', 'data.economie.gouv.fr', 'journal-officiel-datadila.opendatasoft.com', 'recherche-entreprises.api.gouv.fr']);
    expect(a.probe).toEqual({ tool: 'fr_company_get', params: { siren_or_siret: '552032534' } });
  });

  it('filters BODACC by the exact SIREN and drops the optional filters that are not given', () => {
    const m = tool('fr_company_bodacc_announcements').endpointMapping;
    expect(m.queryParams).toMatchObject({
      where: ['registre="${siren}"', "dateparution >= date'${date_from}'", "dateparution <= date'${date_to}'"],
      refine: ['familleavis:${family}'],
      order_by: 'dateparution desc',
    });
    // Each entry is its own repeated query parameter; an entry whose placeholder is empty is dropped.
    expect(Array.isArray(m.queryParams?.where)).toBe(true);
    expect((tool('fr_company_bodacc_announcements').parameters?.properties?.siren as { pattern: string }).pattern).toBe('^[0-9]{9}$');
    expect((tool('fr_company_search').parameters?.properties?.per_page as { maximum: number }).maximum).toBe(25);
    expect(tool('fr_company_get').endpointMapping).toMatchObject({ path: '/search', queryParams: { q: '$siren_or_siret', per_page: 1 } });
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

const live = process.env.RUN_FR_COMPANY_DATA_LIVE === '1' ? describe : describe.skip;
live('fr-company-data adapter: live (keyless)', () => {
  it('finds Danone by SIREN, its BODACC notices and its ratios', async () => {
    const reg = (await (await fetch(`${a.connector.baseUrl}/search?q=552032534&per_page=1`)).json()) as { results: Array<{ siren: string }> };
    expect(reg.results[0].siren).toBe('552032534');
    const bodacc = (await (await fetch(`${tool('fr_company_bodacc_announcements').endpointMapping.path}?where=${encodeURIComponent('registre="552032534"')}&limit=1`)).json()) as { total_count: number };
    expect(bodacc.total_count).toBeGreaterThan(10);
    const ratios = (await (await fetch(`${tool('fr_company_financial_ratios').endpointMapping.path}?where=${encodeURIComponent('siren="552032534"')}&limit=1`)).json()) as { total_count: number };
    expect(ratios.total_count).toBeGreaterThan(0);
  }, 60_000);
});
