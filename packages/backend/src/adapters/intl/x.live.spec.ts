import axios from 'axios';
import * as adapter from './x.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the X adapter:
 *
 *   1. Static: always runs. Pins the OAuth settings (authorization code with
 *      PKCE, which the engine always sends; HTTP Basic at the token endpoint,
 *      as X wants from a confidential client; the scope list), every tool's
 *      method and URL, the field defaults, the post, reply, quote, like,
 *      follow and DM bodies, and which tools publish, are read-only or are
 *      switched off.
 *
 *   2. Live: skipped unless X_ACCESS_TOKEN is set, a user access token from
 *      an authorization of an X app with the scopes in the instructions (it
 *      lasts two hours). Every call spends X API credits, so the reads ask
 *      for few results:
 *
 *        X_ACCESS_TOKEN=... npx jest src/adapters/intl/x.live.spec.ts
 *
 *      Reads the user, a user by @username (X_TEST_USERNAME, default
 *      XDevelopers), their posts and one post, your mentions, home timeline,
 *      likes, bookmarks, followers, following and Lists, a recent search and
 *      count, and your direct messages.
 *
 *      X_LIVE_WRITE=1 publishes a test post on the account, replies to it
 *      and quotes it, likes, bookmarks and reposts it and takes all of that
 *      back, then deletes the three posts in `finally`. It is public for a
 *      few seconds. X_TEST_FOLLOW_USER_ID also follows and unfollows that
 *      account; X_TEST_DM_RECIPIENT_ID sends that account a direct message
 *      and deletes it on your side.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  appRegistrationUrl: string;
  requiredEnvVars: string[];
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.x.com/2';
// The OAuth access token is handed to the engine as a bearer token, which is
// what OAUTH2 auth puts on the request too.
const execute = (name: string, token: string, params: Record<string, unknown>) =>
  new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: a.connector.headers },
    tool(name).endpointMapping,
    applySchemaDefaults(tool(name).parameters, params),
  ) as Promise<any>;
// Built at run time so nothing here looks like a real token.
const FAKE_TOKEN = ['test', 'token', 'x'.repeat(8)].join('-');
const call = (name: string, params: Record<string, unknown>) => execute(name, FAKE_TOKEN, params);
const sent = () => mockedAxios.mock.calls[0][0];
const OFF = ['x_delete_dm', 'x_delete_post'];
const PUBLISHING = ['x_create_post', 'x_quote_post', 'x_reply_to_post', 'x_repost', 'x_send_dm', 'x_send_dm_to_conversation'];
const SCOPES = [
  'tweet.read', 'tweet.write', 'users.read', 'follows.read', 'follows.write', 'like.read', 'like.write',
  'bookmark.read', 'bookmark.write', 'list.read', 'dm.read', 'dm.write', 'offline.access',
];

describe('x adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified against the official API spec on 12 Oct 2026)', () => { expect(a.unlisted).toBeUndefined(); });

  it('names the product and its prerequisites', () => {
    expect(a.name).toBe('X (Twitter)');
    expect(a.prerequisites).toMatch(/credits/);
  });

  it('signs in through X OAuth 2.0 with HTTP Basic at the token endpoint and the documented scopes', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{X_CLIENT_ID}}',
      clientSecret: '{{X_CLIENT_SECRET}}',
      authorizationUrl: 'https://x.com/i/oauth2/authorize',
      tokenUrl: 'https://api.x.com/2/oauth2/token',
      tokenAuthMethod: 'client_secret_basic',
      scopes: SCOPES.join(' '),
    });
    expect(needsBrowserAuthorization(a as never)).toBe(true);
    expect(a.requiredEnvVars).toEqual(['X_CLIENT_ID', 'X_CLIENT_SECRET']);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'X_CLIENT_SECRET')!.secret).toBe(true);
    expect(a.appRegistrationUrl).toBe('https://console.x.com');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    // X refuses localhost callback URLs; the instructions say so.
    expect(a.instructions).toContain('127.0.0.1');
    for (const scope of SCOPES) expect(a.instructions).toContain(`\`${scope}\``);
  });

  it('is honest about paid access and explains the credit errors', () => {
    expect(a.instructions).toMatch(/billed per use with prepaid credits/);
    expect(a.instructions).toContain('https://docs.x.com/x-api/getting-started/pricing');
    expect(a.verifyHints['403']).toMatch(/client-forbidden|client-not-enrolled/);
    expect(a.verifyHints['402']).toMatch(/credit/);
    expect(a.verifyHints.rate_limited).toMatch(/15 minutes/);
  });

  it('probes with the signed-in user', () => {
    expect(a.probe).toEqual({ tool: 'x_get_me' });
    expect(a.connector.healthcheckPath).toBe('/users/me');
  });

  it('prefixes every tool with x_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^x_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, flags everything that publishes and installs deletions switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const name of OFF) expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    for (const name of PUBLISHING) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
      expect(tool(name).description).toMatch(/[Cc]onfirm|get a yes/);
    }
    for (const name of ['x_like_post', 'x_add_bookmark', 'x_follow_user']) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(false);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bx_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bx_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['x_get_me', {}, 'GET', '/users/me'],
    ['x_get_user_by_username', { username: 'XDevelopers' }, 'GET', '/users/by/username/XDevelopers'],
    ['x_get_users_by_usernames', { usernames: 'a,b' }, 'GET', '/users/by'],
    ['x_get_user', { user_id: '12' }, 'GET', '/users/12'],
    ['x_search_users', { query: 'anything' }, 'GET', '/users/search'],
    ['x_get_post', { post_id: '20' }, 'GET', '/tweets/20'],
    ['x_get_posts', { ids: '20,21' }, 'GET', '/tweets'],
    ['x_list_user_posts', { user_id: '12' }, 'GET', '/users/12/tweets'],
    ['x_list_user_mentions', { user_id: '12' }, 'GET', '/users/12/mentions'],
    ['x_get_home_timeline', { user_id: '12' }, 'GET', '/users/12/timelines/reverse_chronological'],
    ['x_search_recent_posts', { query: 'mcp' }, 'GET', '/tweets/search/recent'],
    ['x_count_recent_posts', { query: 'mcp' }, 'GET', '/tweets/counts/recent'],
    ['x_list_quote_posts', { post_id: '20' }, 'GET', '/tweets/20/quote_tweets'],
    ['x_list_reposted_by', { post_id: '20' }, 'GET', '/tweets/20/retweeted_by'],
    ['x_list_liking_users', { post_id: '20' }, 'GET', '/tweets/20/liking_users'],
    ['x_create_post', { text: 'Hi' }, 'POST', '/tweets'],
    ['x_reply_to_post', { post_id: '20', text: 'Hi' }, 'POST', '/tweets'],
    ['x_quote_post', { post_id: '20', text: 'Hi' }, 'POST', '/tweets'],
    ['x_delete_post', { post_id: '20' }, 'DELETE', '/tweets/20'],
    ['x_list_liked_posts', { user_id: '12' }, 'GET', '/users/12/liked_tweets'],
    ['x_like_post', { user_id: '12', post_id: '20' }, 'POST', '/users/12/likes'],
    ['x_unlike_post', { user_id: '12', post_id: '20' }, 'DELETE', '/users/12/likes/20'],
    ['x_repost', { user_id: '12', post_id: '20' }, 'POST', '/users/12/retweets'],
    ['x_undo_repost', { user_id: '12', post_id: '20' }, 'DELETE', '/users/12/retweets/20'],
    ['x_list_bookmarks', { user_id: '12' }, 'GET', '/users/12/bookmarks'],
    ['x_add_bookmark', { user_id: '12', post_id: '20' }, 'POST', '/users/12/bookmarks'],
    ['x_remove_bookmark', { user_id: '12', post_id: '20' }, 'DELETE', '/users/12/bookmarks/20'],
    ['x_list_followers', { user_id: '12' }, 'GET', '/users/12/followers'],
    ['x_list_following', { user_id: '12' }, 'GET', '/users/12/following'],
    ['x_follow_user', { user_id: '12', target_user_id: '13' }, 'POST', '/users/12/following'],
    ['x_unfollow_user', { user_id: '12', target_user_id: '13' }, 'DELETE', '/users/12/following/13'],
    ['x_list_owned_lists', { user_id: '12' }, 'GET', '/users/12/owned_lists'],
    ['x_list_followed_lists', { user_id: '12' }, 'GET', '/users/12/followed_lists'],
    ['x_get_list', { list_id: '30' }, 'GET', '/lists/30'],
    ['x_list_list_posts', { list_id: '30' }, 'GET', '/lists/30/tweets'],
    ['x_list_list_members', { list_id: '30' }, 'GET', '/lists/30/members'],
    ['x_list_dm_events', {}, 'GET', '/dm_events'],
    ['x_list_dm_conversation_with_user', { participant_id: '13' }, 'GET', '/dm_conversations/with/13/dm_events'],
    ['x_send_dm', { participant_id: '13', text: 'Hi' }, 'POST', '/dm_conversations/with/13/messages'],
    ['x_send_dm_to_conversation', { dm_conversation_id: '12-13', text: 'Hi' }, 'POST', '/dm_conversations/12-13/messages'],
    ['x_delete_dm', { event_id: '40' }, 'DELETE', '/dm_events/40'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
  });

  it('sends the token as a bearer header, never in the URL', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('x_get_me', {});
    expect(sent().headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(sent().params)).not.toContain(FAKE_TOKEN);
  });

  it('asks for useful post fields by default and keeps expansions off unless asked', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('x_search_recent_posts', { query: 'from:XDevelopers -is:retweet' });
    expect(sent().params).toEqual({
      query: 'from:XDevelopers -is:retweet',
      max_results: 10,
      'tweet.fields': 'created_at,author_id,conversation_id,in_reply_to_user_id,referenced_tweets,public_metrics,lang,entities,reply_settings,note_tweet',
      'user.fields': 'created_at,description,location,public_metrics,verified,verified_type,profile_image_url,url,protected',
    });
    mockedAxios.mockClear();
    await call('x_list_user_posts', { user_id: '12', exclude: 'replies,retweets', expansions: 'author_id', pagination_token: 'abc', max_results: 5 });
    expect(sent().params).toEqual(expect.objectContaining({ exclude: 'replies,retweets', expansions: 'author_id', pagination_token: 'abc', max_results: 5 }));
  });

  it('keeps the default page sizes inside each endpoint\'s range', () => {
    for (const t of a.tools) {
      const p = t.parameters.properties?.max_results as { default?: number; minimum?: number; maximum?: number } | undefined;
      if (!p) continue;
      expect(p.default).toBeGreaterThanOrEqual(p.minimum!);
      expect(p.default).toBeLessThanOrEqual(p.maximum!);
      expect(p.default).toBeLessThanOrEqual(20);
    }
  });

  it('builds post, reply, quote and poll bodies the way X expects', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('x_create_post', { text: 'Hello' });
    expect(sent().data).toEqual({ text: 'Hello' });
    mockedAxios.mockClear();
    await call('x_create_post', { text: 'Which?', reply_settings: 'following', poll: { options: ['A', 'B'], duration_minutes: 60 } });
    expect(sent().data).toEqual({ text: 'Which?', reply_settings: 'following', poll: { options: ['A', 'B'], duration_minutes: 60 } });
    mockedAxios.mockClear();
    await call('x_reply_to_post', { post_id: '20', text: 'Thanks' });
    expect(sent().data).toEqual({ text: 'Thanks', reply: { in_reply_to_tweet_id: '20' } });
    mockedAxios.mockClear();
    await call('x_quote_post', { post_id: '20', text: 'Worth reading' });
    expect(sent().data).toEqual({ text: 'Worth reading', quote_tweet_id: '20' });
  });

  it('sends likes, reposts, bookmarks, follows and DMs with X\'s field names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    for (const name of ['x_like_post', 'x_repost', 'x_add_bookmark']) {
      mockedAxios.mockClear();
      await call(name, { user_id: '12', post_id: '20' });
      expect(sent().data).toEqual({ tweet_id: '20' });
    }
    mockedAxios.mockClear();
    await call('x_follow_user', { user_id: '12', target_user_id: '13' });
    expect(sent().data).toEqual({ target_user_id: '13' });
    mockedAxios.mockClear();
    await call('x_send_dm', { participant_id: '13', text: 'Hello' });
    expect(sent().data).toEqual({ text: 'Hello' });
    mockedAxios.mockClear();
    await call('x_list_dm_events', {});
    expect(sent().params).toEqual({
      event_types: 'MessageCreate',
      max_results: 20,
      'dm_event.fields': 'id,text,event_type,created_at,dm_conversation_id,attachments',
      expansions: 'sender_id',
      'user.fields': 'created_at,description,location,public_metrics,verified,verified_type,profile_image_url,url,protected',
    });
  });

  it('encodes path values, so a stray slash cannot reach another endpoint', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('x_get_user_by_username', { username: 'a/../b' });
    expect(sent().url).toBe(`${BASE}/users/by/username/a%2F..%2Fb`);
  });
});

const TOKEN = process.env.X_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('x adapter: live X API v2', () => {
  const write = process.env.X_LIVE_WRITE === '1';
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, TOKEN as string, params);
  let me: { id: string; username: string };

  beforeAll(async () => {
    me = (await run('x_get_me')).data;
  }, 30_000);

  it('reads the user, another account, their posts and one post', async () => {
    expect(me.id).toMatch(/^\d+$/);
    const username = process.env.X_TEST_USERNAME || 'XDevelopers';
    const other = (await run('x_get_user_by_username', { username })).data;
    expect(other.username.toLowerCase()).toBe(username.toLowerCase());
    expect((await run('x_get_user', { user_id: other.id })).data.id).toBe(other.id);
    const both = await run('x_get_users_by_usernames', { usernames: `${username},${me.username}` });
    expect(both.data.length).toBe(2);
    const posts = await run('x_list_user_posts', { user_id: other.id, max_results: 5, exclude: 'replies,retweets' });
    if (posts.data?.length) {
      const id = posts.data[0].id;
      expect((await run('x_get_post', { post_id: id })).data.id).toBe(id);
      expect((await run('x_get_posts', { ids: id })).data[0].id).toBe(id);
      expect(await run('x_list_reposted_by', { post_id: id, max_results: 5 })).toBeDefined();
    }
  }, 90_000);

  it('reads your timeline, mentions, likes, bookmarks, follows and Lists', async () => {
    expect(await run('x_get_home_timeline', { user_id: me.id, max_results: 5 })).toHaveProperty('meta');
    expect(await run('x_list_user_mentions', { user_id: me.id, max_results: 5 })).toHaveProperty('meta');
    expect(await run('x_list_liked_posts', { user_id: me.id, max_results: 5 })).toHaveProperty('meta');
    expect(await run('x_list_bookmarks', { user_id: me.id, max_results: 5 })).toHaveProperty('meta');
    expect(await run('x_list_followers', { user_id: me.id, max_results: 5 })).toHaveProperty('meta');
    expect(await run('x_list_following', { user_id: me.id, max_results: 5 })).toHaveProperty('meta');
    const lists = await run('x_list_owned_lists', { user_id: me.id, max_results: 5 });
    expect(lists).toHaveProperty('meta');
    expect(await run('x_list_followed_lists', { user_id: me.id, max_results: 5 })).toHaveProperty('meta');
    if (lists.data?.length) {
      const id = lists.data[0].id;
      expect((await run('x_get_list', { list_id: id })).data.id).toBe(id);
      expect(await run('x_list_list_members', { list_id: id, max_results: 5 })).toHaveProperty('meta');
      expect(await run('x_list_list_posts', { list_id: id, max_results: 5 })).toHaveProperty('meta');
    }
  }, 120_000);

  it('searches and counts recent posts, finds accounts and reads direct messages', async () => {
    const found = await run('x_search_recent_posts', { query: 'from:XDevelopers', max_results: 10 });
    expect(found).toHaveProperty('meta');
    const counts = await run('x_count_recent_posts', { query: 'from:XDevelopers', granularity: 'day' });
    expect(counts.meta.total_tweet_count).toBeGreaterThanOrEqual(0);
    expect(await run('x_search_users', { query: 'XDevelopers', max_results: 5 })).toBeDefined();
    expect(await run('x_list_dm_events', { max_results: 5 })).toHaveProperty('meta');
  }, 90_000);

  (write ? it : it.skip)('publishes, replies, quotes, likes, bookmarks and reposts, then cleans up', async () => {
    const stamp = new Date().toISOString();
    const created: string[] = [];
    try {
      const post = (await run('x_create_post', { text: `AnythingMCP live spec ${stamp}` })).data;
      created.push(post.id);
      const reply = (await run('x_reply_to_post', { post_id: post.id, text: `AnythingMCP live spec reply ${stamp}` })).data;
      created.push(reply.id);
      const quote = (await run('x_quote_post', { post_id: post.id, text: `AnythingMCP live spec quote ${stamp}` })).data;
      created.push(quote.id);

      expect((await run('x_like_post', { user_id: me.id, post_id: post.id })).data.liked).toBe(true);
      expect((await run('x_unlike_post', { user_id: me.id, post_id: post.id })).data.liked).toBe(false);
      expect((await run('x_add_bookmark', { user_id: me.id, post_id: post.id })).data.bookmarked).toBe(true);
      expect((await run('x_remove_bookmark', { user_id: me.id, post_id: post.id })).data.bookmarked).toBe(false);
      expect((await run('x_repost', { user_id: me.id, post_id: post.id })).data.retweeted).toBe(true);
      expect((await run('x_undo_repost', { user_id: me.id, post_id: post.id })).data.retweeted).toBe(false);
      expect(await run('x_list_quote_posts', { post_id: post.id, max_results: 10 })).toBeDefined();
      expect(await run('x_list_liking_users', { post_id: post.id, max_results: 5 })).toBeDefined();

      const follow = process.env.X_TEST_FOLLOW_USER_ID;
      if (follow) {
        expect((await run('x_follow_user', { user_id: me.id, target_user_id: follow })).data).toHaveProperty('following');
        expect((await run('x_unfollow_user', { user_id: me.id, target_user_id: follow })).data.following).toBe(false);
      }
      const recipient = process.env.X_TEST_DM_RECIPIENT_ID;
      if (recipient) {
        const dm = (await run('x_send_dm', { participant_id: recipient, text: `AnythingMCP live spec DM ${stamp}` })).data;
        expect(dm.dm_event_id).toBeDefined();
        const convo = await run('x_list_dm_conversation_with_user', { participant_id: recipient, max_results: 5 });
        expect(convo.data.length).toBeGreaterThan(0);
        const again = (await run('x_send_dm_to_conversation', { dm_conversation_id: dm.dm_conversation_id, text: `AnythingMCP live spec DM 2 ${stamp}` })).data;
        await run('x_delete_dm', { event_id: dm.dm_event_id });
        await run('x_delete_dm', { event_id: again.dm_event_id });
      }
    } finally {
      for (const id of created.reverse()) await run('x_delete_post', { post_id: id });
    }
  }, 180_000);
});
