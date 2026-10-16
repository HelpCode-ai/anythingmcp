import axios from 'axios';
import * as adapter from './google-photos.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google Photos adapter:
 *
 *   1. Static: always runs. Pins the OAuth setup shared by the Google
 *      adapters with the one Picker scope, the Picker workflow (create a
 *      session, read it, list what was picked, delete it), the access check
 *      on Google's tokeninfo endpoint that doubles as probe, and the
 *      transform that flattens picked items. Since March 2025 the Library
 *      API only reaches content an app uploaded itself, so the adapter has
 *      no Library tools; the instructions say so.
 *
 *   2. Live: skipped unless RUN_GOOGLE_PHOTOS_LIVE=1 and GOOGLE_ACCESS_TOKEN
 *      are set (a token with photospicker.mediaitems.readonly):
 *
 *        RUN_GOOGLE_PHOTOS_LIVE=1 GOOGLE_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/google-photos.live.spec.ts
 *
 *      Runs the probe, creates a picking session, reads it back (nothing is
 *      picked, so mediaItemsSet stays false and listing is refused with
 *      FAILED_PRECONDITION) and deletes it in `finally`. Picking itself needs
 *      a person in the Google Photos page and is not automated.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    // The outbound helper also calls axios.getUri, getAdapter and friends:
    // keep every real static, only the call itself is mocked.
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
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
const shaped = (name: string, raw: unknown): any => applyResponseTransform(raw, tool(name).responseMapping).value;

const BASE = 'https://photospicker.googleapis.com/v1';
const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo';
const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
});
// Arguments as DynamicMcpTools hands them to the engine: schema defaults filled in.
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
const sent = () => mockedAxios.mock.calls[0][0];

describe('google-photos adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until it has been verified live', () => {
    expect(a.unlisted).toBe(true);
  });

  it('signs in with the shared Google OAuth client and only the Picker scope', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: SCOPE,
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    // What the model must not promise: browsing the library, or looking at the pictures.
    expect(a.instructions).toMatch(/Since 31 March 2025 Google no longer lets apps read or search a user's whole Photos library/);
    expect(a.instructions).toMatch(/It cannot look at the pictures/);
  });

  it("probes Google's tokeninfo, the one cheap authenticated read the Picker scope allows", () => {
    expect(a.probe).toEqual({ tool: 'google_photos_check_access' });
    expect(a.connector.healthcheckPath).toBe(TOKENINFO);
    expect(tool('google_photos_check_access').endpointMapping).toEqual({ method: 'GET', path: TOKENINFO });
  });

  it('prefixes every tool with google_photos_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^google_photos_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('installs every tool switched on: none of them can touch the library', () => {
    expect(a.tools.filter((t) => t.enabled === false)).toEqual([]);
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(['google_photos_check_access', 'google_photos_get_session', 'google_photos_list_picked_media']);
    // Deleting a session never deletes photos.
    expect(annotationsOf(tool('google_photos_delete_session')).destructiveHint).toBe(false);
    expect(tool('google_photos_delete_session').description).toMatch(/never photos/);
    expect(tool('google_photos_create_session').description).toMatch(/when the user wants to share/);
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgoogle_photos_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgoogle_photos_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('runs the picking workflow against the Picker API', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_photos_create_session', { max_items: 10 });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${BASE}/sessions`);
    expect(sent().data).toEqual({ pickingConfig: { maxItemCount: 10 } });
    expect(sent().headers.Authorization).toBe('Bearer test-token');
    mockedAxios.mockClear();
    await call('google_photos_get_session', { session_id: 's/1' });
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(`${BASE}/sessions/s%2F1`);
    mockedAxios.mockClear();
    await call('google_photos_list_picked_media', { session_id: 's1' });
    expect(sent().url).toBe(`${BASE}/mediaItems`);
    expect(sent().params).toEqual({ sessionId: 's1', pageSize: 100 });
    mockedAxios.mockClear();
    await call('google_photos_list_picked_media', { session_id: 's1', page_size: 20, page_token: 'n1' });
    expect(sent().params).toEqual({ sessionId: 's1', pageSize: 20, pageToken: 'n1' });
    mockedAxios.mockClear();
    await call('google_photos_delete_session', { session_id: 's1' });
    expect(sent().method).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/sessions/s1`);
    mockedAxios.mockClear();
    await call('google_photos_check_access', {});
    expect(sent().url).toBe(TOKENINFO);
    expect(sent().headers.Authorization).toBe('Bearer test-token');
  });

  it('flattens picked items to what the model can use', () => {
    expect(validateTransform(tool('google_photos_list_picked_media').responseMapping!.transform)).toBeNull();
    const raw = {
      mediaItems: [
        {
          id: 'm1',
          createTime: '2026-08-01T10:00:00Z',
          type: 'PHOTO',
          mediaFile: {
            baseUrl: 'https://lh3.googleusercontent.com/ppa/abc',
            mimeType: 'image/jpeg',
            filename: 'IMG_0001.jpg',
            mediaFileMetadata: {
              width: 4032,
              height: 3024,
              cameraMake: 'Google',
              cameraModel: 'Pixel 9',
              photoMetadata: { focalLength: 6.9, apertureFNumber: 1.7, isoEquivalent: 50, exposureTime: '0.001s' },
            },
          },
        },
        {
          id: 'm2',
          createTime: '2026-08-02T10:00:00Z',
          type: 'VIDEO',
          mediaFile: {
            baseUrl: 'https://lh3.googleusercontent.com/ppa/def',
            mimeType: 'video/mp4',
            filename: 'VID_0002.mp4',
            mediaFileMetadata: { width: 1920, height: 1080, videoMetadata: { fps: 30, processingStatus: 'READY' } },
          },
        },
      ],
      nextPageToken: 'n2',
    };
    expect(shaped('google_photos_list_picked_media', raw)).toEqual({
      mediaItems: [
        {
          id: 'm1',
          type: 'PHOTO',
          createTime: '2026-08-01T10:00:00Z',
          mimeType: 'image/jpeg',
          filename: 'IMG_0001.jpg',
          width: 4032,
          height: 3024,
          cameraMake: 'Google',
          cameraModel: 'Pixel 9',
          photo: { focalLength: 6.9, apertureFNumber: 1.7, isoEquivalent: 50, exposureTime: '0.001s' },
          video: null,
          baseUrl: 'https://lh3.googleusercontent.com/ppa/abc',
        },
        {
          id: 'm2',
          type: 'VIDEO',
          createTime: '2026-08-02T10:00:00Z',
          mimeType: 'video/mp4',
          filename: 'VID_0002.mp4',
          width: 1920,
          height: 1080,
          cameraMake: null,
          cameraModel: null,
          photo: null,
          video: { fps: 30, processingStatus: 'READY' },
          baseUrl: 'https://lh3.googleusercontent.com/ppa/def',
        },
      ],
      nextPageToken: 'n2',
    });
  });

  it('keeps only the scope and lifetime from tokeninfo', () => {
    expect(validateTransform(tool('google_photos_check_access').responseMapping!.transform)).toBeNull();
    const raw = { azp: 'x.apps.googleusercontent.com', aud: 'x.apps.googleusercontent.com', sub: '123', scope: SCOPE, exp: '1760000000', expires_in: '3500', access_type: 'offline' };
    expect(shaped('google_photos_check_access', raw)).toEqual({ scope: SCOPE, expires_in: '3500', access_type: 'offline' });
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const live = process.env.RUN_GOOGLE_PHOTOS_LIVE === '1' && TOKEN ? describe : describe.skip;

live('google-photos adapter: live Picker API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const bearer = () => ({
    baseUrl: a.connector.baseUrl,
    authType: 'BEARER_TOKEN',
    authConfig: { token: TOKEN as string },
    headers: a.connector.headers,
  });
  const exec = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(bearer(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));

  it('runs the probe and sees the Picker scope', async () => {
    const info = shaped(a.probe.tool, await exec(a.probe.tool));
    expect(String(info.scope).split(' ')).toContain(SCOPE);
  }, 30_000);

  it('creates a picking session, reads it, and deletes it', async () => {
    const session = await exec('google_photos_create_session', { max_items: 1 });
    expect(typeof session.id).toBe('string');
    try {
      expect(session.pickerUri).toMatch(/^https:\/\//);
      const read = await exec('google_photos_get_session', { session_id: session.id });
      expect(read.id).toBe(session.id);
      expect(read.mediaItemsSet ?? false).toBe(false);
      // Nothing picked yet: Google refuses to list.
      await expect(exec('google_photos_list_picked_media', { session_id: session.id })).rejects.toBeDefined();
    } finally {
      await exec('google_photos_delete_session', { session_id: session.id }).catch(() =>
        console.warn(`Could not delete picking session ${session.id}; it expires on its own.`),
      );
    }
  }, 60_000);
});
