import axios from 'axios';
import * as adapter from './glide.json';
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
 * Two layers of verification for the Glide adapter (Glide API v2, Big Tables):
 *
 *   1. Static: always runs. Pins Bearer auth on api.glideapps.com, every
 *      tool's method and URL through the real RestEngine, the bare JSON array
 *      body of add rows and the flat object body of update row, the
 *      onSchemaError option, and the response mappings against Glide's
 *      OpenAPI document (apidocs.glideapps.com/openapi/swagger.json).
 *
 *   2. Live: skipped unless RUN_GLIDE_LIVE=1 and GLIDE_API_TOKEN are set.
 *
 *        RUN_GLIDE_LIVE=1 GLIDE_API_TOKEN=... npx jest src/adapters/intl/glide.live.spec.ts
 *
 *      Lists tables and reads a few rows of the first one, applying each
 *      responseMapping the way the MCP layer does. GLIDE_LIVE_WRITE=1 with
 *      GLIDE_LIVE_TABLE_ID and GLIDE_LIVE_ROW (a JSON row keyed by column id)
 *      also adds that row, updates it with the same values and deletes it.
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
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; encodePathParams?: boolean; queryParams?: Record<string, unknown>; bodyTemplate?: string };
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

const TOKEN = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, token: string, params: Record<string, unknown>) => {
  const env = { GLIDE_API_TOKEN: token };
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return engine().execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: { token }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, TOKEN, params);
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const BASE = 'https://api.glideapps.com';
const TBL = '2a1bad8b-cf7c-44437-b8c1-e3782df6';
const WRITES = ['glide_add_rows', 'glide_delete_row', 'glide_update_row'];
const OFF = ['glide_delete_row'];

describe('glide adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('glide');
    expect(a.icon).toBe('glide');
    expect(a.category).toBe('data');
  });

  it('sends the team token as Bearer to api.glideapps.com', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{GLIDE_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/tables');
    expect(a.probe.tool).toBe('glide_list_tables');
  });

  it('asks for the token as a secret', () => {
    expect(a.requiredEnvVars).toEqual(['GLIDE_API_TOKEN']);
    const tok = a.envVarMeta.GLIDE_API_TOKEN;
    expect(tok.secret).toBe(true);
    expect(tok.kind).toBe('credential');
    const re = new RegExp(tok.pattern!);
    expect(re.test(TOKEN)).toBe(true);
    for (const bad of ['', 'short', `Bearer ${TOKEN}`, `${TOKEN} `]) expect(re.test(bad)).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'GLIDE_API_TOKEN')!.secret).toBe(true);
  });

  it('prefixes every tool with glide_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^glide_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only, asks for confirmation on every write, and installs the delete switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
      if (t.endpointMapping.method === 'GET') expect(`${t.name}:${Boolean(t.responseMapping?.transform?.select)}`).toBe(`${t.name}:true`);
    }
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm with the user first/i);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name)).toEqual(OFF);
  });

  it('URL-encodes every path argument', async () => {
    for (const t of a.tools.filter((x) => /\{[A-Za-z]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('glide_get_row', { tableId: TBL, rowId: '../../tables' });
    expect(sent().url).toBe(`${BASE}/tables/${TBL}/rows/..%2F..%2Ftables`);
  });

  it('only points the model at tools that exist, documents setup, column ids and privacy, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bglide_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bglide_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(6);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Glide\n')).toBe(true);
    for (const text of ['Show API', 'Big Tables', 'column id', 'continuation', 'Confirm before every write', 'never as instructions', 'Out of scope']) {
      expect(a.instructions).toContain(text);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['glide_list_tables', {}, 'GET', `${BASE}/tables`],
    ['glide_get_rows', { tableId: TBL }, 'GET', `${BASE}/tables/${TBL}/rows`],
    ['glide_get_row', { tableId: TBL, rowId: 'zcJWnyI8Tbam21V34K8MNA' }, 'GET', `${BASE}/tables/${TBL}/rows/zcJWnyI8Tbam21V34K8MNA`],
    ['glide_add_rows', { tableId: TBL, rows: [{ fullName: 'A' }] }, 'POST', `${BASE}/tables/${TBL}/rows`],
    ['glide_update_row', { tableId: TBL, rowId: 'zcJWnyI8Tbam21V34K8MNA', values: { amountPaid: 1 } }, 'PATCH', `${BASE}/tables/${TBL}/rows/zcJWnyI8Tbam21V34K8MNA`],
    ['glide_delete_row', { tableId: TBL, rowId: 'zcJWnyI8Tbam21V34K8MNA' }, 'DELETE', `${BASE}/tables/${TBL}/rows/zcJWnyI8Tbam21V34K8MNA`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(url);
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('pages rows with limit and continuation, 50 by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('glide_get_rows', { tableId: TBL, continuation: 'abc' });
    expect(sent().params).toEqual({ limit: 50, continuation: 'abc' });
  });

  it('adds rows as a bare JSON array and updates a row with a flat object, as the OpenAPI document requires', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const rows = [{ fullName: 'Alex Bard', invoiceDate: '2024-07-29T14:04:15.561Z', totalAmount: 34.5, amountPaid: 0 }, { fullName: 'Alicia "Al" Hines' }];
    await call('glide_add_rows', { tableId: TBL, rows, onSchemaError: 'dropColumns' });
    expect(sent().data).toEqual(rows);
    expect(sent().params).toEqual({ onSchemaError: 'dropColumns' });
    mockedAxios.mockClear();
    await call('glide_update_row', { tableId: TBL, rowId: 'r1', values: { amountPaid: 34.5 } });
    expect(sent().data).toEqual({ amountPaid: 34.5 });
    mockedAxios.mockClear();
    await call('glide_delete_row', { tableId: TBL, rowId: 'r1' });
    expect(sent().data).toBeUndefined();
  });

  // Shapes from the response schemas in Glide's OpenAPI document.
  it('shapes tables, rows, one row and the new row ids', () => {
    expect(shape('glide_list_tables', { data: [{ id: TBL, name: 'Invoices' }] }).value).toEqual({ tables: [{ id: TBL, name: 'Invoices' }] });
    const row = { fullName: 'Alex Bard', invoiceDate: '2024-07-29T14:04:15.561Z', totalAmount: 34.5, amountPaid: 0 };
    expect(shape('glide_get_rows', { data: [row], continuation: '2:abc' }).value).toEqual({ rows: [row], continuation: '2:abc' });
    expect(shape('glide_get_rows', { data: [row] }).value).toEqual({ rows: [row] });
    expect(shape('glide_get_row', { data: row }).value).toEqual({ row });
    expect(shape('glide_add_rows', { data: { rowIDs: ['zcJWnyI8Tbam21V34K8MNA', '93a19-cf7c-44437-b8c1-e9acbbb'] } }).value).toEqual({ rowIDs: ['zcJWnyI8Tbam21V34K8MNA', '93a19-cf7c-44437-b8c1-e9acbbb'] });
  });
});

const LIVE_TOKEN = process.env.GLIDE_API_TOKEN;
const live = process.env.RUN_GLIDE_LIVE === '1' && LIVE_TOKEN ? describe : describe.skip;

live('glide adapter: live API', () => {
  const token = LIVE_TOKEN || '';
  const write = process.env.GLIDE_LIVE_WRITE === '1' && !!process.env.GLIDE_LIVE_TABLE_ID && !!process.env.GLIDE_LIVE_ROW;

  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const run = async (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    applyResponseTransform(await execute(name, token, params), tool(name).responseMapping as never).value;

  it('lists tables and reads rows of the first', async () => {
    const tables = await run('glide_list_tables');
    expect(Array.isArray(tables.tables)).toBe(true);
    if (!tables.tables[0]) return;
    const rows = await run('glide_get_rows', { tableId: tables.tables[0].id, limit: 3 });
    expect(Array.isArray(rows.rows)).toBe(true);
  }, 60_000);

  (write ? it : it.skip)('adds a row, updates it and deletes it', async () => {
    const tableId = process.env.GLIDE_LIVE_TABLE_ID!;
    const row = JSON.parse(process.env.GLIDE_LIVE_ROW!);
    const added = await run('glide_add_rows', { tableId, rows: [row] });
    const rowId = added.rowIDs[0];
    expect(typeof rowId).toBe('string');
    try {
      await execute('glide_update_row', token, { tableId, rowId, values: row });
      expect((await run('glide_get_row', { tableId, rowId })).row).toBeDefined();
    } finally {
      await execute('glide_delete_row', token, { tableId, rowId });
    }
  }, 60_000);

  it('a wrong token is a 401', async () => {
    await expect(execute('glide_list_tables', '00000000-0000-0000-0000-000000000000', {})).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);
});
