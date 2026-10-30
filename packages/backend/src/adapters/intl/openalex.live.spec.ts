import * as adapter from './openalex.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * OpenAlex REST API (help.openalex.org/api/): GET https://api.openalex.org/<entity>[/<id>].
 * Keyless calls share a 0.10 USD daily budget per address; an optional free key goes in
 * Authorization: Bearer (1 USD a day). The mailto polite pool was retired in February 2026.
 * Live part: RUN_OPENALEX_LIVE=1 [OPENALEX_API_KEY=...] npx jest src/adapters/intl/openalex
 * (reads only: a work by DOI, a works search, an author by ORCID, an autocomplete, a group count, topics).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { default?: unknown; enum?: unknown[]; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const KEY = 'OPENALEX_API_KEY';
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings (connector variables excluded).
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) if (p !== KEY) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'openalex_';
const ENTITIES = ['works', 'authors', 'sources', 'institutions', 'topics', 'publishers', 'funders'];
const SINGULAR: Record<string, string> = { works: 'work', authors: 'author', sources: 'source', institutions: 'institution', topics: 'topic', publishers: 'publisher', funders: 'funder' };

describe('openalex adapter: static spec conformance', () => {
  it('calls api.openalex.org without required credentials and sends the optional key as a bearer token', () => {
    expect(a.slug).toBe('openalex');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('data');
    expect(a.icon).toBe('openalex');
    expect(a.docsUrl).toBe('https://help.openalex.org/api/');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars).toEqual([KEY]);
    expect(a.connector.baseUrl).toBe('https://api.openalex.org');
    expect(a.connector.authType).toBe('NONE');
    expect(a.envVarMeta?.[KEY]).toMatchObject({ kind: 'credential', secret: true });
    expect(new RegExp(a.envVarMeta?.[KEY].pattern as string).test(['oa', 'key', '0123456789abcdef'].join('_'))).toBe(true);
    expect(new RegExp(a.envVarMeta?.[KEY].pattern as string).test('api_key=with space')).toBe(false);
    // Templated, so the header is left out when no key is set.
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.headers?.Authorization}`).toBe(`${t.name}:Bearer \${${KEY}}`);
    // The retired polite pool parameter is not sent.
    expect(JSON.stringify(a.tools)).not.toContain('mailto');
  });

  it('maps a search and a get tool per entity plus works, group_by and autocomplete', () => {
    const routes: Record<string, string> = {
      openalex_search_works: '/works',
      openalex_get_work: '/works/{work_id}',
      openalex_group_by: '/{entity}',
      openalex_autocomplete: '/autocomplete/{entity_type}',
    };
    for (const e of ENTITIES.slice(1)) {
      routes[`openalex_search_${e}`] = `/${e}`;
      routes[`openalex_get_${SINGULAR[e]}`] = `/${e}/{${SINGULAR[e]}_id}`;
    }
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(routes).sort());
    for (const [name, path] of Object.entries(routes)) expect(tool(name).endpointMapping).toMatchObject({ method: 'GET', path });
  });

  it('sends the documented list parameters in snake_case and the dotted search variants', () => {
    for (const e of ENTITIES) {
      const t = tool(`openalex_search_${e}`);
      expect(t.endpointMapping.queryParams).toMatchObject({ search: '$search', filter: '$filter', sort: '$sort', per_page: '$per_page', page: '$page', cursor: '$cursor', sample: '$sample', seed: '$seed' });
      expect(t.parameters?.properties?.per_page).toMatchObject({ maximum: 100, default: 25 });
      expect(t.parameters?.required).toBeUndefined();
    }
    expect(tool('openalex_search_works').endpointMapping.queryParams).toMatchObject({ 'search.exact': '$search_exact', 'search.semantic': '$search_semantic', corpus: '$corpus' });
    expect(tool('openalex_search_works').parameters?.properties?.corpus.enum).toEqual(['core', 'expansion', 'all']);
    expect(tool('openalex_group_by').parameters?.properties?.entity.enum).toEqual(ENTITIES);
    expect(tool('openalex_group_by').endpointMapping.queryParams).toEqual({ group_by: '$group_by', filter: '$filter', search: '$search' });
    expect(tool('openalex_autocomplete').parameters?.properties?.entity_type.enum).toEqual(['works', 'authors', 'sources', 'institutions', 'topics', 'keywords', 'publishers', 'funders']);
    for (const e of ENTITIES) expect(tool(`openalex_get_${SINGULAR[e]}`).endpointMapping.queryParams).toEqual({ select: '$select' });
  });

  it('slims a works listing to the fields an agent needs', () => {
    const raw = {
      meta: { notice: 'long', count: 2, page: 1, per_page: 25, next_cursor: null, cost_usd: 0.001, x_query: { oql: 'x' } },
      results: [{
        id: 'https://openalex.org/W2741809807', doi: 'https://doi.org/10.7717/peerj.4375', display_name: 'The state of OA', publication_year: 2018, publication_date: '2018-02-13', type: 'article',
        cited_by_count: 1200, fwci: 20.1, open_access: { is_oa: true, oa_status: 'gold', oa_url: 'https://peerj.com/articles/4375.pdf' },
        primary_location: { source: { display_name: 'PeerJ' } }, authorships: [{ author: { display_name: 'Heather Piwowar' }, institutions: [{}] }, { author: { display_name: 'Jason Priem' } }],
        primary_topic: { display_name: 'Open access' }, abstract_inverted_index: { The: [0] }, referenced_works: ['W1'],
      }],
    };
    const out = applyResponseTransform(raw, tool('openalex_search_works').responseMapping as never).value as { meta: Record<string, unknown>; results: Record<string, unknown>[] };
    expect(out.meta).toEqual({ count: 2, page: 1, per_page: 25, next_cursor: null, cost_usd: 0.001 });
    expect(out.results[0]).toEqual({
      id: 'https://openalex.org/W2741809807', doi: 'https://doi.org/10.7717/peerj.4375', title: 'The state of OA', publication_year: 2018, publication_date: '2018-02-13', type: 'article',
      cited_by_count: 1200, fwci: 20.1, is_oa: true, oa_status: 'gold', oa_url: 'https://peerj.com/articles/4375.pdf', source: 'PeerJ', authors: ['Heather Piwowar', 'Jason Priem'], primary_topic: 'Open access',
    });
    expect(tool('openalex_get_work').responseMapping).toBeUndefined();
  });

  it('returns group counts as key, name and count', () => {
    const out = applyResponseTransform(
      { meta: { count: 10, groups_count: 2, cost_usd: 0.0001 }, group_by: [{ key: '2024', key_display_name: '2024', count: 7 }, { key: '2025', key_display_name: '2025', count: 3 }] },
      tool('openalex_group_by').responseMapping as never,
    ).value;
    expect(out).toEqual({ count: 10, groups_count: 2, cost_usd: 0.0001, groups: [{ key: '2024', name: '2024', count: 7 }, { key: '2025', name: '2025', count: 3 }] });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('is read-only: every tool is a GET marked read-only and installs enabled', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('openalex_search_topics');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toContain(KEY);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_OPENALEX_LIVE === '1' ? describe : describe.skip;
live('openalex adapter: live (read-only)', () => {
  const base = 'https://api.openalex.org';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env[KEY]) headers.Authorization = `Bearer ${process.env[KEY]}`;
  const getJson = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers });
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  };

  it('reads a work by DOI, an author by ORCID and a topic list', async () => {
    const work = (await getJson('/works/doi:10.7717/peerj.4375?select=id,display_name,publication_year')) as { id: string; publication_year: number };
    expect(work).toMatchObject({ id: 'https://openalex.org/W2741809807', publication_year: 2018 });
    const author = (await getJson('/authors/orcid:0000-0003-1613-5981?select=id,display_name')) as { id: string };
    expect(author.id).toMatch(/^https:\/\/openalex\.org\/A\d+$/);
    const topics = await getJson('/topics?per_page=2');
    const shaped = applyResponseTransform(topics, tool('openalex_search_topics').responseMapping as never).value as { meta: { count: number }; results: Array<{ id: string; field: string }> };
    expect(shaped.meta.count).toBeGreaterThan(4000);
    expect(shaped.results[0].id).toMatch(/\/T\d+$/);
    expect(typeof shaped.results[0].field).toBe('string');
  }, 60_000);

  it('searches works, autocompletes an institution and counts works by year', async () => {
    const works = await getJson('/works?search=open%20access%20prevalence&per_page=2');
    const rows = applyResponseTransform(works, tool('openalex_search_works').responseMapping as never).value as { results: Array<{ id: string; authors: unknown[] }> };
    expect(rows.results.length).toBe(2);
    expect(Array.isArray(rows.results[0].authors)).toBe(true);
    const ac = await getJson('/autocomplete/institutions?q=massachusetts%20institute');
    const acRows = applyResponseTransform(ac, tool('openalex_autocomplete').responseMapping as never).value as { results: Array<{ id: string; external_id: string }> };
    expect(acRows.results[0].id).toMatch(/\/I\d+$/);
    const groups = await getJson('/works?group_by=publication_year&filter=authorships.institutions.id:I63966007,publication_year:2020-2022');
    const g = applyResponseTransform(groups, tool('openalex_group_by').responseMapping as never).value as { groups: Array<{ key: string; count: number }> };
    expect(g.groups.map((x) => x.key).sort()).toEqual(['2020', '2021', '2022']);
  }, 60_000);
});
