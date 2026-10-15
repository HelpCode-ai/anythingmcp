import axios from 'axios';
import * as adapter from './egnyte.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { isMachineGrant } from '../../connectors/oauth-grant.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Egnyte adapter:
 *
 *   1. Static: always runs. Pins the OAuth password grant Egnyte prescribes
 *      for internal applications (token URL on the customer's domain, client
 *      id and secret in the form body, the four scopes), every tool's method,
 *      URL and parameters through the real RestEngine (checked against
 *      Egnyte's Public API reference and its official Python SDK), the
 *      byte-range read of text files, the confirm-first wording, the
 *      switched-off delete, and the response mappings against the documented
 *      example payloads.
 *
 *   2. Live: skipped unless RUN_EGNYTE_LIVE=1.
 *
 *        RUN_EGNYTE_LIVE=1 npx jest src/adapters/intl/egnyte.live.spec.ts
 *
 *      Without credentials it only checks that an Egnyte domain refuses a
 *      made-up token with 401. With EGNYTE_DOMAIN and EGNYTE_ACCESS_TOKEN (a
 *      token obtained with the password grant) it reads the user, /Shared,
 *      the links and the event cursor. Nothing is written: the one write,
 *      egnyte_create_link, is only exercised with EGNYTE_LIVE_WRITE=1 and
 *      EGNYTE_TEST_FILE (a file path), creating a domain-only link that
 *      expires after one click.
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
  parameters: { properties?: Record<string, { default?: unknown; pattern?: string; maximum?: number }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string }>;
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

const BASE = 'https://acme.egnyte.com/pubapi';
// Mirrors DynamicMcpTools: {{VAR}} interpolated, schema defaults applied, OAuth2 token from the token service.
const run = async (name: string, params: Record<string, unknown>, token = 'test-token', domain = 'acme') => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    { EGNYTE_DOMAIN: domain },
  );
  const { body } = await new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue(token) } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  ).executeWithMeta(
    { baseUrl: config.baseUrl, authType: 'OAUTH2', authConfig: {}, headers: config.headers } as never,
    endpointMapping as never,
    applySchemaDefaults(tool(name).parameters as never, params),
  );
  return body as any;
};
const runShaped = async (name: string, params: Record<string, unknown>, token?: string, domain?: string) =>
  applyResponseTransform(await run(name, params, token, domain), tool(name).responseMapping as never).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

describe('egnyte adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('egnyte');
    expect(a.icon).toBe('egnyte');
    expect(a.category).toBe('storage');
  });

  it('signs in with the password grant of an internal application on the customer domain', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'password',
      tokenUrl: 'https://{{EGNYTE_DOMAIN}}.egnyte.com/puboauth/token',
      clientId: '{{EGNYTE_CLIENT_ID}}',
      clientSecret: '{{EGNYTE_CLIENT_SECRET}}',
      username: '{{EGNYTE_USERNAME}}',
      password: '{{EGNYTE_PASSWORD}}',
      tokenAuthMethod: 'client_secret_post',
      scope: 'Egnyte.filesystem Egnyte.link Egnyte.permission Egnyte.user',
    });
    // A machine grant: the engine asks for a new token by itself when one expires (30 days).
    expect(isMachineGrant(a.connector.authConfig.grant)).toBe(true);
    expect(a.connector.authConfig.authorizationUrl).toBeUndefined();
    expect(a.connector.baseUrl).toBe('https://{{EGNYTE_DOMAIN}}.egnyte.com/pubapi');
    expect(a.requiredEnvVars).toEqual(['EGNYTE_DOMAIN', 'EGNYTE_CLIENT_ID', 'EGNYTE_CLIENT_SECRET', 'EGNYTE_USERNAME', 'EGNYTE_PASSWORD']);
    for (const v of ['EGNYTE_CLIENT_SECRET', 'EGNYTE_PASSWORD']) expect(a.envVarMeta[v].secret).toBe(true);
    const domain = new RegExp(a.envVarMeta.EGNYTE_DOMAIN.pattern!);
    expect(domain.test('acme')).toBe(true);
    for (const bad of ['acme.egnyte.com', 'https://acme', 'evil.com/x']) expect(domain.test(bad)).toBe(false);
    expect(a.connector.healthcheckPath).toBe('/v1/userinfo');
    expect(a.probe.tool).toBe('egnyte_get_user_info');
    expect(a.instructions).toMatch(/Internal Application/);
    expect(a.instructions).toMatch(/Pending Approval/);
  });

  it('prefixes every tool with egnyte_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^egnyte_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('everything reads except the link creation (confirm) and the switched-off delete', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort();
    expect(writes).toEqual(['egnyte_create_link', 'egnyte_delete_item']);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET')) {
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
    }
    expect(tool('egnyte_create_link').enabled).toBeUndefined();
    expect(tool('egnyte_create_link').description).toMatch(/confirm before calling/);
    expect(tool('egnyte_delete_item').enabled).toBe(false);
    // No uploads: nothing writes to fs-content.
    expect(a.tools.filter((t) => t.endpointMapping.path.startsWith('/v1/fs-content')).map((t) => t.endpointMapping.method)).toEqual(['GET']);
  });

  it('every tool shapes its answer, and only points at tools that exist', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${Boolean(tr && (tr.select || tr.exclude || tr.include))}`).toBe(`${t.name}:true`);
    }
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\begnyte_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\begnyte_[a-z_]+/g)])].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(12);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Egnyte\n')).toBe(true);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('accepts real Egnyte paths and refuses relative or climbing ones', () => {
    const re = new RegExp(tool('egnyte_list_folder').parameters.properties!.path.pattern!);
    for (const ok of ['/Shared', '/Shared/', '/Shared/Projects/Plan v2.docx', '/Private/jsmith', '/Shared/R%26D/Q%3F.xlsx', '/Shared/a..b']) expect(re.test(ok)).toBe(true);
    for (const bad of ['Shared/x', '/Other/x', '/Shared/../../v1/links', '/Shared/./x', '/Shared/x?y', '/Shared/x#y', '']) expect(re.test(bad)).toBe(false);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['egnyte_get_user_info', {}, 'GET', `${BASE}/v1/userinfo`],
    ['egnyte_list_folder', { path: '/Shared/Projects' }, 'GET', `${BASE}/v1/fs/Shared/Projects`],
    ['egnyte_get_item', { path: '/Shared/Projects/Plan.docx' }, 'GET', `${BASE}/v1/fs/Shared/Projects/Plan.docx`],
    ['egnyte_list_file_versions', { path: '/Shared/Plan.docx' }, 'GET', `${BASE}/v1/fs/Shared/Plan.docx`],
    ['egnyte_search', { query: 'budget' }, 'GET', `${BASE}/v1/search`],
    ['egnyte_read_text_file', { path: '/Shared/notes.txt' }, 'GET', `${BASE}/v1/fs-content/Shared/notes.txt`],
    ['egnyte_list_links', {}, 'GET', `${BASE}/v2/links`],
    ['egnyte_get_link', { link_id: '6a7ILnZZZ' }, 'GET', `${BASE}/v1/links/6a7ILnZZZ`],
    ['egnyte_create_link', { path: '/Shared/a.pdf', type: 'file', accessibility: 'domain' }, 'POST', `${BASE}/v1/links`],
    ['egnyte_get_folder_permissions', { path: '/Shared/Finance' }, 'GET', `${BASE}/v2/perms/Shared/Finance`],
    ['egnyte_get_effective_permission', { username: 'jsmith', folder: '/Shared/Finance' }, 'GET', `${BASE}/v1/perms/user/jsmith`],
    ['egnyte_get_events_cursor', {}, 'GET', `${BASE}/v1/events/cursor`],
    ['egnyte_list_events', { id: 16341 }, 'GET', `${BASE}/v2/events`],
    ['egnyte_delete_item', { path: '/Shared/old.txt' }, 'DELETE', `${BASE}/v1/fs/Shared/old.txt`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s calls the customer domain with the Bearer token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(url);
    expect(sent().headers.Authorization).toBe('Bearer test-token');
  });

  it('keeps the slashes of a path and encodes a username', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run('egnyte_list_folder', { path: '/Shared/Sales Team/2026' });
    // Spaces are percent-encoded by the HTTP client when the request is sent.
    expect(sent().url).toBe(`${BASE}/v1/fs/Shared/Sales Team/2026`);
    expect(new URL(sent().url).pathname).toBe('/pubapi/v1/fs/Shared/Sales%20Team/2026');
    mockedAxios.mockClear();
    await run('egnyte_get_effective_permission', { username: '../fs/Shared', folder: '/Shared' });
    expect(sent().url).toBe(`${BASE}/v1/perms/user/..%2Ffs%2FShared`);
  });

  it('lists folder contents, reads details without contents and versions with list_content', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run('egnyte_list_folder', { path: '/Shared', offset: 100, sort_by: 'last_modified' });
    expect(sent().params).toEqual({ list_content: 'true', count: 100, offset: 100, sort_by: 'last_modified' });
    mockedAxios.mockClear();
    await run('egnyte_get_item', { path: '/Shared' });
    expect(sent().params).toEqual({ include_perm: 'true', allowed_link_types: 'true', count: '0' });
    mockedAxios.mockClear();
    await run('egnyte_list_file_versions', { path: '/Shared/a.txt' });
    expect(sent().params).toEqual({ list_content: 'true' });
    mockedAxios.mockClear();
    await run('egnyte_search', { query: 'budget', folder: '/Shared/Finance' });
    expect(sent().params).toEqual({ query: 'budget', folder: '/Shared/Finance', count: 20 });
    mockedAxios.mockClear();
    await run('egnyte_list_events', { id: 16342, reverse: 1, count: 10 });
    expect(sent().params).toEqual({ id: 16342, reverse: 1, count: 10 });
  });

  it('reads a text file with a byte range, defaulting to 50000 bytes', async () => {
    mockedAxios.mockResolvedValue({ data: 'hello' });
    await run('egnyte_read_text_file', { path: '/Shared/notes.txt' });
    expect(sent().headers.Range).toBe('bytes=0-50000');
    expect(sent().headers.Accept).toBe('*/*');
    expect(sent().params).toEqual({});
    mockedAxios.mockClear();
    await run('egnyte_read_text_file', { path: '/Shared/notes.txt', entry_id: 'a4e2857e', max_bytes: 2000 });
    expect(sent().headers.Range).toBe('bytes=0-2000');
    expect(sent().params).toEqual({ entry_id: 'a4e2857e' });
    expect(shape('egnyte_read_text_file', 'line 1\nline 2').value).toBe('line 1\nline 2');
    expect(shape('egnyte_read_text_file', 'x'.repeat(200_000)).truncated).toBe(true);
  });

  it('creates a link with the documented body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run('egnyte_create_link', { path: '/Shared/a.pdf', type: 'file', accessibility: 'recipients', recipients: ['jsmith@acme.com'], send_email: true, expiry_date: '2026-12-31' });
    expect(sent().data).toEqual({ path: '/Shared/a.pdf', type: 'file', accessibility: 'recipients', recipients: ['jsmith@acme.com'], send_email: true, expiry_date: '2026-12-31' });
    expect(tool('egnyte_create_link').parameters.required).toEqual(['path', 'type', 'accessibility']);
  });

  // Example payloads from Egnyte's Public API reference, trimmed.
  it('shapes a folder listing, a file with versions, links and events', () => {
    const folder = shape('egnyte_list_folder', {
      name: 'MyFolder', lastModified: 1554182069000, uploaded: 1554178564015, count: 2, offset: 0, path: '/Shared/MyDocuments/MyFolder', folder_id: 'd7d5', parent_id: 'b0sc', total_count: 2, is_folder: true,
      permissions: { users: [{ subject: 'admin', permission: 'Owner' }] }, custom_metadata: [{ x: {} }],
      folders: [{ name: 'subfolder1', lastModified: 1554185307000, uploaded: 1554185307326, path: '/Shared/MyDocuments/MyFolder/subfolder1', folder_id: 'fc8c', is_folder: true, parent_id: 'd7d5' }],
      files: [{ checksum: '244b', size: 238428, path: '/Shared/MyDocuments/MyFolder/info.pdf', name: 'info.pdf', locked: false, is_folder: false, entry_id: 'e1', group_id: 'g1', last_modified: 'Tue, 02 Apr 2019 05:12:44 GMT', uploaded_by: 'jsmith', num_versions: 1 }],
    }).value as any;
    expect(folder).toEqual({
      name: 'MyFolder', path: '/Shared/MyDocuments/MyFolder', folder_id: 'd7d5', total_count: 2, count: 2, offset: 0,
      folders: [{ name: 'subfolder1', path: '/Shared/MyDocuments/MyFolder/subfolder1', folder_id: 'fc8c', lastModified: 1554185307000 }],
      files: [{ name: 'info.pdf', path: '/Shared/MyDocuments/MyFolder/info.pdf', size: 238428, last_modified: 'Tue, 02 Apr 2019 05:12:44 GMT', uploaded_by: 'jsmith', group_id: 'g1', entry_id: 'e1', num_versions: 1, locked: false }],
    });
    const versions = shape('egnyte_list_file_versions', {
      checksum: '32d9', size: 1023, path: '/Shared/MyDocuments/example.txt', name: 'example.txt', locked: false, is_folder: false, entry_id: 'a4e2', group_id: '765f', last_modified: 'Tue, 02 Apr 2019 05:12:44 GMT', uploaded_by: 'jsmith', uploaded: 1554182069464, num_versions: 3,
      versions: [{ is_folder: false, entry_id: '0ee5', checksum: '2aca', last_modified: 'Fri, 29 Mar 2019 16:31:53 GMT', uploaded_by: 'mjohnson', uploaded: 1554180282161, size: 1378 }],
    }).value as any;
    expect(versions.current).toEqual({ entry_id: 'a4e2', size: 1023, last_modified: 'Tue, 02 Apr 2019 05:12:44 GMT', uploaded_by: 'jsmith', checksum: '32d9' });
    expect(versions.versions[0]).toEqual({ entry_id: '0ee5', size: 1378, last_modified: 'Fri, 29 Mar 2019 16:31:53 GMT', uploaded_by: 'mjohnson', uploaded: 1554180282161, checksum: '2aca' });
    const links = shape('egnyte_list_links', {
      links: [{ path: '/Shared/abcd/123.png', type: 'file', accessibility: 'anyone', protection: 'NONE', recipients: [], notify: false, url: 'https://apidemo.egnyte.com/dl/6a7ILnZZZ', id: '6a7ILnZZZ', link_to_current: false, creation_date: '2022-03-13T06:15:27+0000', created_by: 'admin', resource_id: '6cc7', expiry_clicks: 4, last_accessed: '2022-03-16T10:34:12.000+0000' }],
      count: 1,
    }).value as any;
    expect(links.links[0]).toMatchObject({ id: '6a7ILnZZZ', url: 'https://apidemo.egnyte.com/dl/6a7ILnZZZ', accessibility: 'anyone', expiry_clicks: 4 });
    const created = shape('egnyte_create_link', {
      links: [{ id: '47b7', url: 'https://domain.egnyte.com/h-s/20130717/47b7', recipients: ['jsmith@acme.com'] }],
      path: '/Shared/Documents/example.txt', type: 'file', accessibility: 'recipients', notify: true, link_to_current: false, expiry_date: '2021-05-27', creation_date: '2021-05-02', created_by: 'gbrown',
    }).value as any;
    expect(created).toMatchObject({ links: [{ id: '47b7', url: 'https://domain.egnyte.com/h-s/20130717/47b7', recipients: ['jsmith@acme.com'] }], accessibility: 'recipients', expiry_date: '2021-05-27' });
    const events = shape('egnyte_list_events', {
      latest_id: 16342, oldest_id: 16342, count: 1,
      events: [{ id: 16342, timestamp: '2025-05-28T11:41:12.000Z', action_source: 'WebUI', actor: 1, type: 'file_system', action: 'copy', object_detail: 'https://x', data: { target_path: '/Shared/Documents/My Contract.docx', source_path: '/Shared/Contracts/My Contract.docx', is_folder: false } }],
    }).value as any;
    expect(events.events[0]).toEqual({ id: 16342, timestamp: '2025-05-28T11:41:12.000Z', action_source: 'WebUI', actor: 1, type: 'file_system', action: 'copy', data: { target_path: '/Shared/Documents/My Contract.docx', source_path: '/Shared/Contracts/My Contract.docx', is_folder: false } });
    // 204 No Content when nothing happened: an empty answer passes through.
    expect(shape('egnyte_list_events', '').value).toEqual({});
    const perms = shape('egnyte_get_folder_permissions', { userPerms: { jsmith: 'Full' }, groupPerms: { 'All Administrators': 'Owner' }, inheritsPermissions: true }).value;
    expect(perms).toEqual({ userPerms: { jsmith: 'Full' }, groupPerms: { 'All Administrators': 'Owner' }, inheritsPermissions: true });
  });
});

const live = process.env.RUN_EGNYTE_LIVE === '1' ? describe : describe.skip;

live('egnyte adapter: live API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('a domain refuses a made-up token with 401', async () => {
    await expect(run('egnyte_get_user_info', {}, 'not-a-real-token', 'acme')).rejects.toMatchObject({ response: { status: 401 } });
    await expect(run('egnyte_list_folder', { path: '/Shared' }, 'not-a-real-token', 'acme')).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);

  const domain = process.env.EGNYTE_DOMAIN;
  const token = process.env.EGNYTE_ACCESS_TOKEN;
  const withToken = domain && token ? it : it.skip;
  withToken('reads the user, /Shared, links and the event cursor', async () => {
    const me = await runShaped('egnyte_get_user_info', {}, token, domain);
    expect(typeof me.username).toBe('string');
    const shared = await runShaped('egnyte_list_folder', { path: '/Shared', count: 10 }, token, domain);
    expect(shared.path).toBe('/Shared');
    const links = await runShaped('egnyte_list_links', { count: 5 }, token, domain);
    expect(Array.isArray(links.links ?? [])).toBe(true);
    const cursor = await runShaped('egnyte_get_events_cursor', {}, token, domain);
    expect(typeof cursor.latest_event_id).toBe('number');
  }, 60_000);

  const writes = domain && token && process.env.EGNYTE_LIVE_WRITE === '1' && process.env.EGNYTE_TEST_FILE ? it : it.skip;
  writes('creates a domain-only link that expires after one click', async () => {
    const link = await runShaped('egnyte_create_link', { path: process.env.EGNYTE_TEST_FILE, type: 'file', accessibility: 'domain', expiry_clicks: 1 }, token, domain);
    expect(link.links[0].url).toMatch(/^https:\/\//);
  }, 30_000);
});
