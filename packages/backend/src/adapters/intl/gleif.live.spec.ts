import * as adapter from './gleif.json';

/**
 * GLEIF API v1 (https://www.gleif.org/en/lei-data/gleif-api, https://api.gleif.org/api/v1), JSON:API, no key, CC0.
 * Paths, filters and answers were confirmed against the live API on 2026-11-19.
 * Live part (keyless, six calls): RUN_GLEIF_LIVE=1 npx jest src/adapters/intl/gleif
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
const SLUG = 'gleif';
const REGION = 'intl';
const BASE = 'https://api.gleif.org/api/v1';
const PREFIX = 'gleif_';
const ENV_VARS: string[] = [];
// Tools installed switched off.
const OFF: string[] = [];
// name: [method, path, required arguments]
const TOOLS: Record<string, [string, string, string[]]> = {
  gleif_search_lei_records: ['GET', '/lei-records', []],
  gleif_get_lei_record: ['GET', '/lei-records/{lei}', ['lei']],
  gleif_get_direct_parent: ['GET', '/lei-records/{lei}/direct-parent', ['lei']],
  gleif_get_ultimate_parent: ['GET', '/lei-records/{lei}/ultimate-parent', ['lei']],
  gleif_list_direct_children: ['GET', '/lei-records/{lei}/direct-children', ['lei']],
  gleif_list_ultimate_children: ['GET', '/lei-records/{lei}/ultimate-children', ['lei']],
  gleif_get_parent_relationship: ['GET', '/lei-records/{lei}/{level}-parent-relationship', ['lei', 'level']],
  gleif_get_parent_reporting_exception: ['GET', '/lei-records/{lei}/{level}-parent-reporting-exception', ['lei', 'level']],
  gleif_list_child_relationships: ['GET', '/lei-records/{lei}/{level}-child-relationships', ['lei', 'level']],
  gleif_get_fund_manager: ['GET', '/lei-records/{lei}/fund-manager', ['lei']],
  gleif_list_isins: ['GET', '/lei-records/{lei}/isins', ['lei']],
  gleif_list_field_modifications: ['GET', '/lei-records/{lei}/field-modifications', ['lei']],
  gleif_get_lei_issuer_of_record: ['GET', '/lei-records/{lei}/lei-issuer', ['lei']],
  gleif_fuzzy_complete: ['GET', '/fuzzycompletions', ['q', 'field']],
  gleif_autocomplete: ['GET', '/autocompletions', ['q', 'field']],
  gleif_list_registration_authorities: ['GET', '/registration-authorities', []],
  gleif_get_registration_authority: ['GET', '/registration-authorities/{code}', ['code']],
  gleif_get_legal_form: ['GET', '/entity-legal-forms/{code}', ['code']],
  gleif_list_lei_issuers: ['GET', '/lei-issuers', []],
  gleif_get_lei_issuer: ['GET', '/lei-issuers/{lei}', ['lei']],
};

describe('gleif adapter: static spec conformance', () => {
  it('has the expected envelope and authentication', () => {
    expect(a.slug).toBe(SLUG);
    expect(a.region).toBe(REGION);
    expect(a.icon).toBe(SLUG);
    expect(a.category).toBe('data');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.headers).toEqual({ Accept: 'application/vnd.api+json', 'User-Agent': 'AnythingMCP' });
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

  it('is read-only and maps the JSON:API filter and paging keys', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    expect(tool('gleif_search_lei_records').endpointMapping.queryParams).toEqual({
      'filter[fulltext]': '$fulltext',
      'filter[entity.legalName]': '$legal_name',
      'filter[entity.names]': '$names',
      'filter[lei]': '$lei',
      'filter[bic]': '$bic',
      'filter[isin]': '$isin',
      'filter[entity.legalAddress.country]': '$country',
      'filter[entity.jurisdiction]': '$jurisdiction',
      'filter[entity.registeredAs]': '$registered_as',
      'filter[entity.registeredAt]': '$registered_at',
      'filter[entity.legalForm]': '$legal_form',
      'filter[entity.category]': '$category',
      'filter[entity.status]': '$entity_status',
      'filter[registration.status]': '$registration_status',
      'filter[registration.managingLou]': '$managing_lou',
      'filter[owns]': '$owns',
      'filter[ownedBy]': '$owned_by',
      sort: '$sort',
      'page[number]': '$page_number',
      'page[size]': '$page_size',
    });
    for (const name of ['gleif_list_direct_children', 'gleif_list_ultimate_children', 'gleif_list_isins', 'gleif_list_field_modifications', 'gleif_list_registration_authorities', 'gleif_list_lei_issuers']) {
      expect(tool(name).endpointMapping.queryParams).toEqual({ 'page[number]': '$page_number', 'page[size]': '$page_size' });
      expect(tool(name).parameters?.properties?.page_size).toMatchObject({ minimum: 1, maximum: 200 });
    }
  });

  it('validates LEIs and offers only the completion fields the API supports', () => {
    const re = new RegExp(tool('gleif_get_lei_record').parameters?.properties?.lei.pattern ?? '');
    expect(re.test('529900W18LQJJN6SJ336')).toBe(true);
    expect(re.test('7LTWFZYICNSX8D621K86')).toBe(true);
    expect(re.test('529900w18lqjjn6sj336')).toBe(true);
    expect(re.test('529900W18LQJJN6SJ33')).toBe(false);
    expect(re.test('5299 00W18LQJJN6SJ336')).toBe(false);
    expect(tool('gleif_fuzzy_complete').parameters?.properties?.field.enum).toEqual(['entity.legalName', 'fulltext', 'owns', 'ownedBy']);
    expect(tool('gleif_autocomplete').parameters?.properties?.field.enum).toEqual(['fulltext', 'owns', 'ownedBy']);
    expect(tool('gleif_get_parent_relationship').parameters?.properties?.level.enum).toEqual(['direct', 'ultimate']);
  });
});

const live = process.env.RUN_GLEIF_LIVE === '1' ? describe : describe.skip;
live('gleif adapter: live (keyless, read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/vnd.api+json', 'User-Agent': 'AnythingMCP' } });
    return { status: res.status, body: (await res.json()) as { data?: unknown; meta?: { pagination?: { total: number } } } };
  };
  it('reads a record, its parent, a BIC and ISIN search, children and a completion', async () => {
    const rec = await get('/lei-records/529900W18LQJJN6SJ336');
    expect((rec.body.data as { attributes: { entity: { jurisdiction: string } } }).attributes.entity.jurisdiction).toBe('DE');
    const parent = await get('/lei-records/529900W18LQJJN6SJ336/direct-parent');
    expect((parent.body.data as { id: string }).id).toBe('O2RNE8IBXP4R0TD8PU41');
    const bic = await get(`/lei-records?${encodeURIComponent('filter[bic]')}=DEUTDEFFXXX`);
    expect((bic.body.data as { id: string }[])[0].id).toBe('7LTWFZYICNSX8D621K86');
    const isin = await get(`/lei-records?${encodeURIComponent('filter[isin]')}=DE0005140008`);
    expect(isin.body.meta?.pagination?.total).toBe(1);
    const kids = await get(`/lei-records/7LTWFZYICNSX8D621K86/direct-children?${encodeURIComponent('page[size]')}=2`);
    expect((kids.body.data as unknown[]).length).toBe(2);
    const noParent = await get('/lei-records/7LTWFZYICNSX8D621K86/direct-parent');
    expect(noParent.status).toBe(404);
    const fuzzy = await get('/fuzzycompletions?field=entity.legalName&q=deutsche%20bnk');
    expect((fuzzy.body.data as unknown[]).length).toBeGreaterThan(0);
  }, 60_000);
});
