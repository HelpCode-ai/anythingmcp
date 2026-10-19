import axios from 'axios';
import * as adapter from './moedelo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Two layers of verification for the Moedelo (Моё Дело) adapter:
 *
 *   1. Static: always runs. Pins the md-api-key header, every tool's method
 *      and path (checked against Moedelo's published Swagger at
 *      restapi.moedelo.org/docs), path-id encoding, and the writes that ship
 *      switched off.
 *
 *   2. Live: skipped unless MOEDELO_API_KEY is set. Reads only.
 *
 *        MOEDELO_API_KEY=... npx jest src/adapters/intl/moedelo.live.spec.ts
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
  endpointMapping: { method: string; path: string; encodePathParams?: boolean; queryParams?: Record<string, string>; bodyMapping?: Record<string, string> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  instructions: string;
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
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

const KEY = ['1a2b3c4d', '5e6f', '7a8b', '9c0d', '1e2f3a4b5c6d'].join('-');
const ENV = { MOEDELO_API_KEY: KEY };
const BASE = 'https://restapi.moedelo.org';
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

describe('moedelo adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the key in the md-api-key header', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'md-api-key', apiKey: '{{MOEDELO_API_KEY}}' });
    mockedAxios.mockResolvedValue({ data: { ResourceList: [] } });
    await execute('moedelo_list_kontragents', ENV, { inn: '7700000000', pageSize: 1 });
    expect(sent().url).toBe(`${BASE}/kontragents/api/v1/kontragent`);
    expect(sent().headers['md-api-key']).toBe(KEY);
    expect(sent().params).toEqual({ inn: '7700000000', pageSize: 1 });
    expect(a.probe).toEqual({ tool: 'moedelo_list_kontragents', params: { pageSize: 1 } });
    const p = new RegExp(a.envVarMeta.MOEDELO_API_KEY.pattern!);
    expect(p.test(KEY)).toBe(true);
    expect(p.test(`"${KEY}"`)).toBe(false);
    expect(a.envVarMeta.MOEDELO_API_KEY.secret).toBe(true);
  });

  // [tool, args, url]
  const table: Array<[string, Record<string, unknown>, string]> = [
    ['moedelo_get_kontragent', { id: 42 }, '/kontragents/api/v1/kontragent/42'],
    ['moedelo_list_kontragent_bank_accounts', { kontragentId: 42 }, '/kontragents/api/v1/kontragent/42/account'],
    ['moedelo_list_kontragent_contacts', { kontragentId: 42 }, '/kontragents/api/v1/kontragent/42/contact'],
    ['moedelo_list_contracts', {}, '/contract/api/v1/contract'],
    ['moedelo_get_contract', { id: 7 }, '/contract/api/v1/contract/7'],
    ['moedelo_list_bills', {}, '/accounting/api/v1/sales/bill'],
    ['moedelo_get_bill', { id: 9 }, '/accounting/api/v1/sales/bill/9'],
    ['moedelo_list_bill_linked_documents', { id: 9 }, '/accounting/api/v1/sales/bill/9/LinkedDocuments'],
    ['moedelo_list_sales_acts', {}, '/accounting/api/v1/sales/act'],
    ['moedelo_get_sales_act', { id: 3 }, '/accounting/api/v1/sales/act/3'],
    ['moedelo_list_sales_waybills', {}, '/accounting/api/v1/sales/waybill'],
    ['moedelo_get_sales_waybill', { id: 3 }, '/accounting/api/v1/sales/waybill/3'],
    ['moedelo_list_sales_invoices', {}, '/accounting/api/v1/sales/invoice/common'],
    ['moedelo_get_sales_invoice', { id: 3 }, '/accounting/api/v1/sales/invoice/common/3'],
    ['moedelo_list_sales_advance_invoices', {}, '/accounting/api/v1/sales/invoice/advance'],
    ['moedelo_get_sales_upd', { id: 5 }, '/docs/api/v1/Sales/Upd/5'],
    ['moedelo_list_sales_upd_linked_documents', { id: 5 }, '/upds/api/v1/Sales/5/LinkedDocuments'],
    ['moedelo_list_retail_reports', {}, '/accounting/api/v1/sales/retailreport'],
    ['moedelo_list_purchase_acts', {}, '/accounting/api/v1/purchases/act'],
    ['moedelo_list_purchase_waybills', {}, '/accounting/api/v1/purchases/waybill'],
    ['moedelo_list_purchase_invoices', {}, '/accounting/api/v1/purchases/invoice/common'],
    ['moedelo_get_purchase_upd', { id: 5 }, '/docs/api/v1/Purchases/Upd/5'],
    ['moedelo_list_money_operations', {}, '/money/api/v1/Registry'],
    ['moedelo_get_bank_operation', { documentBaseId: 11 }, '/money/api/v1/PaymentOrders/11'],
    ['moedelo_get_cash_operation', { documentBaseId: 11 }, '/money/api/v1/CashOrders/11'],
    ['moedelo_list_settlement_accounts', {}, '/requisites/api/v1/SettlementAccount'],
    ['moedelo_list_cash_desks', {}, '/accounting/api/v1/cashier'],
    ['moedelo_get_cash_balance', { onDate: '2026-10-01' }, '/accounting/api/v1/cashier/GetCashBalance/2026-10-01'],
    ['moedelo_list_warehouses', {}, '/stock/api/v1/stock'],
    ['moedelo_list_goods', {}, '/stock/api/v1/good'],
    ['moedelo_get_good', { id: 8 }, '/stock/api/v1/good/8'],
    ['moedelo_list_services', {}, '/accounting/api/v1/services'],
    ['moedelo_list_chart_of_accounts', {}, '/accpostings/api/v1/SyntheticAccount'],
    ['moedelo_get_document_postings', { documentBaseId: 11 }, '/accpostingsapi/api/v1/Postings/11'],
    ['moedelo_list_employees', {}, '/payroll/api/v1/Employee'],
    ['moedelo_list_tax_calendar', {}, '/requisites/api/v1/calendar/event'],
  ];
  it.each(table)('%s reads %s', async (name, args, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute(name, ENV, args);
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(`${BASE}${path}`);
  });

  it('covers every read tool in the table', () => {
    expect(a.tools.filter((t) => t.enabled !== false).map((t) => t.name).sort()).toEqual(
      [...table.map((r) => r[0]), 'moedelo_list_kontragents'].sort(),
    );
  });

  it('filters documents by number, dates and counterparty', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('moedelo_list_bills', ENV, { docAfterDate: '2026-01-01', docBeforeDate: '2026-01-31', kontragentId: 42, projectId: 7, pageNo: 2 });
    expect(sent().params).toEqual({ docAfterDate: '2026-01-01', docBeforeDate: '2026-01-31', kontragentId: 42, projectId: 7, pageNo: 2 });
  });

  it('encodes path ids, so an id cannot reach another route', async () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('{'))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('moedelo_get_cash_balance', ENV, { onDate: '../../money' });
    expect(sent().url).toBe(`${BASE}/accounting/api/v1/cashier/GetCashBalance/..%2F..%2Fmoney`);
  });

  it('marks every GET read-only and installs the three writes switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    }
    const writes = ['moedelo_create_bill', 'moedelo_create_kontragent', 'moedelo_update_kontragent'];
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(writes);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(writes);
    expect(tool('moedelo_create_bill').description).toMatch(/no payment/);
  });

  it('sends only the fields given when creating a counterparty', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('moedelo_create_kontragent', ENV, { Name: 'ООО Ромашка', Inn: '7700000000', Form: 'UL' });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${BASE}/kontragents/api/v1/kontragent`);
    expect(sent().data).toEqual({ Name: 'ООО Ромашка', Inn: '7700000000', Form: 'UL' });
    mockedAxios.mockClear();
    await execute('moedelo_update_kontragent', ENV, { id: 42, Name: 'ООО Ромашка' });
    expect(sent().method).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/kontragents/api/v1/kontragent/42`);
    expect(sent().data).toEqual({ Name: 'ООО Ромашка' });
  });

  it('prefixes every tool, points the model only at tools that exist and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    expect(names.size).toBe(a.tools.length);
    for (const n of names) expect(n).toMatch(/^moedelo_[a-z_]+$/);
    for (const m of a.instructions.matchAll(/\bmoedelo_[a-z_]+/g)) expect(names).toContain(m[0]);
    expect(a.instructions).toMatch(/152-FZ/);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.MOEDELO_API_KEY ? describe : describe.skip;
live('moedelo adapter: live reads', () => {
  const env = { MOEDELO_API_KEY: process.env.MOEDELO_API_KEY! };
  beforeAll(() => mockedAxios.mockImplementation((cfg: unknown) => (mockedAxios.__actual as any).request(cfg)));
  it.each([
    ['moedelo_list_kontragents', { pageSize: 2 }],
    ['moedelo_list_bills', { pageSize: 2 }],
    ['moedelo_list_goods', { pageSize: 2 }],
    ['moedelo_list_settlement_accounts', {}],
  ] as Array<[string, Record<string, unknown>]>)('%s answers', async (name, args) => {
    const res = await execute(name, env, args);
    expect(res).toBeDefined();
  }, 30000);
});
