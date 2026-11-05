import * as adapter from './livedune.json';

/**
 * LiveDune API (reference https://api.livedune.com/docs, OpenAPI https://api.livedune.com/docs/openapi.json):
 * host https://api.livedune.com, personal token as the access_token query parameter, cursor paging with `after`.
 * Live part: LIVEDUNE_ACCESS_TOKEN=... RUN_LIVEDUNE_LIVE=1 npx jest src/adapters/intl/livedune
 * (reads only: tariff info, which costs no quota, and the dashboard accounts).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; bodyEncoding?: string };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
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
const PREFIX = 'livedune_';
const WRITES = [
  'livedune_add_account',
  'livedune_create_tag',
  'livedune_remove_account',
  'livedune_create_scheduled_post',
  'livedune_update_scheduled_post',
  'livedune_delete_scheduled_post',
];
const SWITCHED_OFF = ['livedune_add_account', 'livedune_remove_account', 'livedune_create_scheduled_post', 'livedune_update_scheduled_post', 'livedune_delete_scheduled_post'];

describe('livedune adapter: static spec conformance', () => {
  it('sends the token as the access_token query parameter to api.livedune.com', () => {
    expect(a.requiredEnvVars).toEqual(['LIVEDUNE_ACCESS_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.livedune.com');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ access_token: '{{LIVEDUNE_ACCESS_TOKEN}}' });
    expect(a.envVarMeta?.LIVEDUNE_ACCESS_TOKEN.secret).toBe(true);
    expect(a.probe?.tool).toBe('livedune_get_tariff_info');
    expect(tool('livedune_get_tariff_info').endpointMapping).toEqual({ method: 'GET', path: '/info' });
  });

  it('maps the dashboard and statistics routes', () => {
    expect(tool('livedune_list_projects').endpointMapping.path).toBe('/projects');
    expect(tool('livedune_list_accounts').endpointMapping).toEqual({ method: 'GET', path: '/accounts', queryParams: { after: '$after' } });
    expect(tool('livedune_list_tags').endpointMapping.path).toBe('/accounts/tags');
    expect(tool('livedune_search_account').endpointMapping).toEqual({ method: 'GET', path: '/search', queryParams: { url: '$url' } });
    expect(tool('livedune_get_account_analytics').endpointMapping).toEqual({ method: 'GET', path: '/accounts/{accountId}/analytics', queryParams: { date_from: '$date_from', date_to: '$date_to' } });
    for (const [n, p] of [
      ['livedune_get_account_history', '/accounts/{accountId}/history'],
      ['livedune_list_posts', '/accounts/{accountId}/posts'],
      ['livedune_list_videos', '/accounts/{accountId}/video'],
    ]) expect(tool(n).endpointMapping).toEqual({ method: 'GET', path: p, queryParams: { date_from: '$date_from', date_to: '$date_to', after: '$after' } });
    expect(tool('livedune_get_audience').endpointMapping).toMatchObject({ path: '/accounts/{accountId}/audience/{mode}' });
    expect((tool('livedune_get_audience').parameters?.properties?.mode as { enum: string[] }).enum).toEqual(['all', 'age', 'gender']);
    expect(tool('livedune_get_post_stats').endpointMapping.path).toBe('/accounts/{accountId}/posts/{post_id}');
    expect(tool('livedune_list_stories').endpointMapping).toMatchObject({ path: '/accounts/{accountId}/stories', queryParams: { limit: '$limit', after: '$after' } });
    expect(tool('livedune_get_video_stats').endpointMapping.path).toBe('/accounts/{accountId}/video/{video_id}');
    expect(tool('livedune_list_scheduled_posts').endpointMapping).toEqual({ method: 'GET', path: '/posting/{accountId}', queryParams: { after: '$after' } });
  });

  it('maps the writes as documented (header fields, query fields, multipart forms)', () => {
    expect(tool('livedune_add_account').endpointMapping).toEqual({ method: 'POST', path: '/accounts', headers: { name: '$name', social: '$social', project_id: '$project_id', tags: '$tags' } });
    expect(tool('livedune_create_tag').endpointMapping).toEqual({ method: 'POST', path: '/accounts/tags', queryParams: { tag: '$tag', color: '$color' } });
    expect(tool('livedune_remove_account').endpointMapping).toEqual({ method: 'DELETE', path: '/accounts', queryParams: { id: '$id' } });
    expect(tool('livedune_create_scheduled_post').endpointMapping).toMatchObject({ method: 'POST', path: '/posting/{accountId}', bodyEncoding: 'form-data', bodyMapping: { publication_time: '$publication_time', timezone: '$timezone' } });
    expect(tool('livedune_update_scheduled_post').endpointMapping).toMatchObject({ method: 'POST', path: '/posting/{accountId}/{postId}', bodyEncoding: 'form-data', bodyMapping: { status: '$status' } });
    expect(tool('livedune_delete_scheduled_post').endpointMapping).toEqual({ method: 'DELETE', path: '/posting/{accountId}/{postId}' });
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

  it('writes are annotated, publishing, plan-slot and delete tools installed switched off; reads are GET', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...SWITCHED_OFF].sort());
    for (const n of WRITES) expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:false`);
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) continue;
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(t.enabled).toBeUndefined();
    }
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const env = process.env;
const live = env.RUN_LIVEDUNE_LIVE === '1' && env.LIVEDUNE_ACCESS_TOKEN ? describe : describe.skip;
live('livedune adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const url = `${a.connector.baseUrl}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(env.LIVEDUNE_ACCESS_TOKEN as string)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  it('reads the tariff info and the dashboard accounts', async () => {
    const info = (await get('/info')) as { total: { left: number }; period: { from: string } };
    expect(typeof info.total.left).toBe('number');
    const accounts = (await get('/accounts')) as { response: unknown[] };
    expect(Array.isArray(accounts.response)).toBe(true);
  }, 60_000);
});
