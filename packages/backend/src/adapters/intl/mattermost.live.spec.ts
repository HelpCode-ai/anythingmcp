import * as adapter from './mattermost.json';

/**
 * Mattermost REST API v4 adapter (self-hosted or Mattermost Cloud).
 *
 * Static checks always run: the base URL built from MATTERMOST_URL, the bearer
 * token, every tool's method and path against the API v4 reference
 * (https://docs.mattermost.com/api), the bodies of the
 * write tools, that sending a message stays on at install, and that deletes
 * install switched off.
 *
 * Live checks run only with RUN_MATTERMOST_LIVE=1 plus MATTERMOST_URL and
 * MATTERMOST_TOKEN. They read the account, its teams and one page of channels.
 * Nothing is posted.
 *
 *   RUN_MATTERMOST_LIVE=1 MATTERMOST_URL=https://chat.example.com MATTERMOST_TOKEN=... \
 *     npx jest src/adapters/intl/mattermost.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  prerequisites?: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; help?: string; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
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
// Text outside `code` spans: the website renders descriptions as MDX.
const prose = (text: string) => text.replace(/`[^`]*`/g, '');

const PREFIX = 'mattermost_';
// Method and path of every tool, as the vendor documents them.
const ROUTES: Record<string, [string, string]> = {
  mattermost_get_me: ['GET', '/users/me'],
  mattermost_list_users: ['GET', '/users'],
  mattermost_search_users: ['POST', '/users/search'],
  mattermost_get_user: ['GET', '/users/{user_id}'],
  mattermost_get_user_by_username: ['GET', '/users/username/{username}'],
  mattermost_list_my_teams: ['GET', '/users/me/teams'],
  mattermost_list_teams: ['GET', '/teams'],
  mattermost_get_team: ['GET', '/teams/{team_id}'],
  mattermost_get_team_by_name: ['GET', '/teams/name/{team_name}'],
  mattermost_list_team_members: ['GET', '/teams/{team_id}/members'],
  mattermost_list_my_channels: ['GET', '/users/me/teams/{team_id}/channels'],
  mattermost_list_public_channels: ['GET', '/teams/{team_id}/channels'],
  mattermost_search_channels: ['POST', '/teams/{team_id}/channels/search'],
  mattermost_get_channel: ['GET', '/channels/{channel_id}'],
  mattermost_get_channel_by_name: ['GET', '/teams/{team_id}/channels/name/{channel_name}'],
  mattermost_list_channel_members: ['GET', '/channels/{channel_id}/members'],
  mattermost_get_channel_stats: ['GET', '/channels/{channel_id}/stats'],
  mattermost_create_direct_channel: ['POST', '/channels/direct'],
  mattermost_list_channel_posts: ['GET', '/channels/{channel_id}/posts'],
  mattermost_get_post: ['GET', '/posts/{post_id}'],
  mattermost_get_thread: ['GET', '/posts/{post_id}/thread'],
  mattermost_list_pinned_posts: ['GET', '/channels/{channel_id}/pinned'],
  mattermost_search_posts: ['POST', '/teams/{team_id}/posts/search'],
  mattermost_create_post: ['POST', '/posts'],
  mattermost_update_post: ['PUT', '/posts/{post_id}/patch'],
  mattermost_delete_post: ['DELETE', '/posts/{post_id}'],
  mattermost_list_followed_threads: ['GET', '/users/me/teams/{team_id}/threads'],
  mattermost_list_post_reactions: ['GET', '/posts/{post_id}/reactions'],
  mattermost_add_reaction: ['POST', '/reactions'],
  mattermost_remove_reaction: ['DELETE', '/users/me/posts/{post_id}/reactions/{emoji_name}'],
  mattermost_list_post_files: ['GET', '/posts/{post_id}/files/info'],
  mattermost_get_file_info: ['GET', '/files/{file_id}/info'],
  mattermost_search_files: ['POST', '/teams/{team_id}/files/search'],
};
const REQUIRED: Record<string, string[]> = {
  mattermost_search_users: ['term'],
  mattermost_get_user: ['user_id'],
  mattermost_get_user_by_username: ['username'],
  mattermost_get_team: ['team_id'],
  mattermost_get_team_by_name: ['team_name'],
  mattermost_list_team_members: ['team_id'],
  mattermost_list_my_channels: ['team_id'],
  mattermost_list_public_channels: ['team_id'],
  mattermost_search_channels: ['team_id', 'term'],
  mattermost_get_channel: ['channel_id'],
  mattermost_get_channel_by_name: ['team_id', 'channel_name'],
  mattermost_list_channel_members: ['channel_id'],
  mattermost_get_channel_stats: ['channel_id'],
  mattermost_create_direct_channel: ['user_id', 'other_user_id'],
  mattermost_list_channel_posts: ['channel_id'],
  mattermost_get_post: ['post_id'],
  mattermost_get_thread: ['post_id'],
  mattermost_list_pinned_posts: ['channel_id'],
  mattermost_search_posts: ['team_id', 'terms'],
  mattermost_create_post: ['channel_id', 'message'],
  mattermost_update_post: ['post_id'],
  mattermost_delete_post: ['post_id'],
  mattermost_list_followed_threads: ['team_id'],
  mattermost_list_post_reactions: ['post_id'],
  mattermost_add_reaction: ['user_id', 'post_id', 'emoji_name'],
  mattermost_remove_reaction: ['post_id', 'emoji_name'],
  mattermost_list_post_files: ['post_id'],
  mattermost_get_file_info: ['file_id'],
  mattermost_search_files: ['team_id', 'terms'],
};
// Installed switched off: an administrator turns them on per connector.
const SWITCHED_OFF: string[] = ['mattermost_delete_post', 'mattermost_remove_reaction'];
// Writes that are on at install.
const WRITES: string[] = ['mattermost_create_direct_channel', 'mattermost_create_post', 'mattermost_update_post', 'mattermost_add_reaction'];
// POST requests that only read (searches and log queries).
const READ_POSTS: string[] = ['mattermost_search_users', 'mattermost_search_channels', 'mattermost_search_posts', 'mattermost_search_files'];

describe('mattermost adapter: static contract', () => {
  it('declares the catalog envelope, the base URL and the authentication', () => {
    expect(a.slug).toBe('mattermost');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('mattermost');
    expect(a.requiredEnvVars).toEqual(['MATTERMOST_URL', 'MATTERMOST_TOKEN']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{MATTERMOST_URL}}/api/v4');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{MATTERMOST_TOKEN}}' });
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(`${name}:${Boolean(a.envVarMeta[name]?.help)}`).toBe(`${name}:true`);
      expect(`${name}:${a.envVarMeta[name]?.secret === true}`).toBe(`${name}:${(['MATTERMOST_TOKEN'] as string[]).includes(name)}`);
    }
    // An optional variable in a connector header would be sent as the literal placeholder.
    for (const name of a.optionalEnvVars ?? []) expect(JSON.stringify(a.connector.headers ?? {})).not.toContain(name);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'mattermost_get_me' });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['401', '403', '404', 'rate_limited', 'unreachable']) expect(`${key}:${Boolean(a.verifyHints[key])}`).toBe(`${key}:true`);
  });

  it('maps every tool to its documented method and path', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const t of a.tools) {
      expect(`${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${t.name} ${ROUTES[t.name][0]} ${ROUTES[t.name][1]}`);
      expect(`${t.name}:${JSON.stringify(t.parameters?.required ?? [])}`).toBe(`${t.name}:${JSON.stringify(REQUIRED[t.name] ?? [])}`);
    }
  });

  it('prefixes every tool, sends every declared parameter, declares every argument it reads and requires its path parameters', () => {
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) {
        expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
        expect(`${t.name}:${p}:${Boolean(t.parameters?.properties?.[p]?.description)}`).toBe(`${t.name}:${p}:true`);
      }
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p) || envNames.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required ?? []).toContain(p);
    }
  });

  it('installs deletes and other risky calls switched off and marks reading POSTs read-only', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
    for (const t of a.tools) {
      const method = t.endpointMapping.method;
      if (method === 'DELETE') expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:false`);
      if (READ_POSTS.includes(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      else expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:undefined`);
      const reads = method === 'GET' || READ_POSTS.includes(t.name);
      expect(`${t.name}:${reads || WRITES.includes(t.name) || SWITCHED_OFF.includes(t.name)}`).toBe(`${t.name}:true`);
      if (reads) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const texts = [a.description, a.instructions, a.prerequisites ?? '', ...Object.values(a.verifyHints)];
    for (const t of a.tools) {
      texts.push(t.description);
      for (const p of Object.values(t.parameters?.properties ?? {})) texts.push(p.description ?? '');
    }
    for (const text of texts) expect(prose(text)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });


  it('accepts a server address without a trailing slash and a bare token', () => {
    const url = new RegExp(a.envVarMeta.MATTERMOST_URL.pattern ?? '');
    for (const ok of ['https://chat.example.com', 'http://10.0.0.5:8065', 'https://example.com/mattermost', 'https://yourcompany.cloud.mattermost.com']) {
      expect(`${ok}:${url.test(ok)}`).toBe(`${ok}:true`);
    }
    for (const bad of ['chat.example.com', 'https://chat.example.com/', 'ftp://chat.example.com', '']) expect(`${bad}:${url.test(bad)}`).toBe(`${bad}:false`);
    const token = new RegExp(a.envVarMeta.MATTERMOST_TOKEN.pattern ?? '');
    expect(token.test('9xuqwrwgstrb3mzrxb83nb357a')).toBe(true);
    for (const bad of ['', 'Bearer 9xuqwrwgstrb3mzrxb83nb357a', 'has space 9xuqwrwgstrb3mzrxb83', 'short']) expect(`${bad}:${token.test(bad)}`).toBe(`${bad}:false`);
  });

  it('keeps sending on and builds the message, edit, reaction and direct-channel bodies', () => {
    expect(tool('mattermost_create_post').enabled).toBeUndefined();
    expect(tool('mattermost_create_post').endpointMapping).toEqual({
      method: 'POST',
      path: '/posts',
      bodyMapping: { channel_id: '$channel_id', message: '$message', root_id: '$root_id', file_ids: '$file_ids' },
    });
    expect(tool('mattermost_update_post').endpointMapping.bodyMapping).toEqual({ message: '$message', is_pinned: '$is_pinned' });
    expect(tool('mattermost_add_reaction').endpointMapping.bodyMapping).toEqual({ user_id: '$user_id', post_id: '$post_id', emoji_name: '$emoji_name' });
    // The API takes a bare list of exactly two user ids.
    expect(tool('mattermost_create_direct_channel').endpointMapping.bodyMapping).toEqual(['$user_id', '$other_user_id']);
  });

  it('maps reads, searches and paging as the API documents them', () => {
    expect(tool('mattermost_list_channel_posts').endpointMapping.queryParams).toEqual({ page: '$page', per_page: '$per_page', since: '$since', before: '$before', after: '$after' });
    expect(tool('mattermost_get_thread').endpointMapping.queryParams).toEqual({ perPage: '$per_page', fromPost: '$from_post' });
    expect(tool('mattermost_search_posts').endpointMapping.bodyMapping).toMatchObject({ terms: '$terms', is_or_search: '$is_or_search' });
    // is_or_search is required by the API: the schema default fills it in.
    const orSearch = tool('mattermost_search_posts').parameters?.properties?.is_or_search as unknown as { default?: boolean };
    expect(orSearch.default).toBe(false);
    expect(tool('mattermost_search_users').endpointMapping.bodyMapping).toMatchObject({ term: '$term', team_id: '$team_id' });
    for (const t of a.tools) {
      // Files are described, never downloaded or uploaded; nothing manages users, teams or channels.
      expect(t.endpointMapping.path).not.toMatch(/\/files$|\/files\/\{file_id\}$|\/preview|\/thumbnail|\/link|\/tokens|\/password|\/sessions|\/webhooks|\/commands/);
      if (/^\/(teams|users)(\/|$)/.test(t.endpointMapping.path) && !READ_POSTS.includes(t.name) && t.endpointMapping.method !== 'DELETE') {
        expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      }
    }
  });
});

const env = process.env;
const live = env.RUN_MATTERMOST_LIVE === '1' && env.MATTERMOST_URL && env.MATTERMOST_TOKEN ? describe : describe.skip;
live('mattermost adapter: live (read-only)', () => {
  const base = `${env.MATTERMOST_URL}/api/v4`;
  const headers = { Accept: 'application/json', Authorization: `Bearer ${env.MATTERMOST_TOKEN}` };

  it('reads the account, its teams and the channels of the first team', async () => {
    const me = await fetch(`${base}/users/me`, { headers });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { id: string }).id).toMatch(/^[a-z0-9]{26}$/);
    const teams = await fetch(`${base}/users/me/teams`, { headers });
    expect(teams.status).toBe(200);
    const list = (await teams.json()) as Array<{ id: string }>;
    expect(Array.isArray(list)).toBe(true);
    if (list.length === 0) return;
    const channels = await fetch(`${base}/users/me/teams/${list[0].id}/channels`, { headers });
    expect(channels.status).toBe(200);
  }, 60_000);

  it('refuses a request without a token', async () => {
    const res = await fetch(`${base}/users/me`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(401);
  }, 30_000);
});
