import * as adapter from './threads.json';

/**
 * Threads API (developers.facebook.com/docs/threads): https://graph.threads.net/v1.0,
 * a long-lived Threads user token sent as a bearer token; `me` stands for the connected profile.
 * Live part: THREADS_ACCESS_TOKEN=... RUN_THREADS_LIVE=1 npx jest src/adapters/intl/threads
 * (reads only: profile, posts, publishing limit).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
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
const PREFIX = 'threads_';
const WRITES = [
  'threads_hide_reply',
  'threads_manage_pending_reply',
  'threads_post_text',
  'threads_create_container',
  'threads_publish',
  'threads_repost',
  'threads_delete_post',
];
const SWITCHED_OFF = ['threads_delete_post'];

describe('threads adapter: static spec conformance', () => {
  it('calls graph.threads.net v1.0 with the long-lived user token as a bearer token', () => {
    expect(a.slug).toBe('threads');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('social');
    expect(a.icon).toBe('threads');
    expect(a.requiredEnvVars).toEqual(['THREADS_ACCESS_TOKEN']);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://graph.threads.net/v1.0');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{THREADS_ACCESS_TOKEN}}' });
    expect(a.envVarMeta?.THREADS_ACCESS_TOKEN.secret).toBe(true);
    const token = new RegExp(a.envVarMeta?.THREADS_ACCESS_TOKEN.pattern ?? '');
    expect(token.test('THAAx1y2z3AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBe(true);
    expect(token.test('Bearer THAAx1y2z3AbCdEfGhIjKlMnOp')).toBe(false);
    expect(token.test('EAAGm0PX4ZCpsBAKZCZBabcdefghijkl')).toBe(false);
    expect(a.probe?.tool).toBe('threads_get_profile');
  });

  it('maps profile, posts, replies and insights to the documented routes', () => {
    expect(tool('threads_get_profile').endpointMapping).toEqual({ method: 'GET', path: '/me', queryParams: { fields: '$fields' } });
    expect(tool('threads_get_publishing_limit').endpointMapping.path).toBe('/me/threads_publishing_limit');
    expect(tool('threads_list_posts').endpointMapping).toMatchObject({ method: 'GET', path: '/me/threads', queryParams: { since: '$since', until: '$until', limit: '$limit', after: '$after', before: '$before' } });
    expect(tool('threads_get_post').endpointMapping.path).toBe('/{media_id}');
    expect(tool('threads_list_my_replies').endpointMapping.path).toBe('/me/replies');
    expect(tool('threads_list_mentions').endpointMapping.path).toBe('/me/mentions');
    expect(tool('threads_list_replies').endpointMapping).toMatchObject({ method: 'GET', path: '/{media_id}/replies', queryParams: { reverse: '$reverse' } });
    expect(tool('threads_get_conversation').endpointMapping.path).toBe('/{media_id}/conversation');
    expect(tool('threads_list_pending_replies').endpointMapping.path).toBe('/{media_id}/pending_replies');
    expect(tool('threads_get_post_insights').endpointMapping).toMatchObject({ path: '/{media_id}/insights', queryParams: { metric: '$metric' } });
    expect(tool('threads_get_account_insights').endpointMapping).toMatchObject({ path: '/me/threads_insights', queryParams: { metric: '$metric', breakdown: '$breakdown' } });
    expect(tool('threads_search_posts').endpointMapping).toMatchObject({ path: '/keyword_search', queryParams: { q: '$q', search_type: '$search_type', search_mode: '$search_mode' } });
    expect(tool('threads_lookup_profile').endpointMapping).toMatchObject({ path: '/profile_lookup', queryParams: { username: '$username' } });
    expect(tool('threads_list_profile_posts').endpointMapping.path).toBe('/profile_posts');
    expect(tool('threads_search_locations').endpointMapping.path).toBe('/location_search');
  });

  it('publishes through containers, or in one step for text', () => {
    expect(tool('threads_post_text').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/me/threads',
      queryParams: { media_type: 'TEXT', auto_publish_text: 'true', text: '$text', reply_to_id: '$reply_to_id' },
    });
    expect(tool('threads_create_container').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/me/threads',
      queryParams: { media_type: '$media_type', image_url: '$image_url', video_url: '$video_url', children: '$children', reply_to_id: '$reply_to_id' },
    });
    const mediaType = tool('threads_create_container').parameters?.properties?.media_type as { enum: string[] };
    expect(mediaType.enum).toEqual(['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL']);
    expect(tool('threads_get_container_status').endpointMapping).toMatchObject({ method: 'GET', path: '/{container_id}' });
    expect(tool('threads_publish').endpointMapping).toEqual({ method: 'POST', path: '/me/threads_publish', queryParams: { creation_id: '$creation_id' } });
    expect(tool('threads_repost').endpointMapping).toEqual({ method: 'POST', path: '/{media_id}/repost' });
    expect(tool('threads_hide_reply').endpointMapping).toEqual({ method: 'POST', path: '/{reply_id}/manage_reply', queryParams: { hide: '$hide' } });
    expect(tool('threads_manage_pending_reply').endpointMapping).toEqual({ method: 'POST', path: '/{reply_id}/manage_pending_reply', queryParams: { approve: '$approve' } });
    expect(tool('threads_delete_post').endpointMapping).toEqual({ method: 'DELETE', path: '/{media_id}' });
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

  it('publishing stays on, only the delete installs switched off; reads are GET', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name);
    expect(off).toEqual(SWITCHED_OFF);
    for (const n of SWITCHED_OFF) expect(tool(n).annotations?.destructiveHint).toBe(true);
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'DELETE') expect(SWITCHED_OFF).toContain(t.name);
      if (WRITES.includes(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
      else expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    }
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/th_exchange_token/);
    expect(a.instructions).toMatch(/th_refresh_token/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env;
const live = env.RUN_THREADS_LIVE === '1' && env.THREADS_ACCESS_TOKEN ? describe : describe.skip;
live('threads adapter: live (read-only)', () => {
  const base = 'https://graph.threads.net/v1.0';
  const headers = { Accept: 'application/json', Authorization: `Bearer ${env.THREADS_ACCESS_TOKEN}` };
  it('reads the profile, the latest posts and the publishing limit', async () => {
    const me = (await (await fetch(`${base}/me?fields=id,username`, { headers })).json()) as { id: string; username: string };
    expect(me.id).toMatch(/^[0-9]+$/);
    const posts = (await (await fetch(`${base}/me/threads?fields=id,timestamp&limit=3`, { headers })).json()) as { data: unknown[] };
    expect(Array.isArray(posts.data)).toBe(true);
    const quota = (await (await fetch(`${base}/me/threads_publishing_limit?fields=quota_usage,config`, { headers })).json()) as { data: unknown[] };
    expect(Array.isArray(quota.data)).toBe(true);
  }, 60_000);
});
