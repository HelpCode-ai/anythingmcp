import axios from 'axios';
import * as adapter from './quickbooks-online.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { ResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the QuickBooks Online adapter:
 *
 *   1. Static: always runs. Pins Intuit's OAuth endpoints with HTTP Basic
 *      client authentication at the token endpoint, the base URL built from
 *      the environment (production or sandbox) and the realm id, minorversion
 *      75 on every call, the query endpoint, the create and sparse-update
 *      bodies, the errorWhen rule for a Fault in a 200 answer, and which tools
 *      install switched off (send invoice, delete invoice).
 *
 *   2. Live: skipped unless QBO_ACCESS_TOKEN and QBO_REALM_ID are set. An
 *      access token of a sandbox company (Intuit's OAuth 2.0 Playground gives
 *      one, valid for an hour); QBO_SANDBOX=1 points at the sandbox host:
 *
 *        QBO_ACCESS_TOKEN=eyJ... QBO_REALM_ID=9341... QBO_SANDBOX=1 \
 *          npx jest src/adapters/intl/quickbooks-online.live.spec.ts
 *
 *      With QBO_LIVE_WRITE=1 as well (sandbox only), a customer
 *      "AnythingMCP test <time>" and an invoice for it are created and read
 *      back; in `finally` the invoice is deleted and the customer made
 *      inactive (QuickBooks cannot delete customers). Nothing is emailed.
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
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown };
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

const REALM = '9341453050071234';
const SANDBOX = 'https://sandbox-quickbooks.api.intuit.com';
const BASE = `${SANDBOX}/v3/company/${REALM}`;
const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
// The base URL as ConnectorsService resolves it; env vars also reach the
// tool's params, which is how `{QBO_REALM_ID}` in a path is filled.
const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl.replace('{{QBO_API_URL}}', SANDBOX).replace('{{QBO_REALM_ID}}', REALM),
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
  errorWhen: a.connector.config.errorWhen,
});
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping, {
    ...applySchemaDefaults(tool(name).parameters, params),
    QBO_REALM_ID: REALM,
  });
const sent = () => mockedAxios.mock.calls[0][0];

describe('quickbooks-online adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified live', () => {
    expect(a.unlisted).toBe(true);
    expect(a.prerequisites).toMatch(/sandbox/);
  });

  it("signs in at Intuit with HTTP Basic client authentication and the accounting scope", () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{QBO_CLIENT_ID}}',
      clientSecret: '{{QBO_CLIENT_SECRET}}',
      authorizationUrl: 'https://appcenter.intuit.com/connect/oauth2',
      tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      tokenAuthMethod: 'client_secret_basic',
      scopes: 'com.intuit.quickbooks.accounting',
    });
    // The callback stores the (rotating) refresh token; there is no variable for it.
    expect(a.connector.authConfig.refreshToken).toBeUndefined();
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/about every 24 hours/);
  });

  it('builds the base URL from the environment and the realm id, both validated', () => {
    expect(a.requiredEnvVars).toEqual(['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REALM_ID', 'QBO_API_URL']);
    expect(a.connector.baseUrl).toBe('{{QBO_API_URL}}/v3/company/{{QBO_REALM_ID}}');
    const env = new RegExp(a.envVarMeta.QBO_API_URL.pattern!);
    expect(env.test('https://quickbooks.api.intuit.com')).toBe(true);
    expect(env.test(SANDBOX)).toBe(true);
    expect(env.test(`${SANDBOX}/`)).toBe(false);
    expect(env.test('https://evil.example')).toBe(false);
    const realm = new RegExp(a.envVarMeta.QBO_REALM_ID.pattern!);
    expect(realm.test(REALM)).toBe(true);
    expect(realm.test('9341 4530 5007 1234')).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'QBO_API_URL')!.kind).toBe('address');
    expect(described.find((d) => d.name === 'QBO_CLIENT_SECRET')!.secret).toBe(true);
  });

  it('probes with company info and health-checks without a templated path', () => {
    expect(a.probe.tool).toBe('qbo_get_company_info');
    expect(tool('qbo_get_company_info').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/preferences?minorversion=75');
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
  });

  it('prefixes every tool with qbo_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^qbo_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('sends minorversion 75 on every call', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.queryParams?.minorversion}`).toBe(`${t.name}:75`);
  });

  it('installs send and delete switched off, and keeps invoice and customer creation on', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(['qbo_delete_invoice', 'qbo_send_invoice']);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `qbo_send_invoice`/);
    expect(a.instructions).toMatch(/no drafts/);
    expect(annotationsOf(tool('qbo_delete_invoice')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('qbo_update_customer')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('qbo_create_invoice')).destructiveHint).toBe(false);
  });

  it('marks queries, records and reports read-only', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'qbo_get_bill',
      'qbo_get_company_info',
      'qbo_get_customer',
      'qbo_get_invoice',
      'qbo_get_item',
      'qbo_get_payment',
      'qbo_get_vendor',
      'qbo_query',
      'qbo_report_aged_payables',
      'qbo_report_aged_receivables',
      'qbo_report_balance_sheet',
      'qbo_report_profit_and_loss',
    ]);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bqbo_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bqbo_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['qbo_get_company_info', {}, 'GET', `/companyinfo/${REALM}`],
    ['qbo_query', { query: 'select * from Customer' }, 'GET', '/query'],
    ['qbo_get_customer', { id: '58' }, 'GET', '/customer/58'],
    ['qbo_get_invoice', { id: '130' }, 'GET', '/invoice/130'],
    ['qbo_get_item', { id: '1' }, 'GET', '/item/1'],
    ['qbo_get_vendor', { id: '41' }, 'GET', '/vendor/41'],
    ['qbo_get_bill', { id: '25' }, 'GET', '/bill/25'],
    ['qbo_get_payment', { id: '7' }, 'GET', '/payment/7'],
    ['qbo_create_customer', { display_name: 'Acme' }, 'POST', '/customer'],
    ['qbo_update_customer', { id: '58', sync_token: '0' }, 'POST', '/customer'],
    ['qbo_create_invoice', { customer_id: '58', lines: [] }, 'POST', '/invoice'],
    ['qbo_send_invoice', { id: '130' }, 'POST', '/invoice/130/send'],
    ['qbo_delete_invoice', { id: '130', sync_token: '2' }, 'POST', '/invoice'],
    ['qbo_report_profit_and_loss', {}, 'GET', '/reports/ProfitAndLoss'],
    ['qbo_report_balance_sheet', {}, 'GET', '/reports/BalanceSheet'],
    ['qbo_report_aged_receivables', {}, 'GET', '/reports/AgedReceivables'],
    ['qbo_report_aged_payables', {}, 'GET', '/reports/AgedPayables'],
  ])('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url: `${BASE}${path}`,
        headers: expect.objectContaining({ Authorization: 'Bearer test-token', Accept: 'application/json' }),
      }),
    );
  });

  it('passes the query text through as one parameter', async () => {
    mockedAxios.mockResolvedValue({ data: { QueryResponse: {} } });
    const query = "select * from Invoice where Balance > '0' and CustomerRef = '58' orderby DueDate startposition 1 maxresults 100";
    await call('qbo_query', { query });
    expect(sent().params).toEqual({ query, minorversion: '75' });
    expect(sent().paramsSerializer({ query: "DisplayName LIKE '%Acme%'" })).toBe("query=DisplayName+LIKE+'%25Acme%25'");
  });

  it('creates a customer with the given fields and merges additional ones', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('qbo_create_customer', {
      display_name: 'Acme GmbH',
      primary_email_addr: { Address: 'billing@acme.example' },
      additional_fields: { CurrencyRef: { value: 'EUR' }, DisplayName: 'ignored' },
    });
    expect(sent().data).toEqual({
      DisplayName: 'Acme GmbH',
      PrimaryEmailAddr: { Address: 'billing@acme.example' },
      CurrencyRef: { value: 'EUR' },
    });
  });

  it('sends a sparse customer update and can make a customer inactive', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('qbo_update_customer', { id: '58', sync_token: '3', active: false });
    expect(sent().data).toEqual({ Id: '58', SyncToken: '3', sparse: true, Active: false });
  });

  it('creates an invoice with the customer reference and the lines as given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const lines = [{ DetailType: 'SalesItemLineDetail', Amount: 200, SalesItemLineDetail: { ItemRef: { value: '1' }, Qty: 2, UnitPrice: 100 } }];
    await call('qbo_create_invoice', { customer_id: '58', lines, due_date: '2026-11-01', additional_fields: { CustomerMemo: { value: 'Thanks' } } });
    expect(sent().data).toEqual({ CustomerRef: { value: '58' }, Line: lines, DueDate: '2026-11-01', CustomerMemo: { value: 'Thanks' } });
  });

  it('sends an invoice with an empty octet-stream body, and deletes with operation=delete', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('qbo_send_invoice', { id: '130', send_to: 'ana@example.com' });
    expect(sent().headers['Content-Type']).toBe('application/octet-stream');
    expect(sent().data).toBe('');
    expect(sent().params).toEqual({ sendTo: 'ana@example.com', minorversion: '75' });
    mockedAxios.mockClear();
    await call('qbo_delete_invoice', { id: '130', sync_token: '2' });
    expect(sent().params).toEqual({ operation: 'delete', minorversion: '75' });
    expect(sent().data).toEqual({ Id: '130', SyncToken: '2' });
  });

  it('passes report dates and options as Intuit names them', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('qbo_report_profit_and_loss', { start_date: '2026-01-01', end_date: '2026-09-30', accounting_method: 'Cash', summarize_column_by: 'Month' });
    expect(sent().params).toEqual({
      start_date: '2026-01-01',
      end_date: '2026-09-30',
      accounting_method: 'Cash',
      summarize_column_by: 'Month',
      minorversion: '75',
    });
    mockedAxios.mockClear();
    await call('qbo_report_aged_receivables', { report_date: '2026-10-10', aging_period: 15, num_periods: 6 });
    expect(sent().params).toEqual({ report_date: '2026-10-10', aging_period: 15, num_periods: 6, minorversion: '75' });
  });

  it('turns a Fault inside a 200 answer into an error with its message', async () => {
    mockedAxios.mockResolvedValue({
      data: { Fault: { Error: [{ Message: 'Duplicate Name Exists Error', Detail: 'The name supplied already exists.', code: '6240' }], type: 'ValidationFault' } },
    });
    await expect(call('qbo_create_customer', { display_name: 'Acme' })).rejects.toThrow(
      new ResponseBodyError(
        'The API answered with an error in a successful response: Duplicate Name Exists Error The name supplied already exists.',
        400,
        {},
      ).message,
    );
    mockedAxios.mockResolvedValue({ data: { QueryResponse: { Customer: [] } } });
    await expect(call('qbo_query', { query: 'select * from Customer' })).resolves.toEqual({ QueryResponse: { Customer: [] } });
  });
});

const TOKEN = process.env.QBO_ACCESS_TOKEN;
const LIVE_REALM = process.env.QBO_REALM_ID;
const live = TOKEN && LIVE_REALM ? describe : describe.skip;

live('quickbooks-online adapter: live Accounting API', () => {
  const host = process.env.QBO_SANDBOX === '1' ? SANDBOX : 'https://quickbooks.api.intuit.com';
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      {
        baseUrl: `${host}/v3/company/${LIVE_REALM}`,
        authType: 'BEARER_TOKEN',
        authConfig: { token: TOKEN as string },
        headers: a.connector.headers,
        errorWhen: a.connector.config.errorWhen,
      } as never,
      tool(name).endpointMapping,
      { ...applySchemaDefaults(tool(name).parameters, params), QBO_REALM_ID: LIVE_REALM },
    );

  it('reads the company, queries customers and items, and reads one record', async () => {
    const info = await run('qbo_get_company_info');
    expect(typeof info.CompanyInfo.CompanyName).toBe('string');
    const customers = await run('qbo_query', { query: 'select Id, DisplayName, Balance from Customer maxresults 5' });
    expect(customers.QueryResponse).toBeDefined();
    if (customers.QueryResponse.Customer?.length) {
      const one = await run('qbo_get_customer', { id: customers.QueryResponse.Customer[0].Id });
      expect(one.Customer.Id).toBe(customers.QueryResponse.Customer[0].Id);
    }
    const count = await run('qbo_query', { query: 'select count(*) from Invoice' });
    expect(typeof count.QueryResponse.totalCount).toBe('number');
    const items = await run('qbo_query', { query: "select * from Item where Type = 'Service' maxresults 3" });
    expect(items.QueryResponse).toBeDefined();
  }, 60_000);

  it('runs the four reports', async () => {
    const pl = await run('qbo_report_profit_and_loss', { date_macro: 'This Fiscal Year', summarize_column_by: 'Quarter' });
    expect(pl.Header.ReportName).toBe('ProfitAndLoss');
    const bs = await run('qbo_report_balance_sheet', { date_macro: 'This Fiscal Year' });
    expect(bs.Header.ReportName).toBe('BalanceSheet');
    const ar = await run('qbo_report_aged_receivables', {});
    expect(ar.Header).toBeDefined();
    const ap = await run('qbo_report_aged_payables', {});
    expect(ap.Header).toBeDefined();
  }, 60_000);

  it('rejects a malformed query with the Intuit error', async () => {
    await expect(run('qbo_query', { query: 'select * from Customer where OR' })).rejects.toBeDefined();
  }, 30_000);

  (process.env.QBO_LIVE_WRITE === '1' && process.env.QBO_SANDBOX === '1' ? it : it.skip)(
    'creates a test customer and invoice, reads them back, deletes the invoice and deactivates the customer',
    async () => {
      const stamp = new Date().toISOString();
      const created = await run('qbo_create_customer', {
        display_name: `AnythingMCP test ${stamp}`,
        primary_email_addr: { Address: 'anythingmcp-test@example.com' },
        notes: 'Created by the AnythingMCP live spec; safe to ignore.',
      });
      const customer = created.Customer;
      let invoice: { Id: string; SyncToken: string } | undefined;
      try {
        const items = await run('qbo_query', { query: "select * from Item where Type = 'Service' maxresults 1" });
        const item = items.QueryResponse.Item?.[0];
        if (item) {
          const res = await run('qbo_create_invoice', {
            customer_id: customer.Id,
            lines: [{ DetailType: 'SalesItemLineDetail', Amount: 20, Description: 'AnythingMCP test line', SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 2, UnitPrice: 10 } }],
            private_note: 'AnythingMCP live spec',
          });
          invoice = res.Invoice;
          const read = await run('qbo_get_invoice', { id: invoice!.Id });
          expect(read.Invoice.CustomerRef.value).toBe(customer.Id);
          expect(read.Invoice.TotalAmt).toBeGreaterThanOrEqual(20);
          invoice = read.Invoice;
        }
      } finally {
        if (invoice) await run('qbo_delete_invoice', { id: invoice.Id, sync_token: invoice.SyncToken });
        const fresh = await run('qbo_get_customer', { id: customer.Id });
        const done = await run('qbo_update_customer', { id: customer.Id, sync_token: fresh.Customer.SyncToken, active: false });
        expect(done.Customer.Active).toBe(false);
      }
    },
    120_000,
  );
});
