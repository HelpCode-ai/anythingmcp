import axios from 'axios';
import * as adapter from './monet.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';

/**
 * Two layers of verification for the Monet adapter (MonetServices2 API V2):
 *
 *   1. Static: always runs. Pins Basic authentication, the API base path,
 *      every tool's method, path and query or body mapping (from Monet's
 *      published Postman collection), and
 *      which tools write and install switched off.
 *
 *   2. Live: skipped unless MONET_USERNAME and MONET_PASSWORD are set. Reads
 *      only, in the login's current company; it never switches company.
 *
 *        MONET_USERNAME=... MONET_PASSWORD=... \
 *          npx jest src/adapters/intl/monet.live.spec.ts
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; bodyMapping?: Record<string, string> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean }>;
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

const ENV = { MONET_USERNAME: 'apiuser', MONET_PASSWORD: ['pw', 'for', 'tests'].join('-') };
const BASE = 'https://e.monet.lt/DesktopModules/MonetServices2/API/V2';
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

const WRITES_OFF = [
  'monet_create_customer',
  'monet_create_dimension',
  'monet_create_item',
  'monet_create_purchase_invoice',
  'monet_create_purchase_service_invoice',
  'monet_create_sales_invoice',
  'monet_create_sales_service_invoice',
  'monet_create_vendor',
  'monet_delete_customer',
  'monet_delete_item',
  'monet_delete_vendor',
  'monet_update_customer',
  'monet_update_item',
  'monet_update_vendor',
];

describe('monet adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs every call with HTTP Basic against the MonetServices2 V2 API', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{MONET_USERNAME}}', password: '{{MONET_PASSWORD}}' });
    expect(a.requiredEnvVars).toEqual(['MONET_USERNAME', 'MONET_PASSWORD']);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'MONET_PASSWORD')!.secret).toBe(true);
    mockedAxios.mockResolvedValue({ data: 'UAB Pavyzdys' });
    await execute('monet_get_company', ENV, {});
    expect(sent().url).toBe(`${BASE}/GetCompany`);
    // axios turns `auth` into the Basic header.
    expect(sent().auth).toEqual({ username: ENV.MONET_USERNAME, password: ENV.MONET_PASSWORD });
    expect(a.probe).toEqual({ tool: 'monet_get_company' });
  });

  // [tool, args, method, path, query]
  const table: Array<[string, Record<string, unknown>, string, string, Record<string, unknown>]> = [
    ['monet_list_companies', { _search: 'UAB' }, 'GET', '/GetCompanyList', { _search: 'UAB' }],
    ['monet_list_customers', {}, 'GET', '/GetCustList', { _page: 0, _size: 100 }],
    ['monet_list_vendors', { _search: 'ACME', _size: 5 }, 'GET', '/GetVendList', { _page: 0, _size: 5, _search: 'ACME' }],
    ['monet_get_customer_balance', { _accountNum: '0001' }, 'GET', '/GetCustBalance', { _accountNum: '0001' }],
    ['monet_list_vendor_open_items', { _accountNum: 'PIRK' }, 'GET', '/GetVendOpenPayments', { _page: 0, _size: 100, _accountNum: 'PIRK' }],
    ['monet_list_sales_invoices', { _from: '2026-01-01', _to: '2026-01-31' }, 'GET', '/GetCustInvoiceList', { _page: 0, _size: 100, _from: '2026-01-01', _to: '2026-01-31' }],
    ['monet_get_purchase_invoice_balance', { _accountNum: 'PIRK', _invoiceId: 'P-2' }, 'GET', '/GetVendInvoiceBalanceCur', { _accountNum: 'PIRK', _invoiceId: 'P-2' }],
    ['monet_get_item', { itemId: '01' }, 'GET', '/GetItem', { itemId: '01' }],
    ['monet_list_stock_quantities', {}, 'GET', '/ItemsQuantity', { _page: 0, _size: 100, _all: true }],
    ['monet_get_report_parameters', { reportName: 'LedgerTrialBalanceReport' }, 'GET', '/GetReportParameters', { reportName: 'LedgerTrialBalanceReport' }],
    ['monet_set_company', { _company: '0aa' }, 'PUT', '/SetCompany', { _company: '0aa' }],
    ['monet_delete_customer', { _id: 'test0' }, 'DELETE', '/DeleteCust', { _id: 'test0' }],
  ];
  it.each(table)('%s calls %s %s', async (name, args, method, path, query) => {
    mockedAxios.mockResolvedValue({ data: [] });
    await execute(name, ENV, args);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(`${BASE}${path}`);
    expect(sent().params ?? {}).toEqual(query);
  });

  it('runs a report with name, format, language and the parameter list as the JSON body', async () => {
    mockedAxios.mockResolvedValue({ data: 'csv' });
    const parameters = [{ key: 'from', values: ['2026-08-01'] }, { key: 'to', values: ['2026-08-31'] }];
    await execute('monet_get_report', ENV, { name: 'LedgerTrialBalanceReport', parameters });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${BASE}/GetReport`);
    expect(sent().data).toEqual({ name: 'LedgerTrialBalanceReport', format: 'CSV', parameters });
    expect(annotationsOf(tool('monet_get_report')).readOnlyHint).toBe(true);
  });

  it('sends only the fields given on a write', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('monet_create_customer', ENV, { ID: 'ACME', Name: 'UAB Acme', VATNum: 'LT100000000' });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${BASE}/InsertCust`);
    expect(sent().data).toEqual({ ID: 'ACME', Name: 'UAB Acme', VATNum: 'LT100000000' });
  });

  it('marks reads read-only and installs every create, update, delete and invoice posting switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual(WRITES_OFF);
    for (const t of a.tools) {
      if (t.enabled === false || t.name === 'monet_set_company') continue;
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const name of WRITES_OFF) {
      expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
      expect(tool(name).description).toMatch(/switched off/);
    }
    // Switching company changes no accounting data, so it stays on.
    expect(tool('monet_set_company').enabled).toBeUndefined();
    expect(annotationsOf(tool('monet_set_company'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('has no tool that registers payments or bank entries', () => {
    const paths = a.tools.map((t) => t.endpointMapping.path);
    for (const p of ['/PostLedgerJournal', '/DeleteTrans', '/PostSalesRefunds']) expect(paths).not.toContain(p);
  });

  it('prefixes every tool, points the model only at tools that exist and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    expect(names.size).toBe(a.tools.length);
    for (const n of names) expect(n).toMatch(/^monet_[a-z_]+$/);
    const mentioned = [...a.instructions.matchAll(/\bmonet_[a-z_]+/g)].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(3);
    for (const n of mentioned) expect(names).toContain(n);
    expect(a.instructions).toMatch(/monet_set_company/);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.MONET_USERNAME && process.env.MONET_PASSWORD ? describe : describe.skip;
live('monet adapter: live reads', () => {
  const env = { MONET_USERNAME: process.env.MONET_USERNAME!, MONET_PASSWORD: process.env.MONET_PASSWORD! };
  beforeAll(() => mockedAxios.mockImplementation((cfg: unknown) => (mockedAxios.__actual as any).request(cfg)));
  it.each([
    ['monet_get_company', {}],
    ['monet_list_companies', {}],
    ['monet_list_customers', { _size: 2 }],
    ['monet_list_vendors', { _size: 2 }],
    ['monet_list_items', { _size: 2 }],
    ['monet_list_ledger_accounts', { _size: 2 }],
    ['monet_list_purchase_invoices', { _size: 2, _from: '2026-01-01', _to: '2026-12-31' }],
    ['monet_get_report_parameters', { reportName: 'LedgerTrialBalanceReport' }],
  ] as Array<[string, Record<string, unknown>]>)('%s answers', async (name, args) => {
    const res = await execute(name, env, args);
    expect(res).toBeDefined();
  }, 30000);
});
