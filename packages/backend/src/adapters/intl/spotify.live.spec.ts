import axios from 'axios';
import * as adapter from './spotify.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Spotify adapter (Web API v1):
 *
 *   1. Static: always runs. Pins the OAuth settings (authorization code with
 *      PKCE, which the engine sends by default, and HTTP Basic at the token
 *      endpoint), the scopes, every tool's method, URL, query and body through
 *      the real RestEngine, which tools change something and ask first, which
 *      are switched off, and the response shaping.
 *      Checked on 15 Oct 2026 against Spotify's own OpenAPI document
 *      (developer.spotify.com/reference/web-api/open-api-schema.yaml) and the
 *      February 2026 development-mode migration guide and changelogs: playlist
 *      items live under /playlists/{id}/items, playlists are created with
 *      POST /me/playlists, saving and following go through /me/library, search
 *      returns at most 10 per type, and none of the endpoints removed for
 *      development-mode apps is used.
 *
 *   2. Live: skipped unless RUN_SPOTIFY_LIVE=1. Every route answers 401 to a
 *      wrong token while a made-up route answers 410, so the 401s prove the
 *      routes exist. With SPOTIFY_ACCESS_TOKEN (a user token of a Spotify app
 *      with the scopes in the instructions, valid one hour) it runs the read
 *      tools. SPOTIFY_LIVE_WRITE=1 also creates a private test playlist, adds
 *      and removes one track (the playlist stays in the account: unfollowing
 *      needs a scope the connector does not ask for). SPOTIFY_LIVE_PLAYBACK=1
 *      queues a track, pauses and resumes (Premium and an open Spotify app):
 *
 *        RUN_SPOTIFY_LIVE=1 SPOTIFY_ACCESS_TOKEN=... npx jest src/adapters/intl/spotify.live.spec.ts
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
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  appRegistrationUrl: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.spotify.com/v1';
// Built at run time so nothing here looks like a real token.
const FAKE_TOKEN = ['test', 'token', 'x'.repeat(16)].join('-');
// OAUTH2 puts the access token on the request as a Bearer token, as here.
const call = (name: string, params: Record<string, unknown>, token = FAKE_TOKEN) =>
  new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: a.connector.headers },
    tool(name).endpointMapping as any,
    applySchemaDefaults(tool(name).parameters as any, params),
  ) as Promise<any>;
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

const SCOPES = [
  'user-read-private', 'playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-public',
  'playlist-modify-private', 'user-library-read', 'user-follow-read', 'user-top-read', 'user-read-recently-played',
  'user-read-playback-state', 'user-read-currently-playing', 'user-modify-playback-state',
];
const TRACK = '11dFghVXANMlKmJXsNCbNl';
const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['spotify_get_me', {}, 'GET', '/me'],
  ['spotify_search', { q: 'Miles Davis' }, 'GET', '/search'],
  ['spotify_get_track', { track_id: TRACK }, 'GET', `/tracks/${TRACK}`],
  ['spotify_get_album', { album_id: '4aawyAB9vmqN3uQ7FjRGTy' }, 'GET', '/albums/4aawyAB9vmqN3uQ7FjRGTy'],
  ['spotify_get_artist', { artist_id: '0TnOYISbd1XYRBk9myaseg' }, 'GET', '/artists/0TnOYISbd1XYRBk9myaseg'],
  ['spotify_get_artist_albums', { artist_id: '0TnOYISbd1XYRBk9myaseg' }, 'GET', '/artists/0TnOYISbd1XYRBk9myaseg/albums'],
  ['spotify_get_playlist', { playlist_id: '3cEYpjA9oz9GiPac4AsH4n' }, 'GET', '/playlists/3cEYpjA9oz9GiPac4AsH4n'],
  ['spotify_get_playlist_items', { playlist_id: '3cEYpjA9oz9GiPac4AsH4n' }, 'GET', '/playlists/3cEYpjA9oz9GiPac4AsH4n/items'],
  ['spotify_list_my_playlists', {}, 'GET', '/me/playlists'],
  ['spotify_get_top_items', { type: 'tracks' }, 'GET', '/me/top/tracks'],
  ['spotify_get_recently_played', {}, 'GET', '/me/player/recently-played'],
  ['spotify_get_playback_state', {}, 'GET', '/me/player'],
  ['spotify_get_currently_playing', {}, 'GET', '/me/player/currently-playing'],
  ['spotify_list_devices', {}, 'GET', '/me/player/devices'],
  ['spotify_get_queue', {}, 'GET', '/me/player/queue'],
  ['spotify_list_saved_tracks', {}, 'GET', '/me/tracks'],
  ['spotify_check_library', { uris: `spotify:track:${TRACK}` }, 'GET', '/me/library/contains'],
  ['spotify_create_playlist', { name: 'Test' }, 'POST', '/me/playlists'],
  ['spotify_add_playlist_items', { playlist_id: 'p1', uris: [`spotify:track:${TRACK}`] }, 'POST', '/playlists/p1/items'],
  ['spotify_remove_playlist_items', { playlist_id: 'p1', items: [{ uri: `spotify:track:${TRACK}` }] }, 'DELETE', '/playlists/p1/items'],
  ['spotify_start_playback', {}, 'PUT', '/me/player/play'],
  ['spotify_pause_playback', {}, 'PUT', '/me/player/pause'],
  ['spotify_skip_to_next', {}, 'POST', '/me/player/next'],
  ['spotify_skip_to_previous', {}, 'POST', '/me/player/previous'],
  ['spotify_add_to_queue', { uri: `spotify:track:${TRACK}` }, 'POST', '/me/player/queue'],
  ['spotify_save_to_library', { uris: `spotify:track:${TRACK}` }, 'PUT', '/me/library'],
  ['spotify_remove_from_library', { uris: `spotify:track:${TRACK}` }, 'DELETE', '/me/library'],
];
const OFF = ['spotify_remove_from_library', 'spotify_save_to_library'];
const CHANGES = [
  'spotify_add_playlist_items', 'spotify_add_to_queue', 'spotify_create_playlist', 'spotify_pause_playback',
  'spotify_remove_playlist_items', 'spotify_skip_to_next', 'spotify_skip_to_previous', 'spotify_start_playback',
];
const PLAYBACK = ['spotify_add_to_queue', 'spotify_pause_playback', 'spotify_skip_to_next', 'spotify_skip_to_previous', 'spotify_start_playback'];

describe('spotify adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.icon).toBe('spotify');
  });

  it('signs in through Spotify OAuth (authorization code, PKCE on by default, HTTP Basic at the token endpoint)', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{SPOTIFY_CLIENT_ID}}',
      clientSecret: '{{SPOTIFY_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.spotify.com/authorize',
      tokenUrl: 'https://accounts.spotify.com/api/token',
      tokenAuthMethod: 'client_secret_basic',
      scopes: SCOPES.join(' '),
    });
    // PKCE is the engine default; Spotify supports it, so nothing turns it off.
    expect(a.connector.authConfig.pkce).toBeUndefined();
    expect(needsBrowserAuthorization(a as never)).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/me');
    expect(a.probe).toEqual({ tool: 'spotify_get_me' });
    expect(a.requiredEnvVars).toEqual(['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.SPOTIFY_CLIENT_SECRET.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta.SPOTIFY_CLIENT_ID.pattern!);
    expect(pattern.test('0a1b2c3d4e5f60718293a4b5c6d7e8f9')).toBe(true);
    expect(pattern.test('not a client id')).toBe(false);
    expect(a.appRegistrationUrl).toBe('https://developer.spotify.com/dashboard');
    for (const key of ['401', '403', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('explains the 2026 development-mode limits, redirect URI rules and every scope', () => {
    expect(a.instructions).toMatch(/Spotify Premium/);
    expect(a.instructions).toMatch(/At most \*\*5 Spotify users\*\*/);
    expect(a.instructions).toMatch(/250,000 monthly active users/);
    expect(a.instructions).toMatch(/recommendations, audio features/);
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('http://127.0.0.1:<port>');
    expect(a.instructions).toMatch(/`localhost` is refused/);
    for (const scope of SCOPES) expect(a.instructions).toContain(`\`${scope}\``);
    expect(a.prerequisites).toMatch(/Premium/);
  });

  it('prefixes every tool with spotify_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^spotify_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('uses no endpoint Spotify removed for development-mode apps', () => {
    const removed = [
      /^\/recommendations/, /^\/audio-features/, /^\/audio-analysis/, /\/related-artists$/, /\/top-tracks$/,
      /^\/browse\//, /^\/users\//, /^\/markets$/, /^\/(tracks|albums|artists)$/, /^\/playlists\/[^/]+\/tracks$/, /^\/me\/following/,
      /\/followers/,
    ];
    for (const t of a.tools) for (const r of removed) expect(`${t.name}:${r.test(t.endpointMapping.path)}`).toBe(`${t.name}:false`);
    // The two search-style limits that shrank to 10.
    expect(tool('spotify_search').parameters.properties!.limit.maximum).toBe(10);
    expect(tool('spotify_get_artist_albums').parameters.properties!.limit.maximum).toBe(10);
  });

  it('asks before every change, keeps library writes off and marks reads read-only', () => {
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET';
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${!write}`);
      if (write) expect(`${t.name}:${/wait for their yes/.test(t.description)}`).toBe(`${t.name}:true`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET' && t.enabled !== false).map((t) => t.name).sort()).toEqual(CHANGES);
    for (const name of PLAYBACK) expect(tool(name).description).toMatch(/Premium/);
  });

  it('documents every tool, points only at real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bspotify_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bspotify_[a-z_]+/g)]),
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
    // Writes that answer 204 and the boolean list of check_library return nothing to shape.
    const bare = ['spotify_check_library', ...PLAYBACK, ...OFF];
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:${!bare.includes(t.name)}`);
      if (!tr) continue;
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.expression).toBeDefined();
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
  });

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer token', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('builds search, paging and playback queries as the OpenAPI document defines them', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('spotify_search', { q: 'track:Doxy artist:Miles Davis', type: 'track,album', offset: 10 });
    expect(sent().params).toEqual({ q: 'track:Doxy artist:Miles Davis', type: 'track,album', limit: 5, offset: 10 });
    mockedAxios.mockClear();
    await call('spotify_get_top_items', { type: 'artists', time_range: 'short_term' });
    expect(sent().url).toBe(`${BASE}/me/top/artists`);
    expect(sent().params).toEqual({ time_range: 'short_term', limit: 20 });
    mockedAxios.mockClear();
    await call('spotify_get_recently_played', { before: 1700000000000 });
    expect(sent().params).toEqual({ limit: 20, before: 1700000000000 });
    mockedAxios.mockClear();
    await call('spotify_add_to_queue', { uri: `spotify:track:${TRACK}`, device_id: 'dev1' });
    expect(sent().params).toEqual({ uri: `spotify:track:${TRACK}`, device_id: 'dev1' });
    mockedAxios.mockClear();
    await call('spotify_check_library', { uris: `spotify:track:${TRACK},spotify:album:a1` });
    expect(sent().params).toEqual({ uris: `spotify:track:${TRACK},spotify:album:a1` });
  });

  it('builds the playlist and playback bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('spotify_create_playlist', { name: 'Road trip', public: false, description: 'Made by AI' });
    expect(sent().data).toEqual({ name: 'Road trip', public: false, description: 'Made by AI' });
    mockedAxios.mockClear();
    await call('spotify_add_playlist_items', { playlist_id: 'p1', uris: ['spotify:track:a', 'spotify:episode:b'], position: 0 });
    expect(sent().data).toEqual({ uris: ['spotify:track:a', 'spotify:episode:b'], position: 0 });
    mockedAxios.mockClear();
    await call('spotify_remove_playlist_items', { playlist_id: 'p1', items: [{ uri: 'spotify:track:a' }], snapshot_id: 'snap' });
    expect(sent().data).toEqual({ items: [{ uri: 'spotify:track:a' }], snapshot_id: 'snap' });
    mockedAxios.mockClear();
    await call('spotify_start_playback', { context_uri: 'spotify:album:x', offset: { position: 2 }, device_id: 'dev1' });
    expect(sent().params).toEqual({ device_id: 'dev1' });
    expect(sent().data).toEqual({ context_uri: 'spotify:album:x', offset: { position: 2 } });
  });

  it('shapes search results per type and leaves out the types not asked for', () => {
    const out = shape('spotify_search', {
      tracks: {
        total: 812, next: 'https://api.spotify.com/v1/search?offset=5', limit: 5, href: 'h',
        items: [{ id: TRACK, name: 'Doxy', uri: `spotify:track:${TRACK}`, artists: [{ id: 'a', name: 'Miles Davis', href: 'x' }],
          album: { name: 'Bags Groove', release_date: '1957', images: [{ url: 'big' }] }, duration_ms: 290000, explicit: false,
          external_urls: { spotify: `https://open.spotify.com/track/${TRACK}` }, available_markets: ['DE'] }],
      },
      playlists: { total: 1, next: null, items: [null, { id: 'p', name: 'Jazz', uri: 'spotify:playlist:p', owner: { display_name: 'me' }, items: { total: 12 }, external_urls: { spotify: 'u' } }] },
    });
    expect(out.tracks).toEqual({
      total: 812, next: 'https://api.spotify.com/v1/search?offset=5',
      items: [{ id: TRACK, name: 'Doxy', uri: `spotify:track:${TRACK}`, artists: ['Miles Davis'], album: 'Bags Groove', release_date: '1957', duration_ms: 290000, explicit: false, url: `https://open.spotify.com/track/${TRACK}` }],
    });
    expect(out.playlists.items[1]).toEqual({ id: 'p', name: 'Jazz', uri: 'spotify:playlist:p', owner: 'me', items_total: 12, url: 'u' });
    expect(out.artists).toBeNull();
  });

  it('reads playlist items under the 2026 field names and still under the old ones', () => {
    const item = { type: 'track', id: 't', name: 'So What', uri: 'spotify:track:t', artists: [{ name: 'Miles Davis' }], album: { name: 'Kind of Blue' }, duration_ms: 1, external_urls: { spotify: 'u' } };
    const now = shape('spotify_get_playlist_items', { total: 1, offset: 0, next: null, items: [{ added_at: '2026-01-01T00:00:00Z', added_by: { id: 'me' }, is_local: false, item }] });
    const before = shape('spotify_get_playlist_items', { total: 1, offset: 0, next: null, items: [{ added_at: '2026-01-01T00:00:00Z', added_by: { id: 'me' }, is_local: false, track: item }] });
    expect(now).toEqual(before);
    expect(now.items[0].item).toEqual({ type: 'track', id: 't', name: 'So What', uri: 'spotify:track:t', artists: ['Miles Davis'], album: 'Kind of Blue', show: null, duration_ms: 1, url: 'u' });
    expect(shape('spotify_get_playlist', { id: 'p', name: 'Mine', tracks: { total: 3, items: [item] } }).items_total).toBe(3);
    expect(shape('spotify_get_playlist', { id: 'p', name: 'Mine', items: { total: 4, items: [item] } }).items_total).toBe(4);
    expect(shape('spotify_list_my_playlists', { total: 1, items: [{ id: 'p', name: 'Mine', owner: { id: 'u1', display_name: 'U' }, items: { total: 7 } }] }).items[0]).toMatchObject({ id: 'p', owner: 'U', owner_id: 'u1', items_total: 7 });
  });

  it('shapes the profile, playback state and devices', () => {
    expect(shape('spotify_get_me', { id: 'u1', account_id: 'acc', display_name: 'U', uri: 'spotify:user:u1', external_urls: { spotify: 'url' }, images: [{ url: 'img' }], followers: { total: 3 } }))
      .toEqual({ id: 'u1', account_id: 'acc', display_name: 'U', uri: 'spotify:user:u1', url: 'url' });
    const state = shape('spotify_get_playback_state', {
      is_playing: true, progress_ms: 1000, shuffle_state: false, repeat_state: 'off', currently_playing_type: 'track', timestamp: 1,
      device: { id: 'd', name: 'Kitchen', type: 'Speaker', volume_percent: 40, is_active: true, supports_volume: true },
      context: { uri: 'spotify:playlist:p', href: 'h' }, actions: { disallows: {} },
      item: { type: 'track', id: 't', name: 'So What', uri: 'spotify:track:t', artists: [{ name: 'Miles Davis' }], album: { name: 'Kind of Blue', images: [] }, duration_ms: 2, external_urls: { spotify: 'u' } },
    });
    expect(state).toMatchObject({ is_playing: true, device: { name: 'Kitchen', volume_percent: 40 }, context: 'spotify:playlist:p', item: { name: 'So What', artists: ['Miles Davis'] } });
    expect(state.actions).toBeUndefined();
    expect(shape('spotify_list_devices', { devices: [{ id: 'd', name: 'Phone', type: 'Smartphone', is_active: false, volume_percent: 80, supports_volume: true }] }).devices[0])
      .toEqual({ id: 'd', name: 'Phone', type: 'Smartphone', is_active: false, is_private_session: null, is_restricted: null, volume_percent: 80 });
  });
});

const live = process.env.RUN_SPOTIFY_LIVE === '1' ? describe : describe.skip;
live('spotify adapter: live', () => {
  const token = process.env.SPOTIFY_ACCESS_TOKEN;
  const writes = !!token && process.env.SPOTIFY_LIVE_WRITE === '1';
  const playback = !!token && process.env.SPOTIFY_LIVE_PLAYBACK === '1';
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each(table)('%s reaches a real route and is refused with a wrong token (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers a made-up route with 410 even with a wrong token, which makes the 401s above meaningful', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ method: 'GET', url: `${BASE}/me/no-such-route`, headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }),
    ).rejects.toMatchObject({ response: { status: 410 } });
  }, 30000);

  (token ? it : it.skip)('runs the read tools on the signed-in account', async () => {
    const run = async (name: string, params: Record<string, unknown> = {}) => shape(name, await call(name, params, token));
    const me = await run('spotify_get_me');
    expect(me.id).toBeTruthy();
    const search = await run('spotify_search', { q: 'Miles Davis', type: 'track,artist' });
    expect(search.tracks.items.length).toBeGreaterThan(0);
    const track = await run('spotify_get_track', { track_id: search.tracks.items[0].id });
    expect(track.name).toBeTruthy();
    const artistId = search.artists.items[0].id;
    expect((await run('spotify_get_artist', { artist_id: artistId })).name).toBeTruthy();
    const albums = await run('spotify_get_artist_albums', { artist_id: artistId });
    expect(albums.items.length).toBeGreaterThan(0);
    expect((await run('spotify_get_album', { album_id: albums.items[0].id })).tracks.items.length).toBeGreaterThan(0);
    const playlists = await run('spotify_list_my_playlists', { limit: 5 });
    expect(typeof playlists.total).toBe('number');
    const own = playlists.items.find((p: any) => p.owner_id === me.id);
    if (own) {
      expect((await run('spotify_get_playlist', { playlist_id: own.id })).id).toBe(own.id);
      expect(typeof (await run('spotify_get_playlist_items', { playlist_id: own.id, limit: 5 })).total).toBe('number');
    }
    expect(Array.isArray((await run('spotify_get_top_items', { type: 'tracks', limit: 5 })).items)).toBe(true);
    expect(Array.isArray((await run('spotify_get_recently_played', { limit: 5 })).items)).toBe(true);
    expect(Array.isArray((await run('spotify_list_saved_tracks', { limit: 5 })).items)).toBe(true);
    expect(Array.isArray((await run('spotify_list_devices')).devices)).toBe(true);
    expect(await call('spotify_check_library', { uris: `spotify:track:${search.tracks.items[0].id}` }, token)).toHaveLength(1);
    await call('spotify_get_playback_state', {}, token);
    await call('spotify_get_currently_playing', {}, token);
  }, 120000);

  (writes ? it : it.skip)('creates a private test playlist, adds and removes one track', async () => {
    const created = shape('spotify_create_playlist', await call('spotify_create_playlist', { name: 'AnythingMCP live test', public: false }, token));
    expect(created.id).toBeTruthy();
    const uri = `spotify:track:${TRACK}`;
    expect(shape('spotify_add_playlist_items', await call('spotify_add_playlist_items', { playlist_id: created.id, uris: [uri] }, token)).snapshot_id).toBeTruthy();
    const items = shape('spotify_get_playlist_items', await call('spotify_get_playlist_items', { playlist_id: created.id }, token));
    expect(items.items[0].item.uri).toBe(uri);
    expect(shape('spotify_remove_playlist_items', await call('spotify_remove_playlist_items', { playlist_id: created.id, items: [{ uri }] }, token)).snapshot_id).toBeTruthy();
  }, 60000);

  (playback ? it : it.skip)('queues a track, pauses and resumes (Premium, open Spotify app)', async () => {
    await call('spotify_add_to_queue', { uri: `spotify:track:${TRACK}` }, token);
    await call('spotify_pause_playback', {}, token);
    await call('spotify_start_playback', {}, token);
  }, 60000);
});
