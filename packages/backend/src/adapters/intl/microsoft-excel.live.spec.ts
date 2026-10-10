import axios from 'axios';
import * as adapter from './microsoft-excel.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Excel (Microsoft Graph workbook API)
 * adapter:
 *
 *   1. Static: always runs. Pins the Entra OAuth setup shared with Outlook,
 *      every workbook call addressed as /drives/{drive_id}/items/{item_id}
 *      (so OneDrive and SharePoint workbooks work alike), the range function
 *      syntax with a percent-encoded address and sheet name, the `$select`
 *      that keeps range answers to address and values by default, the 200 KB
 *      cap on reads, the write bodies, and which tools install switched off
 *      (clear range, delete worksheet).
 *
 *   2. Live: skipped unless MS_GRAPH_ACCESS_TOKEN is set (a delegated Graph
 *      token with Files.ReadWrite, e.g. from Graph Explorer). Reads use the
 *      first .xlsx found in the user's OneDrive:
 *
 *        MS_GRAPH_ACCESS_TOKEN=eyJ... npx jest src/adapters/intl/microsoft-excel.live.spec.ts
 *
 *      With EXCEL_LIVE_WRITE=1 and EXCEL_TEST_ITEM_ID (the drive item id of a
 *      workbook you own; EXCEL_TEST_DRIVE_ID too when it is not in your own
 *      OneDrive), a sheet "AnythingMCP test <time>" is added to that
 *      workbook, written, turned into a table that gets rows, read back, and
 *      deleted in `finally`. The rest of the workbook is not touched.
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
const WB = `${BASE}/drives/b!d1/items/01X/workbook`;
const ids = { drive_id: 'b!d1', item_id: '01X' };
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

describe('microsoft-excel adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified live on 10 Oct 2026), and says up front that it needs an Entra app', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.prerequisites).toMatch(/Entra/);
    expect(a.prerequisites).toMatch(/Outlook connector can be reused/);
  });

  it('signs in against the configured tenant with the Outlook variables and Files.ReadWrite', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID']);
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MICROSOFT_CLIENT_ID}}',
      clientSecret: '{{MICROSOFT_CLIENT_SECRET}}',
      authorizationUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/token',
      scopes: 'offline_access User.Read Files.ReadWrite',
    });
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/Files\.ReadWrite\.All/);
  });

  it('probes with /me/drive, which needs no arguments', () => {
    expect(a.probe.tool).toBe('excel_get_my_drive');
    expect(tool('excel_get_my_drive').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/me/drive');
  });

  it('prefixes every tool with excel_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^excel_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('addresses every workbook call by drive and item id, percent-encoded', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('/workbook'))) {
      expect(t.endpointMapping.path.startsWith('/drives/{drive_id}/items/{item_id}/workbook/')).toBe(true);
      expect(t.endpointMapping.encodePathParams).toBe(true);
      expect(t.parameters.required).toEqual(expect.arrayContaining(['drive_id', 'item_id']));
    }
  });

  it('installs clear range and delete worksheet switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(['excel_clear_range', 'excel_delete_worksheet']);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `excel_clear_range` and `excel_delete_worksheet`/);
    expect(annotationsOf(tool('excel_clear_range')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('excel_delete_worksheet')).destructiveHint).toBe(true);
  });

  it('marks reads read-only and overwriting a range destructive', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'excel_find_workbooks',
      'excel_get_my_drive',
      'excel_get_workbook_by_path',
      'excel_list_table_columns',
      'excel_list_table_rows',
      'excel_list_tables',
      'excel_list_worksheets',
      'excel_read_range',
      'excel_read_used_range',
    ]);
    expect(annotationsOf(tool('excel_update_range')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('excel_add_table_rows')).destructiveHint).toBe(false);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bexcel_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bexcel_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['excel_get_my_drive', {}, 'GET', `${BASE}/me/drive`],
    ['excel_find_workbooks', { query: 'budget' }, 'GET', `${BASE}/me/drive/root/search(q='budget')`],
    ['excel_get_workbook_by_path', { path: 'Finance/Budget 2026.xlsx' }, 'GET', `${BASE}/me/drive/root:/Finance/Budget 2026.xlsx`],
    ['excel_list_worksheets', ids, 'GET', `${WB}/worksheets`],
    ['excel_read_range', { ...ids, worksheet: 'Sales 2026', address: 'A1:D20' }, 'GET', `${WB}/worksheets/Sales%202026/range(address='A1%3AD20')`],
    ['excel_read_used_range', { ...ids, worksheet: 'Sheet1' }, 'GET', `${WB}/worksheets/Sheet1/usedRange(valuesOnly=true)`],
    ['excel_update_range', { ...ids, worksheet: 'Sheet1', address: 'B2', values: [[1]] }, 'PATCH', `${WB}/worksheets/Sheet1/range(address='B2')`],
    ['excel_add_worksheet', { ...ids, name: 'New' }, 'POST', `${WB}/worksheets/add`],
    ['excel_list_tables', ids, 'GET', `${WB}/tables`],
    ['excel_list_table_columns', { ...ids, table: 'Table1' }, 'GET', `${WB}/tables/Table1/columns`],
    ['excel_list_table_rows', { ...ids, table: 'Table1' }, 'GET', `${WB}/tables/Table1/rows`],
    ['excel_add_table_rows', { ...ids, table: 'Table1', values: [[1, 2]] }, 'POST', `${WB}/tables/Table1/rows`],
    ['excel_create_table', { ...ids, address: 'Sheet1!A1:B1', has_headers: true }, 'POST', `${WB}/tables/add`],
    ['excel_clear_range', { ...ids, worksheet: 'Sheet1', address: 'A2:Z' }, 'POST', `${WB}/worksheets/Sheet1/range(address='A2%3AZ')/clear`],
    ['excel_delete_worksheet', { ...ids, worksheet: '{00000000-0001-0000-0100-000000000000}' }, 'DELETE', `${WB}/worksheets/%7B00000000-0001-0000-0100-000000000000%7D`],
  ])('%s sends %s to the right Graph URL', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url, headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
  });

  it('asks for address and values by default and for more on request', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('excel_read_range', { ...ids, worksheet: 'Sheet1', address: 'A1:B2' });
    expect(sent().params).toEqual({ $select: 'address,values,rowCount,columnCount' });
    mockedAxios.mockClear();
    await call('excel_read_used_range', { ...ids, worksheet: 'Sheet1', fields: 'address,text' });
    expect(sent().params).toEqual({ $select: 'address,text' });
  });

  it('writes values, formulas and number formats as given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('excel_update_range', {
      ...ids,
      worksheet: 'Sheet1',
      address: 'A1:B1',
      formulas: [['=1+1', '=A1*2']],
      number_format: [['0.00', '0.00']],
    });
    expect(sent().data).toEqual({ formulas: [['=1+1', '=A1*2']], numberFormat: [['0.00', '0.00']] });
  });

  it('adds table rows at the end unless an index is given, and creates tables from an address', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('excel_add_table_rows', { ...ids, table: 'Table1', values: [['a', 1], ['b', 2]] });
    expect(sent().data).toEqual({ values: [['a', 1], ['b', 2]] });
    mockedAxios.mockClear();
    await call('excel_add_table_rows', { ...ids, table: 'Table1', values: [['c', 3]], index: 0 });
    expect(sent().data).toEqual({ values: [['c', 3]], index: 0 });
    mockedAxios.mockClear();
    await call('excel_create_table', { ...ids, address: "'Sales 2026'!A1:C1", has_headers: true });
    expect(sent().data).toEqual({ address: "'Sales 2026'!A1:C1", hasHeaders: true });
  });

  it('pages table rows with $top and $skip', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('excel_list_table_rows', { ...ids, table: 'Table1', top: 100, skip: 200 });
    expect(sent().params).toEqual({ $top: 100, $skip: 200 });
  });

  it('caps range and row reads at 200 KB', () => {
    for (const name of ['excel_read_range', 'excel_read_used_range', 'excel_list_table_rows', 'excel_update_range']) {
      const mapping = tool(name).responseMapping!;
      expect(validateTransform(mapping.transform)).toBeNull();
      const big = applyResponseTransform({ values: [['x'.repeat(300_000)]] }, mapping);
      expect(big.truncated).toBe(true);
      expect(applyResponseTransform({ values: [[1]] }, mapping).value).toEqual({ values: [[1]] });
    }
  });
});

const TOKEN = process.env.MS_GRAPH_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('microsoft-excel adapter: live Graph workbook API', () => {
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

  it('finds a workbook and reads its sheets, used range, a range and its tables', async () => {
    const drive = await run('excel_get_my_drive');
    expect(typeof drive.id).toBe('string');
    const hits = await run('excel_find_workbooks', { query: 'xlsx', top: 25 });
    const book = hits.value.find((f: { name: string }) => /\.xlsx$/i.test(f.name));
    if (!book) return;
    const wb = { drive_id: book.parentReference.driveId, item_id: book.id };
    const sheets = await run('excel_list_worksheets', wb);
    expect(sheets.value.length).toBeGreaterThan(0);
    const sheet = sheets.value[0].name;
    const used = await run('excel_read_used_range', { ...wb, worksheet: sheet });
    expect(used.address ?? used._truncated).toBeTruthy();
    const range = await run('excel_read_range', { ...wb, worksheet: sheet, address: 'A1:C3', fields: 'address,values,text' });
    expect(range.values ?? range._truncated).toBeTruthy();
    const tables = await run('excel_list_tables', wb);
    expect(Array.isArray(tables.value)).toBe(true);
    if (tables.value.length) {
      const cols = await run('excel_list_table_columns', { ...wb, table: tables.value[0].name });
      expect(Array.isArray(cols.value)).toBe(true);
      const rows = await run('excel_list_table_rows', { ...wb, table: tables.value[0].name, top: 5 });
      expect(Array.isArray(rows.value) || rows._truncated).toBeTruthy();
    }
  }, 120_000);

  const itemId = process.env.EXCEL_TEST_ITEM_ID;
  (process.env.EXCEL_LIVE_WRITE === '1' && itemId ? it : it.skip)(
    'adds a test sheet, writes it, makes a table with rows, reads it back and deletes the sheet',
    async () => {
      const driveId = process.env.EXCEL_TEST_DRIVE_ID || (await run('excel_get_my_drive')).id;
      const wb = { drive_id: driveId, item_id: itemId };
      const name = `AnythingMCP test ${Date.now() % 1_000_000}`;
      const sheet = await run('excel_add_worksheet', { ...wb, name });
      expect(sheet.name).toBe(name);
      try {
        await run('excel_update_range', { ...wb, worksheet: name, address: 'A1:C2', values: [['Item', 'Qty', 'Total'], ['Grüße', 2, null]] });
        await run('excel_update_range', { ...wb, worksheet: name, address: 'C2', formulas: [['=B2*10']] });
        const read = await run('excel_read_range', { ...wb, worksheet: name, address: 'A1:C2' });
        expect(read.values).toEqual([['Item', 'Qty', 'Total'], ['Grüße', 2, 20]]);

        const table = await run('excel_create_table', { ...wb, address: `'${name}'!A1:C2`, has_headers: true });
        await run('excel_add_table_rows', { ...wb, table: table.name, values: [['a', 1, 'x'], ['b', 2, 'y']] });
        const rows = await run('excel_list_table_rows', { ...wb, table: table.name });
        expect(rows.value.map((r: { values: unknown[][] }) => r.values[0][0])).toEqual(['Grüße', 'a', 'b']);
        const used = await run('excel_read_used_range', { ...wb, worksheet: name });
        expect(used.rowCount).toBe(4);
      } finally {
        await run('excel_delete_worksheet', { ...wb, worksheet: name });
      }
    },
    180_000,
  );
});
