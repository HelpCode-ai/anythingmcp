import * as adapter from './brreg.json';

/**
 * Brønnøysund Register Centre open data (NLOD 2.0): Enhetsregisteret API
 * (https://data.brreg.no/enhetsregisteret/api/dokumentasjon/en/index.html, OpenAPI at ./openapi.json) and
 * Regnskapsregisteret (https://data.brreg.no/regnskapsregisteret/regnskap/v3/api-docs). No key.
 * Live part (keyless, five calls): RUN_BRREG_LIVE=1 npx jest src/adapters/no/brreg
 */

type Prop = { type?: string; default?: unknown; pattern?: string; enum?: unknown[]; maxItems?: number };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, Prop>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; timeoutMs?: number };
  responseMapping?: { binary?: { maxBytes?: number } };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  icon: string;
  category: string;
  aliases?: string[];
  requiredEnvVars: string[];
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const SLUG = 'brreg';
const REGION = 'no';
const BASE = 'https://data.brreg.no';
const PREFIX = 'brreg_';
const POST_TOOLS: string[] = [];
const PROBE_METHOD = 'GET';
// Names users gave their own hand-made tools for this API (the catalog re-sync matches tools by name).
const RESERVED = ['brreg_comptes', 'brreg_fiche', 'brreg_recherche', 'brreg_roles'];

describe('brreg adapter: static spec conformance', () => {
  it('is a keyless REST adapter with the expected envelope', () => {
    expect(a.slug).toBe(SLUG);
    expect(a.region).toBe(REGION);
    expect(a.icon).toBe(SLUG);
    expect(a.category).toBe('government');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.headers?.['User-Agent']).toBe('AnythingMCP');
    for (const alias of a.aliases ?? []) expect(alias.length).toBeLessThanOrEqual(40);
  });

  it('probes with a read tool and arguments it declares', () => {
    const p = a.probe!;
    const t = tool(p.tool);
    expect(t.endpointMapping.method).toBe(PROBE_METHOD);
    const props = Object.keys(t.parameters?.properties ?? {});
    for (const k of Object.keys(p.params ?? {})) expect(props).toContain(k);
    for (const r of t.parameters?.required ?? []) expect(Object.keys(p.params ?? {})).toContain(r);
  });

  it('every tool is prefixed, read-only, maps every declared argument and requires its path parameters', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.enabled).toBeUndefined();
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:${POST_TOOLS.includes(t.name) ? 'POST' : 'GET'}`);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('uses no tool name that users already gave their own tools for this API', () => {
    const names = a.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const r of RESERVED) expect(names).not.toContain(r);
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });

  it('covers the observed endpoints with the documented paths and Norwegian query keys', () => {
    expect(tool('brreg_search_entities').endpointMapping).toMatchObject({ path: '/enhetsregisteret/api/enheter', queryParams: { navn: '$name', organisasjonsform: '$organisation_form', naeringskode: '$industry_code', konkurs: '$bankrupt', page: '$page', size: '$size' } });
    expect(tool('brreg_get_entity').endpointMapping.path).toBe('/enhetsregisteret/api/enheter/{organisation_number}');
    expect(tool('brreg_get_entity_roles').endpointMapping.path).toBe('/enhetsregisteret/api/enheter/{organisation_number}/roller');
    expect(tool('brreg_get_annual_accounts').endpointMapping).toMatchObject({ path: '/regnskapsregisteret/regnskap/{organisation_number}', queryParams: { 'år': '$year', regnskapstype: '$accounts_type' } });
    expect(tool('brreg_get_annual_accounts').parameters?.properties?.accounts_type.enum).toEqual(['SELSKAP', 'KONSERN']);
    expect(tool('brreg_search_sub_entities').endpointMapping.queryParams).toMatchObject({ overordnetEnhet: '$parent_organisation_number' });
    expect(tool('brreg_get_group_structure').endpointMapping.path).toBe('/enhetsregisteret/api/konsernstruktur/{organisation_number}');
    expect(tool('brreg_list_entity_updates').endpointMapping).toMatchObject({ path: '/enhetsregisteret/api/oppdateringer/enheter', queryParams: { dato: '$since', oppdateringsid: '$from_update_id' } });
  });

  it('validates organisation numbers and attaches the annual report PDF', () => {
    const re = new RegExp(tool('brreg_get_entity').parameters?.properties?.organisation_number.pattern ?? '');
    expect(re.test('923609016')).toBe(true);
    expect(re.test('923 609 016')).toBe(false);
    const pdf = tool('brreg_get_annual_report_copy');
    expect(pdf.endpointMapping).toMatchObject({ path: '/regnskapsregisteret/regnskap/aarsregnskap/kopi/{organisation_number}/{year}', headers: { Accept: 'application/pdf' } });
    expect(pdf.responseMapping?.binary?.maxBytes).toBe(10 * 1024 * 1024);
  });
});

const live = process.env.RUN_BRREG_LIVE === '1' ? describe : describe.skip;
live('brreg adapter: live (keyless, read-only)', () => {
  const get = (path: string) => fetch(`${BASE}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'AnythingMCP' } });
  it('searches, reads an entity, its roles, accounts and report years', async () => {
    const search = (await (await get('/enhetsregisteret/api/enheter?navn=equinor%20asa&navnMetodeForSoek=FORTLOEPENDE&size=1')).json()) as { _embedded: { enheter: { organisasjonsnummer: string }[] } };
    expect(search._embedded.enheter[0].organisasjonsnummer).toBe('923609016');
    const entity = (await (await get('/enhetsregisteret/api/enheter/923609016')).json()) as { navn: string; organisasjonsform: { kode: string } };
    expect(entity.organisasjonsform.kode).toBe('ASA');
    const roles = (await (await get('/enhetsregisteret/api/enheter/923609016/roller')).json()) as { rollegrupper: unknown[] };
    expect(roles.rollegrupper.length).toBeGreaterThan(0);
    const accounts = (await (await get(`/regnskapsregisteret/regnskap/923609016?${encodeURIComponent('år')}=2024&regnskapstype=SELSKAP`)).json()) as { regnskapstype: string }[];
    expect(accounts.every((x) => x.regnskapstype === 'SELSKAP')).toBe(true);
    const years = (await (await get('/regnskapsregisteret/regnskap/aarsregnskap/kopi/923609016/aar')).json()) as string[];
    expect(years).toContain('2024');
  }, 60_000);
});
