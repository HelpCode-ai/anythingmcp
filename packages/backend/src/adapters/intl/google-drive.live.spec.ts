import axios from 'axios';
import * as adapter from './google-drive.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google Drive adapter:
 *
 *   1. Static: always runs. Pins the OAuth setup shared by the Google
 *      adapters, shared-drive support on every file call, the fixed `fields`
 *      that keep answers small, the multipart/related body that
 *      gdrive_create_text_file builds from a `__raw` template (Drive's upload
 *      endpoint does not take a JSON body), the 200 KB cap on exports, and
 *      which tools install switched off.
 *
 *   2. Live: skipped unless GOOGLE_ACCESS_TOKEN is set (a token with
 *      drive.readonly for reads, drive for the write round-trip, e.g. from
 *      the OAuth 2.0 Playground):
 *
 *        GOOGLE_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/google-drive.live.spec.ts
 *
 *      With GOOGLE_LIVE_WRITE=1 as well, an "AnythingMCP test folder" is
 *      created in My Drive with a text file, a Google Doc converted from
 *      Markdown and a copy inside; the folder is moved to the trash in
 *      `finally`, contents included. Nothing is shared.
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
  parameters: { properties?: Record<string, { pattern?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: Record<string, unknown>;
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

const BASE = 'https://www.googleapis.com/drive/v3';
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

describe('google-drive adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('signs in with the shared Google OAuth client and the drive scope', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/drive',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/read-only setup[^\n]*drive\.readonly/);
    expect(a.instructions).toMatch(/restricted/);
  });

  it('probes with /about, which needs no arguments', () => {
    expect(a.probe.tool).toBe('gdrive_about');
    expect(tool('gdrive_about').endpointMapping.method).toBe('GET');
    expect(tool('gdrive_about').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/about?fields=user');
  });

  it('prefixes every tool with gdrive_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gdrive_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('percent-encodes ids placed in the path', () => {
    for (const t of a.tools) {
      if (/\{\w+\}/.test(t.endpointMapping.path)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('supports shared drives on every call that addresses files', () => {
    // Export and comments take no supportsAllDrives parameter.
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      if (/files/.test(p) && !/(export|comments)$/.test(p)) expect(`${t.name}:${t.endpointMapping.queryParams?.supportsAllDrives}`).toBe(`${t.name}:true`);
    }
    expect(tool('gdrive_search_files').endpointMapping.queryParams?.includeItemsFromAllDrives).toBe(true);
  });

  it('installs only the trash tool switched off, and has no permanent delete', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['gdrive_trash_file']);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `gdrive_trash_file`/);
    expect(annotationsOf(tool('gdrive_trash_file')).destructiveHint).toBe(true);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('marks reads read-only and renaming or moving as non-destructive', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'gdrive_about',
      'gdrive_export_file',
      'gdrive_get_file',
      'gdrive_list_comments',
      'gdrive_list_permissions',
      'gdrive_list_shared_drives',
      'gdrive_search_files',
    ]);
    expect(annotationsOf(tool('gdrive_update_file')).destructiveHint).toBe(false);
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgdrive_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgdrive_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['gdrive_about', {}, 'GET', '/about'],
    ['gdrive_search_files', { q: "name contains 'x'" }, 'GET', '/files'],
    ['gdrive_get_file', { file_id: '1AbC-_x' }, 'GET', '/files/1AbC-_x'],
    ['gdrive_export_file', { file_id: 'd1', mime_type: 'text/plain' }, 'GET', '/files/d1/export'],
    ['gdrive_create_folder', { name: 'F' }, 'POST', '/files'],
    ['gdrive_copy_file', { file_id: 'f1' }, 'POST', '/files/f1/copy'],
    ['gdrive_update_file', { file_id: 'f1', name: 'N' }, 'PATCH', '/files/f1'],
    ['gdrive_trash_file', { file_id: 'f1' }, 'PATCH', '/files/f1'],
    ['gdrive_list_permissions', { file_id: 'f1' }, 'GET', '/files/f1/permissions'],
    ['gdrive_share_file', { file_id: 'f1', type: 'anyone', role: 'reader' }, 'POST', '/files/f1/permissions'],
    ['gdrive_list_comments', { file_id: 'f1' }, 'GET', '/files/f1/comments'],
    ['gdrive_list_shared_drives', {}, 'GET', '/drives'],
  ])('%s sends %s to the right Drive URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url: `${BASE}${path}`,
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('searches with the query, shared drives and a fixed field list', async () => {
    mockedAxios.mockResolvedValue({ data: { files: [] } });
    await call('gdrive_search_files', { q: "'root' in parents and trashed = false", page_size: 10 });
    expect(sent().params).toMatchObject({
      q: "'root' in parents and trashed = false",
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    expect(sent().params.fields).toMatch(/^nextPageToken,incompleteSearch,files\(id,name,mimeType,/);
  });

  it('moves with addParents and removeParents and trashes with a fixed body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gdrive_update_file', { file_id: 'f1', add_parents: 'new', remove_parents: 'old' });
    expect(sent().params).toMatchObject({ addParents: 'new', removeParents: 'old' });
    expect(sent().data).toEqual({});
    mockedAxios.mockClear();
    await call('gdrive_trash_file', { file_id: 'f1' });
    expect(sent().data).toEqual({ trashed: true });
  });

  it('shares with the permission body and the notification switch as query parameters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gdrive_share_file', {
      file_id: 'f1',
      type: 'user',
      role: 'writer',
      email_address: 'ana@example.com',
      send_notification_email: false,
    });
    expect(sent().params).toMatchObject({ sendNotificationEmail: false, supportsAllDrives: true });
    expect(sent().data).toEqual({ type: 'user', role: 'writer', emailAddress: 'ana@example.com' });
  });

  it('builds a multipart/related upload with metadata first and the text second', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const content = '# Notizen\n\nGrüße, perché 👋';
    await call('gdrive_create_text_file', {
      name: 'Meeting notes',
      content,
      content_type: 'text/markdown',
      drive_mime_type: 'application/vnd.google-apps.document',
    });
    const req = sent();
    expect(req.url).toBe('https://www.googleapis.com/upload/drive/v3/files');
    expect(req.params).toMatchObject({ uploadType: 'multipart', supportsAllDrives: true });
    const boundary = /boundary=(\S+)/.exec(req.headers['Content-Type'])![1];
    expect(req.headers['Content-Type']).toBe(`multipart/related; boundary=${boundary}`);
    const parts = (req.data as string).split(`--${boundary}`);
    expect(parts[0]).toBe('');
    expect(parts[3]).toBe('--\r\n');
    const [metaHead, metaBody] = parts[1].split('\r\n\r\n');
    expect(metaHead).toBe('\r\nContent-Type: application/json; charset=UTF-8');
    expect(JSON.parse(metaBody)).toEqual({
      name: 'Meeting notes',
      mimeType: 'application/vnd.google-apps.document',
      parents: ['root'],
    });
    expect(parts[2]).toBe(`\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n`);
  });

  it('keeps file names that would break the metadata JSON out through the schema', () => {
    const pattern = new RegExp(tool('gdrive_create_text_file').parameters.properties!.name.pattern!);
    expect(pattern.test('Report 2026 (final).txt')).toBe(true);
    expect(pattern.test('Grüße.md')).toBe(true);
    expect(pattern.test('say "hi"')).toBe(false);
    expect(pattern.test('back\\slash')).toBe(false);
    expect(pattern.test('two\nlines')).toBe(false);
    const folder = new RegExp(tool('gdrive_create_text_file').parameters.properties!.folder_id.pattern!);
    expect(folder.test('root')).toBe(true);
    expect(folder.test('1AbC-_9')).toBe(true);
    expect(folder.test('x"],"y')).toBe(false);
  });

  it('caps exported text at 200 KB and leaves small exports untouched', () => {
    const mapping = tool('gdrive_export_file').responseMapping!;
    expect(validateTransform(mapping.transform)).toBeNull();
    expect(applyResponseTransform('a,b\n1,2\n', mapping).value).toBe('a,b\n1,2\n');
    const big = applyResponseTransform('x'.repeat(300_000), mapping);
    expect(big.truncated).toBe(true);
    expect((big.value as { _truncated: boolean })._truncated).toBe(true);
    expect(JSON.stringify(big.value).length).toBeLessThan(210_000);
  });

  it('offers only text export formats', () => {
    const formats = (tool('gdrive_export_file').parameters.properties!.mime_type as unknown as { enum: string[] }).enum;
    for (const f of formats) expect(f).toMatch(/^text\//);
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('google-drive adapter: live Drive API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
      tool(name).endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );
  const shaped = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping).value;

  it('reads who is signed in', async () => {
    const about = await run('gdrive_about');
    expect(about.user.emailAddress).toMatch(/@/);
    expect(about.storageQuota).toBeDefined();
  }, 30_000);

  it('searches files, reads one and its permissions, lists shared drives', async () => {
    const res = await run('gdrive_search_files', { q: 'trashed = false', page_size: 3, order_by: 'modifiedTime desc' });
    expect(Array.isArray(res.files)).toBe(true);
    if (res.files.length) {
      const file = await run('gdrive_get_file', { file_id: res.files[0].id });
      expect(file.id).toBe(res.files[0].id);
      expect(file.capabilities).toBeDefined();
      const perms = await run('gdrive_list_permissions', { file_id: file.id });
      expect(Array.isArray(perms.permissions)).toBe(true);
    }
    const drives = await run('gdrive_list_shared_drives', { page_size: 5 });
    expect(Array.isArray(drives.drives)).toBe(true);
  }, 30_000);

  it('exports a Google Doc as text and lists its comments', async () => {
    const res = await run('gdrive_search_files', {
      q: "mimeType = 'application/vnd.google-apps.document' and trashed = false",
      page_size: 1,
    });
    if (!res.files?.length) return;
    const text = shaped('gdrive_export_file', await run('gdrive_export_file', { file_id: res.files[0].id, mime_type: 'text/plain' }));
    expect(typeof text === 'string' || (text as { _truncated?: boolean })._truncated).toBeTruthy();
    const comments = await run('gdrive_list_comments', { file_id: res.files[0].id, page_size: 5 });
    expect(Array.isArray(comments.comments)).toBe(true);
  }, 30_000);

  (process.env.GOOGLE_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a test folder with a text file, a converted Doc and a copy, then trashes the folder',
    async () => {
      const stamp = new Date().toISOString();
      const folder = await run('gdrive_create_folder', { name: `AnythingMCP test folder ${stamp}` });
      expect(folder.mimeType).toBe('application/vnd.google-apps.folder');
      try {
        const body = 'AnythingMCP test: Grüße, perché 👋\nline 2';
        const txt = await run('gdrive_create_text_file', {
          name: 'AnythingMCP test.txt',
          content: body,
          content_type: 'text/plain',
          drive_mime_type: 'text/plain',
          folder_id: folder.id,
        });
        expect(txt.name).toBe('AnythingMCP test.txt');
        expect(txt.parents).toEqual([folder.id]);

        const doc = await run('gdrive_create_text_file', {
          name: 'AnythingMCP test doc',
          content: '# AnythingMCP test\n\nConverted from **Markdown**.',
          content_type: 'text/markdown',
          drive_mime_type: 'application/vnd.google-apps.document',
          folder_id: folder.id,
        });
        expect(doc.mimeType).toBe('application/vnd.google-apps.document');
        const text = shaped('gdrive_export_file', await run('gdrive_export_file', { file_id: doc.id, mime_type: 'text/plain' }));
        expect(String(text)).toContain('AnythingMCP test');

        const copy = await run('gdrive_copy_file', { file_id: txt.id, name: 'AnythingMCP test copy.txt' });
        const renamed = await run('gdrive_update_file', { file_id: copy.id, name: 'AnythingMCP test renamed.txt' });
        expect(renamed.name).toBe('AnythingMCP test renamed.txt');
        const listed = await run('gdrive_search_files', { q: `'${folder.id}' in parents and trashed = false` });
        expect(listed.files.length).toBe(3);
      } finally {
        const trashed = await run('gdrive_trash_file', { file_id: folder.id });
        expect(trashed.trashed).toBe(true);
      }
    },
    90_000,
  );
});
