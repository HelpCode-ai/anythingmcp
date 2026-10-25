import axios from 'axios';
import * as adapter from './heygen.json';
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
 * Two layers of verification for the HeyGen adapter:
 *
 *   1. Static: always runs. Pins the X-Api-Key header and every tool's
 *      method, URL, query and body through the real RestEngine, checked
 *      against HeyGen's v3 OpenAPI document
 *      (developers.heygen.com/openapi/external-api.json) and the official
 *      HeyGen CLI's generated command specs, read 14 Oct 2026. The adapter
 *      uses only v3: HeyGen retires the v1 and v2 endpoints on 31 Oct 2026.
 *      Also which tools only read, that every paid call states the cost and
 *      asks for confirmation, and that the delete ships switched off.
 *
 *   2. Live: skipped unless RUN_HEYGEN_LIVE=1. Without a key it checks that
 *      HeyGen refuses a wrong key with 401 on the real routes. With
 *      HEYGEN_API_KEY it reads the account, avatars, looks, voices, videos,
 *      templates, translation languages and jobs, shaped by each tool's
 *      response mapping as production does. Nothing that spends money runs
 *      unless RUN_HEYGEN_LIVE_WRITES=1 and HEYGEN_TEST_AVATAR_ID are set too:
 *      then one avatar video of a single short sentence is rendered with
 *      engine avatar_iii and polled until it has a download link.
 *
 *        RUN_HEYGEN_LIVE=1 HEYGEN_API_KEY=... \
 *          npx jest src/adapters/intl/heygen.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
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
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
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

const BASE = 'https://api.heygen.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'fake' + '0'.repeat(28);
const ENV: Record<string, string> = { HEYGEN_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
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
// What the model receives: the raw answer shaped by the tool's response mapping.
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) =>
  applyResponseTransform(await call(name, params, env), tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

const PAID = ['heygen_create_agent_video', 'heygen_create_video', 'heygen_generate_from_template', 'heygen_translate_video'];
const WRITES = [...PAID, 'heygen_create_photo_avatar', 'heygen_delete_video'].sort();

describe('heygen adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor SDK and API spec on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('authenticates with the X-Api-Key header on api.heygen.com and checks the account', () => {
    expect(a.category).toBe('publishing');
    expect(a.icon).toBe('heygen');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Api-Key', apiKey: '{{HEYGEN_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/v3/users/me');
    expect(a.probe).toEqual({ tool: 'heygen_get_account' });
    expect(a.requiredEnvVars).toEqual(['HEYGEN_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.HEYGEN_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    const key = new RegExp(a.envVarMeta.HEYGEN_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', 'abc', 'with space in the middle of key']) expect(key.test(bad)).toBe(false);
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('uses only v3 endpoints (v1 and v2 retire on 31 Oct 2026)', () => {
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/v3\//);
    expect(a.instructions).toMatch(/31 October 2026/);
  });

  it('prefixes every tool with heygen_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^heygen_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks only the creating calls as writes, states the cost and ships the delete switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of PAID) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tool(name).description).toMatch(/SPENDS MONEY/);
      expect(tool(name).description).toMatch(/[Cc]onfirm/);
    }
    expect(tool('heygen_create_photo_avatar').description).toMatch(/confirm they have that right/);
    expect(annotationsOf(tool('heygen_delete_video'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['heygen_delete_video']);
    expect(tool('heygen_delete_video').description).toMatch(/switched off/);
    for (const t of a.tools) if (!writes.includes(t.name)) expect(t.description).toMatch(/Free\.$/);
  });

  it('only points the model at tools that exist, explains the poll flow and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bheygen_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bheygen_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/\*\*How a video is made\*\*/);
    expect(a.instructions).toMatch(/every 30 seconds/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool that returns data a valid response mapping that does real work', () => {
    const passthrough = ['heygen_create_video', 'heygen_translate_video', 'heygen_delete_video'];
    for (const t of a.tools) {
      if (passthrough.includes(t.name)) continue;
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      // A transform with nothing but maxBytes is skipped at runtime.
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['heygen_list_avatar_groups', {}, 'GET', '/v3/avatars'],
    ['heygen_list_avatar_looks', {}, 'GET', '/v3/avatars/looks'],
    ['heygen_get_avatar_look', { look_id: 'l1' }, 'GET', '/v3/avatars/looks/l1'],
    ['heygen_list_voices', {}, 'GET', '/v3/voices'],
    ['heygen_create_video', { avatar_id: 'l1', script: 'Hi' }, 'POST', '/v3/videos'],
    ['heygen_get_video', { video_id: 'v1' }, 'GET', '/v3/videos/v1'],
    ['heygen_list_videos', {}, 'GET', '/v3/videos'],
    ['heygen_delete_video', { video_id: 'v1' }, 'DELETE', '/v3/videos/v1'],
    ['heygen_list_templates', {}, 'GET', '/v3/templates'],
    ['heygen_get_template', { template_id: 't1' }, 'GET', '/v3/templates/t1'],
    ['heygen_generate_from_template', { template_id: 't1', variables: {} }, 'POST', '/v3/templates/t1'],
    ['heygen_list_translation_languages', {}, 'GET', '/v3/video-translations/languages'],
    ['heygen_translate_video', { video_url: 'https://example.com/v.mp4', output_languages: ['German'] }, 'POST', '/v3/video-translations'],
    ['heygen_get_video_translation', { video_translation_id: 'vt1' }, 'GET', '/v3/video-translations/vt1'],
    ['heygen_list_video_translations', {}, 'GET', '/v3/video-translations'],
    ['heygen_create_agent_video', { prompt: 'A 30 second intro to our product' }, 'POST', '/v3/video-agents'],
    ['heygen_get_agent_session', { session_id: 's1' }, 'GET', '/v3/video-agents/s1'],
    ['heygen_create_photo_avatar', { name: 'Ada', photo_url: 'https://example.com/ada.jpg' }, 'POST', '/v3/avatars'],
    ['heygen_get_account', {}, 'GET', '/v3/users/me'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the X-Api-Key header', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers['X-Api-Key']).toBe(FAKE_KEY);
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('sends the documented cursor pagination and filters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('heygen_list_avatar_looks', { group_id: 'g1', ownership: 'private', limit: 50, token: 'n1' });
    expect(sent().params).toEqual({ group_id: 'g1', ownership: 'private', limit: 50, token: 'n1' });
    mockedAxios.mockClear();
    await call('heygen_list_voices', { language: 'German', gender: 'female', type: 'public' });
    expect(sent().params).toEqual({ type: 'public', language: 'German', gender: 'female' });
    mockedAxios.mockClear();
    await call('heygen_list_videos', { title: 'launch', limit: 5 });
    expect(sent().params).toEqual({ title: 'launch', limit: 5 });
  });

  it('builds the v3 avatar video body with the type discriminator and nothing unset', async () => {
    mockedAxios.mockResolvedValue({ data: { data: { video_id: 'v1', status: 'waiting' } } });
    await call('heygen_create_video', { avatar_id: 'l1', script: 'Hello there', voice_id: 'vo1' });
    expect(sent().data).toEqual({ type: 'avatar', avatar_id: 'l1', script: 'Hello there', voice_id: 'vo1' });
    mockedAxios.mockClear();
    await call('heygen_create_video', {
      avatar_id: 'l1', audio_url: 'https://example.com/a.mp3', aspect_ratio: '9:16', resolution: '720p',
      engine: { type: 'avatar_v' }, background: { type: 'color', value: '#FFFFFF' }, voice_settings: { speed: 1.1 },
    });
    expect(sent().data).toEqual({
      type: 'avatar', avatar_id: 'l1', audio_url: 'https://example.com/a.mp3', aspect_ratio: '9:16', resolution: '720p',
      engine: { type: 'avatar_v' }, background: { type: 'color', value: '#FFFFFF' }, voice_settings: { speed: 1.1 },
    });
  });

  it('fills a template, translates by URL, starts the agent in generate mode and makes a photo avatar', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const variables = { name: { type: 'text', content: 'Anna' } };
    await call('heygen_generate_from_template', { template_id: 't1', variables, title: 'For Anna' });
    expect(sent().data).toEqual({ variables, title: 'For Anna' });
    mockedAxios.mockClear();
    await call('heygen_translate_video', { video_url: 'https://example.com/v.mp4', output_languages: ['German', 'Spanish (Spain)'], mode: 'precision' });
    expect(sent().data).toEqual({ video: { type: 'url', url: 'https://example.com/v.mp4' }, output_languages: ['German', 'Spanish (Spain)'], mode: 'precision' });
    mockedAxios.mockClear();
    await call('heygen_create_agent_video', { prompt: 'Explain our refund policy', orientation: 'portrait' });
    expect(sent().data).toEqual({ prompt: 'Explain our refund policy', mode: 'generate', orientation: 'portrait' });
    mockedAxios.mockClear();
    await call('heygen_create_photo_avatar', { name: 'Ada', photo_url: 'https://example.com/ada.jpg' });
    expect(sent().data).toEqual({ type: 'photo', name: 'Ada', file: { type: 'url', url: 'https://example.com/ada.jpg' } });
  });

  it('returns a video with its links and failure reason, flattened out of data', () => {
    const raw = {
      data: {
        id: 'v1', title: 'Intro', status: 'completed', created_at: 1, completed_at: 2, duration: 12.5, folder_id: 'f',
        video_url: 'https://files.heygen.ai/v1.mp4', captioned_video_url: 'https://files.heygen.ai/v1c.mp4', subtitle_url: 'https://files.heygen.ai/v1.srt',
        thumbnail_url: 'https://files.heygen.ai/v1.jpg', gif_url: 'https://files.heygen.ai/v1.gif', video_page_url: 'https://app.heygen.com/videos/v1',
      },
    };
    const out = applyResponseTransform(raw, tool('heygen_get_video').responseMapping as any).value as any;
    expect(out).toMatchObject({ id: 'v1', status: 'completed', duration: 12.5, video_url: raw.data.video_url, subtitle_url: raw.data.subtitle_url, video_page_url: raw.data.video_page_url });
    expect(out.gif_url).toBeUndefined();
    const failed = applyResponseTransform({ data: { id: 'v2', status: 'failed', failure_code: 'download_failed', failure_message: 'Audio not reachable' } }, tool('heygen_get_video').responseMapping as any).value;
    expect(failed).toEqual({ id: 'v2', status: 'failed', failure_code: 'download_failed', failure_message: 'Audio not reachable' });
  });

  it('keeps list pages compact with their cursor', () => {
    const raw = {
      data: [{ id: 'l1', name: 'Ada', avatar_type: 'photo_avatar', supported_api_engines: ['avatar_iv'], tags: ['x'], image_width: 1080, preview_image_url: 'https://p' }],
      has_more: true, next_token: 'n2',
    };
    expect(applyResponseTransform(raw, tool('heygen_list_avatar_looks').responseMapping as any).value).toEqual({
      looks: [{ id: 'l1', name: 'Ada', avatar_type: 'photo_avatar', supported_api_engines: ['avatar_iv'], preview_image_url: 'https://p' }],
      has_more: true, next_token: 'n2',
    });
    const account = { data: { username: 'ada', email: 'ada@example.com', first_name: 'Ada', billing_type: 'wallet', wallet: { currency: 'usd', remaining_balance: 42.5 } } };
    expect(applyResponseTransform(account, tool('heygen_get_account').responseMapping as any).value).toEqual({
      username: 'ada', billing_type: 'wallet', wallet: { currency: 'usd', remaining_balance: 42.5 },
    });
  });
});

const live = process.env.RUN_HEYGEN_LIVE === '1' ? describe : describe.skip;
live('heygen adapter: live', () => {
  const real = !!process.env.HEYGEN_API_KEY;
  const env = () => ({ HEYGEN_API_KEY: process.env.HEYGEN_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['heygen_get_account', {}],
    ['heygen_list_avatar_groups', {}],
    ['heygen_list_avatar_looks', {}],
    ['heygen_list_voices', {}],
    ['heygen_list_videos', {}],
    ['heygen_list_templates', {}],
    ['heygen_list_translation_languages', {}],
    ['heygen_create_video', { avatar_id: 'nobody', script: 'Hi' }],
    ['heygen_create_agent_video', { prompt: 'Hi' }],
  ])('%s reaches HeyGen and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads the account, avatars, voices, videos, templates and translations', async () => {
    const account = await shaped('heygen_get_account', {}, env());
    expect(account.billing_type).toBeTruthy();
    const groups = await shaped('heygen_list_avatar_groups', { ownership: 'public', limit: 3 }, env());
    expect(Array.isArray(groups.avatar_groups)).toBe(true);
    const looks = await shaped('heygen_list_avatar_looks', { ownership: 'public', limit: 3 }, env());
    expect(Array.isArray(looks.looks)).toBe(true);
    if (looks.looks[0]) {
      const look = await shaped('heygen_get_avatar_look', { look_id: looks.looks[0].id }, env());
      expect(look.look.id).toBe(looks.looks[0].id);
    }
    const voices = await shaped('heygen_list_voices', { limit: 3 }, env());
    expect(Array.isArray(voices.voices)).toBe(true);
    const videos = await shaped('heygen_list_videos', { limit: 3 }, env());
    expect(Array.isArray(videos.videos)).toBe(true);
    const templates = await shaped('heygen_list_templates', { limit: 3 }, env());
    expect(Array.isArray(templates.templates)).toBe(true);
    const languages = await shaped('heygen_list_translation_languages', {}, env());
    expect(languages.languages.length).toBeGreaterThan(10);
    const translations = await shaped('heygen_list_video_translations', { limit: 3 }, env());
    expect(Array.isArray(translations.translations)).toBe(true);
  }, 90000);

  const writes = real && process.env.RUN_HEYGEN_LIVE_WRITES === '1' && !!process.env.HEYGEN_TEST_AVATAR_ID;
  (writes ? it : it.skip)('renders one short avatar video and returns its download link (spends API balance)', async () => {
    const started = await call(
      'heygen_create_video',
      { avatar_id: process.env.HEYGEN_TEST_AVATAR_ID, script: 'This is a short AnythingMCP connector test.', engine: { type: 'avatar_iii' }, resolution: '720p', title: 'AnythingMCP live check' },
      env(),
    );
    const videoId = started.data.video_id;
    expect(videoId).toBeTruthy();
    let video: any = { status: 'pending' };
    for (let i = 0; i < 40 && !['completed', 'failed'].includes(video.status); i++) {
      await new Promise((r) => setTimeout(r, 15000));
      video = await shaped('heygen_get_video', { video_id: videoId }, env());
    }
    expect(video.status).toBe('completed');
    expect(video.video_url).toMatch(/^https:\/\//);
  }, 700000);
});
