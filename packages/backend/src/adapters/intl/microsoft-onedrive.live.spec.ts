import axios from 'axios';
import * as adapter from './microsoft-onedrive.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the OneDrive (Microsoft Graph) adapter:
 *
 *   1. Static: always runs. Pins the Entra OAuth setup shared with Outlook
 *      (tenant in both endpoints, offline_access), the fixed `$select` that
 *      keeps item lists small and leaves the pre-authenticated download URL
 *      out, the text upload sent as a raw `text/plain` body that never
 *      overwrites by default, the copy/move bodies Graph documents, and which
 *      tools install switched off (delete, sharing link, invite).
 *
 *   2. Live: skipped unless MS_GRAPH_ACCESS_TOKEN is set (a delegated Graph
 *      token with Files.ReadWrite, e.g. from Graph Explorer):
 *
 *        MS_GRAPH_ACCESS_TOKEN=eyJ... npx jest src/adapters/intl/microsoft-onedrive.live.spec.ts
 *
 *      With ONEDRIVE_LIVE_WRITE=1 as well, an "AnythingMCP test" folder is
 *      created at the top of the OneDrive with a text file in it, the file is
 *      replaced, renamed, copied and moved; the folder is deleted (to the
 *      recycle bin) in `finally`. Nothing is shared.
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
  parameters: { properties?: Record<string, { default?: unknown; enum?: unknown[] }>; required?: string[] };
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
  prerequisites: string;
  appRegistrationUrl: string;
  requiredEnvVars: string[];
  probe: { tool: string };
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

const BASE = 'https://graph.microsoft.com/v1.0';
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

describe('microsoft-onedrive adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified live, and says up front that it needs an Entra app', () => {
    expect(a.unlisted).toBe(true);
    expect(a.prerequisites).toMatch(/Entra/);
    expect(a.prerequisites).toMatch(/Outlook connector can be reused/);
    expect(a.appRegistrationUrl).toMatch(/^https:\/\/entra\.microsoft\.com\//);
  });

  it('signs in against the configured tenant with the Outlook variables and asks for a refresh token', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID']);
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MICROSOFT_CLIENT_ID}}',
      clientSecret: '{{MICROSOFT_CLIENT_SECRET}}',
      authorizationUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/token',
      scopes: 'offline_access User.Read Files.ReadWrite',
    });
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/One Entra app for all Microsoft connectors/);
    expect(a.instructions).toMatch(/read-only setup[^\n]*Files\.Read/);
  });

  it('probes with /me/drive, which needs no arguments', () => {
    expect(a.probe.tool).toBe('onedrive_get_drive');
    expect(tool('onedrive_get_drive').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/me/drive');
  });

  it('prefixes every tool with onedrive_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^onedrive_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('percent-encodes ids in the path, but not paths, whose slashes must stay', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      if (/\{path\}/.test(p)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:undefined`);
      else if (/\{\w+\}/.test(p)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('installs delete, sharing link and invite switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([
      'onedrive_create_sharing_link',
      'onedrive_delete_item',
      'onedrive_invite',
    ]);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `onedrive_delete_item`, `onedrive_create_sharing_link` and `onedrive_invite`/);
    expect(annotationsOf(tool('onedrive_delete_item')).destructiveHint).toBe(true);
  });

  it('never downloads content and keeps the pre-authenticated download URL out of answers', () => {
    // GET .../content would follow a redirect to the whole file, unbounded.
    for (const t of a.tools) {
      if (/\/content$/.test(t.endpointMapping.path)) expect(t.endpointMapping.method).toBe('PUT');
    }
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET')) {
      const select = String(t.endpointMapping.queryParams?.$select ?? '');
      if (t.name !== 'onedrive_list_permissions') expect(`${t.name}:${select.length > 0}`).toBe(`${t.name}:true`);
      expect(select).not.toMatch(/downloadUrl/);
    }
    for (const name of ['onedrive_upload_text_file', 'onedrive_replace_file_content', 'onedrive_rename_item', 'onedrive_move_item']) {
      const mapping = tool(name).responseMapping!;
      expect(validateTransform(mapping.transform)).toBeNull();
      const out = applyResponseTransform(
        { id: '01ABC', name: 'a.txt', '@microsoft.graph.downloadUrl': 'https://public.example/secret' },
        mapping,
      ).value as Record<string, unknown>;
      expect(out).toEqual({ id: '01ABC', name: 'a.txt' });
    }
  });

  it('marks reads read-only and rename or move as non-destructive', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'onedrive_get_drive',
      'onedrive_get_item',
      'onedrive_get_item_by_path',
      'onedrive_get_shared_item',
      'onedrive_list_folder',
      'onedrive_list_folder_by_path',
      'onedrive_list_permissions',
      'onedrive_list_root',
      'onedrive_search',
      'onedrive_search_shared',
    ]);
    expect(annotationsOf(tool('onedrive_rename_item')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('onedrive_move_item')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('onedrive_replace_file_content')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('onedrive_upload_text_file')).destructiveHint).toBe(false);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bonedrive_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bonedrive_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['onedrive_get_drive', {}, 'GET', '/me/drive'],
    ['onedrive_list_root', {}, 'GET', '/me/drive/root/children'],
    ['onedrive_list_folder', { item_id: 'D4648F06C91D9D3D!54927' }, 'GET', '/me/drive/items/D4648F06C91D9D3D!54927/children'],
    ['onedrive_list_folder_by_path', { path: 'Documents/Reports' }, 'GET', '/me/drive/root:/Documents/Reports:/children'],
    ['onedrive_get_item', { item_id: '01BYE5RZ' }, 'GET', '/me/drive/items/01BYE5RZ'],
    ['onedrive_get_item_by_path', { path: 'Documents/notes.txt' }, 'GET', '/me/drive/root:/Documents/notes.txt'],
    ['onedrive_get_shared_item', { drive_id: 'b!x-y_z', item_id: '01AB' }, 'GET', '/drives/b!x-y_z/items/01AB'],
    ['onedrive_search', { query: 'budget 2026' }, 'GET', "/me/drive/root/search(q='budget%202026')"],
    ['onedrive_search_shared', { query: 'plan' }, 'GET', "/me/drive/search(q='plan')"],
    ['onedrive_create_folder', { name: 'F' }, 'POST', '/me/drive/items/root/children'],
    ['onedrive_upload_text_file', { file_name: 'notes.md', content: 'x' }, 'PUT', '/me/drive/items/root:/notes.md:/content'],
    ['onedrive_replace_file_content', { item_id: '01AB', content: 'x' }, 'PUT', '/me/drive/items/01AB/content'],
    ['onedrive_copy_item', { item_id: '01AB', destination_drive_id: 'b!1', destination_folder_id: '01CD' }, 'POST', '/me/drive/items/01AB/copy'],
    ['onedrive_rename_item', { item_id: '01AB', name: 'n.txt' }, 'PATCH', '/me/drive/items/01AB'],
    ['onedrive_move_item', { item_id: '01AB', new_parent_id: '01CD' }, 'PATCH', '/me/drive/items/01AB'],
    ['onedrive_delete_item', { item_id: '01AB' }, 'DELETE', '/me/drive/items/01AB'],
    ['onedrive_list_permissions', { item_id: '01AB' }, 'GET', '/me/drive/items/01AB/permissions'],
    ['onedrive_create_sharing_link', { item_id: '01AB', type: 'view' }, 'POST', '/me/drive/items/01AB/createLink'],
    ['onedrive_invite', { item_id: '01AB', recipients: [{ email: 'a@b.c' }], roles: ['read'] }, 'POST', '/me/drive/items/01AB/invite'],
  ])('%s sends %s to the right Graph URL', async (name, params, method, path) => {
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

  it('lists with a fixed $select and passes paging through', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    await call('onedrive_list_root', { top: 50, skip_token: 'abc', orderby: 'name' });
    expect(sent().params).toMatchObject({ $top: 50, $skiptoken: 'abc', $orderby: 'name' });
    expect(sent().params.$select).toMatch(/^id,name,size,webUrl,/);
  });

  it('uploads the text as a raw text/plain body and refuses to overwrite by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const content = '{"a": 1}\n  indented, Grüße 👋\n';
    await call('onedrive_upload_text_file', { file_name: 'data.json', content, parent_id: '01CD' });
    expect(sent().url).toBe(`${BASE}/me/drive/items/01CD:/data.json:/content`);
    expect(sent().headers['Content-Type']).toBe('text/plain');
    expect(sent().data).toBe(content);
    expect(sent().params).toEqual({ '@microsoft.graph.conflictBehavior': 'fail' });
    expect((tool('onedrive_upload_text_file').parameters.properties!.conflict_behavior.enum as string[]).sort()).toEqual(['fail', 'rename']);
  });

  it('percent-encodes a file name with spaces in the upload path', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('onedrive_upload_text_file', { file_name: 'Meeting notes #3.md', content: 'x' });
    expect(sent().url).toBe(`${BASE}/me/drive/items/root:/Meeting%20notes%20%233.md:/content`);
  });

  it('creates folders with the folder facet and the conflict behavior', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('onedrive_create_folder', { name: 'Reports', parent_id: '01CD' });
    expect(sent().data).toEqual({ name: 'Reports', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
  });

  it('copies with a parentReference naming drive and folder, and moves with the new parent', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('onedrive_copy_item', { item_id: '01AB', destination_drive_id: 'b!1', destination_folder_id: '01CD', name: 'copy.txt' });
    expect(sent().data).toEqual({ parentReference: { driveId: 'b!1', id: '01CD' }, name: 'copy.txt' });
    expect(sent().params).toEqual({});
    mockedAxios.mockClear();
    await call('onedrive_move_item', { item_id: '01AB', new_parent_id: '01CD' });
    expect(sent().data).toEqual({ parentReference: { id: '01CD' } });
    mockedAxios.mockClear();
    await call('onedrive_rename_item', { item_id: '01AB', name: 'n.txt' });
    expect(sent().data).toEqual({ name: 'n.txt' });
  });

  it('builds the sharing link and invite bodies Graph documents', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('onedrive_create_sharing_link', { item_id: '01AB', type: 'view', scope: 'organization' });
    expect(sent().data).toEqual({ type: 'view', scope: 'organization' });
    mockedAxios.mockClear();
    await call('onedrive_invite', {
      item_id: '01AB',
      recipients: [{ email: 'ana@example.com' }],
      roles: ['write'],
      require_sign_in: true,
      send_invitation: false,
    });
    expect(sent().data).toEqual({
      recipients: [{ email: 'ana@example.com' }],
      roles: ['write'],
      requireSignIn: true,
      sendInvitation: false,
    });
  });
});

const TOKEN = process.env.MS_GRAPH_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('microsoft-onedrive adapter: live Graph API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService)
      .execute(
        { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
        tool(name).endpointMapping,
        applySchemaDefaults(tool(name).parameters, params),
      )
      .then((raw) => applyResponseTransform(raw, tool(name).responseMapping).value);

  it('reads the drive, its top folder, one item and its permissions', async () => {
    const drive = await run('onedrive_get_drive');
    expect(typeof drive.id).toBe('string');
    const root = await run('onedrive_list_root', { top: 5 });
    expect(Array.isArray(root.value)).toBe(true);
    const rootItem = await run('onedrive_get_item', { item_id: 'root' });
    expect(rootItem.root).toBeDefined();
    if (root.value.length) {
      const item = await run('onedrive_get_item', { item_id: root.value[0].id });
      expect(item.id).toBe(root.value[0].id);
      expect(item['@microsoft.graph.downloadUrl']).toBeUndefined();
      const perms = await run('onedrive_list_permissions', { item_id: item.id });
      expect(Array.isArray(perms.value)).toBe(true);
    }
  }, 60_000);

  it('searches the OneDrive and what is shared with the user', async () => {
    const mine = await run('onedrive_search', { query: 'a', top: 3 });
    expect(Array.isArray(mine.value)).toBe(true);
    const shared = await run('onedrive_search_shared', { query: 'a', top: 3 });
    expect(Array.isArray(shared.value)).toBe(true);
  }, 60_000);

  (process.env.ONEDRIVE_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a test folder with a text file, replaces, renames, copies and moves it, then deletes the folder',
    async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const drive = await run('onedrive_get_drive');
      const folder = await run('onedrive_create_folder', { name: `AnythingMCP test ${stamp}` });
      expect(folder.folder).toBeDefined();
      try {
        const sub = await run('onedrive_create_folder', { name: 'sub', parent_id: folder.id });
        const body = 'AnythingMCP test: Grüße, perché 👋\nline 2\n';
        const file = await run('onedrive_upload_text_file', { file_name: 'AnythingMCP test.txt', content: body, parent_id: folder.id });
        expect(file.name).toBe('AnythingMCP test.txt');
        expect(file['@microsoft.graph.downloadUrl']).toBeUndefined();
        await expect(
          run('onedrive_upload_text_file', { file_name: 'AnythingMCP test.txt', content: 'again', parent_id: folder.id }),
        ).rejects.toMatchObject({ response: { status: 409 } });

        const replaced = await run('onedrive_replace_file_content', { item_id: file.id, content: 'replaced\n' });
        expect(replaced.size).toBe(9);
        const byPath = await run('onedrive_get_item_by_path', { path: `AnythingMCP test ${stamp}/AnythingMCP test.txt` });
        expect(byPath.id).toBe(file.id);

        const renamed = await run('onedrive_rename_item', { item_id: file.id, name: 'AnythingMCP renamed.txt' });
        expect(renamed.name).toBe('AnythingMCP renamed.txt');
        await run('onedrive_copy_item', {
          item_id: file.id,
          destination_drive_id: drive.id,
          destination_folder_id: folder.id,
          name: 'AnythingMCP copy.txt',
        });
        const moved = await run('onedrive_move_item', { item_id: file.id, new_parent_id: sub.id });
        expect(moved.parentReference.id).toBe(sub.id);
        const listed = await run('onedrive_list_folder', { item_id: sub.id });
        expect(listed.value.map((i: { name: string }) => i.name)).toContain('AnythingMCP renamed.txt');
      } finally {
        await run('onedrive_delete_item', { item_id: folder.id });
      }
    },
    120_000,
  );
});
