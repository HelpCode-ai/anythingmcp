import * as adapter from './prh-ytj.json';

/**
 * PRH open data (CC BY 4.0), three APIs on avoindata.prh.fi documented at https://avoindata.prh.fi/en/ytj/swagger-ui,
 * /en/krek/swagger-ui and /en/xbrl/swagger-ui: opendata-ytj-api/v3, opendata-registerednotices-api/v3 and
 * opendata-xbrl-api/v3. No key.
 * Live part (keyless, four calls): RUN_PRH_YTJ_LIVE=1 npx jest src/adapters/fi/prh-ytj
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
const SLUG = 'prh-ytj';
const REGION = 'fi';
const BASE = 'https://avoindata.prh.fi';
const PREFIX = 'prh_ytj_';
const POST_TOOLS: string[] = [];
const PROBE_METHOD = 'GET';
// Names users gave their own hand-made tools for this API (the catalog re-sync matches tools by name).
const RESERVED = ['prh_recherche'];

describe('prh-ytj adapter: static spec conformance', () => {
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

  it('covers the observed companies endpoint and the documented notice and XBRL paths', () => {
    expect(tool('prh_ytj_search_companies').endpointMapping).toMatchObject({ path: '/opendata-ytj-api/v3/companies', queryParams: { name: '$name', location: '$location', businessId: '$business_id', companyForm: '$company_form', page: '$page' } });
    expect(tool('prh_ytj_get_company').endpointMapping).toMatchObject({ path: '/opendata-ytj-api/v3/companies', queryParams: { businessId: '$business_id' } });
    expect(tool('prh_ytj_get_trade_register_notices').endpointMapping.path).toBe('/opendata-registerednotices-api/v3/{business_id}');
    expect(tool('prh_ytj_search_trade_register_notices').endpointMapping.path).toBe('/opendata-registerednotices-api/v3/');
    expect(tool('prh_ytj_get_public_notice').endpointMapping.path).toBe('/opendata-registerednotices-api/v3/publicnotices/{record_year}/{record_number}');
    expect(tool('prh_ytj_list_financial_statements').endpointMapping).toMatchObject({ path: '/opendata-xbrl-api/v3/financials', queryParams: { businessId: '$business_id' } });
    expect(tool('prh_ytj_get_financial_statement').endpointMapping).toMatchObject({ path: '/opendata-xbrl-api/v3/financial', queryParams: { businessId: '$business_id', financialDate: '$financial_date' } });
  });

  it('validates Business IDs and offers the documented code sets', () => {
    const re = new RegExp(tool('prh_ytj_get_company').parameters?.properties?.business_id.pattern ?? '');
    expect(re.test('0112038-9')).toBe(true);
    expect(re.test('01120389')).toBe(false);
    expect(tool('prh_ytj_get_code_descriptions').parameters?.properties?.code.enum).toContain('YRMU');
    expect(tool('prh_ytj_get_notice_code_descriptions').parameters?.properties?.code.enum).toEqual(['CF', 'EC', 'NRT']);
  });
});

const live = process.env.RUN_PRH_YTJ_LIVE === '1' ? describe : describe.skip;
live('prh-ytj adapter: live (keyless, read-only)', () => {
  const get = (path: string) => fetch(`${BASE}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'AnythingMCP' } });
  it('reads a company, its notices, its financial periods and a code list', async () => {
    const c = (await (await get('/opendata-ytj-api/v3/companies?businessId=0112038-9')).json()) as { totalResults: number; companies: { businessId: { value: string } }[] };
    expect(c.companies[0].businessId.value).toBe('0112038-9');
    const n = (await (await get('/opendata-registerednotices-api/v3/0112038-9')).json()) as { publicNotices: unknown[] };
    expect(n.publicNotices.length).toBeGreaterThan(0);
    const f = (await (await get('/opendata-xbrl-api/v3/financials?businessId=0100379-9')).json()) as { totalResults: number };
    expect(typeof f.totalResults).toBe('number');
    const d = await (await get('/opendata-ytj-api/v3/description?code=YRMU&lang=en')).text();
    expect(d).toMatch(/OYJ\t/);
  }, 60_000);
});
