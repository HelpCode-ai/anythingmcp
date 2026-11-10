import * as adapter from './ares.json';

/**
 * ARES REST API (Czech Ministry of Finance), OpenAPI https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs
 * (Swagger UI https://ares.gov.cz/swagger-ui/). Searches are POST .../vyhledat with a JSON filter; no key.
 * Live part (keyless, four calls): RUN_ARES_LIVE=1 npx jest src/adapters/cz/ares
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
const SLUG = 'ares';
const REGION = 'cz';
const BASE = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest';
const PREFIX = 'ares_';
const POST_TOOLS: string[] = ['ares_search_subjects', 'ares_search_commercial_register', 'ares_search_codelists'];
const PROBE_METHOD = 'GET';
// Names users gave their own hand-made tools for this API (the catalog re-sync matches tools by name).
const RESERVED = ['ares_fiche', 'ares_recherche', 'ares_registre_commerce'];

describe('ares adapter: static spec conformance', () => {
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

  it('covers the observed endpoints with the documented paths and Czech body keys', () => {
    expect(tool('ares_get_subject').endpointMapping.path).toBe('/ekonomicke-subjekty/{ico}');
    expect(tool('ares_get_commercial_register').endpointMapping.path).toBe('/ekonomicke-subjekty-vr/{ico}');
    expect(tool('ares_search_subjects').endpointMapping).toMatchObject({ path: '/ekonomicke-subjekty/vyhledat', bodyMapping: { obchodniJmeno: '$business_name', ico: '$ico', pravniForma: '$legal_forms', czNace: '$nace_codes', start: '$start', pocet: '$count' } });
    expect(tool('ares_search_commercial_register').endpointMapping).toMatchObject({ path: '/ekonomicke-subjekty-vr/vyhledat', bodyMapping: { ico: '$ico' } });
    expect(tool('ares_search_codelists').endpointMapping).toMatchObject({ path: '/ciselniky-nazevniky/vyhledat', bodyMapping: { kodCiselniku: '$codelist', zdrojCiselniku: '$source' } });
    expect(tool('ares_get_other_register_record').endpointMapping.path).toBe('/ekonomicke-subjekty-{register}/{ico}');
    expect(tool('ares_get_other_register_record').parameters?.properties?.register.enum).toEqual(['nrpzs', 'rpsh', 'rcns', 'szr', 'rs']);
  });

  it('validates IČO numbers', () => {
    const re = new RegExp(tool('ares_get_subject').parameters?.properties?.ico.pattern ?? '');
    expect(re.test('27074358')).toBe(true);
    expect(re.test('2707435')).toBe(false);
  });
});

const live = process.env.RUN_ARES_LIVE === '1' ? describe : describe.skip;
live('ares adapter: live (keyless, read-only)', () => {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'AnythingMCP' };
  it('reads a subject, its commercial register extract, searches and decodes a code list', async () => {
    const s = (await (await fetch(`${BASE}/ekonomicke-subjekty/27074358`, { headers })).json()) as { ico: string; seznamRegistraci: { stavZdrojeVr: string } };
    expect(s.ico).toBe('27074358');
    expect(s.seznamRegistraci.stavZdrojeVr).toBe('AKTIVNI');
    const vr = (await (await fetch(`${BASE}/ekonomicke-subjekty-vr/27074358`, { headers })).json()) as { icoId: string; zaznamy: unknown[] };
    expect(vr.zaznamy.length).toBeGreaterThan(0);
    const found = (await (await fetch(`${BASE}/ekonomicke-subjekty/vyhledat`, { method: 'POST', headers, body: JSON.stringify({ obchodniJmeno: 'Seznam.cz', pocet: 2 }) })).json()) as { pocetCelkem: number };
    expect(found.pocetCelkem).toBeGreaterThan(0);
    const cl = (await (await fetch(`${BASE}/ciselniky-nazevniky/vyhledat`, { method: 'POST', headers, body: JSON.stringify({ kodCiselniku: 'PravniForma', zdrojCiselniku: 'res' }) })).json()) as { ciselniky: unknown[] };
    expect(cl.ciselniky.length).toBe(1);
  }, 60_000);
});
