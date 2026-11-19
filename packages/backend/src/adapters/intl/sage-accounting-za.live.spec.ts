import axios from 'axios';
import * as adapter from './sage-accounting-za.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applyEnvDefaults, applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Sage Business Cloud Accounting, South African edition (API 2.0.0).
 *
 * Static checks always run: HTTP Basic with the Sage login, the `apikey`
 * query parameter on every call, the `CompanyId` parameter (from the call or
 * from the connector's default company), every tool's method and path against
 * the published specification, the OData paging options, the report and Save
 * bodies, and that nothing deletes or records a payment.
 * https://accounting.sageone.co.za/api/2.0.0/Help
 * https://accounting.sageone.co.za/marketing/developerprogram.aspx
 *
 * Live checks run only with RUN_SAGE_ACCOUNTING_ZA_LIVE=1 and the SAGE_ZA_*
 * variables set. They read the company list and one page of customers. Reads
 * only; a wrong password counts towards Sage's failed sign-in limit, so the
 * live block makes no call without credentials.
 *
 *   RUN_SAGE_ACCOUNTING_ZA_LIVE=1 SAGE_ZA_USERNAME=... SAGE_ZA_PASSWORD=... SAGE_ZA_API_KEY=... \
 *     npx jest src/adapters/intl/sage-accounting-za.live.spec.ts
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
  envDefaults?: Record<string, string>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
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
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> }>;
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
  for (const param of Object.keys(m.envDefaults ?? {})) out.add(param);
  return out;
};

const HOST = 'https://accounting.sageone.co.za';
const BASE = `${HOST}/api/2.0.0`;
const ENV: Record<string, string> = {
  SAGE_ZA_API_HOST: HOST,
  SAGE_ZA_USERNAME: 'books@example.co.za',
  SAGE_ZA_PASSWORD: 'test-password-123',
  SAGE_ZA_API_KEY: '39478ac6-ac2a-44d8-a31c-7e7e14af4de3',
};
const WITH_COMPANY: Record<string, string> = { ...ENV, SAGE_ZA_COMPANY_ID: '4711' };

const call = (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  const tokens = { getAccessToken: jest.fn() } as unknown as OAuth2TokenService;
  const withEnvDefaults = applyEnvDefaults(tool(name).endpointMapping, params, env);
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, withEnvDefaults), ...env },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200) => mockedAxios.mockResolvedValueOnce({ status, data: {}, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// Method and path of every tool, as published in the API specification.
const P = 'sage_accounting_za_';
const OPERATIONS: Record<string, [string, string]> = {
  list_companies: ['GET', '/Company/Get'],
  list_customers: ['GET', '/Customer/Get'],
  get_customer: ['GET', '/Customer/Get/{id}'],
  list_suppliers: ['GET', '/Supplier/Get'],
  get_supplier: ['GET', '/Supplier/Get/{id}'],
  list_items: ['GET', '/Item/Get'],
  get_item: ['GET', '/Item/Get/{id}'],
  list_tax_invoices: ['GET', '/TaxInvoice/Get'],
  get_tax_invoice: ['GET', '/TaxInvoice/Get/{id}'],
  list_quotes: ['GET', '/Quote/Get'],
  get_quote: ['GET', '/Quote/Get/{id}'],
  list_supplier_invoices: ['GET', '/SupplierInvoice/Get'],
  get_supplier_invoice: ['GET', '/SupplierInvoice/Get/{id}'],
  list_accounts: ['GET', '/Account/Get'],
  list_account_categories: ['GET', '/AccountCategory/Get'],
  list_tax_types: ['GET', '/TaxType/Get'],
  list_bank_accounts: ['GET', '/BankAccount/Get'],
  list_bank_transactions: ['GET', '/BankTransaction/Get'],
  list_customer_receipts: ['GET', '/CustomerReceipt/Get'],
  get_customer_ageing: ['POST', '/CustomerAgeing/GetDetail'],
  get_supplier_ageing: ['POST', '/SupplierAgeing/GetDetail'],
  list_outstanding_customer_documents: ['POST', '/OutstandingCustomerDocument/Get'],
  get_profit_and_loss: ['POST', '/ProfitAndLoss/Get'],
  get_balance_sheet: ['POST', '/BalanceSheet/Get'],
  get_account_balances: ['POST', '/AccountBalance/Get'],
  save_customer: ['POST', '/Customer/Save'],
  save_supplier: ['POST', '/Supplier/Save'],
  save_item: ['POST', '/Item/Save'],
  save_account: ['POST', '/Account/Save'],
  calculate_quote: ['POST', '/Quote/Calculate'],
  save_quote: ['POST', '/Quote/Save'],
  calculate_tax_invoice: ['POST', '/TaxInvoice/Calculate'],
  save_tax_invoice: ['POST', '/TaxInvoice/Save'],
};
const WRITES = ['save_customer', 'save_supplier', 'save_item', 'save_account', 'save_quote', 'save_tax_invoice'];

describe('sage-accounting-za adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with HTTP Basic on the South African API, version 2.0.0', () => {
    expect(a.slug).toBe('sage-accounting-za');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('accounting');
    expect(a.icon).toBe('sage-accounting-za');
    expect(a.aliases).toContain('Sage One');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{SAGE_ZA_API_HOST}}/api/2.0.0');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{SAGE_ZA_USERNAME}}', password: '{{SAGE_ZA_PASSWORD}}' });
    // Sage answers 415 without a Content-Type, also on a GET.
    expect(a.connector.headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(a.requiredEnvVars).toEqual(['SAGE_ZA_API_HOST', 'SAGE_ZA_USERNAME', 'SAGE_ZA_PASSWORD', 'SAGE_ZA_API_KEY']);
    expect(a.optionalEnvVars).toEqual(['SAGE_ZA_COMPANY_ID']);
  });

  it('describes every variable: a host choice, secrets, and patterns that accept real values', () => {
    const host = a.envVarMeta.SAGE_ZA_API_HOST;
    expect(host.secret).toBeUndefined();
    expect(host.options!.map((o) => o.value)).toEqual([HOST, 'https://resellers.accounting.sageone.co.za']);
    expect(a.envVarMeta.SAGE_ZA_PASSWORD).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.SAGE_ZA_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.SAGE_ZA_COMPANY_ID.secret).toBeUndefined();
    const key = new RegExp(a.envVarMeta.SAGE_ZA_API_KEY.pattern!);
    for (const good of [ENV.SAGE_ZA_API_KEY, '{39478AC6-AC2A-44D8-A31C-7E7E14AF4DE3}']) expect(key.test(good)).toBe(true);
    for (const bad of ['', 'apikey=39478ac6', '39478ac6-ac2a-44d8-a31c-7e7e14af4de3 ']) expect(key.test(bad)).toBe(false);
    expect(new RegExp(a.envVarMeta.SAGE_ZA_USERNAME.pattern!).test(ENV.SAGE_ZA_USERNAME)).toBe(true);
    // A colon would break the Basic credentials.
    expect(new RegExp(a.envVarMeta.SAGE_ZA_USERNAME.pattern!).test('user:name@example.co.za')).toBe(false);
    const company = new RegExp(a.envVarMeta.SAGE_ZA_COMPANY_ID.pattern!);
    expect(company.test('4711')).toBe(true);
    expect(company.test('CompanyId=4711')).toBe(false);
  });

  it('probes the company list and explains the refusals', () => {
    expect(a.probe).toEqual({ tool: 'sage_accounting_za_list_companies', params: { top: 1 } });
    for (const key of ['401', '402', '403', '404', '405', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/24 hours/);
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
    for (const name of mine) expect(name).toMatch(/^sage_accounting_za_[a-z0-9_]+$/);
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

  it('sends the API key on every call and the company on every call but the company list', () => {
    for (const entry of a.tools) {
      const m = entry.endpointMapping;
      expect(m.queryParams!.apikey).toBe('{{SAGE_ZA_API_KEY}}');
      if (entry.name === 'sage_accounting_za_list_companies') {
        expect(m.queryParams!.CompanyId).toBeUndefined();
        expect(m.envDefaults).toBeUndefined();
      } else {
        expect(m.queryParams!.CompanyId).toBe('$company_id');
        expect(m.envDefaults).toEqual({ company_id: 'SAGE_ZA_COMPANY_ID' });
        expect(entry.parameters.required ?? []).not.toContain('company_id');
      }
    }
  });

  it('marks reads read-only, switches nothing off, and neither deletes nor records money', () => {
    for (const entry of a.tools) {
      const write = WRITES.includes(entry.name.slice(P.length));
      expect(annotationsOf(entry).readOnlyHint).toBe(!write);
      expect(entry.enabled).not.toBe(false);
      const path = entry.endpointMapping.path;
      expect(entry.endpointMapping.method).not.toBe('DELETE');
      expect(path).not.toMatch(/Delete|Email|Batch/);
      // Receipts, payments, bank transactions and allocations are read or left out.
      if (/Receipt|Payment|BankTransaction|Allocation|JournalEntry/.test(path)) expect(entry.endpointMapping.method).toBe('GET');
    }
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists companies with Basic credentials and the API key, without a company', async () => {
    ok();
    await call('sage_accounting_za_list_companies', { top: 1 });
    const req = sent();
    expect(req.url).toBe(`${BASE}/Company/Get`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.auth).toEqual({ username: ENV.SAGE_ZA_USERNAME, password: ENV.SAGE_ZA_PASSWORD });
    expect(header(req, 'Content-Type')).toBe('application/json');
    expect(req.params).toEqual({ apikey: ENV.SAGE_ZA_API_KEY, $top: 1 });
  });

  it('uses the reseller site when that host is chosen', async () => {
    ok();
    await call('sage_accounting_za_list_companies', {}, { ...ENV, SAGE_ZA_API_HOST: 'https://resellers.accounting.sageone.co.za' });
    expect(sent().url).toBe('https://resellers.accounting.sageone.co.za/api/2.0.0/Company/Get');
  });

  it('takes the company from the call, or from the default company of the connector', async () => {
    ok();
    await call('sage_accounting_za_list_customers', { company_id: 99, filter: 'Active eq true', skip: 100 });
    expect(sent().url).toBe(`${BASE}/Customer/Get`);
    expect(sent().params).toEqual({
      apikey: ENV.SAGE_ZA_API_KEY,
      CompanyId: 99,
      $filter: 'Active eq true',
      $top: 100,
      $skip: 100,
    });

    ok();
    await call('sage_accounting_za_list_customers', {}, WITH_COMPANY);
    expect(sent().params).toEqual({ apikey: ENV.SAGE_ZA_API_KEY, CompanyId: '4711', $top: 100 });

    ok();
    await call('sage_accounting_za_list_customers', { company_id: 99 }, WITH_COMPANY);
    expect(sent().params.CompanyId).toBe(99);
  });

  it('reads documents, bank transactions and receipts on the documented paths', async () => {
    ok();
    await call('sage_accounting_za_get_tax_invoice', { id: 5501 }, WITH_COMPANY);
    expect(sent().url).toBe(`${BASE}/TaxInvoice/Get/5501`);
    expect(sent().params).toEqual({ apikey: ENV.SAGE_ZA_API_KEY, CompanyId: '4711' });

    ok();
    await call('sage_accounting_za_list_tax_invoices', { include_detail: true, orderby: 'Date desc', top: 20 }, WITH_COMPANY);
    expect(sent().url).toBe(`${BASE}/TaxInvoice/Get`);
    expect(sent().params).toEqual({
      apikey: ENV.SAGE_ZA_API_KEY,
      CompanyId: '4711',
      includeDetail: true,
      $orderby: 'Date desc',
      $top: 20,
    });

    ok();
    await call('sage_accounting_za_list_bank_transactions', { filter: 'BankAccountId eq 321' }, WITH_COMPANY);
    expect(sent().url).toBe(`${BASE}/BankTransaction/Get`);
    expect(sent().params.$filter).toBe('BankAccountId eq 321');

    ok();
    await call('sage_accounting_za_list_customer_receipts', { include_customer_details: true }, WITH_COMPANY);
    expect(sent().url).toBe(`${BASE}/CustomerReceipt/Get`);
    expect(sent().params.includeCustomerDetails).toBe(true);
  });

  it('posts the report request models', async () => {
    ok();
    await call('sage_accounting_za_get_customer_ageing', { to_date: '2026-10-31', customer_id: 12, top: 50 }, WITH_COMPANY);
    expect(sent().url).toBe(`${BASE}/CustomerAgeing/GetDetail`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().params).toEqual({ apikey: ENV.SAGE_ZA_API_KEY, CompanyId: '4711', $top: 50 });
    expect(sent().data).toEqual({
      ToDate: '2026-10-31',
      CustomerId: 12,
      ExcludeZeroBalance: true,
      IncludeActive: true,
      IncludeInactive: false,
    });

    ok();
    await call('sage_accounting_za_get_profit_and_loss', { from_date: '2026-03-01', to_date: '2026-10-31', comparative: true }, WITH_COMPANY);
    expect(sent().url).toBe(`${BASE}/ProfitAndLoss/Get`);
    expect(sent().data).toEqual({ FromDate: '2026-03-01', ToDate: '2026-10-31', Comparative: true });

    ok();
    await call('sage_accounting_za_get_balance_sheet', { run_at_date: '2026-10-31' }, WITH_COMPANY);
    expect(sent().url).toBe(`${BASE}/BalanceSheet/Get`);
    expect(sent().data).toEqual({ RunAtDate: '2026-10-31' });
  });

  it('builds the Save bodies: named fields win, extra fields are merged, new records are active', async () => {
    ok(201);
    await call(
      'sage_accounting_za_save_customer',
      {
        name: 'Karoo Trading',
        email: 'accounts@karoo.example',
        category: { ID: 12 },
        extra_fields: { PostalAddress01: '12 Long Street', Name: 'ignored', CreditLimit: 5000 },
      },
      WITH_COMPANY,
    );
    expect(sent().url).toBe(`${BASE}/Customer/Save`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().params).toEqual({ apikey: ENV.SAGE_ZA_API_KEY, CompanyId: '4711' });
    expect(sent().data).toEqual({
      Name: 'Karoo Trading',
      Email: 'accounts@karoo.example',
      Category: { ID: 12 },
      Active: true,
      PostalAddress01: '12 Long Street',
      CreditLimit: 5000,
    });

    ok(201);
    await call('sage_accounting_za_save_account', { name: 'Courier costs', category: { ID: 5 }, default_tax_type_id: 3 }, WITH_COMPANY);
    expect(sent().url).toBe(`${BASE}/Account/Save`);
    expect(sent().data).toEqual({ Name: 'Courier costs', Category: { ID: 5 }, DefaultTaxTypeId: 3, Active: true });

    ok(201);
    await call('sage_accounting_za_save_item', { id: 77, code: 'CONS-1', description: 'Consulting hour', price_exclusive: 950 }, WITH_COMPANY);
    expect(sent().data).toEqual({
      ID: 77,
      Code: 'CONS-1',
      Description: 'Consulting hour',
      PriceExclusive: 950,
      Physical: false,
      Active: true,
    });
  });

  it('saves a tax invoice with its lines and lets Sage number it', async () => {
    const lines = [{ SelectionId: 501, LineType: 0, Description: 'Consulting', Quantity: 2, UnitPriceExclusive: 950, TaxTypeId: 3 }];
    ok(201);
    await call(
      'sage_accounting_za_save_tax_invoice',
      { customer_id: 12, date: '2026-11-19', due_date: '2026-12-19', reference: 'PO-88', lines },
      WITH_COMPANY,
    );
    expect(sent().url).toBe(`${BASE}/TaxInvoice/Save`);
    expect(sent().params).toEqual({ apikey: ENV.SAGE_ZA_API_KEY, CompanyId: '4711', useSystemDocumentNumber: true });
    expect(sent().data).toEqual({ CustomerId: 12, Date: '2026-11-19', DueDate: '2026-12-19', Reference: 'PO-88', Lines: lines });

    ok();
    await call('sage_accounting_za_calculate_quote', { customer_id: 12, date: '2026-11-19', expiry_date: '2026-12-19', lines }, WITH_COMPANY);
    expect(sent().url).toBe(`${BASE}/Quote/Calculate`);
    expect(sent().params).toEqual({ apikey: ENV.SAGE_ZA_API_KEY, CompanyId: '4711' });
    expect(sent().data).toEqual({ CustomerId: 12, Date: '2026-11-19', ExpiryDate: '2026-12-19', Lines: lines });
  });
});

// Opt-in: RUN_SAGE_ACCOUNTING_ZA_LIVE=1 with SAGE_ZA_USERNAME, SAGE_ZA_PASSWORD
// and SAGE_ZA_API_KEY (SAGE_ZA_API_HOST and SAGE_ZA_COMPANY_ID optional).
// Nothing is written, and no call is made without credentials.
const live = process.env.RUN_SAGE_ACCOUNTING_ZA_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Sage Accounting (South Africa): live', () => {
  const host = process.env.SAGE_ZA_API_HOST || HOST;
  const credentials = () => {
    const username = process.env.SAGE_ZA_USERNAME;
    const password = process.env.SAGE_ZA_PASSWORD;
    const apikey = process.env.SAGE_ZA_API_KEY;
    if (!username || !password || !apikey) {
      throw new Error('Set SAGE_ZA_USERNAME, SAGE_ZA_PASSWORD and SAGE_ZA_API_KEY for the live check');
    }
    return { auth: { username, password }, apikey };
  };
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };

  it('publishes the API specification', async () => {
    const response = await liveFetch.get(`${HOST}/api/2.0.0/Help`, { validateStatus: () => true });
    expect(response.status).toBe(200);
    expect(String(response.data)).toContain('TaxInvoice/Get');
  });

  it('reads the company list and one page of customers', async () => {
    const { auth, apikey } = credentials();
    const companies = await liveFetch.get(`${host}/api/2.0.0/Company/Get`, {
      auth,
      headers,
      params: { apikey, $top: 5 },
      validateStatus: () => true,
    });
    expect(companies.status).toBe(200);
    expect(Array.isArray(companies.data.Results)).toBe(true);
    const companyId = process.env.SAGE_ZA_COMPANY_ID || companies.data.Results[0]?.ID;
    if (!companyId) return;
    const customers = await liveFetch.get(`${host}/api/2.0.0/Customer/Get`, {
      auth,
      headers,
      params: { apikey, CompanyId: companyId, $top: 5 },
      validateStatus: () => true,
    });
    expect(customers.status).toBe(200);
    expect(typeof customers.data.TotalResults).toBe('number');
  });
});
