import axios from 'axios';
import * as adapter from './twitch.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Twitch adapter (Helix API):
 *
 *   1. Static: always runs. Pins the OAuth settings (authorization code,
 *      client id and secret in the token request body, no PKCE because Twitch
 *      does not document it), the Client-Id header every Helix call needs, the
 *      scopes, every tool's method, URL, query and body through the real
 *      RestEngine (lists go out as repeated parameters, id=1&id=2), which tools
 *      change something and ask first, and the response shaping.
 *      Checked on 15 Oct 2026 against the Twitch API reference
 *      (dev.twitch.tv/docs/api/reference, the page Twitch generates its docs
 *      and twitch-cli mocks from): paths, methods, scopes, required parameters,
 *      page sizes (first: 100, schedule 25) and the response fields used.
 *
 *   2. Live: skipped unless RUN_TWITCH_LIVE=1. Every route answers 401 to a
 *      wrong token while a made-up route answers 404, so the 401s prove the
 *      routes exist. With TWITCH_ACCESS_TOKEN and TWITCH_CLIENT_ID (a user
 *      token of that app) it runs the read tools; TWITCH_LIVE_WRITE=1 also
 *      sets the signed-in channel's title to itself (no visible change):
 *
 *        RUN_TWITCH_LIVE=1 TWITCH_CLIENT_ID=... TWITCH_ACCESS_TOKEN=... npx jest src/adapters/intl/twitch.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, any>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.twitch.tv/helix';
// Built at run time so nothing here looks like a real credential.
const FAKE_TOKEN = 'x'.repeat(30);
const FAKE_CLIENT = ['abc', '0'.repeat(27)].join('');
// OAUTH2 sends the token as Bearer and adds authConfig.extraHeaders (with
// {{TWITCH_CLIENT_ID}} resolved); the same request is built here.
const call = (name: string, params: Record<string, unknown>, token = FAKE_TOKEN, clientId = FAKE_CLIENT) => {
  const extra = interpolateDeep(a.connector.authConfig.extraHeaders, { TWITCH_CLIENT_ID: clientId }) as Record<string, string>;
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: { ...a.connector.headers, ...extra } },
    tool(name).endpointMapping as any,
    applySchemaDefaults(tool(name).parameters as any, params),
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => new URLSearchParams(sent().paramsSerializer(sent().params));

const SCOPES = ['moderator:read:followers', 'clips:edit', 'channel:manage:broadcast'];
const B = '141981764';
const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['twitch_get_users', {}, 'GET', '/users'],
  ['twitch_get_channel_info', { broadcaster_id: [B] }, 'GET', '/channels'],
  ['twitch_get_streams', {}, 'GET', '/streams'],
  ['twitch_get_videos', { user_id: B }, 'GET', '/videos'],
  ['twitch_get_clips', { broadcaster_id: B }, 'GET', '/clips'],
  ['twitch_get_games', { name: ['Just Chatting'] }, 'GET', '/games'],
  ['twitch_get_top_games', {}, 'GET', '/games/top'],
  ['twitch_search_channels', { query: 'twitchdev' }, 'GET', '/search/channels'],
  ['twitch_search_categories', { query: 'chatting' }, 'GET', '/search/categories'],
  ['twitch_get_channel_followers', { broadcaster_id: B }, 'GET', '/channels/followers'],
  ['twitch_get_schedule', { broadcaster_id: B }, 'GET', '/schedule'],
  ['twitch_get_chat_settings', { broadcaster_id: B }, 'GET', '/chat/settings'],
  ['twitch_create_clip', { broadcaster_id: B }, 'POST', '/clips'],
  ['twitch_update_channel', { broadcaster_id: B, title: 'Hello' }, 'PATCH', '/channels'],
  ['twitch_send_chat_announcement', { broadcaster_id: B, moderator_id: B, message: 'Hi' }, 'POST', '/chat/announcements'],
];

describe('twitch adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.icon).toBe('twitch');
  });

  it('signs in through Twitch OAuth with the secret in the body, no PKCE, and sends Client-Id on every call', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{TWITCH_CLIENT_ID}}',
      clientSecret: '{{TWITCH_CLIENT_SECRET}}',
      authorizationUrl: 'https://id.twitch.tv/oauth2/authorize',
      tokenUrl: 'https://id.twitch.tv/oauth2/token',
      tokenAuthMethod: 'client_secret_post',
      pkce: false,
      scopes: SCOPES.join(' '),
      extraHeaders: { 'Client-Id': '{{TWITCH_CLIENT_ID}}' },
    });
    expect(needsBrowserAuthorization(a as never)).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/users');
    expect(a.probe).toEqual({ tool: 'twitch_get_users' });
    expect(a.requiredEnvVars).toEqual(['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.TWITCH_CLIENT_SECRET.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta.TWITCH_CLIENT_ID.pattern!);
    expect(pattern.test('uo6dggojyb8d6soh92zknwmi5ej1q2')).toBe(true);
    expect(pattern.test('Client ID: x')).toBe(false);
    for (const key of ['401', '403', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/two-factor authentication/);
    expect(a.prerequisites).toMatch(/two-factor/);
    for (const scope of [...SCOPES, 'moderator:manage:announcements']) expect(a.instructions).toContain(`\`${scope}\``);
  });

  it('prefixes every tool with twitch_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^twitch_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('asks before every change, keeps the chat announcement off and marks reads read-only', () => {
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET';
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${!write}`);
      if (write) expect(`${t.name}:${/wait for their yes/.test(t.description)}`).toBe(`${t.name}:true`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['twitch_send_chat_announcement']);
  });

  it('documents every tool, points only at real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\btwitch_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\btwitch_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool that returns data a valid response mapping that does real work', () => {
    // These two answer 204 No Content.
    const bare = ['twitch_send_chat_announcement', 'twitch_update_channel'];
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:${!bare.includes(t.name)}`);
      if (!tr) continue;
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.expression).toBeDefined();
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
  });

  it('caps page sizes as the reference does', () => {
    for (const t of a.tools) {
      const first = t.parameters.properties?.first;
      if (first) expect(`${t.name}:${first.maximum}`).toBe(`${t.name}:${t.name === 'twitch_get_schedule' ? 25 : 100}`);
    }
  });

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer token and Client-Id', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req.headers['Client-Id']).toBe(FAKE_CLIENT);
  });

  it('sends lists as repeated query parameters (id=1&id=2) and the defaults', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('twitch_get_users', { login: ['twitchdev', 'twitch'] });
    expect(query().getAll('login')).toEqual(['twitchdev', 'twitch']);
    mockedAxios.mockClear();
    await call('twitch_get_streams', { user_login: ['a', 'b'], game_id: ['509658'], language: ['de'], type: 'live' });
    expect(query().getAll('user_login')).toEqual(['a', 'b']);
    expect(query().get('first')).toBe('20');
    expect(query().get('type')).toBe('live');
    mockedAxios.mockClear();
    await call('twitch_get_clips', { broadcaster_id: B, started_at: '2026-10-01T00:00:00Z', is_featured: true });
    expect(sent().params).toEqual({ broadcaster_id: B, started_at: '2026-10-01T00:00:00Z', is_featured: true, first: 20 });
    mockedAxios.mockClear();
    await call('twitch_get_schedule', { broadcaster_id: B });
    expect(sent().params).toEqual({ broadcaster_id: B, first: 20 });
  });

  it('builds the write requests: clip in the query, channel and announcement in the body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('twitch_create_clip', { broadcaster_id: B, title: 'Nice', duration: 45.5 });
    expect(sent().params).toEqual({ broadcaster_id: B, title: 'Nice', duration: 45.5 });
    expect(sent().data).toBeUndefined();
    mockedAxios.mockClear();
    await call('twitch_update_channel', { broadcaster_id: B, title: 'New title', game_id: '509658', tags: ['English'] });
    expect(sent().params).toEqual({ broadcaster_id: B });
    expect(sent().data).toEqual({ title: 'New title', game_id: '509658', tags: ['English'] });
    mockedAxios.mockClear();
    await call('twitch_send_chat_announcement', { broadcaster_id: B, moderator_id: B, message: 'Hello chat', color: 'purple' });
    expect(sent().params).toEqual({ broadcaster_id: B, moderator_id: B });
    expect(sent().data).toEqual({ message: 'Hello chat', color: 'purple' });
  });

  it('shapes users, streams, followers and schedules', () => {
    expect(shape('twitch_get_users', { data: [{ id: B, login: 'twitchdev', display_name: 'TwitchDev', type: '', broadcaster_type: 'partner', description: 'd', profile_image_url: 'p', offline_image_url: 'o', view_count: 5, email: 'x@example.com', created_at: '2016-12-14T20:32:28Z' }] }))
      .toEqual({ data: [{ id: B, login: 'twitchdev', display_name: 'TwitchDev', type: '', broadcaster_type: 'partner', description: 'd', profile_image_url: 'p', created_at: '2016-12-14T20:32:28Z' }] });
    const streams = shape('twitch_get_streams', { data: [{ id: 's', user_id: B, user_login: 'twitchdev', user_name: 'TwitchDev', game_id: 'g', game_name: 'G', type: 'live', title: 'T', tags: ['English'], viewer_count: 7, started_at: 'x', language: 'en', thumbnail_url: 't', tag_ids: [], is_mature: false }], pagination: { cursor: 'c1' } });
    expect(streams.next_cursor).toBe('c1');
    expect(streams.data[0].tag_ids).toBeUndefined();
    expect(streams.data[0].viewer_count).toBe(7);
    // The last page has an empty pagination object: no cursor.
    expect(shape('twitch_get_top_games', { data: [], pagination: {} }).next_cursor).toBeUndefined();
    expect(shape('twitch_get_channel_followers', { total: 8, data: [], pagination: {} })).toEqual({ total: 8, data: [] });
    const schedule = shape('twitch_get_schedule', { data: { segments: [{ id: 'seg', start_time: 's', end_time: 'e', title: 'T', canceled_until: null, category: { id: '509658', name: 'Just Chatting' }, is_recurring: true }], broadcaster_id: B, broadcaster_name: 'TwitchDev', broadcaster_login: 'twitchdev', vacation: null }, pagination: {} });
    expect(schedule.segments[0]).toEqual({ id: 'seg', start_time: 's', end_time: 'e', title: 'T', canceled_until: null, category_id: '509658', category_name: 'Just Chatting', is_recurring: true });
    expect(schedule.broadcaster_name).toBe('TwitchDev');
  });
});

const live = process.env.RUN_TWITCH_LIVE === '1' ? describe : describe.skip;
live('twitch adapter: live', () => {
  const token = process.env.TWITCH_ACCESS_TOKEN;
  const clientId = process.env.TWITCH_CLIENT_ID;
  const real = !!token && !!clientId;
  const writes = real && process.env.TWITCH_LIVE_WRITE === '1';
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each(table)('%s reaches a real route and is refused with a wrong token (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers a made-up route with 404 even with a wrong token, which makes the 401s above meaningful', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ method: 'GET', url: `${BASE}/no-such-route`, headers: { Authorization: `Bearer ${FAKE_TOKEN}`, 'Client-Id': FAKE_CLIENT } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (real ? it : it.skip)('runs the read tools as the signed-in user', async () => {
    const run = async (name: string, params: Record<string, unknown> = {}) => shape(name, await call(name, params, token, clientId));
    const me = (await run('twitch_get_users')).data[0];
    expect(me.id).toBeTruthy();
    const dev = (await run('twitch_get_users', { login: ['twitchdev'] })).data[0];
    expect(dev.login).toBe('twitchdev');
    expect((await run('twitch_get_channel_info', { broadcaster_id: [dev.id] })).data[0].broadcaster_login).toBe('twitchdev');
    expect(Array.isArray((await run('twitch_get_streams', { first: 3 })).data)).toBe(true);
    expect(Array.isArray((await run('twitch_get_videos', { user_id: dev.id, first: 3 })).data)).toBe(true);
    expect(Array.isArray((await run('twitch_get_clips', { broadcaster_id: dev.id, first: 3 })).data)).toBe(true);
    const top = await run('twitch_get_top_games', { first: 3 });
    expect(top.data.length).toBeGreaterThan(0);
    expect((await run('twitch_get_games', { id: [top.data[0].id] })).data[0].name).toBe(top.data[0].name);
    expect((await run('twitch_search_channels', { query: 'twitchdev', first: 3 })).data.length).toBeGreaterThan(0);
    expect((await run('twitch_search_categories', { query: 'chatting', first: 3 })).data.length).toBeGreaterThan(0);
    expect(typeof (await run('twitch_get_channel_followers', { broadcaster_id: dev.id, first: 1 })).total).toBe('number');
    expect((await run('twitch_get_chat_settings', { broadcaster_id: dev.id })).data[0].broadcaster_id).toBe(dev.id);
    // A broadcaster without a schedule answers 404; both outcomes prove the call is right.
    try {
      expect(Array.isArray((await run('twitch_get_schedule', { broadcaster_id: dev.id })).segments)).toBe(true);
    } catch (e: any) {
      expect(e.response?.status).toBe(404);
    }
  }, 120000);

  (writes ? it : it.skip)('sets the signed-in channel title to its current value (no visible change)', async () => {
    const me = shape('twitch_get_users', await call('twitch_get_users', {}, token, clientId)).data[0];
    const info = shape('twitch_get_channel_info', await call('twitch_get_channel_info', { broadcaster_id: [me.id] }, token, clientId)).data[0];
    await call('twitch_update_channel', { broadcaster_id: me.id, title: info.title || 'AnythingMCP test' }, token, clientId);
  }, 60000);
});
