import axios from 'axios';
import * as adapter from './zoho-books.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { ResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Zoho Books adapter:
 *
 *   1. Static: always runs. Pins the Zoho OAuth endpoints on the configurable
 *      data-center sign-in server (offline access, consent prompt, the
 *      `Zoho-oauthtoken` header), the API host, organization_id on every call
 *      but the organization list, every tool's method and URL, the create
 *      bodies, the errorWhen rule for a non-zero `code`, and which tools are
 *      read-only, destructive or switched off.
 *
 *   2. Live: skipped unless ZOHO_BOOKS_ACCESS_TOKEN and
 *      ZOHO_BOOKS_ORGANIZATION_ID are set. ZOHO_BOOKS_API_URL defaults to the
 *      EU host (https://www.zohoapis.eu):
 *
 *        ZOHO_BOOKS_ACCESS_TOKEN=1000.abc... ZOHO_BOOKS_ORGANIZATION_ID=20012345678 \
 *          npx jest src/adapters/intl/zoho-books.live.spec.ts
 *
 *      Reads organizations, contacts, items, invoices, estimates, customer
 *      payments, bills, expenses, the chart of accounts with one account's
 *      transactions, bank accounts and transactions, and taxes.
 *
 *      ZOHO_BOOKS_LIVE_WRITE=1 (use a test organization) adds round-trips on
 *      "AnythingMCP test" records, each cleaned up in `finally`: a customer
 *      (created, read, updated, deleted), an item (created, updated, made
 *      inactive), an invoice (created, marked sent, paid with a recorded
 *      customer payment that is deleted again, voided, deleted), an estimate,
 *      and a vendor with a bill and an expense. With ZOHO_BOOKS_TEST_EMAIL the
 *      invoice is also emailed to that address.
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
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
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

const ORG = '20012345678';
const EU = 'https://www.zohoapis.eu';
const BASE = `${EU}/books/v3`;
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params,
// and the OAuth2 token sent with the adapter's prefix.
const execute = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue(token) } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  ).execute(
    {
      baseUrl: config.baseUrl,
      authType: 'OAUTH2',
      authConfig: { tokenPrefix: a.connector.authConfig.tokenPrefix },
      headers: config.headers,
      errorWhen: a.connector.config.errorWhen,
    },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const ENV = { ZOHO_BOOKS_API_URL: EU, ZOHO_BOOKS_ORGANIZATION_ID: ORG };
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, 'test-token', params);
const sent = () => mockedAxios.mock.calls[0][0];

describe('zoho-books adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
    expect(a.prerequisites).toMatch(/free plan|trial/);
  });

  it('signs in at the chosen data center with offline access and sends Zoho-oauthtoken', async () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{ZOHO_BOOKS_CLIENT_ID}}',
      clientSecret: '{{ZOHO_BOOKS_CLIENT_SECRET}}',
      authorizationUrl: '{{ZOHO_BOOKS_ACCOUNTS_URL}}/oauth/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: '{{ZOHO_BOOKS_ACCOUNTS_URL}}/oauth/v2/token',
      scopes: expect.stringContaining('ZohoBooks.invoices.ALL'),
      tokenPrefix: 'Zoho-oauthtoken',
    });
    // Zoho documents client_secret_post; the engine's default for the code grant.
    expect(a.connector.authConfig.tokenAuthMethod).toBeUndefined();
    for (const scope of ['ZohoBooks.settings.ALL', 'ZohoBooks.contacts.ALL', 'ZohoBooks.accountants.READ', 'ZohoBooks.banking.READ']) {
      expect(a.connector.authConfig.scopes.split(',')).toContain(scope);
    }
    expect(a.instructions).toContain(a.connector.authConfig.scopes);
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    mockedAxios.mockResolvedValue({ data: { code: 0 } });
    await call('zoho_books_list_organizations', {});
    expect(sent().headers.Authorization).toBe('Zoho-oauthtoken test-token');
  });

  it('validates the data-center hosts and the organization id', () => {
    expect(a.requiredEnvVars).toEqual(['ZOHO_BOOKS_CLIENT_ID', 'ZOHO_BOOKS_CLIENT_SECRET', 'ZOHO_BOOKS_ORGANIZATION_ID', 'ZOHO_BOOKS_ACCOUNTS_URL', 'ZOHO_BOOKS_API_URL']);
    expect(a.connector.baseUrl).toBe('{{ZOHO_BOOKS_API_URL}}/books/v3');
    const accounts = new RegExp(a.envVarMeta.ZOHO_BOOKS_ACCOUNTS_URL.pattern!);
    for (const ok of ['https://accounts.zoho.eu', 'https://accounts.zoho.com', 'https://accounts.zoho.in', 'https://accounts.zoho.com.au', 'https://accounts.zohocloud.ca']) {
      expect(accounts.test(ok)).toBe(true);
    }
    expect(accounts.test('https://accounts.zoho.eu/')).toBe(false);
    expect(accounts.test('https://accounts.zoho.eu.evil.example')).toBe(false);
    const api = new RegExp(a.envVarMeta.ZOHO_BOOKS_API_URL.pattern!);
    for (const ok of [EU, 'https://www.zohoapis.com', 'https://www.zohoapis.in', 'https://www.zohoapis.ca', 'https://www.zohoapis.com.au']) {
      expect(api.test(ok)).toBe(true);
    }
    expect(api.test(`${EU}/books/v3`)).toBe(false);
    expect(new RegExp(a.envVarMeta.ZOHO_BOOKS_ORGANIZATION_ID.pattern!).test(ORG)).toBe(true);
    expect(new RegExp(a.envVarMeta.ZOHO_BOOKS_CLIENT_ID.pattern!).test('1000.ABCDEF123')).toBe(true);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'ZOHO_BOOKS_CLIENT_SECRET')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'ZOHO_BOOKS_API_URL')!.kind).toBe('address');
  });

  it('probes with the organization and health-checks the organization list', () => {
    expect(a.probe.tool).toBe('zoho_books_get_organization');
    expect(tool('zoho_books_get_organization').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/organizations');
  });

  it('sends organization_id on every call except the organization list', () => {
    for (const t of a.tools) {
      const org = t.endpointMapping.queryParams?.organization_id;
      expect(`${t.name}:${org}`).toBe(`${t.name}:${t.name === 'zoho_books_list_organizations' ? undefined : '{{ZOHO_BOOKS_ORGANIZATION_ID}}'}`);
    }
  });

  it('prefixes every tool with zoho_books_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^zoho_books_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only, voiding destructive, and installs deletes switched off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(a.tools.filter((t) => t.endpointMapping.method === 'GET').map((t) => t.name).sort());
    expect(readOnly.length).toBe(24);
    const ann = annotationsOf(tool('zoho_books_void_invoice'));
    expect(`${ann.destructiveHint}:${ann.idempotentHint}`).toBe('true:false');
    expect(tool('zoho_books_void_invoice').description).toMatch(/confirm/i);
    expect(tool('zoho_books_email_invoice').description).toMatch(/confirm/i);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([
      'zoho_books_delete_bill',
      'zoho_books_delete_contact',
      'zoho_books_delete_customer_payment',
      'zoho_books_delete_estimate',
      'zoho_books_delete_expense',
      'zoho_books_delete_invoice',
    ]);
    for (const t of a.tools.filter((x) => x.enabled === false)) expect(annotationsOf(t).destructiveHint).toBe(true);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bzoho_books_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bzoho_books_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['zoho_books_list_organizations', {}, 'GET', '/organizations'],
    ['zoho_books_get_organization', {}, 'GET', `/organizations/${ORG}`],
    ['zoho_books_list_contacts', {}, 'GET', '/contacts'],
    ['zoho_books_get_contact', { contact_id: '1' }, 'GET', '/contacts/1'],
    ['zoho_books_create_contact', { contact_name: 'Acme' }, 'POST', '/contacts'],
    ['zoho_books_update_contact', { contact_id: '1', contact_name: 'Acme', contact_type: 'customer' }, 'PUT', '/contacts/1'],
    ['zoho_books_mark_contact_inactive', { contact_id: '1' }, 'POST', '/contacts/1/inactive'],
    ['zoho_books_delete_contact', { contact_id: '1' }, 'DELETE', '/contacts/1'],
    ['zoho_books_list_items', {}, 'GET', '/items'],
    ['zoho_books_get_item', { item_id: '2' }, 'GET', '/items/2'],
    ['zoho_books_create_item', { name: 'Widget', rate: 10 }, 'POST', '/items'],
    ['zoho_books_update_item', { item_id: '2', name: 'Widget', rate: 12 }, 'PUT', '/items/2'],
    ['zoho_books_mark_item_inactive', { item_id: '2' }, 'POST', '/items/2/inactive'],
    ['zoho_books_list_invoices', {}, 'GET', '/invoices'],
    ['zoho_books_get_invoice', { invoice_id: '3' }, 'GET', '/invoices/3'],
    ['zoho_books_create_invoice', { customer_id: '1', line_items: [] }, 'POST', '/invoices'],
    ['zoho_books_email_invoice', { invoice_id: '3', to_mail_ids: ['a@example.com'] }, 'POST', '/invoices/3/email'],
    ['zoho_books_mark_invoice_sent', { invoice_id: '3' }, 'POST', '/invoices/3/status/sent'],
    ['zoho_books_void_invoice', { invoice_id: '3' }, 'POST', '/invoices/3/status/void'],
    ['zoho_books_delete_invoice', { invoice_id: '3' }, 'DELETE', '/invoices/3'],
    ['zoho_books_list_estimates', {}, 'GET', '/estimates'],
    ['zoho_books_get_estimate', { estimate_id: '4' }, 'GET', '/estimates/4'],
    ['zoho_books_create_estimate', { customer_id: '1', line_items: [] }, 'POST', '/estimates'],
    ['zoho_books_delete_estimate', { estimate_id: '4' }, 'DELETE', '/estimates/4'],
    ['zoho_books_list_customer_payments', {}, 'GET', '/customerpayments'],
    ['zoho_books_get_customer_payment', { payment_id: '5' }, 'GET', '/customerpayments/5'],
    ['zoho_books_create_customer_payment', { customer_id: '1', amount: 10, date: '2026-10-10', payment_mode: 'cash', invoices: [] }, 'POST', '/customerpayments'],
    ['zoho_books_delete_customer_payment', { payment_id: '5' }, 'DELETE', '/customerpayments/5'],
    ['zoho_books_list_bills', {}, 'GET', '/bills'],
    ['zoho_books_get_bill', { bill_id: '6' }, 'GET', '/bills/6'],
    ['zoho_books_create_bill', { vendor_id: '7', bill_number: 'B-1', line_items: [] }, 'POST', '/bills'],
    ['zoho_books_delete_bill', { bill_id: '6' }, 'DELETE', '/bills/6'],
    ['zoho_books_list_expenses', {}, 'GET', '/expenses'],
    ['zoho_books_get_expense', { expense_id: '8' }, 'GET', '/expenses/8'],
    ['zoho_books_create_expense', { account_id: '9', paid_through_account_id: '10', date: '2026-10-10', amount: 5 }, 'POST', '/expenses'],
    ['zoho_books_delete_expense', { expense_id: '8' }, 'DELETE', '/expenses/8'],
    ['zoho_books_list_chart_of_accounts', {}, 'GET', '/chartofaccounts'],
    ['zoho_books_get_account', { account_id: '9' }, 'GET', '/chartofaccounts/9'],
    ['zoho_books_list_account_transactions', { account_id: '9' }, 'GET', '/chartofaccounts/accounttransactions'],
    ['zoho_books_list_bank_accounts', {}, 'GET', '/bankaccounts'],
    ['zoho_books_get_bank_account', { account_id: '10' }, 'GET', '/bankaccounts/10'],
    ['zoho_books_list_bank_transactions', {}, 'GET', '/banktransactions'],
    ['zoho_books_get_bank_transaction', { bank_transaction_id: '11' }, 'GET', '/banktransactions/11'],
    ['zoho_books_list_taxes', {}, 'GET', '/settings/taxes'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: { code: 0 } });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url: `${BASE}${path}`, headers: expect.objectContaining({ Authorization: 'Zoho-oauthtoken test-token' }) }),
    );
    if (name !== 'zoho_books_list_organizations') expect(sent().params.organization_id).toBe(ORG);
  });

  it('creates an invoice with the send flag in the query and the fields in the body', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 0 } });
    const lines = [{ item_id: '2', quantity: 1, rate: 12 }];
    await call('zoho_books_create_invoice', { customer_id: '1', line_items: lines, due_date: '2026-11-01', reference_number: 'PO-7' });
    expect(sent().params).toEqual({ organization_id: ORG, send: false });
    expect(sent().data).toEqual({ customer_id: '1', line_items: lines, due_date: '2026-11-01', reference_number: 'PO-7' });
  });

  it('records a customer payment applied to invoices', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 0 } });
    const invoices = [{ invoice_id: '3', amount_applied: 12 }];
    await call('zoho_books_create_customer_payment', { customer_id: '1', amount: 12, date: '2026-10-10', payment_mode: 'banktransfer', invoices });
    expect(sent().data).toEqual({ customer_id: '1', amount: 12, date: '2026-10-10', payment_mode: 'banktransfer', invoices });
  });

  it('pages lists with page and per_page and passes filters through', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 0 } });
    await call('zoho_books_list_invoices', { status: 'overdue', customer_id: '1', page: 2, per_page: 50 });
    expect(sent().params).toEqual({ organization_id: ORG, status: 'overdue', customer_id: '1', page: 2, per_page: 50 });
  });

  it('turns a non-zero code in a 200 answer into an error and passes code 0 through', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 1002, message: 'Invoice does not exist.' } });
    await expect(call('zoho_books_get_invoice', { invoice_id: '3' })).rejects.toBeInstanceOf(ResponseBodyError);
    mockedAxios.mockResolvedValue({ data: { code: 0, message: 'success', invoice: { invoice_id: '3' } } });
    await expect(call('zoho_books_get_invoice', { invoice_id: '3' })).resolves.toEqual({ code: 0, message: 'success', invoice: { invoice_id: '3' } });
  });
});

const TOKEN = process.env.ZOHO_BOOKS_ACCESS_TOKEN;
const LIVE_ORG = process.env.ZOHO_BOOKS_ORGANIZATION_ID;
const live = TOKEN && LIVE_ORG ? describe : describe.skip;

live('zoho-books adapter: live API', () => {
  const env = { ZOHO_BOOKS_API_URL: process.env.ZOHO_BOOKS_API_URL || EU, ZOHO_BOOKS_ORGANIZATION_ID: LIVE_ORG as string };
  const write = process.env.ZOHO_BOOKS_LIVE_WRITE === '1';
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, TOKEN as string, params);
  const today = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  it('reads the organization, contacts, items and sales documents', async () => {
    const orgs = await run('zoho_books_list_organizations');
    expect(orgs.organizations.map((o: { organization_id: string }) => o.organization_id)).toContain(LIVE_ORG);
    const org = await run('zoho_books_get_organization');
    expect(org.organization.organization_id).toBe(LIVE_ORG);
    for (const [list, key, get, idKey, param] of [
      ['zoho_books_list_contacts', 'contacts', 'zoho_books_get_contact', 'contact_id', 'contact_id'],
      ['zoho_books_list_items', 'items', 'zoho_books_get_item', 'item_id', 'item_id'],
      ['zoho_books_list_invoices', 'invoices', 'zoho_books_get_invoice', 'invoice_id', 'invoice_id'],
      ['zoho_books_list_estimates', 'estimates', 'zoho_books_get_estimate', 'estimate_id', 'estimate_id'],
      ['zoho_books_list_customer_payments', 'customer_payments', 'zoho_books_get_customer_payment', 'payment_id', 'payment_id'],
      ['zoho_books_list_bills', 'bills', 'zoho_books_get_bill', 'bill_id', 'bill_id'],
      ['zoho_books_list_expenses', 'expenses', 'zoho_books_get_expense', 'expense_id', 'expense_id'],
    ]) {
      const page = await run(list, { per_page: 5 });
      expect(Array.isArray(page[key])).toBe(true);
      if (page[key].length) {
        const one = await run(get, { [param]: page[key][0][idKey] });
        expect(one.code).toBe(0);
      }
    }
  }, 120_000);

  it('reads the chart of accounts, an account ledger, banking and taxes', async () => {
    const accounts = await run('zoho_books_list_chart_of_accounts', { showbalance: true });
    expect(accounts.chartofaccounts.length).toBeGreaterThan(0);
    const first = accounts.chartofaccounts[0];
    const one = await run('zoho_books_get_account', { account_id: first.account_id });
    expect(one.account_id ?? one.chart_of_account?.account_id).toBe(first.account_id);
    const ledger = await run('zoho_books_list_account_transactions', { account_id: first.account_id, per_page: 5 });
    expect(ledger.code).toBe(0);
    const banks = await run('zoho_books_list_bank_accounts');
    if (banks.bankaccounts?.length) {
      const bank = await run('zoho_books_get_bank_account', { account_id: banks.bankaccounts[0].account_id });
      expect(bank.code).toBe(0);
    }
    const txs = await run('zoho_books_list_bank_transactions', { per_page: 5 });
    if (txs.banktransactions?.length) {
      const tx = await run('zoho_books_get_bank_transaction', { bank_transaction_id: txs.banktransactions[0].transaction_id });
      expect(tx.code).toBe(0);
    }
    const taxes = await run('zoho_books_list_taxes');
    expect(taxes.code).toBe(0);
  }, 90_000);

  (write ? it : it.skip)('runs a customer, item, invoice, payment and estimate round-trip and cleans up', async () => {
    const customer = (
      await run('zoho_books_create_contact', {
        contact_name: `AnythingMCP test ${stamp}`,
        contact_type: 'customer',
        contact_persons: [{ first_name: 'AnythingMCP', last_name: 'Test', email: 'anythingmcp-test@example.com', is_primary_contact: true }],
        notes: 'Created by the AnythingMCP live spec; safe to delete.',
      })
    ).contact;
    let itemId: string | undefined;
    try {
      const read = await run('zoho_books_get_contact', { contact_id: customer.contact_id });
      expect(read.contact.contact_name).toBe(customer.contact_name);
      await run('zoho_books_update_contact', { contact_id: customer.contact_id, contact_name: customer.contact_name, contact_type: 'customer', notes: 'Updated by the live spec' });
      const found = await run('zoho_books_list_contacts', { search_text: customer.contact_name });
      expect(found.contacts.map((c: { contact_id: string }) => c.contact_id)).toContain(customer.contact_id);

      const item = (await run('zoho_books_create_item', { name: `AnythingMCP test item ${stamp}`, rate: 10, product_type: 'service' })).item;
      itemId = item.item_id;
      expect((await run('zoho_books_get_item', { item_id: item.item_id })).item.rate).toBe(10);
      await run('zoho_books_update_item', { item_id: item.item_id, name: item.name, rate: 12 });

      const invoice = (await run('zoho_books_create_invoice', { customer_id: customer.contact_id, line_items: [{ item_id: item.item_id, quantity: 1, rate: 12 }], reference_number: 'AnythingMCP test' })).invoice;
      try {
        expect((await run('zoho_books_get_invoice', { invoice_id: invoice.invoice_id })).invoice.status).toBe('draft');
        await run('zoho_books_mark_invoice_sent', { invoice_id: invoice.invoice_id });
        if (process.env.ZOHO_BOOKS_TEST_EMAIL) {
          await run('zoho_books_email_invoice', { invoice_id: invoice.invoice_id, to_mail_ids: [process.env.ZOHO_BOOKS_TEST_EMAIL], subject: 'AnythingMCP live spec' });
        }
        const listed = await run('zoho_books_list_invoices', { customer_id: customer.contact_id });
        expect(listed.invoices.map((i: { invoice_id: string }) => i.invoice_id)).toContain(invoice.invoice_id);
        const payment = (
          await run('zoho_books_create_customer_payment', {
            customer_id: customer.contact_id, amount: invoice.total, date: today, payment_mode: 'cash',
            invoices: [{ invoice_id: invoice.invoice_id, amount_applied: invoice.total }], reference_number: 'AnythingMCP test',
          })
        ).payment;
        try {
          expect((await run('zoho_books_get_customer_payment', { payment_id: payment.payment_id })).payment.amount).toBe(invoice.total);
        } finally {
          await run('zoho_books_delete_customer_payment', { payment_id: payment.payment_id });
        }
        await run('zoho_books_void_invoice', { invoice_id: invoice.invoice_id });
        expect((await run('zoho_books_get_invoice', { invoice_id: invoice.invoice_id })).invoice.status).toBe('void');
      } finally {
        await run('zoho_books_delete_invoice', { invoice_id: invoice.invoice_id });
      }

      const estimate = (await run('zoho_books_create_estimate', { customer_id: customer.contact_id, line_items: [{ item_id: item.item_id, quantity: 2, rate: 12 }], reference_number: 'AnythingMCP test' })).estimate;
      try {
        expect((await run('zoho_books_get_estimate', { estimate_id: estimate.estimate_id })).estimate.customer_id).toBe(customer.contact_id);
      } finally {
        await run('zoho_books_delete_estimate', { estimate_id: estimate.estimate_id });
      }
    } finally {
      try {
        if (itemId) await run('zoho_books_mark_item_inactive', { item_id: itemId });
      } finally {
        await run('zoho_books_delete_contact', { contact_id: customer.contact_id });
      }
    }
  }, 240_000);

  (write ? it : it.skip)('records a bill and an expense for a test vendor and deletes them', async () => {
    const chart = await run('zoho_books_list_chart_of_accounts', { filter_by: 'AccountType.Expense' });
    const expenseAccount = chart.chartofaccounts.find((x: { account_type: string }) => x.account_type === 'expense') ?? chart.chartofaccounts[0];
    const all = await run('zoho_books_list_chart_of_accounts', { filter_by: 'AccountType.Active' });
    const paidThrough = all.chartofaccounts.find((x: { account_type: string }) => x.account_type === 'cash' || x.account_type === 'bank');
    expect(paidThrough).toBeDefined();
    const vendor = (await run('zoho_books_create_contact', { contact_name: `AnythingMCP test vendor ${stamp}`, contact_type: 'vendor' })).contact;
    try {
      const bill = (
        await run('zoho_books_create_bill', {
          vendor_id: vendor.contact_id, bill_number: `AMCP-${stamp}`, date: today,
          line_items: [{ account_id: expenseAccount.account_id, description: 'AnythingMCP test line', quantity: 1, rate: 5 }],
        })
      ).bill;
      try {
        expect((await run('zoho_books_get_bill', { bill_id: bill.bill_id })).bill.vendor_id).toBe(vendor.contact_id);
      } finally {
        await run('zoho_books_delete_bill', { bill_id: bill.bill_id });
      }
      const expense = (
        await run('zoho_books_create_expense', {
          account_id: expenseAccount.account_id, paid_through_account_id: paidThrough.account_id, date: today, amount: 3,
          description: 'AnythingMCP live spec', vendor_id: vendor.contact_id,
        })
      ).expense;
      try {
        expect((await run('zoho_books_get_expense', { expense_id: expense.expense_id })).expense.total).toBe(3);
      } finally {
        await run('zoho_books_delete_expense', { expense_id: expense.expense_id });
      }
    } finally {
      await run('zoho_books_delete_contact', { contact_id: vendor.contact_id });
    }
  }, 180_000);
});
