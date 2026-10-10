import axios from 'axios';
import * as adapter from './microsoft-sharepoint.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the SharePoint (Microsoft Graph) adapter:
 *
 *   1. Static: always runs. Pins the Entra OAuth setup shared with Outlook,
 *      the Sites/Files scopes, composite site ids percent-encoded into the
 *      path while server-relative site paths keep their slashes, list items
 *      read with `expand=fields` and written as a `fields` object (create) or
 *      the bare field map (update), the Microsoft Search request body, the cap
 *      on page content, and which tools install switched off (deletes,
 *      sharing link, invite).
 *
 *   2. Live: skipped unless MS_GRAPH_ACCESS_TOKEN is set (a delegated Graph
 *      token of a Microsoft 365 work account with Sites.ReadWrite.All and
 *      Files.ReadWrite.All, e.g. from Graph Explorer). The site is discovered,
 *      not configured: the root site, or the first search hit when the user
 *      cannot read the root site.
 *
 *        MS_GRAPH_ACCESS_TOKEN=eyJ... npx jest src/adapters/intl/microsoft-sharepoint.live.spec.ts
 *
 *      With SHAREPOINT_LIVE_WRITE=1 as well, a list "AnythingMCP test <time>"
 *      is created in that site with one item, which is read and updated, and a
 *      folder with a text file is created in the site's default library; the
 *      list and the folder are deleted (to the recycle bin) in `finally`.
 *      Nothing is shared.
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
const SITE = 'contoso.sharepoint.com,2C712604-1370-44E7-A1F5-426573FDA80A,2D2244C3-251A-49EA-93A8-39E1C3A060FE';
const SITE_ENC = 'contoso.sharepoint.com%2C2C712604-1370-44E7-A1F5-426573FDA80A%2C2D2244C3-251A-49EA-93A8-39E1C3A060FE';
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

describe('microsoft-sharepoint adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified live on 10 Oct 2026), and needs a work account and an Entra app', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.prerequisites).toMatch(/work or school account/);
    expect(a.prerequisites).toMatch(/Outlook connector can be reused/);
  });

  it('signs in against the configured tenant with the Outlook variables and the Sites and Files scopes', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID']);
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MICROSOFT_CLIENT_ID}}',
      clientSecret: '{{MICROSOFT_CLIENT_SECRET}}',
      authorizationUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/token',
      scopes: 'offline_access User.Read Sites.ReadWrite.All Files.ReadWrite.All',
    });
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/read-only setup[^\n]*Sites\.Read\.All Files\.Read\.All/);
  });

  it('probes with the root site, which needs no arguments', () => {
    expect(a.probe.tool).toBe('sharepoint_get_root_site');
    expect(tool('sharepoint_get_root_site').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/sites/root');
  });

  it('prefixes every tool with sharepoint_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^sharepoint_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('percent-encodes ids in the path, except the site address whose slashes must stay', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      if (t.name === 'sharepoint_get_site_by_path') expect(t.endpointMapping.encodePathParams).toBeUndefined();
      else if (/\{\w+\}/.test(p)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('installs deletes, sharing link and invite switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([
      'sharepoint_create_sharing_link',
      'sharepoint_delete_drive_item',
      'sharepoint_delete_list_item',
      'sharepoint_invite',
    ]);
    expect(a.instructions).toMatch(
      /Switched off at install\*\*: `sharepoint_delete_list_item`, `sharepoint_delete_drive_item`, `sharepoint_create_sharing_link` and `sharepoint_invite`/,
    );
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'DELETE')) expect(t.enabled).toBe(false);
  });

  it('marks reads, Microsoft Search included, read-only', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'sharepoint_get_drive_item',
      'sharepoint_get_list_item',
      'sharepoint_get_page',
      'sharepoint_get_root_site',
      'sharepoint_get_site',
      'sharepoint_get_site_by_path',
      'sharepoint_list_columns',
      'sharepoint_list_drive_root',
      'sharepoint_list_drives',
      'sharepoint_list_folder',
      'sharepoint_list_items',
      'sharepoint_list_lists',
      'sharepoint_list_pages',
      'sharepoint_list_permissions',
      'sharepoint_list_subsites',
      'sharepoint_search',
      'sharepoint_search_drive',
      'sharepoint_search_sites',
    ]);
    expect(annotationsOf(tool('sharepoint_rename_drive_item')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('sharepoint_move_drive_item')).destructiveHint).toBe(false);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bsharepoint_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bsharepoint_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['sharepoint_get_root_site', {}, 'GET', '/sites/root'],
    ['sharepoint_search_sites', { query: 'marketing' }, 'GET', '/sites'],
    ['sharepoint_get_site_by_path', { hostname: 'contoso.sharepoint.com', site_path: 'sites/Marketing' }, 'GET', '/sites/contoso.sharepoint.com:/sites/Marketing'],
    ['sharepoint_get_site', { site_id: SITE }, 'GET', `/sites/${SITE_ENC}`],
    ['sharepoint_list_subsites', { site_id: SITE }, 'GET', `/sites/${SITE_ENC}/sites`],
    ['sharepoint_list_drives', { site_id: SITE }, 'GET', `/sites/${SITE_ENC}/drives`],
    ['sharepoint_list_drive_root', { drive_id: 'b!abc' }, 'GET', '/drives/b!abc/root/children'],
    ['sharepoint_list_folder', { drive_id: 'b!abc', item_id: '01AB' }, 'GET', '/drives/b!abc/items/01AB/children'],
    ['sharepoint_search_drive', { drive_id: 'b!abc', query: 'q 1' }, 'GET', "/drives/b!abc/root/search(q='q%201')"],
    ['sharepoint_get_drive_item', { drive_id: 'b!abc', item_id: '01AB' }, 'GET', '/drives/b!abc/items/01AB'],
    ['sharepoint_search', { query: 'budget' }, 'POST', '/search/query'],
    ['sharepoint_list_lists', { site_id: SITE }, 'GET', `/sites/${SITE_ENC}/lists`],
    ['sharepoint_list_columns', { site_id: SITE, list_id: 'L1' }, 'GET', `/sites/${SITE_ENC}/lists/L1/columns`],
    ['sharepoint_list_items', { site_id: SITE, list_id: 'L1' }, 'GET', `/sites/${SITE_ENC}/lists/L1/items`],
    ['sharepoint_get_list_item', { site_id: SITE, list_id: 'L1', item_id: '3' }, 'GET', `/sites/${SITE_ENC}/lists/L1/items/3`],
    ['sharepoint_create_list_item', { site_id: SITE, list_id: 'L1', fields: { Title: 'x' } }, 'POST', `/sites/${SITE_ENC}/lists/L1/items`],
    ['sharepoint_update_list_item', { site_id: SITE, list_id: 'L1', item_id: '3', fields: { Title: 'y' } }, 'PATCH', `/sites/${SITE_ENC}/lists/L1/items/3/fields`],
    ['sharepoint_delete_list_item', { site_id: SITE, list_id: 'L1', item_id: '3' }, 'DELETE', `/sites/${SITE_ENC}/lists/L1/items/3`],
    ['sharepoint_create_list', { site_id: SITE, display_name: 'T' }, 'POST', `/sites/${SITE_ENC}/lists`],
    ['sharepoint_create_folder', { drive_id: 'b!abc', name: 'F' }, 'POST', '/drives/b!abc/items/root/children'],
    ['sharepoint_upload_text_file', { drive_id: 'b!abc', file_name: 'a.csv', content: 'a,b' }, 'PUT', '/drives/b!abc/items/root:/a.csv:/content'],
    ['sharepoint_rename_drive_item', { drive_id: 'b!abc', item_id: '01AB', name: 'n' }, 'PATCH', '/drives/b!abc/items/01AB'],
    ['sharepoint_move_drive_item', { drive_id: 'b!abc', item_id: '01AB', new_parent_id: '01CD' }, 'PATCH', '/drives/b!abc/items/01AB'],
    ['sharepoint_delete_drive_item', { drive_id: 'b!abc', item_id: '01AB' }, 'DELETE', '/drives/b!abc/items/01AB'],
    ['sharepoint_list_permissions', { drive_id: 'b!abc', item_id: '01AB' }, 'GET', '/drives/b!abc/items/01AB/permissions'],
    ['sharepoint_create_sharing_link', { drive_id: 'b!abc', item_id: '01AB', type: 'view' }, 'POST', '/drives/b!abc/items/01AB/createLink'],
    ['sharepoint_invite', { drive_id: 'b!abc', item_id: '01AB', recipients: [{ email: 'a@b.c' }], roles: ['read'] }, 'POST', '/drives/b!abc/items/01AB/invite'],
    ['sharepoint_list_pages', { site_id: SITE }, 'GET', `/sites/${SITE_ENC}/pages/microsoft.graph.sitePage`],
    ['sharepoint_get_page', { site_id: SITE, page_id: 'p1' }, 'GET', `/sites/${SITE_ENC}/pages/p1/microsoft.graph.sitePage`],
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

  it('reads list items with their fields, an OData filter and the non-indexed query header', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    await call('sharepoint_list_items', { site_id: SITE, list_id: 'L1', filter: "fields/Status eq 'Open'", top: 20 });
    expect(sent().params).toEqual({ expand: 'fields', $filter: "fields/Status eq 'Open'", $top: 20 });
    expect(sent().headers.Prefer).toBe('HonorNonIndexedQueriesWarningMayFailRandomly');
    mockedAxios.mockClear();
    await call('sharepoint_list_items', { site_id: SITE, list_id: 'L1', expand: 'fields(select=Title,Status)' });
    expect(sent().params.expand).toBe('fields(select=Title,Status)');
  });

  it('creates an item with a fields object and updates with the bare field map', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('sharepoint_create_list_item', { site_id: SITE, list_id: 'L1', fields: { Title: 'Order 4711', Amount: 12.5 } });
    expect(sent().data).toEqual({ fields: { Title: 'Order 4711', Amount: 12.5 } });
    mockedAxios.mockClear();
    await call('sharepoint_update_list_item', { site_id: SITE, list_id: 'L1', item_id: '3', fields: { Status: 'Done' } });
    expect(sent().data).toEqual({ Status: 'Done' });
  });

  it('creates a generic list with columns by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('sharepoint_create_list', { site_id: SITE, display_name: 'Orders', columns: [{ name: 'Status', text: {} }] });
    expect(sent().data).toEqual({ displayName: 'Orders', columns: [{ name: 'Status', text: {} }], list: { template: 'genericList' } });
  });

  it('builds the Microsoft Search request body', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    await call('sharepoint_search', { query: 'budget filetype:xlsx', size: 10 });
    expect(sent().data).toEqual({ requests: [{ entityTypes: ['driveItem'], query: { queryString: 'budget filetype:xlsx' }, size: 10 }] });
    mockedAxios.mockClear();
    await call('sharepoint_search', { query: 'x', entity_type: 'listItem', from: 25, size: 25 });
    expect(sent().data.requests[0]).toMatchObject({ entityTypes: ['listItem'], from: 25, size: 25 });
  });

  it('searches sites by keyword and pages with skip_token', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    await call('sharepoint_search_sites', { query: 'finance', skip_token: 't' });
    expect(sent().params).toMatchObject({ search: 'finance', $skiptoken: 't' });
  });

  it('uploads text raw, never overwriting by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('sharepoint_upload_text_file', { drive_id: 'b!abc', file_name: 'Notes 1.md', content: '# Hi\n', parent_id: '01CD' });
    expect(sent().url).toBe(`${BASE}/drives/b!abc/items/01CD:/Notes%201.md:/content`);
    expect(sent().headers['Content-Type']).toBe('text/plain');
    expect(sent().data).toBe('# Hi\n');
    expect(sent().params).toEqual({ '@microsoft.graph.conflictBehavior': 'fail' });
  });

  it('caps page content at 200 KB and keeps download URLs out of write answers', () => {
    const page = tool('sharepoint_get_page').responseMapping!;
    expect(validateTransform(page.transform)).toBeNull();
    expect(applyResponseTransform({ title: 'x'.repeat(300_000) }, page).truncated).toBe(true);
    for (const name of ['sharepoint_upload_text_file', 'sharepoint_rename_drive_item', 'sharepoint_move_drive_item']) {
      const out = applyResponseTransform(
        { id: '1', '@microsoft.graph.downloadUrl': 'https://public.example/secret' },
        tool(name).responseMapping,
      ).value;
      expect(out).toEqual({ id: '1' });
    }
    for (const t of a.tools) {
      if (/\/content$/.test(t.endpointMapping.path)) expect(t.endpointMapping.method).toBe('PUT');
    }
  });
});

const TOKEN = process.env.MS_GRAPH_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('microsoft-sharepoint adapter: live Graph API', () => {
  const auth = { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers };
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService)
      .execute(auth, tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params))
      .then((raw) => applyResponseTransform(raw, tool(name).responseMapping).value);
  let site: { id: string; webUrl: string; siteCollection?: { hostname: string } };

  beforeAll(async () => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
    // A site the user can reach: the root site, else the first search hit.
    try {
      site = await run('sharepoint_get_root_site');
    } catch {
      const found = await run('sharepoint_search_sites', { query: '*', top: 5 });
      if (!found.value?.length) throw new Error('The token reaches no SharePoint site');
      site = found.value[0];
    }
  }, 60_000);

  it('reads the site by id and by path, its drives, lists and pages', async () => {
    const byId = await run('sharepoint_get_site', { site_id: site.id });
    expect(byId.id).toBe(site.id);
    const url = new URL(site.webUrl);
    if (url.pathname.length > 1) {
      const byPath = await run('sharepoint_get_site_by_path', { hostname: url.hostname, site_path: url.pathname.replace(/^\//, '') });
      expect(byPath.id).toBe(site.id);
    }
    const drives = await run('sharepoint_list_drives', { site_id: site.id });
    expect(Array.isArray(drives.value)).toBe(true);
    if (drives.value.length) {
      const root = await run('sharepoint_list_drive_root', { drive_id: drives.value[0].id, top: 5 });
      expect(Array.isArray(root.value)).toBe(true);
      const hits = await run('sharepoint_search_drive', { drive_id: drives.value[0].id, query: 'a', top: 3 });
      expect(Array.isArray(hits.value)).toBe(true);
    }
    const lists = await run('sharepoint_list_lists', { site_id: site.id });
    expect(Array.isArray(lists.value)).toBe(true);
    const visible = lists.value.find((l: { list?: { hidden?: boolean; template?: string } }) => !l.list?.hidden && l.list?.template === 'genericList');
    if (visible) {
      const cols = await run('sharepoint_list_columns', { site_id: site.id, list_id: visible.id });
      expect(Array.isArray(cols.value)).toBe(true);
      const items = await run('sharepoint_list_items', { site_id: site.id, list_id: visible.id, top: 3 });
      expect(Array.isArray(items.value)).toBe(true);
    }
    const pages = await run('sharepoint_list_pages', { site_id: site.id, top: 3 });
    expect(Array.isArray(pages.value)).toBe(true);
    if (pages.value.length) {
      const page = await run('sharepoint_get_page', { site_id: site.id, page_id: pages.value[0].id });
      expect(page.id ?? page._truncated).toBeTruthy();
    }
  }, 120_000);

  it('searches across SharePoint with Microsoft Search', async () => {
    const res = await run('sharepoint_search', { query: 'a', size: 5 });
    expect(Array.isArray(res.value)).toBe(true);
  }, 60_000);

  (process.env.SHAREPOINT_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a test list with an item and a test folder with a text file, then deletes both',
    async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const list = await run('sharepoint_create_list', {
        site_id: site.id,
        display_name: `AnythingMCP test ${stamp}`,
        columns: [{ name: 'Status', text: {} }, { name: 'Amount', number: {} }],
      });
      const drives = await run('sharepoint_list_drives', { site_id: site.id });
      const driveId: string = drives.value[0].id;
      let folderId: string | undefined;
      try {
        const item = await run('sharepoint_create_list_item', {
          site_id: site.id,
          list_id: list.id,
          fields: { Title: 'AnythingMCP test item', Status: 'Open', Amount: 12.5 },
        });
        expect(item.fields.Title).toBe('AnythingMCP test item');
        const updated = await run('sharepoint_update_list_item', { site_id: site.id, list_id: list.id, item_id: item.id, fields: { Status: 'Done' } });
        expect(updated.Status).toBe('Done');
        const read = await run('sharepoint_get_list_item', { site_id: site.id, list_id: list.id, item_id: item.id });
        expect(read.fields.Amount).toBe(12.5);
        const open = await run('sharepoint_list_items', { site_id: site.id, list_id: list.id, filter: "fields/Status eq 'Done'" });
        expect(open.value.length).toBe(1);

        const folder = await run('sharepoint_create_folder', { drive_id: driveId, name: `AnythingMCP test ${stamp}` });
        folderId = folder.id;
        const file = await run('sharepoint_upload_text_file', { drive_id: driveId, file_name: 'AnythingMCP test.txt', content: 'AnythingMCP test\n', parent_id: folder.id });
        expect(file['@microsoft.graph.downloadUrl']).toBeUndefined();
        const renamed = await run('sharepoint_rename_drive_item', { drive_id: driveId, item_id: file.id, name: 'AnythingMCP renamed.txt' });
        expect(renamed.name).toBe('AnythingMCP renamed.txt');
        const perms = await run('sharepoint_list_permissions', { drive_id: driveId, item_id: file.id });
        expect(Array.isArray(perms.value)).toBe(true);
      } finally {
        if (folderId) await run('sharepoint_delete_drive_item', { drive_id: driveId, item_id: folderId });
        // No tool deletes a list, on purpose: clean up with a direct call.
        await mockedAxios.__actual({
          method: 'DELETE',
          url: `${BASE}/sites/${encodeURIComponent(site.id)}/lists/${list.id}`,
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
      }
    },
    180_000,
  );
});
