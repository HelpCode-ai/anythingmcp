import * as adapter from './anaf.json';

/**
 * ANAF public web services: PlatitorTvaRest v9 (https://static.anaf.ro/static/10/Anaf/Informatii_R/Servicii_web/doc_WS_V9.txt,
 * POST https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva with [{cui, data}], max 100 codes, 1 request/s) and
 * the financial statements service (https://static.anaf.ro/static/10/Anaf/Informatii_R/doc_WS_Bilant_V1.txt, GET /bilant?an&cui).
 * Live part (keyless, two calls, spaced): RUN_ANAF_LIVE=1 npx jest src/adapters/ro/anaf
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
const SLUG = 'anaf';
const REGION = 'ro';
const BASE = 'https://webservicesp.anaf.ro';
const PREFIX = 'anaf_';
const POST_TOOLS: string[] = ['anaf_get_company_vat_status', 'anaf_get_companies_vat_status'];
const PROBE_METHOD = 'GET';
// Names users gave their own hand-made tools for this API (the catalog re-sync matches tools by name).
const RESERVED = ['anaf_bilan', 'anaf_identite'];

describe('anaf adapter: static spec conformance', () => {
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

  it('covers the observed VAT (v9) and bilant endpoints with the documented bodies', () => {
    expect(tool('anaf_get_company_vat_status').endpointMapping).toEqual({ method: 'POST', path: '/api/PlatitorTvaRest/v9/tva', bodyMapping: [{ cui: '$cui', data: '$date' }] });
    expect(tool('anaf_get_companies_vat_status').endpointMapping).toEqual({ method: 'POST', path: '/api/PlatitorTvaRest/v9/tva', bodyMapping: { __raw: '$companies' } });
    expect(tool('anaf_get_companies_vat_status').parameters?.properties?.companies.maxItems).toBe(100);
    expect(tool('anaf_get_financial_statement').endpointMapping).toEqual({ method: 'GET', path: '/bilant', queryParams: { an: '$year', cui: '$cui' } });
    expect(a.instructions).toMatch(/1 request per second/);
  });
});

const live = process.env.RUN_ANAF_LIVE === '1' ? describe : describe.skip;
live('anaf adapter: live (keyless, read-only)', () => {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'AnythingMCP' };
  it('checks one VAT status and reads one financial statement', async () => {
    const vat = (await (await fetch(`${BASE}/api/PlatitorTvaRest/v9/tva`, { method: 'POST', headers, body: JSON.stringify([{ cui: 14399840, data: '2026-11-06' }]) })).json()) as { found: { date_generale: { cui: number }; inregistrare_scop_Tva: { scpTVA: boolean } }[] };
    expect(vat.found[0].date_generale.cui).toBe(14399840);
    expect(typeof vat.found[0].inregistrare_scop_Tva.scpTVA).toBe('boolean');
    await new Promise((r) => setTimeout(r, 1500));
    const bilant = (await (await fetch(`${BASE}/bilant?an=2024&cui=14399840`, { headers })).json()) as { cui: number; i: { indicator: string }[] };
    expect(bilant.cui).toBe(14399840);
    expect(bilant.i.some((x) => x.indicator === 'I13')).toBe(true);
  }, 60_000);
});
