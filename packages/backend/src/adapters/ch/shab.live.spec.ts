import * as adapter from './shab.json';

/**
 * Swiss official gazettes portal API (https://www.amtsblattportal.ch/docs/api/): GET /api/v1/publications
 * (publicationStates=PUBLISHED is mandatory without a login), /publications/{id}/xml and /pdf. No key.
 * Live part (keyless, two calls): RUN_SHAB_LIVE=1 npx jest src/adapters/ch/shab
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
const SLUG = 'shab';
const REGION = 'ch';
const BASE = 'https://www.amtsblattportal.ch/api/v1';
const PREFIX = 'shab_';
const POST_TOOLS: string[] = [];
const PROBE_METHOD = 'GET';
// Names users gave their own hand-made tools for this API (the catalog re-sync matches tools by name).
const RESERVED = ['fosc_publication_texte', 'fosc_publications'];

describe('shab adapter: static spec conformance', () => {
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

  it('covers the observed search and XML endpoints and always asks for published notices', () => {
    const search = tool('shab_search_publications').endpointMapping;
    expect(search.path).toBe('/publications');
    expect(search.queryParams).toMatchObject({ publicationStates: 'PUBLISHED', keyword: '$keyword', uids: '$uids', rubrics: '$rubrics', subRubrics: '$sub_rubrics', cantons: '$cantons', tenant: '$tenant', 'publicationDate.start': '$date_start', 'publicationDate.end': '$date_end', 'pageRequest.page': '$page', 'pageRequest.size': '$size' });
    expect(tool('shab_get_publication').endpointMapping).toMatchObject({ path: '/publications/{publication_id}/xml' });
    expect(tool('shab_get_publication_pdf').endpointMapping).toMatchObject({ path: '/publications/{publication_id}/pdf', headers: { Accept: 'application/pdf' } });
    expect(tool('shab_get_publication_pdf').responseMapping?.binary?.maxBytes).toBe(10 * 1024 * 1024);
  });
});

const live = process.env.RUN_SHAB_LIVE === '1' ? describe : describe.skip;
live('shab adapter: live (keyless, read-only)', () => {
  it('finds a commercial register notice and reads its XML', async () => {
    const res = await fetch(`${BASE}/publications?publicationStates=PUBLISHED&tenant=shab&rubrics=HR&pageRequest.size=1`, { headers: { Accept: 'application/json', 'User-Agent': 'AnythingMCP' } });
    const page = (await res.json()) as { total: number; content: { meta: { id: string; rubric: string } }[] };
    expect(page.content[0].meta.rubric).toBe('HR');
    const xml = await (await fetch(`${BASE}/publications/${page.content[0].meta.id}/xml`, { headers: { Accept: 'application/xml', 'User-Agent': 'AnythingMCP' } })).text();
    expect(xml).toContain('<publicationText>');
  }, 60_000);
});
