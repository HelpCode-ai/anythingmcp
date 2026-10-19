import axios from 'axios';
import * as adapter from './rivile.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Two layers of verification for the Rivile GAMA adapter (Rivile API v2):
 *
 *   1. Static: always runs. Every Rivile call is a POST to one address with
 *      a method name and params; this pins the ApiKey header, the method of
 *      each tool (from gidas.rivile.lt), the params it sends, the read-only
 *      annotation every GET_ method needs over POST, and the edits that ship
 *      switched off.
 *
 *   2. Live: skipped unless RIVILE_API_KEY is set. Reads only. Rivile bills
 *      the API per request, so it makes a handful of calls.
 *
 *        RIVILE_API_KEY=... npx jest src/adapters/intl/rivile.live.spec.ts
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
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping: { method: string; params?: unknown; data?: unknown } };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const KEY = ['XW3CDDX', 'Bfnjvrurjygzuj0testkey0ORuYcT5JhjGSH2F2z5tL'].join('.');
const ENV = { RIVILE_API_KEY: KEY };
const URL = 'https://api.manorivile.lt/client/v2';
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep({ ...a.connector.authConfig }, env), headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];

const EDITS = ['rivile_create_document', 'rivile_edit_client', 'rivile_edit_document', 'rivile_edit_product'];

describe('rivile adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('posts JSON to the single API v2 address with the key in the ApiKey header', async () => {
    expect(a.connector.baseUrl).toBe(URL);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'ApiKey', apiKey: '{{RIVILE_API_KEY}}' });
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
    mockedAxios.mockResolvedValue({ data: { N07: [] } });
    await execute('rivile_list_divisions', ENV, {});
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(URL);
    expect(sent().headers.ApiKey).toBe(KEY);
    expect(sent().data).toEqual({ method: 'GET_N07_LIST', params: {} });
    expect(a.probe).toEqual({ tool: 'rivile_list_divisions' });
  });

  it('accepts the USERNAME.secret key form only', () => {
    const p = new RegExp(a.envVarMeta.RIVILE_API_KEY.pattern!);
    expect(p.test(KEY)).toBe(true);
    for (const bad of [`ApiKey ${KEY}`, `"${KEY}"`, 'nodot', `${KEY} `]) expect(p.test(bad)).toBe(false);
    expect(a.envVarMeta.RIVILE_API_KEY.secret).toBe(true);
  });

  // [tool, args, Rivile method, params sent]
  const table: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ['rivile_list_clients', { list: 'A', fil: "n08_kodas_ks='121411842'" }, 'GET_N08_LIST', { list: 'A', fil: "n08_kodas_ks='121411842'" }],
    ['rivile_list_products', { pagenumber: 2 }, 'GET_N17_LIST', { pagenumber: 2 }],
    ['rivile_list_stock_balances', { group: 'I17_KODAS_IS' }, 'GET_I17_LIST', { group: 'I17_KODAS_IS' }],
    ['rivile_list_product_prices', {}, 'GET_I33_LIST', {}],
    ['rivile_list_documents', { fil: "i06_dok_data>='2026-01-01'" }, 'GET_I06_LIST', { fil: "i06_dok_data>='2026-01-01'" }],
    ['rivile_list_documents_extended', {}, 'GET_I06_LIST_EXT', {}],
    ['rivile_list_document_debts', { list: 'H' }, 'GET_I06_DEBT', { list: 'H' }],
    ['rivile_list_internal_operations', {}, 'GET_I09_LIST', {}],
    ['rivile_list_debt_operations', {}, 'GET_I31_LIST', {}],
    ['rivile_list_debts_detailed', {}, 'GET_I44_LIST', {}],
    ['rivile_list_debts_summary', { list: 'A' }, 'GET_T03_LIST', { list: 'A' }],
    ['rivile_list_payment_operations', {}, 'GET_I53_LIST', {}],
    ['rivile_list_receipts_payments_register', {}, 'GET_I04_LIST', {}],
    ['rivile_list_ledger_operations', {}, 'GET_I02_LIST', {}],
    ['rivile_get_account_balances', { beg_date: '2026-01-01', end_date: '2026-06-30', group: 'kodas_is' }, 'GET_I02_LIST_EXT', { beg_date: '2026-01-01', end_date: '2026-06-30', group: 'kodas_is' }],
    ['rivile_list_chart_of_accounts', {}, 'GET_N01_LIST', {}],
    ['rivile_list_divisions', {}, 'GET_N07_LIST', {}],
    ['rivile_list_objects', {}, 'GET_N06_LIST', {}],
    ['rivile_list_purchase_sales_codes', {}, 'GET_N25_LIST', {}],
    ['rivile_list_vat_classifiers', {}, 'GET_N63_LIST', {}],
    ['rivile_list_currencies', {}, 'GET_N45_LIST', {}],
    ['rivile_list_contracts', {}, 'GET_N51_LIST', {}],
    ['rivile_list_import_export_operations', {}, 'GET_B00_LIST', {}],
    ['rivile_call_read_method', { method: 'GET_N32_LIST', params: { list: 'H' } }, 'GET_N32_LIST', { list: 'H' }],
  ];
  it.each(table)('%s calls %s', async (name, args, method, params) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute(name, ENV, args);
    expect(sent().data).toEqual({ method, params });
    expect(annotationsOf(tool(name)).readOnlyHint).toBe(true);
  });

  it('covers every read tool in the table and documents each table code', () => {
    const reads = a.tools.filter((t) => t.enabled !== false).map((t) => t.name).sort();
    expect(reads).toEqual(table.map((r) => r[0]).sort());
    for (const [name, , method] of table.filter((r) => r[0] !== 'rivile_call_read_method')) {
      const code = method.replace(/^GET_/, '').replace(/_(LIST|LIST_EXT|DEBT)$/, '');
      expect(`${name}:${tool(name).description.includes(code)}`).toBe(`${name}:true`);
      expect(`${code}:${a.instructions.includes(code)}`).toBe(`${code}:true`);
    }
  });

  it('lets the generic tool call GET_ methods only, not user procedures or views', () => {
    const p = new RegExp(tool('rivile_call_read_method').parameters.properties!.method.pattern);
    for (const ok of ['GET_N32_LIST', 'GET_PS_KAIN', 'MGAMA_GET_K14_LIST', 'GET_I06_DOCS']) expect(p.test(ok)).toBe(true);
    for (const bad of ['EDIT_N08', 'GET_USER_PROC', 'GET_VIEWS_LIST', 'INIT_TRIGGER', 'get_n08_list', 'MGAMA_EDIT_K14']) expect(p.test(bad)).toBe(false);
  });

  it('installs every edit switched off and sends oper and data as Rivile documents them', async () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(EDITS);
    for (const name of EDITS) {
      expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
      expect(tool(name).description).toMatch(/switched off/);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    const data = { N08: { N08_KODAS_KS: '121411842', N08_PAV: 'UAB Pavyzdys' } };
    await execute('rivile_edit_client', ENV, { oper: 'U', data });
    expect(sent().data).toEqual({ method: 'EDIT_N08', params: { oper: 'U' }, data });
    mockedAxios.mockClear();
    await execute('rivile_create_document', ENV, { data: { I06: { I06_OP_TIP: '51' } } });
    expect(sent().data).toEqual({ method: 'EDIT_I06_FULL', params: { oper: 'I' }, data: { I06: { I06_OP_TIP: '51' } } });
  });

  it('has no payment, POS, gift card or payroll writes', () => {
    const methods = a.tools.map((t) => String(t.endpointMapping.bodyMapping.method));
    for (const m of methods.filter((x) => x.startsWith('EDIT_'))) expect(m).toMatch(/^EDIT_(N08|N17|I06|I06_FULL)$/);
  });

  it('prefixes every tool, points the model only at tools that exist and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    expect(names.size).toBe(a.tools.length);
    for (const n of names) expect(n).toMatch(/^rivile_[a-z_]+$/);
    for (const m of a.instructions.matchAll(/\brivile_[a-z_]+/g)) expect(names).toContain(m[0]);
    expect(a.instructions).toMatch(/Manorivile-Gateway/);
    expect(a.instructions).toMatch(/100 records/);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RIVILE_API_KEY ? describe : describe.skip;
live('rivile adapter: live reads', () => {
  const env = { RIVILE_API_KEY: process.env.RIVILE_API_KEY! };
  beforeAll(() => mockedAxios.mockImplementation((cfg: unknown) => (mockedAxios.__actual as any).request(cfg)));
  it.each([
    ['rivile_list_divisions', {}],
    ['rivile_list_clients', { fil: "n08_pav like 'A%'" }],
    ['rivile_list_vat_classifiers', {}],
  ] as Array<[string, Record<string, unknown>]>)('%s answers', async (name, args) => {
    const res = await execute(name, env, args);
    expect(res).toBeDefined();
  }, 30000);
});
