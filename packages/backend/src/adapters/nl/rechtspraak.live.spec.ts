import * as adapter from './rechtspraak.json';

/**
 * Open Data van de Rechtspraak (https://www.rechtspraak.nl/Uitspraken/Paginas/Open-Data.aspx, technical
 * documentation PDF linked there), https://data.rechtspraak.nl, no key. The service answers in XML (an Atom feed
 * for the index, an RDF and text document per decision); the REST engine parses XML answers into objects.
 * Paths, parameters and answers were confirmed against the live service on 2026-11-19.
 * Live part (keyless, three calls): RUN_RECHTSPRAAK_LIVE=1 npx jest src/adapters/nl/rechtspraak
 */

type Prop = { type?: string; default?: unknown; pattern?: string; enum?: unknown[]; items?: { type?: string; enum?: unknown[] } };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: { readOnlyHint?: boolean };
  parameters?: { properties?: Record<string, Prop>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; timeoutMs?: number };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  icon: string;
  category: string;
  aliases?: string[];
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { secret?: boolean; kind?: string; pattern?: string }>;
  verifyHints?: Record<string, unknown>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments and "$arg" values in query, body and headers.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
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
const SLUG = 'rechtspraak';
const REGION = 'nl';
const BASE = 'https://data.rechtspraak.nl';
const PREFIX = 'rechtspraak_';
const ENV_VARS: string[] = [];
// Tools installed switched off.
const OFF: string[] = [];
// name: [method, path, required arguments]
const TOOLS: Record<string, [string, string, string[]]> = {
  rechtspraak_search_decisions: ['GET', '/uitspraken/zoeken', []],
  rechtspraak_get_decision: ['GET', '/uitspraken/content', ['id']],
  rechtspraak_get_decision_metadata: ['GET', '/uitspraken/content', ['id']],
  rechtspraak_list_courts: ['GET', '/Waardelijst/Instanties', []],
  rechtspraak_list_legal_areas: ['GET', '/Waardelijst/Rechtsgebieden', []],
  rechtspraak_list_procedure_types: ['GET', '/Waardelijst/Proceduresoorten', []],
  rechtspraak_list_formal_relations: ['GET', '/Waardelijst/FormeleRelaties', []],
};

describe('rechtspraak adapter: static spec conformance', () => {
  it('has the expected envelope and authentication', () => {
    expect(a.slug).toBe(SLUG);
    expect(a.region).toBe(REGION);
    expect(a.icon).toBe(SLUG);
    expect(a.category).toBe('government');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.headers).toEqual({ Accept: 'application/xml', 'User-Agent': 'AnythingMCP' });
    for (const alias of a.aliases ?? []) expect(alias.length).toBeLessThanOrEqual(40);
  });

  it('probes with a read tool and arguments it declares', () => {
    const p = a.probe!;
    const t = tool(p.tool);
    expect(t.enabled).toBeUndefined();
    const props = Object.keys(t.parameters?.properties ?? {});
    for (const k of Object.keys(p.params ?? {})) expect(props).toContain(k);
    for (const r of t.parameters?.required ?? []) expect(Object.keys(p.params ?? {})).toContain(r);
  });

  it('pins the method, path and required arguments of every tool', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    for (const [name, [method, path, required]] of Object.entries(TOOLS)) {
      const t = tool(name);
      expect(`${name}:${t.endpointMapping.method}`).toBe(`${name}:${method}`);
      expect(`${name}:${t.endpointMapping.path}`).toBe(`${name}:${path}`);
      expect(`${name}:${(t.parameters?.required ?? []).join(',')}`).toBe(`${name}:${required.join(',')}`);
    }
  });

  it('every tool is prefixed, described, maps every declared argument and requires its path parameters', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p) || ENV_VARS.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('installs exactly the expected tools switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...OFF].sort());
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });

  it('is read-only and sends date ranges as repeated parameters', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    const s = tool('rechtspraak_search_decisions');
    expect(s.endpointMapping.queryParams).toEqual({
      date: ['$date_from', '$date_to'],
      modified: ['$modified_from', '$modified_to'],
      creator: '$court',
      subject: '$legal_area',
      type: '$type',
      return: '$with_text_only',
      replaces: '$replaces',
      max: '$max',
      from: '$offset',
      sort: '$sort',
    });
    expect(s.parameters?.properties?.type.enum).toEqual(['Uitspraak', 'Conclusie']);
    expect(s.parameters?.properties?.with_text_only.enum).toEqual(['DOC']);
    expect(s.parameters?.properties?.sort.enum).toEqual(['ASC', 'DESC']);
    expect(s.parameters?.properties?.max).toMatchObject({ minimum: 1, maximum: 1000, default: 50 });
    expect(s.parameters?.required).toBeUndefined();
  });

  it('reads a decision by ECLI, with and without its text', () => {
    expect(tool('rechtspraak_get_decision').endpointMapping.queryParams).toEqual({ id: '$id' });
    expect(tool('rechtspraak_get_decision_metadata').endpointMapping.queryParams).toEqual({ return: 'META', id: '$id' });
    const re = new RegExp(tool('rechtspraak_get_decision').parameters?.properties?.id.pattern ?? '');
    for (const ok of ['ECLI:NL:HR:2024:300', 'ECLI:NL:RVS:2024:2', 'ECLI:NL:HR:2013:BZ9225', 'ECLI:NL:GHARL:2020:1234', 'ecli:nl:rvs:2024:2', 'ECLI:EU:C:1974:140']) expect(`${ok}:${re.test(ok)}`).toBe(`${ok}:true`);
    for (const bad of ['NL:HR:2024:300', 'ECLI:NL:HR:24:300', 'BZ9225']) expect(`${bad}:${re.test(bad)}`).toBe(`${bad}:false`);
    expect(a.instructions).toContain('no full-text or keyword search');
  });
});

const live = process.env.RUN_RECHTSPRAAK_LIVE === '1' ? describe : describe.skip;
live('rechtspraak adapter: live (keyless, read-only)', () => {
  const get = async (path: string) => (await fetch(`${BASE}${path}`, { headers: { Accept: 'application/xml', 'User-Agent': 'AnythingMCP' } })).text();
  it('searches the index, reads a decision and a value list', async () => {
    const feed = await get('/uitspraken/zoeken?max=2&date=2024-03-01&date=2024-03-05&creator=' + encodeURIComponent('http://standaarden.overheid.nl/owms/terms/Hoge_Raad_der_Nederlanden') + '&subject=' + encodeURIComponent('http://psi.rechtspraak.nl/rechtsgebied#civielRecht'));
    expect(feed).toContain("Aantal gevonden ECLI's: 8");
    expect(feed).toContain('<id>ECLI:NL:HR:2024:');
    const doc = await get('/uitspraken/content?id=ECLI:NL:RVS:2024:2');
    expect(doc).toContain('<dcterms:identifier>ECLI:NL:RVS:2024:2</dcterms:identifier>');
    expect(doc).toContain('<uitspraak');
    const courts = await get('/Waardelijst/Instanties');
    expect(courts).toContain('<Afkorting>HR</Afkorting>');
  }, 60_000);
});
