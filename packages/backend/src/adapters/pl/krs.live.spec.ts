import * as adapter from './krs.json';

/**
 * KRS open API of the Polish Ministry of Justice (https://prs.ms.gov.pl/krs/openApi):
 * GET https://api-krs.ms.gov.pl/api/krs/OdpisAktualny|OdpisPelny/{krs}?rejestr=P|S&format=json and /Biuletyn/{date}. No key.
 * Live part (keyless, three calls): RUN_KRS_LIVE=1 npx jest src/adapters/pl/krs
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
const SLUG = 'krs';
const REGION = 'pl';
const BASE = 'https://api-krs.ms.gov.pl/api/krs';
const PREFIX = 'krs_';
const POST_TOOLS: string[] = [];
const PROBE_METHOD = 'GET';
// Names users gave their own hand-made tools for this API (the catalog re-sync matches tools by name).
const RESERVED = ['krs_extrait_actuel', 'krs_extrait_complet'];

describe('krs adapter: static spec conformance', () => {
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

  it('covers the observed extract endpoints and asks for JSON', () => {
    expect(tool('krs_get_current_extract').endpointMapping).toEqual({ method: 'GET', path: '/OdpisAktualny/{krs_number}', queryParams: { rejestr: '$register', format: 'json' } });
    expect(tool('krs_get_full_extract').endpointMapping).toMatchObject({ method: 'GET', path: '/OdpisPelny/{krs_number}', queryParams: { rejestr: '$register', format: 'json' } });
    expect(tool('krs_list_changed_entities').endpointMapping).toEqual({ method: 'GET', path: '/Biuletyn/{date}' });
    expect(tool('krs_get_current_extract').parameters?.properties?.register.enum).toEqual(['P', 'S']);
    const re = new RegExp(tool('krs_get_current_extract').parameters?.properties?.krs_number.pattern ?? '');
    expect(re.test('0000019193')).toBe(true);
    expect(re.test('19193')).toBe(true);
    expect(re.test('KRS 19193')).toBe(false);
  });
});

const live = process.env.RUN_KRS_LIVE === '1' ? describe : describe.skip;
live('krs adapter: live (keyless, read-only)', () => {
  const get = (path: string) => fetch(`${BASE}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'AnythingMCP' } });
  it('reads the current extract, answers 404 for an unknown number and lists a day of changes', async () => {
    const res = await get('/OdpisAktualny/0000019193?format=json');
    expect(res.status).toBe(200);
    const odpis = ((await res.json()) as { odpis: { naglowekA: { numerKRS: string }; dane: { dzial1: { danePodmiotu: { identyfikatory: { nip: string } } } } } }).odpis;
    expect(odpis.naglowekA.numerKRS).toBe('0000019193');
    expect(odpis.dane.dzial1.danePodmiotu.identyfikatory.nip).toBe('5250000251');
    expect((await get('/OdpisAktualny/0000000001?format=json')).status).toBe(404);
    const day = (await (await get('/Biuletyn/2026-11-06')).json()) as string[];
    expect(Array.isArray(day)).toBe(true);
  }, 60_000);
});
