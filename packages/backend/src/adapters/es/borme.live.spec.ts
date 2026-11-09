import * as adapter from './borme.json';

/**
 * BOE open data API (https://www.boe.es/datosabiertos/api/api.php): GET /datosabiertos/api/borme/sumario/{AAAAMMDD} and
 * /datosabiertos/api/boe/sumario/{AAAAMMDD} (JSON with Accept: application/json), items as XML from
 * /diario_borme/xml.php?id= and /diario_boe/xml.php?id= (the url_xml links of the summaries). No key.
 * Live part (keyless, two calls): RUN_BORME_LIVE=1 npx jest src/adapters/es/borme
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
const SLUG = 'borme';
const REGION = 'es';
const BASE = 'https://www.boe.es';
const PREFIX = 'borme_';
const POST_TOOLS: string[] = [];
const PROBE_METHOD = 'GET';
// Names users gave their own hand-made tools for this API (the catalog re-sync matches tools by name).
const RESERVED = ['boe_sumario', 'borme_sommaire'];

describe('borme adapter: static spec conformance', () => {
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

  it('covers the observed summary endpoints and the item links of the summaries', () => {
    expect(tool('borme_get_summary').endpointMapping).toMatchObject({ path: '/datosabiertos/api/borme/sumario/{date}', headers: { Accept: 'application/json' } });
    expect(tool('borme_get_boe_summary').endpointMapping).toMatchObject({ path: '/datosabiertos/api/boe/sumario/{date}', headers: { Accept: 'application/json' } });
    expect(tool('borme_get_item').endpointMapping).toMatchObject({ path: '/diario_borme/xml.php', queryParams: { id: '$id' } });
    expect(tool('borme_get_boe_item').endpointMapping).toMatchObject({ path: '/diario_boe/xml.php', queryParams: { id: '$id' } });
    const date = new RegExp(tool('borme_get_summary').parameters?.properties?.date.pattern ?? '');
    expect(date.test('20261106')).toBe(true);
    expect(date.test('2026-11-06')).toBe(false);
    expect(new RegExp(tool('borme_get_item').parameters?.properties?.id.pattern ?? '').test('BORME-A-2026-214-28')).toBe(true);
    expect(new RegExp(tool('borme_get_boe_item').parameters?.properties?.id.pattern ?? '').test('BOE-A-2026-23341')).toBe(true);
  });
});

const live = process.env.RUN_BORME_LIVE === '1' ? describe : describe.skip;
live('borme adapter: live (keyless, read-only)', () => {
  it('reads a BORME summary and one of its items', async () => {
    const sum = (await (await fetch(`${BASE}/datosabiertos/api/borme/sumario/20261106`, { headers: { Accept: 'application/json', 'User-Agent': 'AnythingMCP' } })).json()) as { data: { sumario: { diario: { seccion: { codigo: string; item?: { identificador: string }[] }[] }[] } } };
    const a1 = sum.data.sumario.diario[0].seccion.find((s) => s.codigo === 'A');
    const id = a1?.item?.[0].identificador as string;
    expect(id).toMatch(/^BORME-A-2026-/);
    const xml = await (await fetch(`${BASE}/diario_borme/xml.php?id=${id}`, { headers: { 'User-Agent': 'AnythingMCP' } })).text();
    expect(xml).toContain(`<identificador>${id}</identificador>`);
  }, 60_000);
});
