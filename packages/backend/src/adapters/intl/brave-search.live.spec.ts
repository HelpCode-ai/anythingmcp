import * as adapter from './brave-search.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Brave Search API (api-dashboard.search.brave.com/llms.txt, API reference per endpoint):
 * X-Subscription-Token header on https://api.search.brave.com/res/v1/<endpoint>.
 * Live part: RUN_BRAVE_SEARCH_LIVE=1 BRAVE_SEARCH_API_KEY=... npx jest src/adapters/intl/brave-search
 * (reads only, 2 billed requests: one LLM Context call and one web search with 1 result).
 * Without a key, RUN_BRAVE_SEARCH_LIVE=1 only checks that the API asks for the token.
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { default?: unknown; enum?: unknown[]; maximum?: number; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
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
const PREFIX = 'brave_search_';

describe('brave-search adapter: static spec conformance', () => {
  it('sends the key in X-Subscription-Token to api.search.brave.com/res/v1', () => {
    expect(a.slug).toBe('brave-search');
    expect(a.icon).toBe('brave');
    expect(a.requiredEnvVars).toEqual(['BRAVE_SEARCH_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.search.brave.com/res/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Subscription-Token', apiKey: '{{BRAVE_SEARCH_API_KEY}}' });
    expect(a.envVarMeta?.BRAVE_SEARCH_API_KEY.secret).toBe(true);
  });

  it('maps the documented endpoints', () => {
    const routes: Record<string, [string, string]> = {
      brave_search_llm_context: ['GET', '/llm/context'],
      brave_search_web: ['GET', '/web/search'],
      brave_search_news: ['GET', '/news/search'],
      brave_search_images: ['GET', '/images/search'],
      brave_search_videos: ['GET', '/videos/search'],
      brave_search_suggest: ['GET', '/suggest/search'],
      brave_search_spellcheck: ['GET', '/spellcheck/search'],
      brave_search_places: ['GET', '/local/place_search'],
      brave_search_get_pois: ['GET', '/local/pois'],
      brave_search_get_poi_descriptions: ['GET', '/local/descriptions'],
      brave_search_get_rich_result: ['GET', '/web/rich'],
      brave_search_answer: ['POST', '/chat/completions'],
    };
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(routes).sort());
    for (const [name, [method, path]] of Object.entries(routes)) expect(tool(name).endpointMapping).toMatchObject({ method, path });
  });

  it('passes the LLM Context options with documented bounds and a moderate token budget', () => {
    const t = tool('brave_search_llm_context');
    expect(t.endpointMapping.queryParams).toMatchObject({ q: '$q', freshness: '$freshness', count: '$count', maximum_number_of_tokens: '$maximum_number_of_tokens', maximum_number_of_urls: '$maximum_number_of_urls', context_threshold_mode: '$context_threshold_mode', enable_local: '$enable_local' });
    const p = t.parameters?.properties ?? {};
    expect(p.maximum_number_of_tokens).toMatchObject({ default: 4096, maximum: 32768 });
    expect(p.count.maximum).toBe(50);
    expect(p.context_threshold_mode.enum).toEqual(['disabled', 'strict', 'lenient', 'balanced']);
    expect(t.parameters?.required).toEqual(['q']);
  });

  it('keeps the documented page sizes of each vertical', () => {
    expect(tool('brave_search_web').parameters?.properties?.count.maximum).toBe(20);
    expect(tool('brave_search_web').parameters?.properties?.offset.maximum).toBe(9);
    expect(tool('brave_search_news').parameters?.properties?.count.maximum).toBe(50);
    expect(tool('brave_search_videos').parameters?.properties?.count.maximum).toBe(50);
    expect(tool('brave_search_images').parameters?.properties?.count.maximum).toBe(200);
    expect(tool('brave_search_images').parameters?.properties?.safesearch.enum).toEqual(['off', 'strict']);
    expect(tool('brave_search_images').endpointMapping.queryParams).not.toHaveProperty('offset');
    expect(tool('brave_search_suggest').parameters?.properties?.count.maximum).toBe(20);
    expect(tool('brave_search_get_pois').parameters?.properties?.ids.type).toBe('array');
  });

  it('asks Answers for a single non-streamed user message', () => {
    expect(tool('brave_search_answer').endpointMapping.bodyMapping).toEqual({
      messages: [{ role: 'user', content: '$question' }],
      model: '$model',
      country: '$country',
      language: '$language',
      safesearch: '$safesearch',
      max_completion_tokens: '$max_completion_tokens',
      stream: false,
    });
  });

  it('slims a web search page to the fields a model reads', () => {
    const out = applyResponseTransform(
      {
        type: 'search',
        query: { original: 'brave serach', altered: 'brave search', more_results_available: true, is_navigational: false },
        web: { type: 'search', results: [{ title: 'Brave Search', url: 'https://search.brave.com/', description: 'Private search', age: '2 days ago', profile: { img: 'x' }, meta_url: { favicon: 'f' }, thumbnail: { src: 't' } }] },
        news: { results: [{ title: 'N', url: 'https://n.example/', description: 'd', age: '1 hour ago', meta_url: { hostname: 'n.example' } }] },
        locations: { results: [{ id: 'loc1', title: 'Cafe', postal_address: { displayAddress: '1 Main St' }, rating: { ratingValue: 4.5 }, coordinates: [1, 2] }] },
        rich: { hint: { callback_key: 'k1', vertical: 'weather' } },
        mixed: { main: [] },
      },
      tool('brave_search_web').responseMapping as never,
    ).value as Record<string, unknown>;
    expect(out.query).toEqual({ original: 'brave serach', altered: 'brave search', more_results_available: true });
    expect(out.web).toEqual([{ title: 'Brave Search', url: 'https://search.brave.com/', description: 'Private search', age: '2 days ago' }]);
    expect(out.news).toEqual([{ title: 'N', url: 'https://n.example/', description: 'd', age: '1 hour ago', source: 'n.example' }]);
    expect(out.locations).toEqual([{ id: 'loc1', title: 'Cafe', address: '1 Main St', rating: 4.5, coordinates: [1, 2] }]);
    expect(out.rich).toEqual({ hint: { callback_key: 'k1', vertical: 'weather' } });
    expect(JSON.stringify(out)).not.toMatch(/mixed|profile|favicon/);
  });

  it('slims image and video results', () => {
    const img = applyResponseTransform(
      { query: { original: 'cat' }, results: [{ title: 'A cat', url: 'https://p.example/', source: 'p.example', thumbnail: { src: 'https://t/' }, properties: { url: 'https://i/cat.jpg', width: 800, height: 600, placeholder: 'x' } }] },
      tool('brave_search_images').responseMapping as never,
    ).value as { results: unknown[] };
    expect(img.results[0]).toEqual({ title: 'A cat', page_url: 'https://p.example/', source: 'p.example', image_url: 'https://i/cat.jpg', thumbnail: 'https://t/', width: 800, height: 600 });
    const vid = applyResponseTransform(
      { query: { original: 'x' }, results: [{ title: 'V', url: 'https://v/', description: 'd', age: 'May 1', video: { duration: '03:10', creator: 'C', publisher: 'YouTube', views: 10 }, thumbnail: { src: 'https://t/' } }] },
      tool('brave_search_videos').responseMapping as never,
    ).value as { results: unknown[] };
    expect(vid.results[0]).toEqual({ title: 'V', url: 'https://v/', description: 'd', age: 'May 1', duration: '03:10', creator: 'C', publisher: 'YouTube', views: 10, thumbnail: 'https://t/' });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('is read-only: GETs and the POST answer tool are all marked read-only and install enabled', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.name !== 'brave_search_answer') expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    }
  });

  it('probes with a one-result web search and documents every tool in the instructions', () => {
    expect(a.probe).toEqual({ tool: 'brave_search_web', params: { q: 'brave search api', count: 1 } });
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const liveOn = process.env.RUN_BRAVE_SEARCH_LIVE === '1';
const live = liveOn ? describe : describe.skip;
live('brave-search adapter: live (read-only)', () => {
  const base = 'https://api.search.brave.com/res/v1';

  it('asks for the subscription token when none is sent', async () => {
    const res = await fetch(`${base}/web/search?q=brave`, { headers: { Accept: 'application/json' } });
    expect([401, 403, 422]).toContain(res.status);
  }, 30_000);

  (process.env.BRAVE_SEARCH_API_KEY ? it : it.skip)('runs one LLM Context call and one web search', async () => {
    const headers = { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY as string };
    const ctx = await fetch(`${base}/llm/context?${new URLSearchParams({ q: 'what is the capital of france', maximum_number_of_tokens: '1024', count: '3' })}`, { headers });
    expect(ctx.status).toBe(200);
    const body = (await ctx.json()) as { grounding: { generic: Array<{ url: string; snippets: string[] }> } };
    expect(body.grounding.generic.length).toBeGreaterThan(0);
    const web = await fetch(`${base}/web/search?${new URLSearchParams({ q: 'brave search api', count: '1' })}`, { headers });
    expect(web.status).toBe(200);
    const shaped = applyResponseTransform(await web.json(), tool('brave_search_web').responseMapping as never).value as { web: Array<{ url: string }> };
    expect(shaped.web[0].url).toMatch(/^https?:\/\//);
  }, 60_000);
});
