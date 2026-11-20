import * as adapter from './event-registry.json';

/**
 * Event Registry REST API, sold as NewsAPI.ai (https://newsapi.ai/documentation, OpenAPI at
 * https://eventregistry.org/static/api.yaml). Query authentication with the apiKey parameter. A different vendor
 * from intl/newsapi.json (NewsAPI.org).
 * The trends call (/api/v1/trends) and the usage call (/api/v1/usage) are not in the OpenAPI file; they are taken
 * from the vendor's own Python SDK (github.com/EventRegistry/event-registry-python).
 * Live part: RUN_EVENT_REGISTRY_LIVE=1 EVENT_REGISTRY_API_KEY=... npx jest src/adapters/intl/event-registry
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
const SLUG = 'event-registry';
const REGION = 'intl';
const BASE = 'https://eventregistry.org';
const PREFIX = 'event_registry_';
const ENV_VARS: string[] = ['EVENT_REGISTRY_API_KEY'];
// Tools installed switched off.
const OFF: string[] = [];
// name: [method, path, required arguments]
const TOOLS: Record<string, [string, string, string[]]> = {
  event_registry_search_articles: ['GET', '/api/v1/article/getArticles', []],
  event_registry_summarize_articles: ['GET', '/api/v1/article/getArticles', ['result_type']],
  event_registry_get_article: ['GET', '/api/v1/article/getArticle', ['article_uri']],
  event_registry_map_article_url: ['GET', '/api/v1/articleMapper', ['article_url']],
  event_registry_get_recent_articles: ['GET', '/api/v1/minuteStreamArticles', []],
  event_registry_search_events: ['GET', '/api/v1/event/getEvents', []],
  event_registry_get_event: ['GET', '/api/v1/event/getEvent', ['event_uri']],
  event_registry_get_event_articles: ['GET', '/api/v1/event/getEvent', ['event_uri']],
  event_registry_get_breaking_events: ['GET', '/api/v1/event/getBreakingEvents', []],
  event_registry_get_recent_events: ['GET', '/api/v1/minuteStreamEvents', []],
  event_registry_find_events_for_text: ['GET', '/api/v1/getEventForText', ['text']],
  event_registry_suggest_concepts: ['GET', '/api/v1/suggestConceptsFast', ['prefix']],
  event_registry_suggest_categories: ['GET', '/api/v1/suggestCategoriesFast', ['prefix']],
  event_registry_suggest_sources: ['GET', '/api/v1/suggestSourcesFast', ['prefix']],
  event_registry_suggest_locations: ['GET', '/api/v1/suggestLocationsFast', ['prefix']],
  event_registry_suggest_authors: ['GET', '/api/v1/suggestAuthorsFast', ['prefix']],
  event_registry_get_trending_concepts: ['GET', '/api/v1/trends', []],
  event_registry_extract_article_info: ['GET', 'https://analytics.eventregistry.org/api/v1/extractArticleInfo', ['url']],
  event_registry_get_usage: ['GET', '/api/v1/usage', []],
};

describe('event-registry adapter: static spec conformance', () => {
  it('has the expected envelope and authentication', () => {
    expect(a.slug).toBe(SLUG);
    expect(a.region).toBe(REGION);
    expect(a.icon).toBe(SLUG);
    expect(a.category).toBe('data');
    expect(a.requiredEnvVars).toEqual(['EVENT_REGISTRY_API_KEY']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ apiKey: '{{EVENT_REGISTRY_API_KEY}}' });
    expect(a.envVarMeta?.EVENT_REGISTRY_API_KEY).toMatchObject({ secret: true, kind: 'credential' });
    expect(a.description).toContain('NewsAPI.org');
    expect(a.aliases).toContain('NewsAPI.ai');
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

  it('is read-only, never maps the key itself and stays on the vendor hosts', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(Object.keys(t.endpointMapping.queryParams ?? {})).not.toContain('apiKey');
      if (t.endpointMapping.path.startsWith('https://')) expect(new URL(t.endpointMapping.path).host).toBe('analytics.eventregistry.org');
    }
    expect(tool('event_registry_get_usage').endpointMapping.queryParams).toBeUndefined();
  });

  it('covers the endpoints in use with the documented parameter names', () => {
    const q = (name: string) => tool(name).endpointMapping.queryParams as Record<string, unknown>;
    expect(q('event_registry_search_articles')).toMatchObject({ resultType: 'articles', keyword: '$keyword', conceptUri: '$concept_uri', categoryUri: '$category_uri', sourceUri: '$source_uri', lang: '$lang', dateStart: '$date_start', dateEnd: '$date_end', articlesPage: '$articles_page', articlesCount: '$articles_count', articlesSortBy: '$articles_sort_by', articleBodyLen: '$article_body_len', isDuplicateFilter: '$is_duplicate_filter' });
    expect(q('event_registry_summarize_articles')).toMatchObject({ resultType: '$result_type', keyword: '$keyword' });
    expect(q('event_registry_get_article')).toMatchObject({ articleUri: '$article_uri', infoArticleBodyLen: '$article_body_len' });
    expect(q('event_registry_map_article_url')).toMatchObject({ articleUrl: '$article_url' });
    expect(q('event_registry_search_events')).toMatchObject({ resultType: 'events', eventsPage: '$events_page', eventsCount: '$events_count', eventsSortBy: '$events_sort_by', minArticlesInEvent: '$min_articles_in_event' });
    expect(q('event_registry_get_event')).toEqual({ resultType: 'info', eventUri: '$event_uri' });
    expect(q('event_registry_get_event_articles')).toMatchObject({ resultType: 'articles', eventUri: '$event_uri', articlesPage: '$articles_page', articlesCount: '$articles_count' });
    expect(q('event_registry_get_recent_articles')).toMatchObject({ recentActivityArticlesMaxArticleCount: '$max_article_count', recentActivityArticlesUpdatesAfterMinsAgo: '$updates_after_mins_ago' });
    expect(q('event_registry_get_trending_concepts')).toEqual({ action: 'getTrendingConcepts', source: '$source', dataType: '$source', conceptCount: '$concept_count', conceptType: '$concept_type' });
    for (const s of ['concepts', 'categories', 'sources', 'locations', 'authors']) {
      const t = tool(`event_registry_suggest_${s}`);
      expect(t.endpointMapping.path).toBe(`/api/v1/suggest${s[0].toUpperCase()}${s.slice(1)}Fast`);
      expect(t.endpointMapping.queryParams).toMatchObject({ prefix: '$prefix' });
    }
  });

  it('declares list filters as arrays and caps the page sizes as the API does', () => {
    const p = tool('event_registry_search_articles').parameters?.properties ?? {};
    for (const k of ['keyword', 'concept_uri', 'category_uri', 'source_uri', 'lang', 'ignore_keyword']) expect(`${k}:${p[k].type}`).toBe(`${k}:array`);
    expect(p.articles_count).toMatchObject({ maximum: 100 });
    expect(tool('event_registry_search_events').parameters?.properties?.events_count).toMatchObject({ maximum: 50 });
    expect(tool('event_registry_get_recent_articles').parameters?.properties?.updates_after_mins_ago).toMatchObject({ maximum: 240 });
    expect(a.probe).toEqual({ tool: 'event_registry_get_usage', params: {} });
  });
});

const live = process.env.RUN_EVENT_REGISTRY_LIVE === '1' && process.env.EVENT_REGISTRY_API_KEY ? describe : describe.skip;
live('event-registry adapter: live (read-only, uses about 2 tokens)', () => {
  const key = encodeURIComponent(process.env.EVENT_REGISTRY_API_KEY ?? '');
  const get = async (path: string) => (await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}apiKey=${key}`, { headers: { Accept: 'application/json' } })).json();
  it('reads the usage, suggests a concept and searches recent articles', async () => {
    const usage = (await get('/api/v1/usage')) as { availableTokens: number; usedTokens: number };
    expect(typeof usage.availableTokens).toBe('number');
    const concepts = (await get('/api/v1/suggestConceptsFast?prefix=tesla&lang=eng')) as { uri: string }[];
    expect(concepts.some((c) => c.uri.includes('wikipedia.org/wiki/Tesla'))).toBe(true);
    const found = (await get('/api/v1/article/getArticles?resultType=articles&keyword=tesla&lang=eng&articlesCount=2&articleBodyLen=200')) as { articles: { results: { uri: string; title: string }[]; totalResults: number } };
    expect(found.articles.results.length).toBeGreaterThan(0);
    expect(found.articles.totalResults).toBeGreaterThan(0);
  }, 60_000);
});
