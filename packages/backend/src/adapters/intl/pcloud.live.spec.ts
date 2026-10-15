import axios from 'axios';
import * as adapter from './pcloud.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the pCloud adapter:
 *
 *   1. Static: always runs. Pins the OAuth setup (authorize at my.pcloud.com,
 *      token exchange and API calls at the region host, no PKCE, no refresh),
 *      every tool's method, URL and parameters through the real RestEngine
 *      (checked against pCloud's method reference and official JavaScript
 *      SDK), the `result` codes of HTTP 200 answers turned into errors, the
 *      confirm-first wording, the switched-off deletes, and the response
 *      mappings against the documented example payloads.
 *
 *   2. Live: skipped unless RUN_PCLOUD_LIVE=1.
 *
 *        RUN_PCLOUD_LIVE=1 npx jest src/adapters/intl/pcloud.live.spec.ts
 *
 *      Without a token it only checks that both region hosts refuse a made-up
 *      token with result 2094, which the connector reports as 401. With
 *      PCLOUD_ACCESS_TOKEN and PCLOUD_API_HOST it reads the account, the root
 *      folder and the public links. With PCLOUD_LIVE_WRITE=1 as well, a folder
 *      "AnythingMCP test" is created in the root and deleted again.
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
  parameters: { properties?: Record<string, { default?: unknown; pattern?: string; enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    bodyEncoding?: string;
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
    authConfig: Record<string, unknown>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown[] };
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

const EU = 'https://eapi.pcloud.com';
// Mirrors DynamicMcpTools: {{VAR}} interpolated, schema defaults applied, OAuth2 token from the token service.
const run = async (name: string, params: Record<string, unknown>, token = 'test-token', host = 'eapi.pcloud.com') => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    { PCLOUD_API_HOST: host },
  );
  const { body } = await new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue(token) } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  ).executeWithMeta(
    { baseUrl: config.baseUrl, authType: 'OAUTH2', authConfig: {}, headers: config.headers, errorWhen: a.connector.config.errorWhen } as never,
    endpointMapping as never,
    applySchemaDefaults(tool(name).parameters as never, params),
  );
  return body as any;
};
const runShaped = async (name: string, params: Record<string, unknown>, token?: string, host?: string) =>
  applyResponseTransform(await run(name, params, token, host), tool(name).responseMapping as never).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const READS = [
  'pcloud_get_user_info', 'pcloud_list_folder', 'pcloud_stat', 'pcloud_read_text_file', 'pcloud_get_file_link', 'pcloud_list_revisions', 'pcloud_list_public_links',
];
const WRITES = [
  'pcloud_create_folder', 'pcloud_copy_file', 'pcloud_move_file', 'pcloud_move_folder', 'pcloud_copy_folder', 'pcloud_create_file_public_link', 'pcloud_create_folder_public_link',
];

describe('pcloud adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('pcloud');
    expect(a.icon).toBe('pcloud');
    expect(a.category).toBe('storage');
  });

  it('authorizes at my.pcloud.com and exchanges the code at the account region host, without PKCE', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{PCLOUD_CLIENT_ID}}',
      clientSecret: '{{PCLOUD_CLIENT_SECRET}}',
      authorizationUrl: 'https://my.pcloud.com/oauth2/authorize',
      tokenUrl: 'https://{{PCLOUD_API_HOST}}/oauth2_token',
      tokenAuthMethod: 'client_secret_post',
      pkce: false,
    });
    // pCloud tokens do not expire and come without a refresh token.
    expect(a.connector.authConfig.refreshToken).toBeUndefined();
    expect(a.connector.baseUrl).toBe('https://{{PCLOUD_API_HOST}}');
    expect(a.requiredEnvVars).toEqual(['PCLOUD_CLIENT_ID', 'PCLOUD_CLIENT_SECRET', 'PCLOUD_API_HOST']);
    expect(a.envVarMeta.PCLOUD_CLIENT_SECRET.secret).toBe(true);
    const host = new RegExp(a.envVarMeta.PCLOUD_API_HOST.pattern!);
    expect(host.test('api.pcloud.com')).toBe(true);
    expect(host.test('eapi.pcloud.com')).toBe(true);
    for (const bad of ['https://eapi.pcloud.com', 'evil.com', 'api.pcloud.com.evil.com']) expect(host.test(bad)).toBe(false);
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/e\.pcloud\.com/);
    expect(a.connector.healthcheckPath).toBe('/userinfo');
    expect(a.probe.tool).toBe('pcloud_get_user_info');
  });

  it('prefixes every tool with pcloud_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^pcloud_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    expect([...READS, ...WRITES, 'pcloud_delete_file', 'pcloud_delete_folder'].sort()).toEqual([...mine].sort());
  });

  it('reads are GETs, writes are form POSTs that ask to confirm, deletes are switched off', () => {
    for (const name of READS) expect(`${name}:${annotationsOf(tool(name)).readOnlyHint}`).toBe(`${name}:true`);
    for (const name of [...WRITES, 'pcloud_delete_file', 'pcloud_delete_folder']) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(tool(name).endpointMapping.bodyEncoding).toBe('form-urlencoded');
      expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
    }
    for (const name of WRITES) {
      expect(tool(name).enabled).toBeUndefined();
      expect(tool(name).description).toMatch(/confirm before calling/);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['pcloud_delete_file', 'pcloud_delete_folder']);
    // deletefolderrecursive (a folder with all its contents) is not offered at all.
    expect(JSON.stringify(adapter)).not.toContain('deletefolderrecursive');
  });

  it('every tool shapes its answer, and only points at tools that exist', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${Boolean(tr && (tr.select || tr.exclude || tr.include))}`).toBe(`${t.name}:true`);
    }
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bpcloud_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bpcloud_[a-z_]+/g)])].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(12);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## pCloud\n')).toBe(true);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string]> = [
    ['pcloud_get_user_info', {}, '/userinfo'],
    ['pcloud_list_folder', { folder_id: 0 }, '/listfolder'],
    ['pcloud_stat', { file_id: 1 }, '/stat'],
    ['pcloud_read_text_file', { file_id: 1 }, '/gettextfile'],
    ['pcloud_get_file_link', { file_id: 1 }, '/getfilelink'],
    ['pcloud_list_revisions', { file_id: 1 }, '/listrevisions'],
    ['pcloud_list_public_links', {}, '/listpublinks'],
    ['pcloud_create_folder', { path: '/x' }, '/createfolderifnotexists'],
    ['pcloud_copy_file', { file_id: 1, to_folder_id: 2 }, '/copyfile'],
    ['pcloud_move_file', { file_id: 1, to_name: 'y' }, '/renamefile'],
    ['pcloud_move_folder', { folder_id: 3, to_name: 'y' }, '/renamefolder'],
    ['pcloud_copy_folder', { folder_id: 3, to_folder_id: 0 }, '/copyfolder'],
    ['pcloud_create_file_public_link', { file_id: 1 }, '/getfilepublink'],
    ['pcloud_create_folder_public_link', { folder_id: 3 }, '/getfolderpublink'],
    ['pcloud_delete_file', { file_id: 1 }, '/deletefile'],
    ['pcloud_delete_folder', { folder_id: 3 }, '/deletefolder'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s calls the pCloud method at the region host with the Bearer token', async (name, params, path) => {
    mockedAxios.mockResolvedValue({ data: { result: 0 } });
    await run(name, params);
    expect(sent().url).toBe(`${EU}${path}`);
    expect(sent().method).toBe(tool(name).endpointMapping.method);
    expect(sent().headers.Authorization).toBe('Bearer test-token');
  });

  it('switches to the US host with PCLOUD_API_HOST', async () => {
    mockedAxios.mockResolvedValue({ data: { result: 0 } });
    await run('pcloud_get_user_info', {}, 'test-token', 'api.pcloud.com');
    expect(sent().url).toBe('https://api.pcloud.com/userinfo');
  });

  it('sends read parameters in the query string and write parameters as a form body', async () => {
    mockedAxios.mockResolvedValue({ data: { result: 0 } });
    await run('pcloud_list_folder', { folder_id: 0 });
    expect(sent().params).toEqual({ folderid: 0 });
    mockedAxios.mockClear();
    await run('pcloud_list_folder', { path: '/Documents', nofiles: 1 });
    expect(sent().params).toEqual({ path: '/Documents', nofiles: 1 });
    mockedAxios.mockClear();
    await run('pcloud_read_text_file', { file_id: 42 });
    expect(sent().params).toEqual({ fileid: 42, toencoding: 'utf-8' });
    mockedAxios.mockClear();
    await run('pcloud_get_file_link', { file_id: 42, revision_id: 7 });
    expect(sent().params).toEqual({ fileid: 42, revisionid: 7 });
    mockedAxios.mockClear();
    await run('pcloud_move_file', { file_id: 42, to_folder_id: 0, to_name: 'new name.txt' });
    expect(sent().headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(sent().data).toString()).toBe('fileid=42&tofolderid=0&toname=new+name.txt');
    mockedAxios.mockClear();
    await run('pcloud_create_folder', { folder_id: 0, name: 'Projects' });
    expect(new URLSearchParams(sent().data).toString()).toBe('folderid=0&name=Projects');
    mockedAxios.mockClear();
    await run('pcloud_create_file_public_link', { file_id: 42, expire: '2026-12-31T23:59:59Z', maxdownloads: 5 });
    expect(new URLSearchParams(sent().data).toString()).toBe('fileid=42&expire=2026-12-31T23%3A59%3A59Z&maxdownloads=5');
    // Flags count as set whenever they are present, so they only take 1.
    expect(tool('pcloud_copy_file').parameters.properties!.noover.enum).toEqual([1]);
  });

  it('turns result codes of HTTP 200 answers into errors and lets result 0 through', async () => {
    const cases: Array<[number, string, RegExp]> = [
      [2094, "Invalid 'access_token' provided.", /Invalid 'access_token'/],
      [1000, 'Log in required.', /Log in required/],
      [2005, 'Directory does not exist.', /Directory does not exist/],
      [2004, 'File or folder alredy exists.', /alredy exists/],
      [4000, 'Too many login tries from this IP address.', /Too many/],
      [5000, 'Internal error. Try again later.', /Internal error/],
    ];
    for (const [result, error, re] of cases) {
      mockedAxios.mockResolvedValue({ data: { result, error } });
      await expect(run('pcloud_stat', { file_id: 1 })).rejects.toThrow(re);
    }
    mockedAxios.mockResolvedValue({ data: { result: 0, metadata: { name: 'a.txt' } } });
    await expect(run('pcloud_stat', { file_id: 1 })).resolves.toMatchObject({ result: 0 });
    // A text file's contents are a string, not a result envelope.
    mockedAxios.mockResolvedValue({ data: 'hello, world\n' });
    await expect(run('pcloud_read_text_file', { file_id: 1 })).resolves.toBe('hello, world\n');
  });

  // Example payloads from pCloud's method reference, trimmed.
  it('shapes a folder listing, a file and a download link', () => {
    const listing = shape('pcloud_list_folder', {
      result: 0,
      metadata: {
        icon: 'folder', id: 'd0', modified: 'Thu, 19 Sep 2013 07:31:46 +0000', path: '/', thumb: false, folderid: 0, isshared: false, isfolder: true, ismine: true, name: '/',
        contents: [
          { parentfolderid: 0, id: 'd230807', modified: 'Wed, 02 Oct 2013 13:23:35 +0000', path: '/Simple Folder', thumb: false, folderid: 230807, ismine: true, isshared: false, isfolder: true, name: 'Simple Folder', icon: 'folder' },
          { icon: 'audio', contenttype: 'audio/mpeg', parentfolderid: 0, modified: 'Wed, 02 Oct 2013 13:23:19 +0000', hash: 5380817599554757000, thumb: false, id: 'f1723778', ismine: true, category: 3, fileid: 1723778, isshared: false, isfolder: false, name: 'Simple Audio.mp3', size: 11252576 },
        ],
      },
    }).value as any;
    expect(listing.folderid).toBe(0);
    expect(listing.contents).toEqual([
      { name: 'Simple Folder', isfolder: true, folderid: 230807, modified: 'Wed, 02 Oct 2013 13:23:35 +0000', isshared: false },
      { name: 'Simple Audio.mp3', isfolder: false, fileid: 1723778, size: 11252576, contenttype: 'audio/mpeg', modified: 'Wed, 02 Oct 2013 13:23:19 +0000', isshared: false },
    ]);
    const link = shape('pcloud_get_file_link', { result: 0, path: '/hash/My%20picture.jpg', expires: 'Thu, 03 Oct 2013 01:06:49 +0000', hosts: ['c63.pcloud.com', 'c1.pcloud.com'] }).value;
    expect(link).toEqual({ hosts: ['c63.pcloud.com', 'c1.pcloud.com'], path: '/hash/My%20picture.jpg', expires: 'Thu, 03 Oct 2013 01:06:49 +0000' });
    const revisions = shape('pcloud_list_revisions', {
      result: 0,
      revisions: [{ revisionid: 7, size: 100, hash: 123, created: 'Thu, 03 Oct 2013 01:06:49 +0000' }],
      metadata: { fileid: 42, name: 'a.txt', size: 120, modified: 'x', icon: 'document' },
    }).value as any;
    expect(revisions).toEqual({ file: { fileid: 42, name: 'a.txt', size: 120, modified: 'x' }, revisions: [{ revisionid: 7, size: 100, hash: 123, created: 'Thu, 03 Oct 2013 01:06:49 +0000' }] });
  });

  it('caps a long text file', () => {
    const out = shape('pcloud_read_text_file', 'x'.repeat(300_000));
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out.value).length).toBeLessThan(110_000);
    expect(shape('pcloud_read_text_file', 'short text').value).toBe('short text');
  });
});

const live = process.env.RUN_PCLOUD_LIVE === '1' ? describe : describe.skip;

live('pcloud adapter: live API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('both region hosts refuse a made-up token, reported as an auth failure', async () => {
    for (const host of ['api.pcloud.com', 'eapi.pcloud.com']) {
      await expect(run('pcloud_get_user_info', {}, 'not-a-real-token', host)).rejects.toThrow(/Invalid 'access_token'/);
    }
  }, 30_000);

  const token = process.env.PCLOUD_ACCESS_TOKEN;
  const host = process.env.PCLOUD_API_HOST || 'eapi.pcloud.com';
  const withToken = token ? it : it.skip;
  withToken('reads the account, the root folder and the public links', async () => {
    const me = await runShaped('pcloud_get_user_info', {}, token, host);
    expect(typeof me.email).toBe('string');
    const root = await runShaped('pcloud_list_folder', { folder_id: 0 }, token, host);
    expect(root.folderid).toBe(0);
    expect(Array.isArray(root.contents)).toBe(true);
    const links = await runShaped('pcloud_list_public_links', {}, token, host);
    expect(Array.isArray(links.publinks ?? [])).toBe(true);
    const file = root.contents.find((c: { isfolder: boolean }) => !c.isfolder);
    if (file) {
      const stat = await runShaped('pcloud_stat', { file_id: file.fileid }, token, host);
      expect(stat.fileid).toBe(file.fileid);
      const dl = await runShaped('pcloud_get_file_link', { file_id: file.fileid }, token, host);
      expect(dl.hosts.length).toBeGreaterThan(0);
    }
  }, 60_000);

  const writes = token && process.env.PCLOUD_LIVE_WRITE === '1' ? it : it.skip;
  writes('creates and deletes a test folder', async () => {
    const created = await runShaped('pcloud_create_folder', { folder_id: 0, name: 'AnythingMCP test' }, token, host);
    expect(created.name).toBe('AnythingMCP test');
    const deleted = await runShaped('pcloud_delete_folder', { folder_id: created.folderid }, token, host);
    expect(deleted.isdeleted).toBe(true);
  }, 60_000);
});
