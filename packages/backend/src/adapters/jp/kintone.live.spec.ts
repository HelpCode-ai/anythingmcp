import * as adapter from './kintone.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

/**
 * kintone REST API (kintone.dev/en/docs/kintone/rest-api/): base https://<domain>/k/v1 on
 * cybozu.com, kintone.com or cybozu.cn. Two ways to sign in, both optional and sent as
 * headers on every call: an app API token in X-Cybozu-API-Token, or the Base64 of
 * login:password in X-Cybozu-Authorization (password wins when both are sent; apps
 * lists and spaces accept only it). Reads that take lists go as POST with
 * X-HTTP-Method-Override: GET, which kintone documents for every REST API.
 * Live part (reads only: API list, one app, its fields, layout, views and a few records):
 *   KINTONE_DOMAIN=example.cybozu.com KINTONE_API_TOKEN=... KINTONE_APP_ID=1 RUN_KINTONE_LIVE=1 npx jest src/adapters/jp/kintone
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; maxItems?: number; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; bodyEncoding?: string };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const ENV = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings (connector variables excluded).
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  for (const e of ENV) out.delete(e);
  return out;
};
const PREFIX = 'kintone_';
const AUTH = { 'X-Cybozu-API-Token': '${KINTONE_API_TOKEN}', 'X-Cybozu-Authorization': '${KINTONE_PASSWORD_AUTH}' };

describe('kintone adapter: static spec conformance', () => {
  it('targets the per-domain /k/v1 base and sends the token or password header on every call', () => {
    expect(a.slug).toBe('kintone');
    expect(a.region).toBe('jp');
    expect(a.requiredEnvVars).toEqual(['KINTONE_DOMAIN']);
    expect(a.optionalEnvVars).toEqual(['KINTONE_API_TOKEN', 'KINTONE_PASSWORD_AUTH']);
    expect(a.connector.baseUrl).toBe('https://{{KINTONE_DOMAIN}}/k/v1');
    expect(a.connector.authType).toBe('NONE');
    expect(a.envVarMeta?.KINTONE_API_TOKEN.secret).toBe(true);
    expect(a.envVarMeta?.KINTONE_PASSWORD_AUTH.secret).toBe(true);
    const domain = new RegExp(a.envVarMeta!.KINTONE_DOMAIN.pattern!);
    expect(domain.test('example.cybozu.com')).toBe(true);
    expect(domain.test('example.kintone.com')).toBe(true);
    expect(domain.test('https://example.cybozu.com')).toBe(false);
    expect(domain.test('example.cybozu.com/k/')).toBe(false);
    const token = new RegExp(a.envVarMeta!.KINTONE_API_TOKEN.pattern!);
    expect(token.test(['Ab12', 'Cd34'].join(','))).toBe(true);
    expect(token.test('Ab12 Cd34')).toBe(false);
    for (const t of a.tools) {
      expect(t.endpointMapping.headers).toMatchObject(AUTH);
      expect(t.endpointMapping.path.endsWith('.json')).toBe(true);
      expect(t.endpointMapping.path.startsWith('/k/')).toBe(false);
    }
  });

  it('maps apps, form, views, process management and settings to the documented paths', () => {
    expect(tool('kintone_get_api_list').endpointMapping).toMatchObject({ method: 'GET', path: '/apis.json' });
    expect(tool('kintone_list_apps').endpointMapping).toMatchObject({
      method: 'POST', path: '/apps.json', headers: { 'X-HTTP-Method-Override': 'GET' },
      bodyMapping: { ids: '$ids', codes: '$codes', name: '$name', spaceIds: '$space_ids', limit: '$limit', offset: '$offset' },
    });
    expect(tool('kintone_get_app').endpointMapping).toMatchObject({ method: 'GET', path: '/app.json', queryParams: { id: '$id' } });
    expect(tool('kintone_get_form_fields').endpointMapping).toMatchObject({ method: 'GET', path: '/app/form/fields.json', queryParams: { app: '$app', lang: '$lang' } });
    expect(tool('kintone_get_form_layout').endpointMapping).toMatchObject({ method: 'GET', path: '/app/form/layout.json', queryParams: { app: '$app' } });
    expect(tool('kintone_list_views').endpointMapping.path).toBe('/app/views.json');
    expect(tool('kintone_get_process_management').endpointMapping.path).toBe('/app/status.json');
    expect(tool('kintone_get_app_settings').endpointMapping.path).toBe('/app/settings.json');
  });

  it('reads records by id, by query (method override) and by cursor', () => {
    expect(tool('kintone_get_record').endpointMapping).toMatchObject({ method: 'GET', path: '/record.json', queryParams: { app: '$app', id: '$id' } });
    expect(tool('kintone_list_records').endpointMapping).toMatchObject({
      method: 'POST', path: '/records.json', headers: { 'X-HTTP-Method-Override': 'GET' },
      bodyMapping: { app: '$app', query: '$query', fields: '$fields', totalCount: '$total_count' },
    });
    expect(tool('kintone_create_cursor').endpointMapping).toMatchObject({ method: 'POST', path: '/records/cursor.json', bodyMapping: { app: '$app', query: '$query', fields: '$fields', size: '$size' } });
    expect(tool('kintone_create_cursor').parameters?.properties?.size.maximum).toBe(500);
    expect(tool('kintone_get_cursor_records').endpointMapping).toMatchObject({ method: 'GET', path: '/records/cursor.json', queryParams: { id: '$id' } });
    expect(tool('kintone_delete_cursor').endpointMapping).toMatchObject({ method: 'DELETE', path: '/records/cursor.json', queryParams: { id: '$id' } });
    for (const n of ['kintone_list_apps', 'kintone_list_records', 'kintone_create_cursor']) expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:true`);
  });

  it('maps record writes, comments, status, assignees, files and spaces', () => {
    expect(tool('kintone_create_record').endpointMapping).toMatchObject({ method: 'POST', path: '/record.json', bodyMapping: { app: '$app', record: '$record' } });
    expect(tool('kintone_create_records').endpointMapping).toMatchObject({ method: 'POST', path: '/records.json', bodyMapping: { app: '$app', records: '$records' } });
    expect(tool('kintone_create_records').parameters?.properties?.records.maxItems).toBe(100);
    expect(tool('kintone_update_record').endpointMapping).toMatchObject({ method: 'PUT', path: '/record.json', bodyMapping: { app: '$app', id: '$id', updateKey: '$update_key', record: '$record', revision: '$revision' } });
    expect(tool('kintone_update_records').endpointMapping).toMatchObject({ method: 'PUT', path: '/records.json', bodyMapping: { app: '$app', records: '$records', upsert: '$upsert' } });
    expect(tool('kintone_delete_records').endpointMapping).toMatchObject({ method: 'POST', path: '/records.json', headers: { 'X-HTTP-Method-Override': 'DELETE' }, bodyMapping: { app: '$app', ids: '$ids', revisions: '$revisions' } });
    expect(tool('kintone_list_comments').endpointMapping).toMatchObject({ method: 'GET', path: '/record/comments.json', queryParams: { app: '$app', record: '$record', order: '$order', offset: '$offset', limit: '$limit' } });
    expect(tool('kintone_list_comments').parameters?.properties?.limit.maximum).toBe(10);
    expect(tool('kintone_add_comment').endpointMapping).toMatchObject({ method: 'POST', path: '/record/comment.json', bodyMapping: { app: '$app', record: '$record', comment: { text: '$text', mentions: '$mentions' } } });
    expect(tool('kintone_update_status').endpointMapping).toMatchObject({ method: 'PUT', path: '/record/status.json', bodyMapping: { app: '$app', id: '$id', action: '$action', assignee: '$assignee', revision: '$revision' } });
    expect(tool('kintone_update_assignees').endpointMapping).toMatchObject({ method: 'PUT', path: '/record/assignees.json', bodyMapping: { assignees: '$assignees' } });
    expect(tool('kintone_download_file').endpointMapping).toMatchObject({ method: 'GET', path: '/file.json', queryParams: { fileKey: '$file_key' } });
    expect(tool('kintone_upload_file').endpointMapping).toMatchObject({ method: 'POST', path: '/file.json', bodyEncoding: 'form-data', bodyMapping: { file: { __file: '$file_url' } } });
    expect(tool('kintone_get_space').endpointMapping).toMatchObject({ method: 'GET', path: '/space.json', queryParams: { id: '$id' } });
    expect(tool('kintone_list_space_members').endpointMapping).toMatchObject({ method: 'GET', path: '/space/members.json', queryParams: { id: '$id' } });
    expect(tool('kintone_add_thread_comment').endpointMapping).toMatchObject({ method: 'POST', path: '/space/thread/comment.json', bodyMapping: { space: '$space', thread: '$thread', comment: { text: '$text', mentions: '$mentions' } } });
  });

  it('installs only the record delete switched off and marks it destructive', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(['kintone_delete_records']);
    expect(tool('kintone_delete_records').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.instructions).toContain('**Switched off at install**: `kintone_delete_records`; it cannot be undone');
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(`${t.name}:${r}:${props.includes(r)}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('probes with a read tool without required parameters and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

describe('kintone adapter: requests', () => {
  const engine = new RestEngine(
    { getAccessToken: jest.fn(), refreshToken: jest.fn() } as any,
    { getToken: jest.fn(), forceRelogin: jest.fn() } as any,
  );
  const config = { baseUrl: 'https://example.cybozu.com/k/v1', authType: 'NONE' as const, authConfig: {}, headers: {} };
  const sent = () => mockedAxios.mock.calls[0][0] as any;
  const token = ['tok', 'en1'].join('');

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.mockResolvedValue({ status: 200, data: { records: [] }, headers: {} });
  });

  it('sends only the API token when no password login is set', async () => {
    await engine.execute(config, tool('kintone_get_form_fields').endpointMapping as any, { app: 7, KINTONE_API_TOKEN: token, KINTONE_PASSWORD_AUTH: '' });
    expect(sent().url).toBe('https://example.cybozu.com/k/v1/app/form/fields.json');
    expect(sent().params).toEqual({ app: 7 });
    expect(sent().headers['X-Cybozu-API-Token']).toBe(token);
    expect(sent().headers).not.toHaveProperty('X-Cybozu-Authorization');
  });

  it('searches records with a POST that kintone treats as GET, with the query in the JSON body', async () => {
    await engine.execute(config, tool('kintone_list_records').endpointMapping as any, {
      app: 7, query: 'status in ("完了") limit 10', fields: ['$id', 'title'], KINTONE_PASSWORD_AUTH: Buffer.from('user:pass').toString('base64'),
    });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe('https://example.cybozu.com/k/v1/records.json');
    expect(sent().headers['X-HTTP-Method-Override']).toBe('GET');
    expect(sent().headers['X-Cybozu-Authorization']).toBe(Buffer.from('user:pass').toString('base64'));
    expect(sent().headers).not.toHaveProperty('X-Cybozu-API-Token');
    expect(sent().data).toEqual({ app: 7, query: 'status in ("完了") limit 10', fields: ['$id', 'title'] });
  });
});

const live =
  process.env.RUN_KINTONE_LIVE === '1' && process.env.KINTONE_DOMAIN && (process.env.KINTONE_API_TOKEN || process.env.KINTONE_PASSWORD_AUTH) && process.env.KINTONE_APP_ID
    ? describe
    : describe.skip;
live('kintone adapter: live (read-only)', () => {
  const base = `https://${process.env.KINTONE_DOMAIN}/k/v1`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.KINTONE_API_TOKEN) headers['X-Cybozu-API-Token'] = process.env.KINTONE_API_TOKEN;
  if (process.env.KINTONE_PASSWORD_AUTH) headers['X-Cybozu-Authorization'] = process.env.KINTONE_PASSWORD_AUTH;
  const app = process.env.KINTONE_APP_ID;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the API list, the app, its fields, layout, views and a few records', async () => {
    expect(await get('/apis.json')).toHaveProperty('apis');
    expect(await get(`/app.json?id=${app}`)).toHaveProperty('appId', String(app));
    expect(await get(`/app/form/fields.json?app=${app}`)).toHaveProperty('properties');
    expect(await get(`/app/form/layout.json?app=${app}`)).toHaveProperty('layout');
    expect(await get(`/app/views.json?app=${app}`)).toHaveProperty('views');
    const res = await fetch(`${base}/records.json`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-HTTP-Method-Override': 'GET' },
      body: JSON.stringify({ app, query: 'order by $id desc limit 3', totalCount: true }),
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { records: unknown[] }).records)).toBe(true);
  }, 60_000);
});
