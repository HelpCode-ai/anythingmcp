import axios from 'axios';
import * as adapter from './reeleezee.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Reeleezee REST API adapter (Exact Reeleezee, OData v4, API v1).
 *
 * Static checks always run: HTTP Basic with the Reeleezee login, the headers
 * of Reeleezee's own sample clients (Prefer: return=representation), every
 * tool's method and path against the published help page, the administration
 * id in the path of every scoped call, the OData options, the period
 * parameters of the financial reports and the PUT bodies of the three writes.
 * Nothing deletes, books, sends or pays.
 * https://portal.reeleezee.nl/api/v1/Help
 *
 * Live checks run only with RUN_REELEEZEE_LIVE=1. Without credentials they
 * confirm the API refuses an anonymous call; with REELEEZEE_USERNAME and
 * REELEEZEE_PASSWORD they read the administrations and one page of customers.
 * Reads only, one call at a time (Reeleezee allows no parallel calls per login).
 *
 *   RUN_REELEEZEE_LIVE=1 REELEEZEE_USERNAME=... REELEEZEE_PASSWORD=... \
 *     npx jest src/adapters/nl/reeleezee.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
  headers?: Record<string, string>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; pattern?: string }>; required?: string[] };
  endpointMapping: Mapping;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  aliases: string[];
  instructions: string;
  instructionFacts: string[];
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const BASE = 'https://portal.reeleezee.nl/api/v1';
const ENV: Record<string, string> = {
  REELEEZEE_USERNAME: 'boekhouding',
  REELEEZEE_PASSWORD: 'test-password-123',
};
const ADMIN = '7f9c2a34-5b1d-4e8a-9c0f-2d6a1b3e4f50';
const CUSTOMER = '0b5d7c1e-3f1a-4a7e-9c55-2f6f0d1c8a11';
const INVOICE = 'c2a1e0d4-6b7f-4c3a-8e21-9a0b1c2d3e4f';
const PERIOD_1 = '11111111-2222-4333-8444-555555555555';
const PERIOD_2 = '66666666-7777-4888-9999-000000000000';

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn() } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200) => mockedAxios.mockResolvedValueOnce({ status, data: {}, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// Method and path of every tool, as listed on the API help page ({adminId} variants).
const P = 'reeleezee_';
const A = '/{administration_id}';
const OPERATIONS: Record<string, [string, string]> = {
  list_administrations: ['GET', '/Administrations'],
  get_administration: ['GET', '/Administrations/{administration_id}'],
  list_periods: ['GET', `${A}/Periods`],
  list_ledger_accounts: ['GET', `${A}/Ledgers`],
  get_ledger_account: ['GET', `${A}/Ledgers/{ledger_id}`],
  get_column_balance: ['GET', `${A}/Financials/ColumnBalances`],
  get_balance_sheet: ['GET', `${A}/Financials/Balances`],
  get_profit_and_loss: ['GET', `${A}/Financials/ProfitAndLosses`],
  get_ledger_balance: ['GET', `${A}/Financials/LedgerBalances/{ledger_id}`],
  list_journal_entry_lines: ['GET', `${A}/JournalEntryLines`],
  list_sales_invoices: ['GET', `${A}/SalesInvoices`],
  get_sales_invoice: ['GET', `${A}/SalesInvoices/{invoice_id}`],
  list_sales_invoice_lines: ['GET', `${A}/SalesInvoices/{invoice_id}/Lines`],
  list_offerings: ['GET', `${A}/Offerings`],
  get_offering: ['GET', `${A}/Offerings/{offering_id}`],
  list_offering_lines: ['GET', `${A}/Offerings/{offering_id}/Lines`],
  list_purchase_invoices: ['GET', `${A}/PurchaseInvoices`],
  get_purchase_invoice: ['GET', `${A}/PurchaseInvoices/{invoice_id}`],
  list_purchase_invoice_lines: ['GET', `${A}/PurchaseInvoices/{invoice_id}/Lines`],
  list_customers: ['GET', `${A}/Customers`],
  get_customer: ['GET', `${A}/Customers/{customer_id}`],
  list_vendors: ['GET', `${A}/Vendors`],
  get_vendor: ['GET', `${A}/Vendors/{vendor_id}`],
  list_products: ['GET', `${A}/Products`],
  list_tax_rates: ['GET', `${A}/TaxRates`],
  list_payment_accounts: ['GET', `${A}/PaymentAccounts`],
  list_bank_statements: ['GET', `${A}/BankStatements`],
  list_bank_transactions: ['GET', `${A}/PaymentTransactions`],
  save_customer: ['PUT', `${A}/Customers/{customer_id}`],
  save_customer_address: ['PUT', `${A}/Customers/{customer_id}/Addresses/{address_id}`],
  save_sales_invoice_draft: ['PUT', `${A}/SalesInvoices/{invoice_id}`],
};
const WRITES = ['save_customer', 'save_customer_address', 'save_sales_invoice_draft'];

describe('reeleezee adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with HTTP Basic at portal.reeleezee.nl and asks for the saved record back', () => {
    expect(a.slug).toBe('reeleezee');
    expect(a.region).toBe('nl');
    expect(a.category).toBe('accounting');
    expect(a.icon).toBe('reeleezee');
    expect(a.aliases).toContain('Exact Reeleezee');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{REELEEZEE_USERNAME}}', password: '{{REELEEZEE_PASSWORD}}' });
    expect(a.connector.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      Prefer: 'return=representation',
    });
    expect(a.requiredEnvVars).toEqual(['REELEEZEE_USERNAME', 'REELEEZEE_PASSWORD']);
    expect(a.optionalEnvVars).toEqual(['REELEEZEE_ADMINISTRATION_ID']);
    expect(a.envVarMeta.REELEEZEE_PASSWORD).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.REELEEZEE_ADMINISTRATION_ID.secret).toBeUndefined();
    expect(new RegExp(a.envVarMeta.REELEEZEE_USERNAME.pattern!).test(ENV.REELEEZEE_USERNAME)).toBe(true);
    expect(new RegExp(a.envVarMeta.REELEEZEE_USERNAME.pattern!).test('user@example.nl')).toBe(true);
    // A colon would break the Basic credentials.
    expect(new RegExp(a.envVarMeta.REELEEZEE_USERNAME.pattern!).test('user:name')).toBe(false);
    expect(new RegExp(a.envVarMeta.REELEEZEE_ADMINISTRATION_ID.pattern!).test(ADMIN)).toBe(true);
    expect(new RegExp(a.envVarMeta.REELEEZEE_ADMINISTRATION_ID.pattern!).test('12345')).toBe(false);
  });

  it('tells the model the default administration only through a fact, never through a secret', () => {
    expect(a.instructionFacts).toHaveLength(1);
    expect(a.instructionFacts[0]).toContain('{{REELEEZEE_ADMINISTRATION_ID}}');
    expect(a.instructionFacts[0]).not.toContain('PASSWORD');
  });

  it('probes the administration list and explains the refusals', () => {
    expect(a.probe).toEqual({ tool: 'reeleezee_list_administrations', params: { top: 1, select: 'id,Name' } });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('has exactly the published operations, each on its documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(OPERATIONS).map((name) => P + name).sort());
    for (const [name, [method, path]] of Object.entries(OPERATIONS)) {
      expect(tool(P + name).endpointMapping.method).toBe(method);
      expect(tool(P + name).endpointMapping.path).toBe(path);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^reeleezee_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('requires the administration id, as a GUID, on every call but the administration list', () => {
    for (const entry of a.tools) {
      if (entry.name === 'reeleezee_list_administrations') {
        expect(entry.parameters.properties!.administration_id).toBeUndefined();
        continue;
      }
      expect(entry.endpointMapping.path).toContain('{administration_id}');
      expect(entry.parameters.required).toContain('administration_id');
      const pattern = new RegExp(entry.parameters.properties!.administration_id.pattern!);
      expect(pattern.test(ADMIN)).toBe(true);
      expect(pattern.test(ADMIN.toUpperCase())).toBe(true);
      expect(pattern.test('my-administration')).toBe(false);
      // Every path parameter is required: a missing one would be sent as text.
      for (const [, p] of entry.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(entry.parameters.required).toContain(p);
    }
  });

  it('marks reads read-only, switches nothing off, and neither deletes, books nor pays', () => {
    for (const entry of a.tools) {
      const write = WRITES.includes(entry.name.slice(P.length));
      expect(entry.endpointMapping.method).toBe(write ? 'PUT' : 'GET');
      expect(annotationsOf(entry).readOnlyHint).toBe(!write);
      expect(entry.enabled).not.toBe(false);
      const path = entry.endpointMapping.path;
      expect(path).not.toMatch(/Actions|Download|Uploads|Exports|CreditTransfers|DirectDebits|Remittances/);
      // Bank data is read only.
      if (/Payment|Bank/.test(path)) expect(entry.endpointMapping.method).toBe('GET');
    }
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists administrations with Basic credentials and the sample-client headers', async () => {
    ok();
    await call('reeleezee_list_administrations', { top: 1, select: 'id,Name' });
    const req = sent();
    expect(req.url).toBe(`${BASE}/Administrations`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.auth).toEqual({ username: ENV.REELEEZEE_USERNAME, password: ENV.REELEEZEE_PASSWORD });
    expect(header(req, 'Accept')).toBe('application/json');
    expect(header(req, 'Prefer')).toBe('return=representation');
    expect(req.params).toEqual({ $top: 1, $select: 'id,Name' });
  });

  it('reads inside one administration with OData options and a page of 50 by default', async () => {
    ok();
    await call('reeleezee_list_sales_invoices', {
      administration_id: ADMIN,
      search: 'Jansen',
      filter: 'Date ge 2026-01-01T00:00:00Z',
      orderby: 'Date desc',
      skip: 50,
    });
    expect(sent().url).toBe(`${BASE}/${ADMIN}/SalesInvoices`);
    expect(sent().params).toEqual({
      search: 'Jansen',
      $filter: 'Date ge 2026-01-01T00:00:00Z',
      $orderby: 'Date desc',
      $top: 50,
      $skip: 50,
    });

    ok();
    await call('reeleezee_list_customers', { administration_id: ADMIN, include_archived: true, top: 10 });
    expect(sent().url).toBe(`${BASE}/${ADMIN}/Customers`);
    expect(sent().params).toEqual({ includeArchived: true, $top: 10 });

    ok();
    await call('reeleezee_list_sales_invoice_lines', { administration_id: ADMIN, invoice_id: INVOICE });
    expect(sent().url).toBe(`${BASE}/${ADMIN}/SalesInvoices/${INVOICE}/Lines`);

    ok();
    await call('reeleezee_list_bank_transactions', { administration_id: ADMIN, search: 'NL91ABNA' });
    expect(sent().url).toBe(`${BASE}/${ADMIN}/PaymentTransactions`);
    expect(sent().params).toEqual({ search: 'NL91ABNA', $top: 50 });

    ok();
    await call('reeleezee_get_administration', { administration_id: ADMIN });
    expect(sent().url).toBe(`${BASE}/Administrations/${ADMIN}`);
  });

  it('passes period ids to the financial reports', async () => {
    ok();
    await call('reeleezee_get_column_balance', { administration_id: ADMIN, start_period: PERIOD_1, end_period: PERIOD_2 });
    expect(sent().url).toBe(`${BASE}/${ADMIN}/Financials/ColumnBalances`);
    expect(sent().params).toEqual({ startPeriod: PERIOD_1, endPeriod: PERIOD_2 });

    ok();
    await call('reeleezee_get_ledger_balance', { administration_id: ADMIN, ledger_id: CUSTOMER, start_period: PERIOD_1 });
    expect(sent().url).toBe(`${BASE}/${ADMIN}/Financials/LedgerBalances/${CUSTOMER}`);
    expect(sent().params).toEqual({ startPeriod: PERIOD_1 });

    ok();
    await call('reeleezee_get_profit_and_loss', { administration_id: ADMIN });
    expect(sent().url).toBe(`${BASE}/${ADMIN}/Financials/ProfitAndLosses`);
    expect(sent().params ?? {}).toEqual({});
  });

  it('creates a customer and its address with PUT on a GUID the caller chooses', async () => {
    const channels = [{ id: PERIOD_1, CommunicationType: 10, FormattedValue: 'info@example.nl' }];
    ok();
    await call('reeleezee_save_customer', {
      administration_id: ADMIN,
      customer_id: CUSTOMER,
      name: 'Bakkerij Jansen B.V.',
      search_name: 'Jansen',
      due_days: 30,
      communication_channels: channels,
      extra_fields: { ChamberOfCommerceCity: 'Utrecht', Name: 'ignored' },
    });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/${ADMIN}/Customers/${CUSTOMER}`);
    expect(header(sent(), 'Content-Type')).toBe('application/json; charset=utf-8');
    expect(sent().data).toEqual({
      id: CUSTOMER,
      EntityKind: 1,
      Name: 'Bakkerij Jansen B.V.',
      SearchName: 'Jansen',
      DueDays: 30,
      CommunicationChannelList: channels,
      ChamberOfCommerceCity: 'Utrecht',
    });

    ok();
    await call('reeleezee_save_customer_address', {
      administration_id: ADMIN,
      customer_id: CUSTOMER,
      address_id: PERIOD_2,
      street: 'Oudegracht',
      number: '12',
      postcode: '3511 AB',
      city: 'Utrecht',
    });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/${ADMIN}/Customers/${CUSTOMER}/Addresses/${PERIOD_2}`);
    expect(sent().data).toEqual({ id: PERIOD_2, Type: 2, Street: 'Oudegracht', Number: '12', Postcode: '3511 AB', City: 'Utrecht' });
  });

  it('writes a sales invoice as a tentative draft with its lines', async () => {
    const lines = [{ Description: 'Advies oktober', Quantity: 4, Price: 95, TaxRate: { id: PERIOD_1 } }];
    ok();
    await call('reeleezee_save_sales_invoice_draft', {
      administration_id: ADMIN,
      invoice_id: INVOICE,
      customer_id: CUSTOMER,
      date: '2026-11-19',
      reference: 'PO-88',
      lines,
    });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/${ADMIN}/SalesInvoices/${INVOICE}`);
    expect(sent().data).toEqual({
      id: INVOICE,
      Status: 1,
      Type: 1,
      DocumentType: 10,
      Origin: 2,
      Entity: { id: CUSTOMER },
      Date: '2026-11-19',
      Reference: 'PO-88',
      DocumentLineList: lines,
    });
  });
});

// Opt-in: RUN_REELEEZEE_LIVE=1. The refusal check needs no account; the reads
// need REELEEZEE_USERNAME and REELEEZEE_PASSWORD. Nothing is written.
const live = process.env.RUN_REELEEZEE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Reeleezee: live', () => {
  const headers = { Accept: 'application/json', 'Accept-Language': 'en' };

  it('refuses an anonymous call and publishes its help page', async () => {
    const anonymous = await liveFetch.get(`${BASE}/Administrations`, { headers, validateStatus: () => true });
    expect(anonymous.status).toBe(401);
    const help = await liveFetch.get(`${BASE}/Help`, { validateStatus: () => true });
    expect(help.status).toBe(200);
    expect(String(help.data)).toContain('SalesInvoices');
  });

  it('reads the administrations and one page of customers', async () => {
    const username = process.env.REELEEZEE_USERNAME;
    const password = process.env.REELEEZEE_PASSWORD;
    if (!username || !password) throw new Error('Set REELEEZEE_USERNAME and REELEEZEE_PASSWORD for the live check');
    const auth = { username, password };
    const administrations = await liveFetch.get(`${BASE}/Administrations`, {
      auth,
      headers,
      params: { $top: 5, $select: 'id,Name' },
      validateStatus: () => true,
    });
    expect(administrations.status).toBe(200);
    expect(Array.isArray(administrations.data.value)).toBe(true);
    const administrationId = process.env.REELEEZEE_ADMINISTRATION_ID || administrations.data.value[0]?.id;
    if (!administrationId) return;
    const customers = await liveFetch.get(`${BASE}/${administrationId}/Customers`, {
      auth,
      headers,
      params: { $top: 5 },
      validateStatus: () => true,
    });
    expect(customers.status).toBe(200);
    expect(Array.isArray(customers.data.value)).toBe(true);
  });
});
