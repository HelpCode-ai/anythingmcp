import * as adapter from './semantic-scholar.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Semantic Scholar APIs (api.semanticscholar.org/api-docs/): Academic Graph under
 * /graph/v1, Recommendations under /recommendations/v1, Datasets under /datasets/v1.
 * Keyless calls share one public pool; an optional key goes in the x-api-key header.
 * Live part: RUN_SEMANTIC_SCHOLAR_LIVE=1 [SEMANTIC_SCHOLAR_API_KEY=...] npx jest src/adapters/intl/semantic-scholar
 * (reads only: a title match, a paper by DOI, its citations, an author search, recommendations, dataset releases).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { default?: unknown; enum?: unknown[]; maximum?: number; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, unknown> };
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
const KEY = 'SEMANTIC_SCHOLAR_API_KEY';
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
const PREFIX = 'semantic_scholar_';

describe('semantic-scholar adapter: static spec conformance', () => {
  it('calls api.semanticscholar.org without required credentials and sends the optional key as x-api-key', () => {
    expect(a.slug).toBe('semantic-scholar');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('data');
    expect(a.icon).toBe('semantic-scholar');
    expect(a.docsUrl).toBe('https://api.semanticscholar.org/api-docs/');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars).toEqual([KEY]);
    expect(a.connector.baseUrl).toBe('https://api.semanticscholar.org');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.envVarMeta?.[KEY]).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta?.[KEY].pattern as string);
    expect(pattern.test(['abcDEF', '0123456789', 'abcdefghij', 'KLMNOP'].join(''))).toBe(true);
    expect(pattern.test('has a space in it 0123456789')).toBe(false);
    // The header is templated so it is left out when no key is set.
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.headers?.['x-api-key']}`).toBe(`${t.name}:\${${KEY}}`);
  });

  it('maps the documented Graph, Recommendations and Datasets routes', () => {
    const routes: Record<string, [string, string]> = {
      semantic_scholar_search_papers: ['GET', '/graph/v1/paper/search'],
      semantic_scholar_bulk_search_papers: ['GET', '/graph/v1/paper/search/bulk'],
      semantic_scholar_match_paper_title: ['GET', '/graph/v1/paper/search/match'],
      semantic_scholar_autocomplete_papers: ['GET', '/graph/v1/paper/autocomplete'],
      semantic_scholar_get_paper: ['GET', '/graph/v1/paper/{paper_id}'],
      semantic_scholar_get_papers_batch: ['POST', '/graph/v1/paper/batch'],
      semantic_scholar_get_paper_authors: ['GET', '/graph/v1/paper/{paper_id}/authors'],
      semantic_scholar_get_paper_citations: ['GET', '/graph/v1/paper/{paper_id}/citations'],
      semantic_scholar_get_paper_references: ['GET', '/graph/v1/paper/{paper_id}/references'],
      semantic_scholar_search_authors: ['GET', '/graph/v1/author/search'],
      semantic_scholar_get_author: ['GET', '/graph/v1/author/{author_id}'],
      semantic_scholar_get_authors_batch: ['POST', '/graph/v1/author/batch'],
      semantic_scholar_get_author_papers: ['GET', '/graph/v1/author/{author_id}/papers'],
      semantic_scholar_recommend_for_paper: ['GET', '/recommendations/v1/papers/forpaper/{paper_id}'],
      semantic_scholar_recommend_papers: ['POST', '/recommendations/v1/papers/'],
      semantic_scholar_search_snippets: ['GET', '/graph/v1/snippet/search'],
      semantic_scholar_list_dataset_releases: ['GET', '/datasets/v1/release/'],
      semantic_scholar_get_dataset_release: ['GET', '/datasets/v1/release/{release_id}'],
    };
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(routes).sort());
    for (const [name, [method, path]] of Object.entries(routes)) expect(tool(name).endpointMapping).toMatchObject({ method, path });
  });

  it('sends the documented query and body fields', () => {
    expect(tool('semantic_scholar_search_papers').endpointMapping.queryParams).toEqual({
      query: '$query', fields: '$fields', publicationTypes: '$publicationTypes', openAccessPdf: '$openAccessPdf', minCitationCount: '$minCitationCount',
      publicationDateOrYear: '$publicationDateOrYear', year: '$year', venue: '$venue', fieldsOfStudy: '$fieldsOfStudy', offset: '$offset', limit: '$limit',
    });
    expect(tool('semantic_scholar_search_papers').parameters?.properties?.limit.maximum).toBe(100);
    expect(tool('semantic_scholar_bulk_search_papers').endpointMapping.queryParams).toMatchObject({ query: '$query', token: '$token', sort: '$sort' });
    // Batch and recommendation reads put the ids in the JSON body and fields in the query string.
    expect(tool('semantic_scholar_get_papers_batch').endpointMapping).toMatchObject({ bodyMapping: { ids: '$ids' }, queryParams: { fields: '$fields' } });
    expect(tool('semantic_scholar_get_papers_batch').parameters?.properties?.ids.type).toBe('array');
    expect(tool('semantic_scholar_get_authors_batch').endpointMapping).toMatchObject({ bodyMapping: { ids: '$ids' }, queryParams: { fields: '$fields' } });
    expect(tool('semantic_scholar_recommend_papers').endpointMapping).toMatchObject({
      bodyMapping: { positivePaperIds: '$positivePaperIds', negativePaperIds: '$negativePaperIds' },
      queryParams: { fields: '$fields', limit: '$limit' },
    });
    expect(tool('semantic_scholar_recommend_for_paper').parameters?.properties?.from.enum).toEqual(['recent', 'all-cs']);
    expect(tool('semantic_scholar_search_snippets').endpointMapping.queryParams).toMatchObject({ query: '$query', paperIds: '$paperIds', authors: '$authors', insertedBefore: '$insertedBefore' });
    // A compact default field list keeps answers small.
    expect(tool('semantic_scholar_get_paper').parameters?.properties?.fields.default).toContain('abstract');
    expect(tool('semantic_scholar_get_dataset_release').parameters?.properties?.release_id.default).toBe('latest');
  });

  it('drops the long READMEs from a dataset release', () => {
    const out = applyResponseTransform(
      { release_id: '2026-10-27', README: 'long text', datasets: [{ name: 'papers', description: 'Core paper metadata', README: 'long text' }] },
      tool('semantic_scholar_get_dataset_release').responseMapping as never,
    ).value;
    expect(out).toEqual({ release_id: '2026-10-27', datasets: [{ name: 'papers', description: 'Core paper metadata' }] });
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

  it('is read-only: every tool is marked read-only, installs enabled and only the batch and recommendation reads use POST', () => {
    const posts = a.tools.filter((t) => t.endpointMapping.method === 'POST').map((t) => t.name).sort();
    expect(posts).toEqual(['semantic_scholar_get_authors_batch', 'semantic_scholar_get_papers_batch', 'semantic_scholar_recommend_papers']);
    for (const t of a.tools) {
      expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:undefined`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('semantic_scholar_list_dataset_releases');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toContain(KEY);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_SEMANTIC_SCHOLAR_LIVE === '1' ? describe : describe.skip;
live('semantic-scholar adapter: live (read-only)', () => {
  const base = 'https://api.semanticscholar.org';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env[KEY]) headers['x-api-key'] = process.env[KEY] as string;
  // The keyless pool answers 429 when busy: retry a few times with a pause.
  const getJson = async (path: string) => {
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}${path}`, { headers });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      expect(res.status).toBe(200);
      return res.json() as Promise<Record<string, unknown>>;
    }
    throw new Error(`still rate limited: ${path}`);
  };

  it('matches a title, reads the paper by DOI, its citations, an author and recommendations', async () => {
    const match = (await getJson('/graph/v1/paper/search/match?query=Construction%20of%20the%20Literature%20Graph%20in%20Semantic%20Scholar')) as { data: Array<{ paperId: string }> };
    expect(match.data[0].paperId).toBe('649def34f8be52c8b66281af98ae884c09aef38b');
    const paper = (await getJson('/graph/v1/paper/DOI:10.18653/v1/N18-3011?fields=title,year,externalIds')) as { paperId: string; year: number };
    expect(paper).toMatchObject({ paperId: '649def34f8be52c8b66281af98ae884c09aef38b', year: 2018 });
    const cites = (await getJson('/graph/v1/paper/649def34f8be52c8b66281af98ae884c09aef38b/citations?limit=2&fields=title,isInfluential')) as { data: Array<{ citingPaper: { paperId: string } }> };
    expect(cites.data.length).toBeGreaterThan(0);
    expect(cites.data[0].citingPaper.paperId).toMatch(/^[0-9a-f]{40}$/);
    const authors = (await getJson('/graph/v1/author/search?query=oren%20etzioni&limit=1&fields=name,hIndex')) as { data: Array<{ authorId: string }> };
    expect(authors.data[0].authorId).toMatch(/^\d+$/);
    const recs = (await getJson('/recommendations/v1/papers/forpaper/649def34f8be52c8b66281af98ae884c09aef38b?limit=2')) as { recommendedPapers: unknown[] };
    expect(Array.isArray(recs.recommendedPapers)).toBe(true);
  }, 180_000);

  it('lists dataset releases and the datasets of the latest one', async () => {
    const releases = (await getJson('/datasets/v1/release/')) as unknown as string[];
    expect(releases[releases.length - 1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const latest = await getJson('/datasets/v1/release/latest');
    const shaped = applyResponseTransform(latest, tool('semantic_scholar_get_dataset_release').responseMapping as never).value as { datasets: Array<{ name: string }> };
    expect(shaped.datasets.map((d) => d.name)).toContain('papers');
  }, 120_000);
});
