import axios from 'axios';
import * as adapter from './yandex-disk.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Yandex Disk adapter:
 *
 *   1. Static: always runs. Pins the Yandex OAuth endpoints (no scope in the
 *      request, so Yandex grants the permissions registered with the app),
 *      the `Authorization: OAuth <token>` header, and every tool's method,
 *      URL and query through the real RestEngine, checked against Yandex's
 *      own Swagger description (cloud-api.yandex.net/v1/schema/resources,
 *      fetched 14 Oct 2026). Also the response shaping, which tools are
 *      read-only, and that delete installs switched off and goes to the Trash
 *      by default.
 *
 *   2. Live: skipped unless RUN_YANDEX_DISK_LIVE=1. Without a token it checks
 *      that Yandex answers 401 on the real routes. With YANDEX_DISK_TOKEN (an
 *      OAuth token of an app with the Disk permissions, e.g. a debug token from
 *      https://oauth.yandex.ru/authorize?response_type=token&client_id=...)
 *      it reads the Disk info, the root, the flat file list, recent uploads,
 *      public resources and the Trash:
 *
 *        RUN_YANDEX_DISK_LIVE=1 YANDEX_DISK_TOKEN=y0_... npx jest src/adapters/intl/yandex-disk.live.spec.ts
 *
 *      YANDEX_DISK_LIVE_WRITE=1 adds a round-trip in a new folder
 *      disk:/AnythingMCP-test-<time>: create, upload from URL (polled),
 *      copy, move, publish, unpublish, delete to the Trash, restore, and a
 *      final delete of the folder (which stays in the Trash).
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
  parameters: { properties?: Record<string, { default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: { transform?: unknown };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
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

const BASE = 'https://cloud-api.yandex.net/v1';
// Mirrors DynamicMcpTools: {{VAR}} interpolated, schema defaults applied, and
// the OAuth2 token sent with the adapter's prefix.
const execute = (name: string, token: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    {},
  );
  return new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue(token) } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  ).execute(
    {
      baseUrl: config.baseUrl,
      authType: 'OAUTH2',
      authConfig: { tokenPrefix: a.connector.authConfig.tokenPrefix },
      headers: config.headers,
    },
    endpointMapping,
    applySchemaDefaults(tool(name).parameters as any, params),
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, 'test-token', params);
const sent = () => mockedAxios.mock.calls[0][0];

const READ_ONLY = [
  'yandex_disk_get_disk_info',
  'yandex_disk_get_download_link',
  'yandex_disk_get_operation_status',
  'yandex_disk_get_public_resource',
  'yandex_disk_get_resource',
  'yandex_disk_list_files',
  'yandex_disk_list_folder',
  'yandex_disk_list_last_uploaded',
  'yandex_disk_list_public',
  'yandex_disk_list_trash',
];

describe('yandex-disk adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against vendor SDKs, specs and working clients on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('storage');
    expect(a.icon).toBe('yandex-disk');
  });

  it('signs in at oauth.yandex.ru without a scope and sends Authorization: OAuth', async () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{YANDEX_DISK_CLIENT_ID}}',
      clientSecret: '{{YANDEX_DISK_CLIENT_SECRET}}',
      authorizationUrl: 'https://oauth.yandex.ru/authorize?force_confirm=yes',
      tokenUrl: 'https://oauth.yandex.ru/token',
      tokenPrefix: 'OAuth',
    });
    // Yandex issues the permissions registered with the app when no scope is
    // sent; the instructions name the ones to tick.
    for (const scope of ['cloud_api:disk.read', 'cloud_api:disk.write', 'cloud_api:disk.info']) {
      expect(a.instructions).toContain(scope);
      expect(a.prerequisites).toContain(scope);
    }
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    mockedAxios.mockResolvedValue({ data: {} });
    await call('yandex_disk_get_disk_info', {});
    expect(sent().headers.Authorization).toBe('OAuth test-token');
  });

  it('describes the client credentials and probes the Disk info', () => {
    expect(a.requiredEnvVars).toEqual(['YANDEX_DISK_CLIENT_ID', 'YANDEX_DISK_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toBeUndefined();
    const id = new RegExp(a.envVarMeta.YANDEX_DISK_CLIENT_ID.pattern!);
    expect(id.test('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(id.test('Bearer 0123456789abcdef')).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'YANDEX_DISK_CLIENT_SECRET')!.secret).toBe(true);
    expect(a.probe.tool).toBe('yandex_disk_get_disk_info');
    expect(tool('yandex_disk_get_disk_info').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/disk');
    for (const status of ['401', '403']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with yandex_disk_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^yandex_disk_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks the reads read-only, asks to confirm every write and installs delete switched off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    for (const t of a.tools.filter((x) => !READ_ONLY.includes(x.name))) {
      expect(`${t.name}: ${t.description}`).toMatch(/confirm/i);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['yandex_disk_delete']);
    expect(annotationsOf(tool('yandex_disk_delete')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('yandex_disk_create_folder'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsOf(tool('yandex_disk_publish'))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });

  it('explains disk:/ paths, the missing search endpoint and background operations', () => {
    expect(a.instructions).toMatch(/disk:\/folder\/file/);
    expect(a.instructions).toMatch(/no full-text or file-name search/);
    for (const name of ['yandex_disk_list_folder', 'yandex_disk_get_resource', 'yandex_disk_move', 'yandex_disk_delete']) {
      expect(tool(name).description).toContain('disk:/');
    }
    expect(tool('yandex_disk_list_folder').description).toMatch(/no search endpoint/);
    for (const name of ['yandex_disk_upload_from_url', 'yandex_disk_copy', 'yandex_disk_move', 'yandex_disk_delete', 'yandex_disk_restore_from_trash']) {
      expect(tool(name).description).toContain('yandex_disk_get_operation_status');
    }
    expect(tool('yandex_disk_delete').description).toMatch(/Trash/);
    expect(tool('yandex_disk_delete').parameters.properties!.permanently.default).toBe(false);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\byandex_disk_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\byandex_disk_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, params, method, path, expected query]
  const table: Array<[string, Record<string, unknown>, string, string, Record<string, unknown> | undefined]> = [
    ['yandex_disk_get_disk_info', {}, 'GET', '/disk', undefined],
    ['yandex_disk_list_folder', {}, 'GET', '/disk/resources', { path: 'disk:/', limit: 20 }],
    ['yandex_disk_get_resource', { path: 'disk:/a.txt' }, 'GET', '/disk/resources', { path: 'disk:/a.txt' }],
    ['yandex_disk_list_files', { media_type: 'image,video' }, 'GET', '/disk/resources/files', { media_type: 'image,video', limit: 20 }],
    ['yandex_disk_list_last_uploaded', {}, 'GET', '/disk/resources/last-uploaded', { limit: 20 }],
    ['yandex_disk_get_download_link', { path: 'disk:/a.txt' }, 'GET', '/disk/resources/download', { path: 'disk:/a.txt' }],
    ['yandex_disk_list_public', { type: 'file' }, 'GET', '/disk/resources/public', { type: 'file', limit: 20 }],
    ['yandex_disk_get_public_resource', { public_key: 'https://disk.yandex.ru/d/abc' }, 'GET', '/disk/public/resources', { public_key: 'https://disk.yandex.ru/d/abc', limit: 20 }],
    ['yandex_disk_create_folder', { path: 'disk:/New' }, 'PUT', '/disk/resources', { path: 'disk:/New' }],
    ['yandex_disk_copy', { from: 'disk:/a.txt', path: 'disk:/b.txt' }, 'POST', '/disk/resources/copy', { from: 'disk:/a.txt', path: 'disk:/b.txt', overwrite: false }],
    ['yandex_disk_move', { from: 'disk:/a.txt', path: 'disk:/c.txt' }, 'POST', '/disk/resources/move', { from: 'disk:/a.txt', path: 'disk:/c.txt', overwrite: false }],
    ['yandex_disk_publish', { path: 'disk:/a.txt' }, 'PUT', '/disk/resources/publish', { path: 'disk:/a.txt' }],
    ['yandex_disk_unpublish', { path: 'disk:/a.txt' }, 'PUT', '/disk/resources/unpublish', { path: 'disk:/a.txt' }],
    ['yandex_disk_upload_from_url', { url: 'https://example.com/f.pdf', path: 'disk:/f.pdf' }, 'POST', '/disk/resources/upload', { url: 'https://example.com/f.pdf', path: 'disk:/f.pdf' }],
    ['yandex_disk_get_operation_status', { operation_id: 'op123' }, 'GET', '/disk/operations/op123', undefined],
    ['yandex_disk_list_trash', {}, 'GET', '/disk/trash/resources', { path: 'trash:/', limit: 20 }],
    ['yandex_disk_restore_from_trash', { path: 'trash:/a.txt_1' }, 'PUT', '/disk/trash/resources/restore', { path: 'trash:/a.txt_1', overwrite: false }],
    ['yandex_disk_delete', { path: 'disk:/a.txt' }, 'DELETE', '/disk/resources', { path: 'disk:/a.txt', permanently: false }],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL and query', async (name, params, method, path, query) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url: `${BASE}${path}`, headers: expect.objectContaining({ Authorization: 'OAuth test-token' }) }),
    );
    if (query) expect(sent().params).toEqual(query);
    else expect(sent().params ?? {}).toEqual({});
    expect(sent().data).toBeUndefined();
  });

  it('deletes permanently only when asked', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('yandex_disk_delete', { path: 'disk:/a.txt', permanently: true });
    expect(sent().params).toEqual({ path: 'disk:/a.txt', permanently: true });
  });

  it('pages and sorts folder listings', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('yandex_disk_list_folder', { path: 'disk:/Docs', limit: 50, offset: 50, sort: '-modified' });
    expect(sent().params).toEqual({ path: 'disk:/Docs', limit: 50, offset: 50, sort: '-modified' });
  });

  it('keeps valid response transforms that shrink listings to the useful fields', () => {
    for (const t of a.tools) {
      if (t.responseMapping?.transform) expect(validateTransform(t.responseMapping.transform)).toBeNull();
    }
    const item = { name: 'a.txt', path: 'disk:/Docs/a.txt', type: 'file', size: 3, mime_type: 'text/plain', media_type: 'document', created: 'c', modified: 'm', md5: 'x', preview: 'https://p', sizes: [{}] };
    const raw = { path: 'disk:/Docs', type: 'dir', name: 'Docs', _embedded: { total: 1, limit: 20, offset: 0, path: 'disk:/Docs', items: [item] } };
    expect(applyResponseTransform(raw, tool('yandex_disk_list_folder').responseMapping as any).value).toEqual({
      path: 'disk:/Docs',
      type: 'dir',
      total: 1,
      limit: 20,
      offset: 0,
      items: [{ name: 'a.txt', path: 'disk:/Docs/a.txt', type: 'file', size: 3, mime_type: 'text/plain', media_type: 'document', created: 'c', modified: 'm' }],
    });
    const meta = applyResponseTransform({ ...item, _embedded: raw._embedded }, tool('yandex_disk_get_resource').responseMapping as any).value as Record<string, unknown>;
    expect(meta._embedded).toBeUndefined();
    expect(meta.sizes).toBeUndefined();
    expect(meta.md5).toBe('x');
    const trash = applyResponseTransform(
      { _embedded: { total: 1, limit: 20, offset: 0, items: [{ name: 'a.txt', path: 'trash:/a.txt_1', type: 'file', origin_path: 'disk:/a.txt', deleted: 'd', preview: 'p' }] } },
      tool('yandex_disk_list_trash').responseMapping as any,
    ).value as any;
    expect(trash.items[0]).toEqual({ name: 'a.txt', path: 'trash:/a.txt_1', type: 'file', origin_path: 'disk:/a.txt', deleted: 'd' });
  });
});

const live = process.env.RUN_YANDEX_DISK_LIVE === '1' ? describe : describe.skip;
const TOKEN = process.env.YANDEX_DISK_TOKEN;

live('yandex-disk adapter: live API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, TOKEN as string, params);

  it('answers 401 without a valid token on the real routes', async () => {
    for (const [name, params] of [
      ['yandex_disk_get_disk_info', {}],
      ['yandex_disk_list_folder', {}],
      ['yandex_disk_list_files', {}],
      ['yandex_disk_list_trash', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      await expect(execute(name, 'invalid-token', params)).rejects.toMatchObject({ response: { status: 401 } });
    }
  }, 60_000);

  (TOKEN ? it : it.skip)('reads the Disk, the root, all files, recent uploads, public resources and the Trash', async () => {
    const info = await run('yandex_disk_get_disk_info');
    expect(typeof info.total_space).toBe('number');
    const root = await run('yandex_disk_list_folder', { limit: 5 });
    expect(root.path).toBe('disk:/');
    expect(Array.isArray(root.items)).toBe(true);
    const files = await run('yandex_disk_list_files', { limit: 5 });
    expect(Array.isArray(files.items)).toBe(true);
    if (files.items.length) {
      const one = await run('yandex_disk_get_resource', { path: files.items[0].path });
      expect(one.path).toBe(files.items[0].path);
      const link = await run('yandex_disk_get_download_link', { path: files.items[0].path });
      expect(link.href).toMatch(/^https:\/\//);
    }
    expect(Array.isArray((await run('yandex_disk_list_last_uploaded', { limit: 5 })).items)).toBe(true);
    expect(Array.isArray((await run('yandex_disk_list_public', { limit: 5 })).items)).toBe(true);
    expect(Array.isArray((await run('yandex_disk_list_trash', { limit: 5 })).items)).toBe(true);
  }, 120_000);

  (TOKEN && process.env.YANDEX_DISK_LIVE_WRITE === '1' ? it : it.skip)('runs a folder round-trip and leaves it in the Trash', async () => {
    const dir = `disk:/AnythingMCP-test-${Date.now()}`;
    const opId = (href: string) => href.split('/operations/')[1];
    const wait = async (href: string) => {
      for (let i = 0; i < 30; i++) {
        const { status } = await run('yandex_disk_get_operation_status', { operation_id: opId(href) });
        if (status !== 'in-progress') return status;
        await new Promise((r) => setTimeout(r, 2000));
      }
      return 'timeout';
    };
    await run('yandex_disk_create_folder', { path: dir });
    try {
      const upload = await run('yandex_disk_upload_from_url', { url: 'https://www.ietf.org/rfc/rfc2549.txt', path: `${dir}/rfc.txt` });
      expect(await wait(upload.href)).toBe('success');
      await run('yandex_disk_copy', { from: `${dir}/rfc.txt`, path: `${dir}/copy.txt` });
      await run('yandex_disk_move', { from: `${dir}/copy.txt`, path: `${dir}/moved.txt` });
      await run('yandex_disk_publish', { path: `${dir}/moved.txt` });
      const published = await run('yandex_disk_get_resource', { path: `${dir}/moved.txt` });
      expect(published.public_url).toMatch(/^https:\/\//);
      const pub = await run('yandex_disk_get_public_resource', { public_key: published.public_key });
      expect(pub.name).toBe('moved.txt');
      await run('yandex_disk_unpublish', { path: `${dir}/moved.txt` });
      await run('yandex_disk_delete', { path: `${dir}/moved.txt` });
      const trash = await run('yandex_disk_list_trash', { sort: '-deleted', limit: 5 });
      const entry = trash.items.find((x: { origin_path: string }) => x.origin_path === `${dir}/moved.txt`);
      expect(entry).toBeDefined();
      await run('yandex_disk_restore_from_trash', { path: entry.path });
      expect((await run('yandex_disk_get_resource', { path: `${dir}/moved.txt` })).name).toBe('moved.txt');
    } finally {
      await run('yandex_disk_delete', { path: dir });
    }
  }, 180_000);
});
