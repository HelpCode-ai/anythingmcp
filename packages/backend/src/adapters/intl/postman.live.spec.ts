import axios from 'axios';
import * as adapter from './postman.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Postman API (learning.postman.com/api-docs, server api.postman.com or
 * api.eu.postman.com): the key goes in the X-Api-Key header. Paths, query
 * names and bodies are checked against the API reference pages (read
 * 30 Oct 2026) and Postman's own MCP server (postmanlabs/postman-mcp-server,
 * generated from the same API). With a fake key every GET route used here
 * answered 401 or 403 and an unknown route 404 on 30 Oct 2026.
 *
 * Live part (reads only: the user, workspaces, collections, environments, specs, mocks, monitors):
 *   RUN_POSTMAN_LIVE=1 POSTMAN_API_KEY=PMAK-... [POSTMAN_API_URL=https://api.eu.postman.com] \
 *     npx jest src/adapters/intl/postman.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
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
  return out;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping as never, annotations: t.annotations });

const HOST = 'https://api.postman.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'PMAK-' + '0'.repeat(24) + '-' + 'a'.repeat(34);
const ENV: Record<string, string> = { POSTMAN_API_URL: HOST, POSTMAN_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping as never, ENV);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: config.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  ) as Promise<unknown>;
};
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'postman_create_collection',
  'postman_create_collection_folder',
  'postman_create_collection_request',
  'postman_create_environment',
  'postman_create_mock',
  'postman_create_monitor',
  'postman_create_spec',
  'postman_run_monitor',
  'postman_update_collection',
  'postman_update_collection_request',
  'postman_update_environment',
  'postman_update_spec_file',
];
const SWITCHED_OFF: string[] = [];
const WS = '1f0df51a-8658-4ee8-a2a1-d2567dfa09a9';
const CID = '12ece9e1-2abf-4edc-8e34-de66e74114d2';
const CUID = `12345678-${CID}`;

describe('postman adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the API key in X-Api-Key to the chosen data region and checks it on /me', () => {
    expect(a.icon).toBe('postman');
    expect(a.requiredEnvVars).toEqual(['POSTMAN_API_URL', 'POSTMAN_API_KEY']);
    expect(a.connector.baseUrl).toBe('{{POSTMAN_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Api-Key', apiKey: '{{POSTMAN_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/me');
    expect(a.envVarMeta.POSTMAN_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const region = new RegExp(a.envVarMeta.POSTMAN_API_URL.pattern!);
    expect(region.test('https://api.postman.com')).toBe(true);
    expect(region.test('https://api.eu.postman.com')).toBe(true);
    for (const bad of ['https://api.postman.com/', 'https://api.getpostman.com', 'http://api.postman.com', 'https://go.postman.co']) expect(region.test(bad)).toBe(false);
    const key = new RegExp(a.envVarMeta.POSTMAN_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', 'abc', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} x`]) expect(key.test(bad)).toBe(false);
  });

  it('every tool is prefixed and unique in the catalog, every declared parameter reaches the request and path parameters are required', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)?.tools ?? []) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.name).toMatch(/^postman_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
    }
  });

  it('knows exactly which tools write, asks for confirmation on each, ships no deletes and switches nothing off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(`${name}:${/agree/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(SWITCHED_OFF);
    expect(tool('postman_search').endpointMapping.method).toBe('POST');
    expect(annotationsOf(tool('postman_search')).readOnlyHint).toBe(true);
  });

  it('probes with a read tool and documents every tool in the instructions, without em dashes', () => {
    expect(a.probe.tool).toBe('postman_get_me');
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
    const names = new Set(a.tools.map((t) => t.name));
    for (const name of names) expect(`${name}:${a.instructions.includes(`\`${name}\``)}`).toBe(`${name}:true`);
    for (const [m] of [...a.instructions.matchAll(/\bpostman_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bpostman_[a-z_]+/g)])]) expect(names).toContain(m);
    expect(a.instructions).toContain('https://mcp.postman.com/mcp');
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['postman_get_me', {}, 'GET', '/me'],
    ['postman_list_workspaces', {}, 'GET', '/workspaces'],
    ['postman_get_workspace', { workspaceId: WS }, 'GET', `/workspaces/${WS}`],
    ['postman_list_collections', { workspace: WS }, 'GET', '/collections'],
    ['postman_get_collection', { collectionId: CUID }, 'GET', `/collections/${CUID}`],
    ['postman_get_collection_request', { collectionId: CID, requestId: 'r1' }, 'GET', `/collections/${CID}/requests/r1`],
    ['postman_get_collection_folder', { collectionId: CID, folderId: 'f1' }, 'GET', `/collections/${CID}/folders/f1`],
    ['postman_list_environments', {}, 'GET', '/environments'],
    ['postman_get_environment', { environmentId: 'e1' }, 'GET', '/environments/e1'],
    ['postman_list_apis', { workspaceId: WS }, 'GET', '/apis'],
    ['postman_get_api', { apiId: 'a1' }, 'GET', '/apis/a1'],
    ['postman_list_mocks', {}, 'GET', '/mocks'],
    ['postman_get_mock', { mockId: 'm1' }, 'GET', '/mocks/m1'],
    ['postman_get_mock_call_logs', { mockId: 'm1' }, 'GET', '/mocks/m1/call-logs'],
    ['postman_list_monitors', {}, 'GET', '/monitors'],
    ['postman_get_monitor', { monitorId: 'mo1' }, 'GET', '/monitors/mo1'],
    ['postman_list_specs', { workspaceId: WS }, 'GET', '/specs'],
    ['postman_get_spec', { specId: 's1' }, 'GET', '/specs/s1'],
    ['postman_list_spec_files', { specId: 's1' }, 'GET', '/specs/s1/files'],
    ['postman_get_spec_file', { specId: 's1', filePath: 'components/schemas.json' }, 'GET', '/specs/s1/files/components/schemas.json'],
    ['postman_get_spec_definition', { specId: 's1' }, 'GET', '/specs/s1/definitions'],
    ['postman_list_team_users', {}, 'GET', '/users'],
    ['postman_search', { elementType: 'collections', q: 'payments' }, 'POST', '/search'],
    ['postman_create_collection', { workspace: WS, name: 'Demo' }, 'POST', '/collections'],
    ['postman_update_collection', { collectionId: CUID, info: { name: 'New' } }, 'PATCH', `/collections/${CUID}`],
    ['postman_create_collection_folder', { collectionId: CID, name: 'Users' }, 'POST', `/collections/${CID}/folders`],
    ['postman_create_collection_request', { collectionId: CID, name: 'List users' }, 'POST', `/collections/${CID}/requests`],
    ['postman_update_collection_request', { collectionId: CID, requestId: 'r1', name: 'x' }, 'PUT', `/collections/${CID}/requests/r1`],
    ['postman_create_environment', { workspace: WS, name: 'Staging' }, 'POST', '/environments'],
    ['postman_update_environment', { environmentId: 'e1', operations: [{ op: 'replace', path: '/name', value: 'Prod' }] }, 'PATCH', '/environments/e1'],
    ['postman_create_mock', { workspace: WS, collection: CUID }, 'POST', '/mocks'],
    ['postman_create_monitor', { workspace: WS, name: 'Nightly', collection: CUID, cron: '0 3 * * *' }, 'POST', '/monitors'],
    ['postman_run_monitor', { monitorId: 'mo1' }, 'POST', '/monitors/mo1/run'],
    ['postman_create_spec', { workspaceId: WS, name: 'API', type: 'OPENAPI:3.0', files: [{ path: 'index.yaml', content: 'openapi: 3.0.0' }] }, 'POST', '/specs'],
    ['postman_update_spec_file', { specId: 's1', filePath: 'index.yaml', content: 'openapi: 3.0.0' }, 'PATCH', '/specs/s1/files/index.yaml'],
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
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers['X-Api-Key']).toBe(FAKE_KEY);
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('builds the documented query strings, headers and bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('postman_list_workspaces', { type: 'team', createdBy: '42' });
    expect(sent().params).toEqual({ type: 'team', createdBy: '42', limit: 50 });
    mockedAxios.mockClear();
    await call('postman_list_apis', { workspaceId: WS });
    expect(sent().headers.Accept).toBe('application/vnd.api.v10+json');
    expect(sent().params).toEqual({ workspaceId: WS, limit: 10 });
    mockedAxios.mockClear();
    await call('postman_create_collection', { workspace: WS, name: 'Demo', description: 'd' });
    expect(sent().params).toEqual({ workspace: WS });
    expect(sent().data).toEqual({ collection: { info: { name: 'Demo', description: 'd', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] } });
    mockedAxios.mockClear();
    await call('postman_update_collection', { collectionId: CUID, variable: [{ key: 'baseUrl', value: 'x' }] });
    expect(sent().data).toEqual({ collection: { variable: [{ key: 'baseUrl', value: 'x' }] } });
    mockedAxios.mockClear();
    const ops = [{ op: 'add', path: '/values/3', value: { key: 'region', value: 'eu' } }];
    await call('postman_update_environment', { environmentId: 'e1', operations: ops });
    expect(sent().data).toEqual(ops);
    mockedAxios.mockClear();
    await call('postman_create_monitor', { workspace: WS, name: 'Nightly', collection: CUID, cron: '0 3 * * *', timezone: 'Europe/Berlin' });
    expect(sent().data).toEqual({ monitor: { name: 'Nightly', collection: CUID, schedule: { cron: '0 3 * * *', timezone: 'Europe/Berlin' } } });
    mockedAxios.mockClear();
    await call('postman_create_mock', { workspace: WS, collection: CUID, private: true });
    expect(sent().data).toEqual({ mock: { collection: CUID, private: true } });
    mockedAxios.mockClear();
    await call('postman_run_monitor', { monitorId: 'mo1' });
    expect(sent().params).toEqual({ async: true });
    mockedAxios.mockClear();
    await call('postman_search', { elementType: 'requests', q: 'login', ownership: 'all' });
    expect(sent().params).toEqual({ limit: 10 });
    expect(sent().data).toEqual({ elementType: 'requests', q: 'login', ownership: 'all' });
  });
});

const live = process.env.RUN_POSTMAN_LIVE === '1' && process.env.POSTMAN_API_KEY ? describe : describe.skip;
live('postman adapter: live (read-only)', () => {
  const base = process.env.POSTMAN_API_URL || HOST;
  const get = async (path: string, accept = 'application/json') => {
    const res = await mockedAxios.__actual.get(`${base}${path}`, { headers: { 'X-Api-Key': process.env.POSTMAN_API_KEY!, Accept: accept }, validateStatus: () => true });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.data as Record<string, any>;
  };
  it('reads the user, workspaces, collections, environments, specs, mocks and monitors', async () => {
    const me = await get('/me');
    expect(typeof me.user.id).toBe('number');
    const ws = await get('/workspaces?limit=5');
    expect(Array.isArray(ws.workspaces)).toBe(true);
    expect(Array.isArray((await get('/collections?limit=5&offset=0')).collections)).toBe(true);
    expect(Array.isArray((await get('/environments')).environments)).toBe(true);
    expect(Array.isArray((await get('/mocks')).mocks)).toBe(true);
    expect(Array.isArray((await get('/monitors?limit=5')).monitors)).toBe(true);
    if (ws.workspaces[0]) {
      const id = ws.workspaces[0].id;
      expect((await get(`/workspaces/${id}`)).workspace.id).toBe(id);
      expect(Array.isArray((await get(`/specs?workspaceId=${id}`)).specs)).toBe(true);
    }
  }, 60_000);
});
