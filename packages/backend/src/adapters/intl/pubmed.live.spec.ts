import * as adapter from './pubmed.json';

/**
 * NCBI E-utilities (https://www.ncbi.nlm.nih.gov/books/NBK25499/): esearch, esummary, efetch, elink, einfo, espell,
 * ecitmatch; plus the PMC ID Converter (pmc.ncbi.nlm.nih.gov/tools/idconv) and the BioC full-text service.
 * Keyless (3 requests per second). The optional NCBI_API_KEY goes out as the api_key query parameter, written
 * "${NCBI_API_KEY}" so that the parameter is left out when the variable is not set.
 * Live part (keyless, five calls, paced): RUN_PUBMED_LIVE=1 npx jest src/adapters/intl/pubmed
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
const SLUG = 'pubmed';
const REGION = 'intl';
const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const PREFIX = 'pubmed_';
const ENV_VARS: string[] = ['NCBI_API_KEY'];
// Tools installed switched off.
const OFF: string[] = [];
// name: [method, path, required arguments]
const TOOLS: Record<string, [string, string, string[]]> = {
  pubmed_search: ['GET', '/esearch.fcgi', ['term']],
  pubmed_get_summaries: ['GET', '/esummary.fcgi', ['id']],
  pubmed_fetch_abstracts: ['GET', '/efetch.fcgi', ['id']],
  pubmed_fetch_article_details: ['GET', '/efetch.fcgi', ['id']],
  pubmed_list_similar_articles: ['GET', '/elink.fcgi', ['id']],
  pubmed_list_citing_articles: ['GET', '/elink.fcgi', ['id']],
  pubmed_list_references: ['GET', '/elink.fcgi', ['id']],
  pubmed_get_full_text_links: ['GET', '/elink.fcgi', ['id']],
  pubmed_get_links: ['GET', '/elink.fcgi', ['id']],
  pubmed_check_spelling: ['GET', '/espell.fcgi', ['term']],
  pubmed_match_citations: ['GET', '/ecitmatch.cgi', ['citations']],
  pubmed_list_databases: ['GET', '/einfo.fcgi', []],
  pubmed_get_database_info: ['GET', '/einfo.fcgi', ['db']],
  pubmed_convert_ids: ['GET', 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/', ['ids']],
  pubmed_get_pmc_full_text: ['GET', 'https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/{article_id}/unicode', ['article_id']],
};

describe('pubmed adapter: static spec conformance', () => {
  it('has the expected envelope and authentication', () => {
    expect(a.slug).toBe(SLUG);
    expect(a.region).toBe(REGION);
    expect(a.icon).toBe(SLUG);
    expect(a.category).toBe('data');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars ?? []).toEqual(['NCBI_API_KEY']);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.envVarMeta?.NCBI_API_KEY).toMatchObject({ secret: true, kind: 'credential' });
    expect(new RegExp(a.envVarMeta?.NCBI_API_KEY.pattern ?? '').test('0123456789abcdef0123456789abcdef0123')).toBe(true);
    // The key is optional: it must never sit in a connector header, where an empty value would go out as {{VAR}}.
    expect(JSON.stringify(a.connector)).not.toContain('NCBI_API_KEY');
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

  it('is read-only and sends the optional key only to the E-utilities, as a parameter that drops out when unset', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      const q = (t.endpointMapping.queryParams ?? {}) as Record<string, unknown>;
      const onEutils = !t.endpointMapping.path.startsWith('https://');
      expect(`${t.name}:${q.api_key}`).toBe(`${t.name}:${onEutils ? '${NCBI_API_KEY}' : undefined}`);
      if (onEutils) expect(`${t.name}:${q.tool}`).toBe(`${t.name}:AnythingMCP`);
    }
    expect(a.tools.filter((t) => t.endpointMapping.path.startsWith('https://')).map((t) => t.name).sort()).toEqual(['pubmed_convert_ids', 'pubmed_get_pmc_full_text']);
  });

  it('fixes the E-utilities parameters each tool depends on', () => {
    expect(tool('pubmed_search').endpointMapping.queryParams).toMatchObject({ db: '$db', term: '$term', retmode: 'json', retmax: '$retmax', retstart: '$retstart', sort: '$sort', datetype: '$datetype', mindate: '$mindate', maxdate: '$maxdate', reldate: '$reldate' });
    expect(tool('pubmed_search').parameters?.properties?.db.default).toBe('pubmed');
    expect(tool('pubmed_get_summaries').endpointMapping.queryParams).toMatchObject({ db: '$db', id: '$id', retmode: 'json' });
    expect(tool('pubmed_fetch_abstracts').endpointMapping.queryParams).toMatchObject({ db: 'pubmed', id: '$id', rettype: '$format', retmode: 'text' });
    expect(tool('pubmed_fetch_abstracts').parameters?.properties?.format).toMatchObject({ enum: ['abstract', 'medline'], default: 'abstract' });
    expect(tool('pubmed_fetch_article_details').endpointMapping.queryParams).toMatchObject({ db: 'pubmed', retmode: 'xml' });
    expect(tool('pubmed_list_similar_articles').endpointMapping.queryParams).toMatchObject({ dbfrom: 'pubmed', db: 'pubmed', cmd: 'neighbor_score', retmode: 'json' });
    expect(tool('pubmed_list_citing_articles').endpointMapping.queryParams).toMatchObject({ linkname: 'pubmed_pubmed_citedin' });
    expect(tool('pubmed_list_references').endpointMapping.queryParams).toMatchObject({ linkname: 'pubmed_pubmed_refs' });
    expect(tool('pubmed_get_full_text_links').endpointMapping.queryParams).toMatchObject({ cmd: '$scope', dbfrom: 'pubmed' });
    expect(tool('pubmed_match_citations').endpointMapping.queryParams).toMatchObject({ bdata: '$citations', db: 'pubmed' });
    expect(tool('pubmed_convert_ids').endpointMapping.queryParams).toEqual({ format: 'json', tool: 'AnythingMCP', ids: '$ids', idtype: '$idtype' });
    expect(a.connector.config?.errorWhen).toEqual([{ path: 'esearchresult.ERROR', messagePath: 'esearchresult.ERROR', status: 400 }]);
  });
});

const live = process.env.RUN_PUBMED_LIVE === '1' ? describe : describe.skip;
live('pubmed adapter: live (keyless, read-only, under 3 requests per second)', () => {
  const pause = () => new Promise((r) => setTimeout(r, 500));
  const key = process.env.NCBI_API_KEY ? `&api_key=${process.env.NCBI_API_KEY}` : '';
  const get = (path: string) => fetch(`${BASE}${path}&tool=AnythingMCP${key}`, { headers: { 'User-Agent': 'AnythingMCP' } });
  it('searches, summarises, fetches an abstract, follows links and converts ids', async () => {
    const search = (await (await get('/esearch.fcgi?db=pubmed&term=genbank%5Bti%5D+AND+2013%5Bdp%5D&retmode=json&retmax=5')).json()) as { esearchresult: { count: string; idlist: string[] } };
    expect(Number(search.esearchresult.count)).toBeGreaterThan(0);
    await pause();
    const sum = (await (await get('/esummary.fcgi?db=pubmed&id=23193287&retmode=json')).json()) as { result: Record<string, { title: string; source: string }> };
    expect(sum.result['23193287'].title).toBe('GenBank.');
    await pause();
    const abs = await (await get('/efetch.fcgi?db=pubmed&id=23193287&rettype=abstract&retmode=text')).text();
    expect(abs).toContain('PMID: 23193287');
    await pause();
    const links = (await (await get('/elink.fcgi?dbfrom=pubmed&linkname=pubmed_pmc&id=23193287&retmode=json')).json()) as { linksets: { linksetdbs: { links: string[] }[] }[] };
    expect(links.linksets[0].linksetdbs[0].links).toContain('3531190');
    await pause();
    const bad = (await (await get('/esearch.fcgi?db=nosuchdb&term=x&retmode=json')).json()) as { esearchresult: { ERROR?: string } };
    expect(bad.esearchresult.ERROR).toContain('Invalid db name');
    const conv = (await (await fetch('https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=PMC3531190&format=json&tool=AnythingMCP')).json()) as { records: { pmid: number; doi: string }[] };
    expect(String(conv.records[0].pmid)).toBe('23193287');
  }, 60_000);
});
