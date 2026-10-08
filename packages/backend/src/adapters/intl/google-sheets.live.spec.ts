import axios from 'axios';
import * as adapter from './google-sheets.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google Sheets adapter:
 *
 *   1. Static: always runs. Pins the OAuth setup shared by the Google
 *      adapters, A1 ranges percent-encoded into the path (sheet names carry
 *      spaces and quotes), USER_ENTERED as the default input option, the
 *      batchUpdate bodies for adding and renaming sheets, and which tools
 *      install switched off.
 *
 *   2. Live: skipped unless GOOGLE_ACCESS_TOKEN is set (spreadsheets.readonly
 *      for reads, spreadsheets for the write round-trip). Reads Google's
 *      public sample spreadsheet, the same one the probe uses:
 *
 *        GOOGLE_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/google-sheets.live.spec.ts
 *
 *      With GOOGLE_LIVE_WRITE=1 as well, an "AnythingMCP test spreadsheet"
 *      is created, written, appended to, cleared and moved to the trash in
 *      `finally` through the Drive API (the token then also needs the drive
 *      or drive.file scope; without it the test names the file to delete).
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
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  probe: { tool: string; params?: Record<string, unknown> };
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

const BASE = 'https://sheets.googleapis.com/v4';
const SAMPLE = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
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

describe('google-sheets adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('signs in with the shared Google OAuth client and the spreadsheets scope', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/spreadsheets',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/read-only setup[^\n]*spreadsheets\.readonly/);
  });

  it("probes by reading Google's public sample spreadsheet, since Sheets has no list call", () => {
    expect(a.probe).toEqual({ tool: 'gsheets_get_spreadsheet', params: { spreadsheet_id: SAMPLE } });
    expect(tool('gsheets_get_spreadsheet').endpointMapping.method).toBe('GET');
    expect(a.connector.healthcheckPath).toBe(`/spreadsheets/${SAMPLE}?fields=spreadsheetId`);
  });

  it('prefixes every tool with gsheets_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gsheets_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('percent-encodes ids and ranges placed in the path', () => {
    for (const t of a.tools) {
      if (/\{\w+\}/.test(t.endpointMapping.path)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('installs clearing and the raw batchUpdate switched off, and says so', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([
      'gsheets_batch_update',
      'gsheets_clear_range',
    ]);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `gsheets_clear_range` and `gsheets_batch_update`/);
    for (const name of ['gsheets_clear_range', 'gsheets_batch_update', 'gsheets_update_range', 'gsheets_batch_update_values']) {
      expect(`${name}:${annotationsOf(tool(name)).destructiveHint}`).toBe(`${name}:true`);
    }
  });

  it('marks the reads read-only', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(['gsheets_batch_read', 'gsheets_get_spreadsheet', 'gsheets_read_range']);
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgsheets_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgsheets_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['gsheets_get_spreadsheet', { spreadsheet_id: 'S1' }, 'GET', '/spreadsheets/S1'],
    ['gsheets_read_range', { spreadsheet_id: 'S1', range: "'Sales 2026'!A1:C10" }, 'GET', "/spreadsheets/S1/values/'Sales%202026'!A1%3AC10"],
    ['gsheets_batch_read', { spreadsheet_id: 'S1', ranges: ['A1:B2'] }, 'GET', '/spreadsheets/S1/values:batchGet'],
    ['gsheets_append_rows', { spreadsheet_id: 'S1', range: 'Sheet1!A:E', values: [[1]] }, 'POST', '/spreadsheets/S1/values/Sheet1!A%3AE:append'],
    ['gsheets_update_range', { spreadsheet_id: 'S1', range: 'Sheet1!B2', values: [[1]] }, 'PUT', '/spreadsheets/S1/values/Sheet1!B2'],
    ['gsheets_batch_update_values', { spreadsheet_id: 'S1', data: [] }, 'POST', '/spreadsheets/S1/values:batchUpdate'],
    ['gsheets_clear_range', { spreadsheet_id: 'S1', range: 'Sheet1!A2:Z' }, 'POST', '/spreadsheets/S1/values/Sheet1!A2%3AZ:clear'],
    ['gsheets_create_spreadsheet', { title: 'T' }, 'POST', '/spreadsheets'],
    ['gsheets_add_sheet', { spreadsheet_id: 'S1', title: 'T' }, 'POST', '/spreadsheets/S1:batchUpdate'],
    ['gsheets_batch_update', { spreadsheet_id: 'S1', requests: [] }, 'POST', '/spreadsheets/S1:batchUpdate'],
  ])('%s sends %s to the right Sheets URL', async (name, params, method, path) => {
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

  it('keeps spreadsheet metadata small with a fixed field mask', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gsheets_get_spreadsheet', { spreadsheet_id: 'S1' });
    expect(sent().params.fields).toMatch(/sheets\(properties\(sheetId,title,/);
    expect(sent().params.fields).not.toMatch(/data|gridData/);
  });

  it('sends repeated ranges for a batch read', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gsheets_batch_read', { spreadsheet_id: 'S1', ranges: ['A!A1:B2', 'B!C:C'], value_render_option: 'FORMULA' });
    expect(sent().params).toEqual({ ranges: ['A!A1:B2', 'B!C:C'], valueRenderOption: 'FORMULA' });
    expect(sent().paramsSerializer(sent().params)).toBe('ranges=A!A1:B2&ranges=B!C:C&valueRenderOption=FORMULA');
  });

  it('appends rows as typed input after the table, inserting rows', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gsheets_append_rows', { spreadsheet_id: 'S1', range: 'Sheet1!A:B', values: [['2026-10-09', '=1+1']] });
    expect(sent().params).toEqual({ valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
    expect(sent().data).toEqual({ majorDimension: 'ROWS', values: [['2026-10-09', '=1+1']] });
    mockedAxios.mockClear();
    await call('gsheets_update_range', { spreadsheet_id: 'S1', range: 'A1', values: [['x']], value_input_option: 'RAW' });
    expect(sent().params).toEqual({ valueInputOption: 'RAW' });
  });

  it('clears with an empty body and builds the add and rename requests', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gsheets_clear_range', { spreadsheet_id: 'S1', range: 'A2:Z' });
    expect(sent().data).toEqual({});
    mockedAxios.mockClear();
    await call('gsheets_add_sheet', { spreadsheet_id: 'S1', title: 'Q4' });
    expect(sent().data).toEqual({ requests: [{ addSheet: { properties: { title: 'Q4' } } }] });
    mockedAxios.mockClear();
    await call('gsheets_rename_sheet', { spreadsheet_id: 'S1', sheet_id: 0, title: 'Data' });
    expect(sent().data).toEqual({
      requests: [{ updateSheetProperties: { properties: { sheetId: 0, title: 'Data' }, fields: 'title' } }],
    });
    mockedAxios.mockClear();
    await call('gsheets_create_spreadsheet', { title: 'Budget', locale: 'de_DE' });
    expect(sent().data).toEqual({ properties: { title: 'Budget', locale: 'de_DE' } });
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('google-sheets adapter: live Sheets API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const bearer = (baseUrl: string) => ({
    baseUrl,
    authType: 'BEARER_TOKEN',
    authConfig: { token: TOKEN as string },
    headers: a.connector.headers,
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(bearer(a.connector.baseUrl), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));

  it('runs the probe on the public sample spreadsheet', async () => {
    const ss = await run(a.probe.tool, a.probe.params);
    expect(ss.spreadsheetId).toBe(SAMPLE);
    expect(ss.sheets[0].properties.title).toBe('Class Data');
    expect(ss.sheets[0].data).toBeUndefined();
  }, 30_000);

  it('reads one range and a batch of ranges', async () => {
    const one = await run('gsheets_read_range', { spreadsheet_id: SAMPLE, range: 'Class Data!A1:E3' });
    expect(one.values[0][0]).toBe('Student Name');
    const batch = await run('gsheets_batch_read', { spreadsheet_id: SAMPLE, ranges: ['Class Data!A1:A2', 'Class Data!E1:E2'] });
    expect(batch.valueRanges).toHaveLength(2);
  }, 30_000);

  (process.env.GOOGLE_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a test spreadsheet, writes, appends, renames and clears, then trashes it',
    async () => {
      const ss = await run('gsheets_create_spreadsheet', { title: `AnythingMCP test spreadsheet ${new Date().toISOString()}` });
      const id = ss.spreadsheetId as string;
      try {
        const first = ss.sheets[0].properties;
        await run('gsheets_rename_sheet', { spreadsheet_id: id, sheet_id: first.sheetId, title: 'Data' });
        await run('gsheets_update_range', { spreadsheet_id: id, range: 'Data!A1:B2', values: [['Item', 'Amount'], ['Grüße', 2]] });
        const appended = await run('gsheets_append_rows', { spreadsheet_id: id, range: 'Data!A:B', values: [['perché', 3], ['Total', '=SUM(B2:B3)']] });
        expect(appended.updates.updatedRows).toBe(2);
        const read = await run('gsheets_read_range', { spreadsheet_id: id, range: 'Data!A1:B4', value_render_option: 'UNFORMATTED_VALUE' });
        expect(read.values).toEqual([['Item', 'Amount'], ['Grüße', 2], ['perché', 3], ['Total', 5]]);
        const added = await run('gsheets_add_sheet', { spreadsheet_id: id, title: 'AnythingMCP test tab' });
        expect(added.replies[0].addSheet.properties.title).toBe('AnythingMCP test tab');
        await run('gsheets_batch_update_values', { spreadsheet_id: id, data: [{ range: "'AnythingMCP test tab'!A1", values: [['x']] }] });
        await run('gsheets_clear_range', { spreadsheet_id: id, range: 'Data!A2:B' });
        const after = await run('gsheets_read_range', { spreadsheet_id: id, range: 'Data!A1:B4' });
        expect(after.values).toEqual([['Item', 'Amount']]);
      } finally {
        await engine()
          .execute(
            bearer('https://www.googleapis.com/drive/v3'),
            { method: 'PATCH', path: '/files/{id}', encodePathParams: true, bodyMapping: { trashed: true } },
            { id },
          )
          .catch(() => console.warn(`Could not trash test spreadsheet ${id}: delete it by hand.`));
      }
    },
    90_000,
  );
});
