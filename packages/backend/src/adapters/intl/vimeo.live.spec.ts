import axios from 'axios';
import * as adapter from './vimeo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Vimeo adapter (API 3.4):
 *
 *   1. Static: always runs. Pins the Bearer token and the versioned Accept
 *      header, every tool's method, URL, query (including the reduced `fields`
 *      each tool asks for) and body through the real RestEngine, which tools
 *      change something and ask first, the delete switched off, and the
 *      response shaping.
 *      Checked on 15 Oct 2026 against Vimeo's official OpenAPI document
 *      (github.com/vimeo/openapi, api.yaml 3.4) and the newer 3.4.9 document
 *      embedded in developer.vimeo.com/api/reference (folders and their items,
 *      showcases, text tracks, transcripts, pull uploads, video edits).
 *
 *   2. Live: skipped unless RUN_VIMEO_LIVE=1. Every route answers 401 to a
 *      wrong token while a made-up route answers 404, so the 401s prove the
 *      routes exist. With VIMEO_ACCESS_TOKEN it runs the read tools on that
 *      account; VIMEO_LIVE_WRITE=1 with VIMEO_TEST_VIDEO_ID also sets that
 *      video's title to its current value (no visible change). Uploads are
 *      not exercised: they use the account's quota.
 *
 *        RUN_VIMEO_LIVE=1 VIMEO_ACCESS_TOKEN=... npx jest src/adapters/intl/vimeo.live.spec.ts
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
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.vimeo.com';
// Built at run time so nothing here looks like a real token.
const FAKE_TOKEN = ['0'.repeat(28), 'beef'].join('');
const call = (name: string, params: Record<string, unknown>, token = FAKE_TOKEN) =>
  new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: a.connector.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, { VIMEO_ACCESS_TOKEN: token }),
      headers: a.connector.headers,
    } as any,
    tool(name).endpointMapping as any,
    applySchemaDefaults(tool(name).parameters as any, params),
  ) as Promise<any>;
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

const V = '76979871';
const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['vimeo_get_me', {}, 'GET', '/me'],
  ['vimeo_list_my_videos', {}, 'GET', '/me/videos'],
  ['vimeo_get_video', { video_id: V }, 'GET', `/videos/${V}`],
  ['vimeo_list_folders', {}, 'GET', '/me/projects'],
  ['vimeo_list_folder_items', { folder_id: '456' }, 'GET', '/me/projects/456/items'],
  ['vimeo_list_folder_videos', { folder_id: '456' }, 'GET', '/me/projects/456/videos'],
  ['vimeo_list_showcases', {}, 'GET', '/me/albums'],
  ['vimeo_list_showcase_videos', { showcase_id: '789' }, 'GET', '/me/albums/789/videos'],
  ['vimeo_list_video_comments', { video_id: V }, 'GET', `/videos/${V}/comments`],
  ['vimeo_list_text_tracks', { video_id: V }, 'GET', `/videos/${V}/texttracks`],
  ['vimeo_get_transcript', { video_id: V, texttrack_id: '123' }, 'GET', `/videos/${V}/transcripts/123`],
  ['vimeo_upload_video_from_url', { video_url: 'https://example.com/v.mp4' }, 'POST', '/me/videos'],
  ['vimeo_update_video', { video_id: V, name: 'New' }, 'PATCH', `/videos/${V}`],
  ['vimeo_delete_video', { video_id: V }, 'DELETE', `/videos/${V}`],
];

describe('vimeo adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.icon).toBe('vimeo');
  });

  it('sends the personal access token as Bearer with the versioned Accept header', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{VIMEO_ACCESS_TOKEN}}' });
    expect(a.connector.headers.Accept).toBe('application/vnd.vimeo.*+json;version=3.4');
    expect(a.connector.healthcheckPath).toBe('/me');
    expect(a.probe).toEqual({ tool: 'vimeo_get_me' });
    expect(a.requiredEnvVars).toEqual(['VIMEO_ACCESS_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.VIMEO_ACCESS_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.VIMEO_ACCESS_TOKEN.pattern!);
    expect(pattern.test(FAKE_TOKEN)).toBe(true);
    expect(pattern.test(`Bearer ${FAKE_TOKEN}`)).toBe(false);
    for (const key of ['401', '403', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    for (const scope of ['Public', 'Private', 'Edit', 'Upload', 'Stats']) expect(a.instructions).toContain(`**${scope}**`);
  });

  it('prefixes every tool with vimeo_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^vimeo_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('asks before every change, keeps the delete off and marks reads read-only', () => {
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET';
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${!write}`);
      if (write && t.enabled !== false) expect(`${t.name}:${/wait for their yes/.test(t.description)}`).toBe(`${t.name}:true`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['vimeo_delete_video']);
    expect(tool('vimeo_delete_video').description).toMatch(/explicit yes/);
  });

  it('documents every tool, points only at real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bvimeo_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bvimeo_[a-z_]+/g)]),
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
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:${t.name !== 'vimeo_delete_video'}`);
      if (!tr) continue;
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.expression).toBeDefined();
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
    // Every read except the transcript asks Vimeo for a reduced set of fields.
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET' && x.name !== 'vimeo_get_transcript')) {
      expect(`${t.name}:${typeof t.endpointMapping.queryParams?.fields}`).toBe(`${t.name}:string`);
    }
  });

  it('caps per_page at 100 as the API does', () => {
    for (const t of a.tools) {
      const pp = t.parameters.properties?.per_page;
      if (pp) expect(`${t.name}:${pp.maximum}`).toBe(`${t.name}:100`);
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
    expect(req.headers.Accept).toBe('application/vnd.vimeo.*+json;version=3.4');
  });

  it('builds search and paging queries', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('vimeo_list_my_videos', { query: 'demo', sort: 'date', direction: 'desc', page: 2, per_page: 10 });
    expect(sent().params).toMatchObject({ query: 'demo', sort: 'date', direction: 'desc', page: 2, per_page: 10 });
    expect(sent().params.fields).toContain('privacy.view');
    mockedAxios.mockClear();
    await call('vimeo_list_folder_items', { folder_id: '456', filter: 'video' });
    expect(sent().params).toMatchObject({ filter: 'video' });
    expect(sent().params.fields).toContain('folder.uri');
  });

  it('uploads by pull with the documented body and edits only what is given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('vimeo_upload_video_from_url', {
      video_url: 'https://example.com/v.mp4', name: 'Demo', privacy: { view: 'unlisted' }, folder_uri: '/users/1/projects/456',
    });
    expect(sent().data).toEqual({
      upload: { approach: 'pull', link: 'https://example.com/v.mp4' },
      name: 'Demo',
      privacy: { view: 'unlisted' },
      folder_uri: '/users/1/projects/456',
    });
    mockedAxios.mockClear();
    await call('vimeo_update_video', { video_id: V, description: 'New text', privacy: { view: 'password' }, password: 'secret1' });
    expect(sent().data).toEqual({ description: 'New text', privacy: { view: 'password' }, password: 'secret1' });
  });

  it('shapes lists and the account, and drops embed HTML from a video', () => {
    const list = shape('vimeo_list_my_videos', {
      total: 2, page: 1, per_page: 25,
      paging: { next: '/me/videos?page=2', previous: null, first: '/me/videos?page=1', last: '/me/videos?page=2' },
      data: [{ uri: `/videos/${V}`, name: 'Demo' }],
    });
    expect(list).toEqual({ total: 2, page: 1, per_page: 25, next: '/me/videos?page=2', data: [{ uri: `/videos/${V}`, name: 'Demo' }] });
    expect(shape('vimeo_get_me', { uri: '/users/1', name: 'Me', account: 'free', upload_quota: { space: { free: 1 } }, metadata: { connections: { videos: { total: 3 } } } }))
      .toEqual({ uri: '/users/1', name: 'Me', account: 'free', upload_quota: { space: { free: 1 } }, videos_total: 3 });
    const video = shape('vimeo_get_video', { uri: `/videos/${V}`, name: 'Demo', embed: { html: '<iframe/>' }, pictures: { sizes: [] } });
    expect(video).toEqual({ uri: `/videos/${V}`, name: 'Demo' });
  });
});

const live = process.env.RUN_VIMEO_LIVE === '1' ? describe : describe.skip;
live('vimeo adapter: live', () => {
  const token = process.env.VIMEO_ACCESS_TOKEN;
  const testVideo = process.env.VIMEO_TEST_VIDEO_ID;
  const writes = !!token && !!testVideo && process.env.VIMEO_LIVE_WRITE === '1';
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each(table)('%s reaches a real route and is refused with a wrong token (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers a made-up route with 404 even with a wrong token, which makes the 401s above meaningful', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ method: 'GET', url: `${BASE}/me/no-such-route`, headers: { Authorization: `Bearer ${FAKE_TOKEN}`, Accept: a.connector.headers.Accept } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (token ? it : it.skip)('runs the read tools on the account', async () => {
    const run = async (name: string, params: Record<string, unknown> = {}) => shape(name, await call(name, params, token));
    const me = await run('vimeo_get_me');
    expect(me.uri).toMatch(/^\/users\/\d+$/);
    const videos = await run('vimeo_list_my_videos', { per_page: 3 });
    expect(typeof videos.total).toBe('number');
    const folders = await run('vimeo_list_folders', { per_page: 3 });
    expect(Array.isArray(folders.data)).toBe(true);
    if (folders.data[0]) {
      const folderId = folders.data[0].uri.split('/').pop();
      expect(Array.isArray((await run('vimeo_list_folder_items', { folder_id: folderId, per_page: 3 })).data)).toBe(true);
      expect(Array.isArray((await run('vimeo_list_folder_videos', { folder_id: folderId, per_page: 3 })).data)).toBe(true);
    }
    const showcases = await run('vimeo_list_showcases', { per_page: 3 });
    if (showcases.data[0]) {
      expect(Array.isArray((await run('vimeo_list_showcase_videos', { showcase_id: showcases.data[0].uri.split('/').pop(), per_page: 3 })).data)).toBe(true);
    }
    if (videos.data[0]) {
      const id = videos.data[0].uri.split('/').pop();
      expect((await run('vimeo_get_video', { video_id: id })).uri).toBe(videos.data[0].uri);
      expect(Array.isArray((await run('vimeo_list_video_comments', { video_id: id, per_page: 3 })).data)).toBe(true);
      const tracks = await run('vimeo_list_text_tracks', { video_id: id });
      expect(Array.isArray(tracks.data)).toBe(true);
      if (tracks.data[0]) await call('vimeo_get_transcript', { video_id: id, texttrack_id: String(tracks.data[0].id ?? tracks.data[0].uri.split('/').pop()) }, token);
    }
  }, 120000);

  (writes ? it : it.skip)('sets the test video title to its current value (no visible change)', async () => {
    const video = shape('vimeo_get_video', await call('vimeo_get_video', { video_id: testVideo }, token));
    const updated = shape('vimeo_update_video', await call('vimeo_update_video', { video_id: testVideo, name: video.name }, token));
    expect(updated.name).toBe(video.name);
  }, 60000);
});
