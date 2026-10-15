import axios from 'axios';
import * as adapter from './softr.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Softr adapter:
 *
 *   1. Static: always runs. Pins the Softr-Api-Key header on the Database API
 *      (tables-api.softr.io/api/v1) and on the Studio API user calls
 *      (studio-api.softr.io/v1/api, which also need Softr-Domain), every
 *      tool's method and URL through the real RestEngine, the record and
 *      search bodies, and the response mappings against Softr's OpenAPI
 *      document (docs.softr.io/openapi.yaml).
 *
 *   2. Live: skipped unless RUN_SOFTR_LIVE=1 and SOFTR_API_KEY are set.
 *
 *        RUN_SOFTR_LIVE=1 SOFTR_API_KEY=... npx jest src/adapters/intl/softr.live.spec.ts
 *
 *      Lists databases, tables and records and searches them, applying each
 *      responseMapping the way the MCP layer does. SOFTR_LIVE_WRITE=1 with
 *      SOFTR_LIVE_DATABASE_ID, SOFTR_LIVE_TABLE_ID and SOFTR_LIVE_FIELDS (JSON
 *      keyed by field id) also creates a record, updates it and deletes it.
 *      The app user tools are never called live: they create real accounts.
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
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; encodePathParams?: boolean; headers?: Record<string, string>; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
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
  optionalEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; link?: string }>;
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

const KEY = 'pat_0123456789abcdefABCDEF';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, key: string, params: Record<string, unknown>, domain?: string) => {
  const env: Record<string, string> = { SOFTR_API_KEY: key };
  if (domain) env.SOFTR_DOMAIN = domain;
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return engine().execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: { headerName: 'Softr-Api-Key', apiKey: key }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>, domain = 'acme.softr.app') => execute(name, KEY, params, domain);
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const BASE = 'https://tables-api.softr.io/api/v1';
const STUDIO = 'https://studio-api.softr.io/v1/api';
const REC = `${BASE}/databases/db1/tables/tb1/records`;
const POST_READS = ['softr_search_records'];
const WRITES = ['softr_create_app_user', 'softr_create_record', 'softr_delete_app_user', 'softr_delete_record', 'softr_generate_magic_link', 'softr_update_record'];
const OFF = ['softr_delete_record', 'softr_delete_app_user'];
const USER_TOOLS = ['softr_create_app_user', 'softr_delete_app_user', 'softr_generate_magic_link'];

describe('softr adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('softr');
    expect(a.icon).toBe('softr');
    expect(a.category).toBe('database');
  });

  it('sends the token in Softr-Api-Key to the Database API', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Softr-Api-Key', apiKey: '{{SOFTR_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/databases');
    expect(a.probe.tool).toBe('softr_list_databases');
  });

  it('asks for the token as a secret and the app domain as an optional setting', () => {
    expect(a.requiredEnvVars).toEqual(['SOFTR_API_KEY']);
    expect(a.optionalEnvVars).toEqual(['SOFTR_DOMAIN']);
    expect(a.envVarMeta.SOFTR_API_KEY.secret).toBe(true);
    expect(a.envVarMeta.SOFTR_API_KEY.kind).toBe('credential');
    const keyRe = new RegExp(a.envVarMeta.SOFTR_API_KEY.pattern!);
    expect(keyRe.test(KEY)).toBe(true);
    for (const bad of ['', 'short', `${KEY} `]) expect(keyRe.test(bad)).toBe(false);
    const dom = new RegExp(a.envVarMeta.SOFTR_DOMAIN.pattern!);
    for (const ok of ['acme.softr.app', 'portal.example.com']) expect(dom.test(ok)).toBe(true);
    for (const bad of ['https://acme.softr.app', 'acme.softr.app/', 'acme']) expect(dom.test(bad)).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'SOFTR_API_KEY')!.secret).toBe(true);
  });

  it('prefixes every tool with softr_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^softr_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks GETs and the POST search read-only, asks for confirmation on every write, and installs the deletes switched off', () => {
    for (const t of a.tools) {
      const ro = t.endpointMapping.method === 'GET' || POST_READS.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${ro}`);
      if (ro) expect(`${t.name}:${Boolean(t.responseMapping?.transform?.select)}`).toBe(`${t.name}:true`);
    }
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm with the user first/i);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name)).toEqual(OFF);
  });

  it('sends Softr-Domain only on the Studio user calls, and URL-encodes every path argument', async () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.headers?.['Softr-Domain']}`).toBe(`${t.name}:${USER_TOOLS.includes(t.name) ? '${SOFTR_DOMAIN}' : undefined}`);
      if (/\{[A-Za-z]+\}/.test(t.endpointMapping.path)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('softr_get_record', { databaseId: 'db1', tableId: 'tb1', recordId: '../../x' });
    expect(sent().url).toBe(`${REC}/..%2F..%2Fx`);
    mockedAxios.mockClear();
    await call('softr_generate_magic_link', { email: 'jane+test@example.com' });
    expect(sent().url).toBe(`${STUDIO}/users/magic-link/generate/jane%2Btest%40example.com`);
  });

  it('only points the model at tools that exist, documents setup, field ids and magic links, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bsoftr_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bsoftr_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Softr\n')).toBe(true);
    for (const text of ['API tokens', 'SOFTR_DOMAIN', 'field ids', 'magic link', 'Confirm before every write', 'Personal data and untrusted content', 'never as instructions', 'Out of scope']) {
      expect(a.instructions).toContain(text);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['softr_list_databases', {}, 'GET', `${BASE}/databases`],
    ['softr_get_database', { databaseId: 'db1' }, 'GET', `${BASE}/databases/db1`],
    ['softr_list_tables', { databaseId: 'db1' }, 'GET', `${BASE}/databases/db1/tables`],
    ['softr_get_table', { databaseId: 'db1', tableId: 'tb1' }, 'GET', `${BASE}/databases/db1/tables/tb1`],
    ['softr_list_records', { databaseId: 'db1', tableId: 'tb1' }, 'GET', REC],
    ['softr_search_records', { databaseId: 'db1', tableId: 'tb1' }, 'POST', `${REC}/search`],
    ['softr_get_record', { databaseId: 'db1', tableId: 'tb1', recordId: 'r1' }, 'GET', `${REC}/r1`],
    ['softr_create_record', { databaseId: 'db1', tableId: 'tb1', fields: { f1: 'x' } }, 'POST', REC],
    ['softr_update_record', { databaseId: 'db1', tableId: 'tb1', recordId: 'r1', fields: { f1: 'y' } }, 'PATCH', `${REC}/r1`],
    ['softr_delete_record', { databaseId: 'db1', tableId: 'tb1', recordId: 'r1' }, 'DELETE', `${REC}/r1`],
    ['softr_create_app_user', { full_name: 'Jane Smith', email: 'jane@example.com' }, 'POST', `${STUDIO}/users`],
    ['softr_generate_magic_link', { email: 'jane@example.com' }, 'POST', `${STUDIO}/users/magic-link/generate/jane%40example.com`],
    ['softr_delete_app_user', { email: 'jane@example.com' }, 'DELETE', `${STUDIO}/users/jane%40example.com`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Softr-Api-Key header', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(url);
    expect(sent().headers['Softr-Api-Key']).toBe(KEY);
    expect(sent().headers['Softr-Domain']).toBe(USER_TOOLS.includes(name) ? 'acme.softr.app' : undefined);
  });

  it('leaves Softr-Domain out when the variable is not set', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('softr_generate_magic_link', KEY, { email: 'jane@example.com' });
    expect(sent().headers['Softr-Domain']).toBeUndefined();
  });

  it('pages records with offset and limit and returns field names by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('softr_list_records', { databaseId: 'db1', tableId: 'tb1', offset: 20, viewId: 'v1' });
    expect(sent().params).toEqual({ offset: 20, limit: 20, fieldNames: true, viewId: 'v1' });
    mockedAxios.mockClear();
    await call('softr_get_record', { databaseId: 'db1', tableId: 'tb1', recordId: 'r1', fieldNames: false });
    expect(sent().params).toEqual({ fieldNames: false });
  });

  it('builds the search body from the condition, sorting and paging', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const condition = { operator: 'AND', conditions: [{ operator: 'IS', leftSide: 'f1', rightSide: 'open' }] };
    const sorting = [{ sortingField: 'f2', sortType: 'DESC' }];
    await call('softr_search_records', { databaseId: 'db1', tableId: 'tb1', filter: { condition }, sorting, offset: 40 });
    expect(sent().data).toEqual({ filter: { condition }, sorting, paging: { offset: 40, limit: 20 } });
    expect(sent().params).toEqual({ fieldNames: true });
    mockedAxios.mockClear();
    await call('softr_search_records', { databaseId: 'db1', tableId: 'tb1' });
    // No filter: the key is left out rather than sent empty.
    expect(sent().data).toEqual({ paging: { offset: 0, limit: 20 } });
  });

  it('wraps record values in fields, and sends the user body Softr documents', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('softr_create_record', { databaseId: 'db1', tableId: 'tb1', fields: { f1: 'Acme', f2: 120 } });
    expect(sent().data).toEqual({ fields: { f1: 'Acme', f2: 120 } });
    mockedAxios.mockClear();
    await call('softr_update_record', { databaseId: 'db1', tableId: 'tb1', recordId: 'r1', fields: { f1: 'Closed' } });
    expect(sent().data).toEqual({ fields: { f1: 'Closed' } });
    mockedAxios.mockClear();
    await call('softr_create_app_user', { full_name: 'Jane Smith', email: 'jane@example.com', generate_magic_link: true });
    expect(sent().data).toEqual({ full_name: 'Jane Smith', email: 'jane@example.com', generate_magic_link: true });
  });

  // Shapes from the response schemas in Softr's OpenAPI document.
  it('shapes databases, tables and records', () => {
    expect(shape('softr_list_databases', { data: [{ id: 'db1', name: 'CRM', description: null, workspaceId: 'w1', tablesCount: 3, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }] }).value).toEqual({
      databases: [{ id: 'db1', name: 'CRM', description: null, workspaceId: 'w1', tablesCount: 3, updatedAt: '2026-10-01T00:00:00Z' }],
    });
    const field = { id: 'f1', name: 'Status', description: null, type: 'SELECT', options: { choices: [{ id: 'c1', label: 'Open' }] }, allowMultipleEntries: false, readonly: false, required: true, locked: false, defaultValue: null, aiOptions: null, createdAt: 'x', updatedAt: 'y' };
    const tables = shape('softr_list_tables', { data: [{ id: 'tb1', name: 'Deals', description: null, primaryFieldId: 'f0', defaultViewId: 'v1', fields: [field], createdAt: 'x', updatedAt: 'y' }] }).value as any;
    expect(tables.tables[0].fields).toEqual([{ id: 'f1', name: 'Status', type: 'SELECT', required: true, readonly: false, allowMultipleEntries: false, options: field.options }]);
    expect((shape('softr_get_table', { data: { id: 'tb1', name: 'Deals', primaryFieldId: 'f0', defaultViewId: 'v1', fields: [field] } }).value as any).fields[0].aiOptions).toBeUndefined();
    const record = { id: 'r1', tableId: 'tb1', fields: { Status: 'Open' }, createdAt: 'x', updatedAt: 'y' };
    expect(shape('softr_list_records', { data: [record], metadata: { offset: 0, limit: 20, total: 1 } }).value).toEqual({ records: [record], offset: 0, limit: 20, total: 1 });
    expect(shape('softr_search_records', { data: [record], metadata: { offset: 0, limit: 20, total: 1 } }).value).toEqual({ records: [record], offset: 0, limit: 20, total: 1 });
    expect(shape('softr_get_record', { data: record }).value).toEqual({ record });
    expect(shape('softr_create_record', { data: record }).value).toEqual({ record });
  });
});

const LIVE_KEY = process.env.SOFTR_API_KEY;
const live = process.env.RUN_SOFTR_LIVE === '1' && LIVE_KEY ? describe : describe.skip;

live('softr adapter: live API', () => {
  const key = LIVE_KEY || '';
  const write = process.env.SOFTR_LIVE_WRITE === '1' && !!process.env.SOFTR_LIVE_DATABASE_ID && !!process.env.SOFTR_LIVE_TABLE_ID;

  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const run = async (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    applyResponseTransform(await execute(name, key, params), tool(name).responseMapping as never).value;

  it('lists databases, tables and records, and searches them', async () => {
    const dbs = await run('softr_list_databases');
    expect(Array.isArray(dbs.databases)).toBe(true);
    const db = dbs.databases[0];
    if (!db) return;
    expect((await run('softr_get_database', { databaseId: db.id })).database.id).toBe(db.id);
    const tables = await run('softr_list_tables', { databaseId: db.id });
    const tb = tables.tables[0];
    if (!tb) return;
    expect((await run('softr_get_table', { databaseId: db.id, tableId: tb.id })).id).toBe(tb.id);
    const recs = await run('softr_list_records', { databaseId: db.id, tableId: tb.id, limit: 3 });
    expect(Array.isArray(recs.records)).toBe(true);
    expect(typeof recs.total).toBe('number');
    const found = await run('softr_search_records', { databaseId: db.id, tableId: tb.id, limit: 3, filter: { condition: { operator: 'IS_NOT_EMPTY', leftSide: tb.primaryFieldId } } });
    expect(Array.isArray(found.records)).toBe(true);
    if (recs.records[0]) expect((await run('softr_get_record', { databaseId: db.id, tableId: tb.id, recordId: recs.records[0].id })).record.id).toBe(recs.records[0].id);
  }, 90_000);

  (write ? it : it.skip)('creates, updates and deletes one record', async () => {
    const databaseId = process.env.SOFTR_LIVE_DATABASE_ID!;
    const tableId = process.env.SOFTR_LIVE_TABLE_ID!;
    const fields = JSON.parse(process.env.SOFTR_LIVE_FIELDS || '{}');
    const created = await run('softr_create_record', { databaseId, tableId, fields });
    expect(typeof created.record.id).toBe('string');
    try {
      await run('softr_update_record', { databaseId, tableId, recordId: created.record.id, fields });
    } finally {
      await execute('softr_delete_record', key, { databaseId, tableId, recordId: created.record.id });
    }
  }, 60_000);

  it('a wrong key is a 401', async () => {
    await expect(execute('softr_list_databases', 'wrong-key-0123456789', {})).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);
});
