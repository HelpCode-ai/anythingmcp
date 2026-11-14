import axios from 'axios';
import * as adapter from './immich.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Immich adapter (read-only):
 *
 *   1. Static: always runs. Pins the API key in the `x-api-key` header on the
 *      server URL the user enters, GET-only tools, every tool's URL and query
 *      through the real RestEngine, and the response mappings that strip file
 *      paths, checksums, thumbhashes, OAuth ids and license keys, checked
 *      against the Immich OpenAPI spec (https://api.immich.app, v3.3.5, read
 *      29 Oct 2026).
 *
 *   2. Live: skipped unless RUN_IMMICH_LIVE=1 with IMMICH_URL and
 *      IMMICH_API_KEY set (a key with user.read, asset.read, asset.statistics,
 *      album.read and person.read, created by a non-admin user). Optional:
 *      IMMICH_PERSON_NAME (a named person that must be found),
 *      IMMICH_PLACE_NAME (default Berlin) and IMMICH_API_KEY_NO_PERSON (a key
 *      without person.read, to pin the 403). Logs the server version and the
 *      raw and mapped response sizes.
 *
 *        RUN_IMMICH_LIVE=1 IMMICH_URL=http://localhost:2283 \
 *        IMMICH_API_KEY=... npx jest src/adapters/intl/immich
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
  parameters: { properties?: Record<string, { description?: string; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'imk' + 'x'.repeat(40);
const ENV: Record<string, string> = { IMMICH_URL: 'https://photos.example.com', IMMICH_API_KEY: FAKE_KEY };
const API = 'https://photos.example.com/api';
const UUID = '1e80e25e-4f5f-48cf-8807-e25209774beb';

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => {
  const req = sent();
  return req.paramsSerializer ? decodeURIComponent(req.paramsSerializer(req.params)) : '';
};
const mapped = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;

describe('immich adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the API key as x-api-key to {{IMMICH_URL}}/api', () => {
    expect(a.category).toBe('storage');
    expect(a.icon).toBe('immich');
    expect(a.docsUrl).toBe('https://api.immich.app');
    expect(a.connector.baseUrl).toBe('{{IMMICH_URL}}/api');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-api-key', apiKey: '{{IMMICH_API_KEY}}' });
    expect(a.connector.headers).not.toHaveProperty('Content-Type');
    expect(a.connector.healthcheckPath).toBe('/server/ping');
    expect(a.probe.tool).toBe('immich_get_my_user');
    expect(a.requiredEnvVars).toEqual(['IMMICH_URL', 'IMMICH_API_KEY']);
    expect(Object.keys(a.verifyHints).sort()).toEqual(['401', '403', '404']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.IMMICH_URL).toMatchObject({ kind: 'address', secret: false });
    expect(meta.IMMICH_API_KEY).toMatchObject({ kind: 'credential', secret: true });
  });

  it('accepts server URLs without /api or a trailing slash, and a bare key', () => {
    const url = new RegExp(a.envVarMeta.IMMICH_URL.pattern!);
    for (const ok of ['https://photos.example.com', 'http://192.168.1.10:2283', 'http://immich.local:2283', 'https://example.com/immich']) expect(url.test(ok)).toBe(true);
    for (const bad of ['photos.example.com', 'https://photos.example.com/', 'http://192.168.1.10:2283/api', 'http://192.168.1.10:2283/api/']) expect(url.test(bad)).toBe(false);
    const key = new RegExp(a.envVarMeta.IMMICH_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `x-api-key ${FAKE_KEY}`, 'short']) expect(key.test(bad)).toBe(false);
  });

  it('is strictly read-only: eight GET tools, no uploads, downloads, admin or key management', () => {
    expect(a.tools).toHaveLength(8);
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations }))
        .toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.endpointMapping.path).not.toMatch(/admin|api-keys|original|thumbnail|video|download|shared-links|sessions|auth/);
    }
  });

  it('prefixes every tool and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    for (const name of mine) expect(name).toMatch(/^immich_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('instructions cover the five permissions, no admin, SSRF allowlist, Cloud reachability, 400 for unknown ids and privacy', () => {
    const i = a.instructions;
    expect(i.length).toBeGreaterThanOrEqual(800);
    for (const p of ['user.read', 'asset.read', 'asset.statistics', 'album.read', 'person.read']) {
      expect(i).toContain(`\`${p}\``);
      expect((a as any).prerequisites).toContain(p);
    }
    expect(i).toMatch(/No admin account is needed/);
    expect(i).toMatch(/x-api-key/);
    expect(i).toMatch(/SSRF_ALLOWED_HOSTS/);
    expect(i).toMatch(/Cloud can only reach .* public internet over HTTPS/);
    expect(i).toMatch(/Immich answers 400, not 404/);
    expect(i).toMatch(/Assign this connector only to MCP servers/);
    const names = new Set(a.tools.map((t) => t.name));
    for (const m of [...i.matchAll(/\bimmich_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bimmich_[a-z_]+/g)])]) expect(names).toContain(m[0]);
    for (const name of names) expect(i).toContain(`\`${name}\``);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, s] of Object.entries(t.parameters.properties ?? {})) expect(`${t.name}.${p}:${typeof s.description}`).toBe(`${t.name}.${p}:string`);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('ids are UUIDs, and visibility leaves out locked (an API key cannot read the locked folder)', () => {
    for (const [t, p] of [['immich_get_album', 'id'], ['immich_get_asset', 'id'], ['immich_list_albums', 'assetId'], ['immich_get_timeline_buckets', 'personId'], ['immich_get_timeline_buckets', 'albumId'], ['immich_get_timeline_buckets', 'tagId']]) {
      const re = new RegExp(tool(t).parameters.properties![p].pattern!);
      expect(re.test(UUID)).toBe(true);
      expect(re.test('not-a-uuid')).toBe(false);
    }
    for (const t of ['immich_get_asset_statistics', 'immich_get_timeline_buckets']) {
      expect((tool(t).parameters.properties!.visibility as any).enum).toEqual(['timeline', 'archive', 'hidden']);
    }
    expect(tool('immich_search_people').parameters.required).toEqual(['name']);
    expect(tool('immich_search_places').parameters.required).toEqual(['name']);
  });

  it('sends only the filters that were given, booleans as true/false', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('immich_get_timeline_buckets', { personId: UUID, isFavorite: false, visibility: 'timeline' });
    const q = query();
    expect(q).toContain(`personId=${UUID}`);
    expect(q).toContain('isFavorite=false');
    expect(q).toContain('visibility=timeline');
    expect(q).not.toMatch(/albumId|tagId|isTrashed|\$/);
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('immich_get_asset_statistics', {});
    expect(query()).toBe('');
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['immich_get_my_user', {}, '/users/me', ''],
    ['immich_get_asset_statistics', { isTrashed: true }, '/assets/statistics', 'isTrashed=true'],
    ['immich_list_albums', { isShared: true, name: 'Holidays' }, '/albums', 'isShared=true'],
    ['immich_get_album', { id: UUID }, `/albums/${UUID}`, ''],
    ['immich_get_asset', { id: UUID }, `/assets/${UUID}`, ''],
    ['immich_search_people', { name: 'Anna', withHidden: true }, '/search/person', 'name=Anna'],
    ['immich_get_timeline_buckets', { albumId: UUID }, '/timeline/buckets', `albumId=${UUID}`],
    ['immich_search_places', { name: 'Berlin' }, '/search/places', 'name=Berlin'],
  ];
  it('lists every tool in the URL table', () => expect(table.map(([n]) => n).sort()).toEqual(a.tools.map((t) => t.name).sort()));
  it.each(table)('%s sends GET to the right URL with the x-api-key header', async (name, params, path, q) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${API}${path}`);
    expect(req.headers['x-api-key']).toBe(FAKE_KEY);
    expect(req.headers.Authorization).toBeUndefined();
    expect(query()).toContain(q);
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('every transform is valid', () => {
    for (const t of a.tools) if (t.responseMapping) expect(`${t.name}:${validateTransform(t.responseMapping.transform)}`).toBe(`${t.name}:null`);
  });

  it('get_my_user drops the license keys, OAuth id and profile image path', () => {
    const raw = { id: UUID, name: 'Anna', email: 'a@example.com', isAdmin: false, quotaUsageInBytes: 1, profileImagePath: '/data/profile/x.jpg', oauthId: 'oid', license: { licenseKey: 'IMCL-x', activationKey: 'act', activatedAt: '2026-01-01' } };
    const out = mapped('immich_get_my_user', raw);
    expect(out).toEqual({ id: UUID, name: 'Anna', email: 'a@example.com', isAdmin: false, quotaUsageInBytes: 1 });
    expect(JSON.stringify(out)).not.toMatch(/IMCL|act|oid|\/data/);
  });

  it('get_asset drops server paths, checksum, thumbhash and every thumbnail path', () => {
    const raw = {
      id: UUID, originalFileName: 'IMG_1.jpg', originalPath: '/data/upload/u/a.jpg', checksum: 'c2hh', thumbhash: 'th',
      owner: { id: 'u', name: 'Anna', profileImagePath: '/data/profile/u.jpg' },
      exifInfo: { city: 'Arezzo', latitude: 43.4 },
      people: [{ id: 'p', name: 'Ben', thumbnailPath: '/data/thumbs/p.jpeg', faces: [] }],
      tags: [{ id: 't', name: 'travel', value: 'travel' }],
    };
    const out = mapped('immich_get_asset', raw);
    expect(out).toEqual({
      id: UUID, originalFileName: 'IMG_1.jpg', owner: { id: 'u', name: 'Anna' }, exifInfo: { city: 'Arezzo', latitude: 43.4 },
      people: [{ id: 'p', name: 'Ben', faces: [] }], tags: [{ id: 't', name: 'travel', value: 'travel' }],
    });
  });

  it('search_people drops thumbnail paths; get_album drops member profile image paths', () => {
    expect(mapped('immich_search_people', [{ id: 'p', name: 'Ben', thumbnailPath: '/data/thumbs/p.jpeg' }])).toEqual([{ id: 'p', name: 'Ben' }]);
    const album = { id: UUID, albumName: 'Holidays', albumUsers: [{ role: 'owner', user: { id: 'u', name: 'Anna', profileImagePath: '/data/profile/u.jpg' } }] };
    expect(mapped('immich_get_album', album)).toEqual({ id: UUID, albumName: 'Holidays', albumUsers: [{ role: 'owner', user: { id: 'u', name: 'Anna' } }] });
  });

  it('list_albums shapes each album to a compact row with owner and members', () => {
    const raw = [{
      id: UUID, albumName: 'Family', description: '', assetCount: 3, shared: true, startDate: '2026-01-01T00:00:00Z', endDate: '2026-02-01T00:00:00Z',
      albumThumbnailAssetId: 'a1', createdAt: 'x', updatedAt: 'x', hasSharedLink: false, isActivityEnabled: true, order: 'desc',
      albumUsers: [
        { role: 'owner', user: { id: 'u1', name: 'Anna', email: 'anna@example.com', profileImagePath: '/data/p.jpg', avatarColor: 'gray' } },
        { role: 'viewer', user: { id: 'u2', name: 'Ben', email: 'ben@example.com', profileImagePath: '', avatarColor: 'pink' } },
      ],
    }];
    expect(mapped('immich_list_albums', raw)).toEqual([{
      id: UUID, albumName: 'Family', description: '', assetCount: 3, shared: true, startDate: '2026-01-01T00:00:00Z', endDate: '2026-02-01T00:00:00Z',
      albumThumbnailAssetId: 'a1', owner: 'Anna', members: [{ name: 'Ben', role: 'viewer' }],
    }]);
  });
});

const live = process.env.RUN_IMMICH_LIVE === '1' && process.env.IMMICH_URL && process.env.IMMICH_API_KEY ? describe : describe.skip;
live('immich adapter: live', () => {
  const env = { IMMICH_URL: process.env.IMMICH_URL!, IMMICH_API_KEY: process.env.IMMICH_API_KEY! };
  const body = (res: any) => (res && typeof res === 'object' && 'data' in res ? res.data : res);
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const sizes: Record<string, string> = {};
  const both = async (name: string, params: Record<string, unknown>) => {
    const raw = body(await call(name, params, env));
    const out = tool(name).responseMapping ? mapped(name, raw) : raw;
    sizes[name] = `${size(raw)} B raw, ${size(out)} B mapped`;
    return { raw, out };
  };
  const status = async (p: Promise<unknown>) => {
    try {
      await p;
      return 200;
    } catch (e: any) {
      return e?.response?.status ?? e?.status ?? String(e?.message ?? e);
    }
  };
  const statusOf = (s: unknown) => (typeof s === 'number' ? s : Number(/\b(4\d\d)\b/.exec(String(s))?.[1] ?? NaN));
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => console.log(`Immich response sizes:\n${JSON.stringify(sizes, null, 2)}`));

  it('the healthcheck /server/ping answers pong; logs the server version', async () => {
    const { config } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, { method: 'GET', path: '/' }, env);
    const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
    const cfg = { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, env), headers: config.headers } as any;
    expect(body(await engine.execute(cfg, { method: 'GET', path: a.connector.healthcheckPath! }, {}))).toEqual({ res: 'pong' });
    const v = body(await engine.execute(cfg, { method: 'GET', path: '/server/version' }, {}));
    console.log(`Immich server version ${v.major}.${v.minor}.${v.patch}`);
    expect(v.major).toBeGreaterThanOrEqual(3);
  }, 30000);

  it('get_my_user answers without license, oauthId or profileImagePath', async () => {
    const { raw, out } = await both('immich_get_my_user', {});
    expect(raw.id).toBeTruthy();
    expect(out).not.toHaveProperty('license');
    expect(out).not.toHaveProperty('oauthId');
    expect(out).not.toHaveProperty('profileImagePath');
    console.log(`Immich key user isAdmin=${raw.isAdmin}`);
  }, 30000);

  it('get_asset_statistics: default leaves out the trash; visibility and isTrashed narrow it', async () => {
    const all = body(await call('immich_get_asset_statistics', {}, env));
    const timeline = body(await call('immich_get_asset_statistics', { visibility: 'timeline' }, env));
    const archive = body(await call('immich_get_asset_statistics', { visibility: 'archive' }, env));
    const trash = body(await call('immich_get_asset_statistics', { isTrashed: true }, env));
    for (const s of [all, timeline, archive, trash]) expect(Object.keys(s).sort()).toEqual(['images', 'total', 'videos']);
    expect(timeline.total).toBeLessThanOrEqual(all.total);
    console.log(`Immich statistics: default ${all.total}, timeline ${timeline.total}, archive ${archive.total}, trash ${trash.total}`);
  }, 30000);

  let albumId = '';
  let assetId = '';
  it('list_albums returns compact rows; get_album has members but no asset list', async () => {
    const { out } = await both('immich_list_albums', {});
    expect(Array.isArray(out)).toBe(true);
    if (!out.length) return;
    expect(Object.keys(out[0]).sort()).toEqual(['albumName', 'albumThumbnailAssetId', 'assetCount', 'description', 'endDate', 'id', 'members', 'owner', 'shared', 'startDate']);
    const withThumb = out.find((r: any) => r.albumThumbnailAssetId) ?? out[0];
    albumId = withThumb.id;
    assetId = withThumb.albumThumbnailAssetId ?? '';
    const album = await both('immich_get_album', { id: albumId });
    expect(album.out.id).toBe(albumId);
    expect(album.out).not.toHaveProperty('assets');
    expect(JSON.stringify(album.out)).not.toContain('profileImagePath');
  }, 30000);

  it('get_asset strips server paths and checksums', async () => {
    if (!assetId) return;
    const { out } = await both('immich_get_asset', { id: assetId });
    expect(out.id).toBe(assetId);
    for (const k of ['originalPath', 'checksum', 'thumbhash']) expect(out).not.toHaveProperty(k);
    expect(JSON.stringify(out)).not.toMatch(/thumbnailPath|profileImagePath|\/data\//);
  }, 30000);

  let personId = '';
  it('search_people finds people by name without thumbnail paths', async () => {
    const name = process.env.IMMICH_PERSON_NAME ?? 'a';
    const { out } = await both('immich_search_people', { name });
    expect(Array.isArray(out)).toBe(true);
    if (process.env.IMMICH_PERSON_NAME) expect(out.length).toBeGreaterThan(0);
    for (const p of out) expect(p).not.toHaveProperty('thumbnailPath');
    personId = out[0]?.id ?? '';
  }, 30000);

  it('get_timeline_buckets returns one {timeBucket, count} per month, newest first', async () => {
    const { out } = await both('immich_get_timeline_buckets', {});
    expect(Array.isArray(out)).toBe(true);
    for (const b of out) {
      expect(Object.keys(b).sort()).toEqual(['count', 'timeBucket']);
      expect(b.timeBucket).toMatch(/^\d{4}-\d{2}-01$/);
    }
    const sorted = [...out].map((b: any) => b.timeBucket).sort().reverse();
    expect(out.map((b: any) => b.timeBucket)).toEqual(sorted);
    const filters: Record<string, string>[] = [];
    if (personId) filters.push({ personId });
    if (albumId) filters.push({ albumId });
    for (const params of filters) {
      expect(Array.isArray(body(await call('immich_get_timeline_buckets', params, env)))).toBe(true);
    }
  }, 30000);

  it('search_places finds a place with coordinates', async () => {
    const { out } = await both('immich_search_places', { name: process.env.IMMICH_PLACE_NAME ?? 'Berlin' });
    expect(out.length).toBeGreaterThan(0);
    expect(typeof out[0].latitude).toBe('number');
    expect(typeof out[0].longitude).toBe('number');
  }, 30000);

  it('error codes: 400 for a non-UUID or unknown id, 401 for a wrong key, 403 for a missing permission', async () => {
    expect(statusOf(await status(call('immich_get_asset', { id: 'not-a-uuid' }, env)))).toBe(400);
    expect(statusOf(await status(call('immich_get_album', { id: '00000000-0000-4000-8000-000000000000' }, env)))).toBe(400);
    expect(statusOf(await status(call('immich_get_my_user', {}, { ...env, IMMICH_API_KEY: 'x'.repeat(43) })))).toBe(401);
    expect(statusOf(await status(call('immich_get_asset_statistics', { visibility: 'locked' }, env)))).toBe(401);
    if (process.env.IMMICH_API_KEY_NO_PERSON) {
      expect(statusOf(await status(call('immich_search_people', { name: 'a' }, { ...env, IMMICH_API_KEY: process.env.IMMICH_API_KEY_NO_PERSON })))).toBe(403);
    }
  }, 60000);
});
