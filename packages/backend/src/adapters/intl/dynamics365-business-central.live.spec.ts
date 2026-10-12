import axios from 'axios';
import * as adapter from './dynamics365-business-central.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Business Central (API v2.0) adapter:
 *
 *   1. Static: always runs. Pins the Entra sign-in with the tenant in the
 *      authorize, token and API URLs, the Business Central scope, the company
 *      in every business path, deep insert of document lines, the If-Match
 *      every update and delete carries, and which tools install switched off.
 *
 *   2. Live: skipped unless BC_ACCESS_TOKEN, BC_TENANT_ID and BC_ENVIRONMENT
 *      are set (a delegated token for https://api.businesscentral.dynamics.com,
 *      e.g. from `az account get-access-token --resource
 *      https://api.businesscentral.dynamics.com`), ideally against a sandbox:
 *
 *        BC_ACCESS_TOKEN=eyJ... BC_TENANT_ID=<guid> BC_ENVIRONMENT=Sandbox \
 *          npx jest src/adapters/intl/dynamics365-business-central.live.spec.ts
 *
 *      With BC_LIVE_WRITE=1 as well, a test customer is created and updated,
 *      a sales quote with a line is created and gets a second line, and both
 *      are deleted again in `finally`. Nothing is released, shipped or posted.
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
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
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
  appRegistrationUrl: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
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

const TENANT = '11111111-2222-3333-4444-555555555555';
const ENV = 'Sandbox';
const COMPANY = 'aaaaaaaa-0000-1111-2222-bbbbbbbbbbbb';
const RECORD = 'cccccccc-3333-4444-5555-dddddddddddd';
const BASE = `https://api.businesscentral.dynamics.com/v2.0/${TENANT}/${ENV}/api/v2.0`;
// Built at run time so no token-shaped literal sits in the source.
const FAKE_TOKEN = ['unit', 'test', 'token'].join('-');

const baseFor = (tenant: string, env: string) =>
  a.connector.baseUrl.replace('{{MICROSOFT_TENANT_ID}}', tenant).replace('{{BC_ENVIRONMENT}}', env);
const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue(FAKE_TOKEN) } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
const connectorConfig = () => ({
  baseUrl: baseFor(TENANT, ENV),
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
});
// Arguments as DynamicMcpTools hands them to the engine: schema defaults filled in.
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
const sent = () => mockedAxios.mock.calls[0][0];

describe('dynamics365-business-central adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified live', () => {
    expect(a.unlisted).toBe(true);
  });

  it('says up front that it needs an Entra app and a licensed Business Central user', () => {
    expect(a.prerequisites).toMatch(/Entra/);
    expect(a.prerequisites).toMatch(/Financials\.ReadWrite\.All/);
    expect(a.prerequisites).toMatch(/sandbox/i);
    expect(a.appRegistrationUrl).toMatch(/^https:\/\/entra\.microsoft\.com\//);
  });

  it('signs in against the tenant with the Business Central scope and puts tenant and environment in the API URL', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID', 'BC_ENVIRONMENT']);
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MICROSOFT_CLIENT_ID}}',
      clientSecret: '{{MICROSOFT_CLIENT_SECRET}}',
      authorizationUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/token',
      scopes: 'https://api.businesscentral.dynamics.com/Financials.ReadWrite.All offline_access',
    });
    // One token serves one API: no Graph scope may ride along.
    expect(a.connector.authConfig.scopes).not.toMatch(/User\.Read|graph/i);
    expect(a.connector.baseUrl).toBe(
      'https://api.businesscentral.dynamics.com/v2.0/{{MICROSOFT_TENANT_ID}}/{{BC_ENVIRONMENT}}/api/v2.0',
    );
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
  });

  it('accepts a tenant GUID or domain but not common or organizations, which cannot address Business Central', () => {
    const tenant = new RegExp(a.envVarMeta.MICROSOFT_TENANT_ID.pattern!);
    expect(tenant.test(TENANT)).toBe(true);
    expect(tenant.test('contoso.onmicrosoft.com')).toBe(true);
    expect(tenant.test('common')).toBe(false);
    expect(tenant.test('organizations')).toBe(false);
    const env = new RegExp(a.envVarMeta.BC_ENVIRONMENT.pattern!);
    expect(env.test('Production')).toBe(true);
    expect(env.test('SANDBOX-TEST')).toBe(true);
    expect(env.test('https://businesscentral.dynamics.com/Sandbox')).toBe(false);
  });

  it('probes with the company list, which needs no arguments', () => {
    expect(a.probe.tool).toBe('bc_list_companies');
    expect(tool('bc_list_companies').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/companies');
  });

  it('prefixes every tool with bc_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^bc_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('scopes every business call to a company and percent-encodes ids', () => {
    for (const t of a.tools) {
      if (['bc_list_environments', 'bc_list_companies'].includes(t.name)) continue;
      expect(`${t.name}:${t.endpointMapping.path.startsWith('/companies({company_id})/')}`).toBe(`${t.name}:true`);
      expect(t.parameters.required).toContain('company_id');
      // bc_query takes a nested path whose slashes must survive.
      if (t.name !== 'bc_query') expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('installs deletes and the quote conversion switched off and marks them destructive', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual(['bc_delete_customer', 'bc_delete_sales_order', 'bc_delete_sales_quote', 'bc_make_order_from_quote']);
    for (const name of off) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
      expect(a.instructions).toContain(`\`${name}\``);
    }
  });

  it('marks every GET read-only and every write as a write', () => {
    for (const t of a.tools) {
      const readOnly = annotationsOf(t).readOnlyHint === true;
      expect(`${t.name}:${readOnly}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    }
    expect(annotationsOf(tool('bc_create_customer')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('bc_create_sales_quote')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('bc_update_customer')).destructiveHint).toBe(true);
  });

  it('asks the model to confirm every write with the user', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method !== 'GET')) {
      expect(`${t.name}: ${/confirm/i.test(t.description)}`).toBe(`${t.name}: true`);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bbc_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbc_[a-z_]+/g)]),
      ...a.tools.flatMap((t) => [...JSON.stringify(t.parameters).matchAll(/\bbc_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['bc_list_environments', {}, 'GET', 'https://api.businesscentral.dynamics.com/environments/v1.2'],
    ['bc_list_companies', {}, 'GET', `${BASE}/companies`],
    ['bc_list_customers', { company_id: COMPANY }, 'GET', `${BASE}/companies(${COMPANY})/customers`],
    ['bc_get_customer', { company_id: COMPANY, customer_id: RECORD }, 'GET', `${BASE}/companies(${COMPANY})/customers(${RECORD})`],
    ['bc_create_customer', { company_id: COMPANY, displayName: 'X' }, 'POST', `${BASE}/companies(${COMPANY})/customers`],
    ['bc_update_customer', { company_id: COMPANY, customer_id: RECORD, fields: { city: 'Freiburg' } }, 'PATCH', `${BASE}/companies(${COMPANY})/customers(${RECORD})`],
    ['bc_delete_customer', { company_id: COMPANY, customer_id: RECORD }, 'DELETE', `${BASE}/companies(${COMPANY})/customers(${RECORD})`],
    ['bc_list_vendors', { company_id: COMPANY }, 'GET', `${BASE}/companies(${COMPANY})/vendors`],
    ['bc_get_vendor', { company_id: COMPANY, vendor_id: RECORD }, 'GET', `${BASE}/companies(${COMPANY})/vendors(${RECORD})`],
    ['bc_list_items', { company_id: COMPANY }, 'GET', `${BASE}/companies(${COMPANY})/items`],
    ['bc_get_item', { company_id: COMPANY, item_id: RECORD }, 'GET', `${BASE}/companies(${COMPANY})/items(${RECORD})`],
    ['bc_list_sales_quotes', { company_id: COMPANY }, 'GET', `${BASE}/companies(${COMPANY})/salesQuotes`],
    ['bc_get_sales_quote', { company_id: COMPANY, quote_id: RECORD }, 'GET', `${BASE}/companies(${COMPANY})/salesQuotes(${RECORD})`],
    ['bc_create_sales_quote', { company_id: COMPANY, customerNumber: '10000' }, 'POST', `${BASE}/companies(${COMPANY})/salesQuotes`],
    ['bc_add_sales_quote_line', { company_id: COMPANY, quote_id: RECORD, lineObjectNumber: '1896-S', quantity: 2 }, 'POST', `${BASE}/companies(${COMPANY})/salesQuotes(${RECORD})/salesQuoteLines`],
    ['bc_make_order_from_quote', { company_id: COMPANY, quote_id: RECORD }, 'POST', `${BASE}/companies(${COMPANY})/salesQuotes(${RECORD})/Microsoft.NAV.makeOrder`],
    ['bc_delete_sales_quote', { company_id: COMPANY, quote_id: RECORD }, 'DELETE', `${BASE}/companies(${COMPANY})/salesQuotes(${RECORD})`],
    ['bc_list_sales_orders', { company_id: COMPANY }, 'GET', `${BASE}/companies(${COMPANY})/salesOrders`],
    ['bc_get_sales_order', { company_id: COMPANY, order_id: RECORD }, 'GET', `${BASE}/companies(${COMPANY})/salesOrders(${RECORD})`],
    ['bc_create_sales_order', { company_id: COMPANY, customerNumber: '10000' }, 'POST', `${BASE}/companies(${COMPANY})/salesOrders`],
    ['bc_add_sales_order_line', { company_id: COMPANY, order_id: RECORD, lineObjectNumber: '1896-S', quantity: 1 }, 'POST', `${BASE}/companies(${COMPANY})/salesOrders(${RECORD})/salesOrderLines`],
    ['bc_delete_sales_order', { company_id: COMPANY, order_id: RECORD }, 'DELETE', `${BASE}/companies(${COMPANY})/salesOrders(${RECORD})`],
    ['bc_list_sales_invoices', { company_id: COMPANY }, 'GET', `${BASE}/companies(${COMPANY})/salesInvoices`],
    ['bc_get_sales_invoice', { company_id: COMPANY, invoice_id: RECORD }, 'GET', `${BASE}/companies(${COMPANY})/salesInvoices(${RECORD})`],
    ['bc_list_purchase_invoices', { company_id: COMPANY }, 'GET', `${BASE}/companies(${COMPANY})/purchaseInvoices`],
    ['bc_get_purchase_invoice', { company_id: COMPANY, invoice_id: RECORD }, 'GET', `${BASE}/companies(${COMPANY})/purchaseInvoices(${RECORD})`],
    ['bc_list_general_ledger_entries', { company_id: COMPANY }, 'GET', `${BASE}/companies(${COMPANY})/generalLedgerEntries`],
    ['bc_list_accounts', { company_id: COMPANY }, 'GET', `${BASE}/companies(${COMPANY})/accounts`],
    ['bc_list_dimensions', { company_id: COMPANY }, 'GET', `${BASE}/companies(${COMPANY})/dimensions`],
    ['bc_list_dimension_values', { company_id: COMPANY, dimension_id: RECORD }, 'GET', `${BASE}/companies(${COMPANY})/dimensions(${RECORD})/dimensionValues`],
    ['bc_list_employees', { company_id: COMPANY }, 'GET', `${BASE}/companies(${COMPANY})/employees`],
    ['bc_query', { company_id: COMPANY, resource: `salesOrders(${RECORD})/salesOrderLines` }, 'GET', `${BASE}/companies(${COMPANY})/salesOrders(${RECORD})/salesOrderLines`],
  ])('%s sends %s to the right URL', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url,
        headers: expect.objectContaining({ Authorization: `Bearer ${FAKE_TOKEN}`, Accept: 'application/json' }),
      }),
    );
  });

  it('has a URL test for every tool', () => {
    // Keeps the table above complete as tools are added.
    expect(a.tools.length).toBe(32);
  });

  it('passes OData options through and pages with top and skip', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    await call('bc_list_customers', {
      company_id: COMPANY,
      filter: "contains(displayName,'Adatum')",
      select: 'id,number,displayName',
      orderby: 'displayName',
      skip: 50,
    });
    expect(sent().params).toEqual({
      $filter: "contains(displayName,'Adatum')",
      $select: 'id,number,displayName',
      $orderby: 'displayName',
      $top: 50,
      $skip: 50,
    });
  });

  it('creates a document with its lines in one call and reads the lines back', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const lines = [{ lineType: 'Item', lineObjectNumber: '1896-S', quantity: 3, unitPrice: 120 }];
    await call('bc_create_sales_quote', {
      company_id: COMPANY,
      customerNumber: '10000',
      externalDocumentNumber: 'PO-77',
      lines,
      fields: { validUntilDate: '2026-12-31' },
    });
    expect(sent().data).toEqual({
      customerNumber: '10000',
      externalDocumentNumber: 'PO-77',
      salesQuoteLines: lines,
      validUntilDate: '2026-12-31',
    });
    expect(sent().params).toEqual({ $expand: 'salesQuoteLines' });
    mockedAxios.mockClear();
    await call('bc_create_sales_order', { company_id: COMPANY, customerId: RECORD });
    expect(sent().data).toEqual({ customerId: RECORD });
    expect(sent().params).toEqual({ $expand: 'salesOrderLines' });
  });

  it('adds a line as an Item line unless told otherwise', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('bc_add_sales_order_line', { company_id: COMPANY, order_id: RECORD, lineObjectNumber: '1896-S', quantity: 2 });
    expect(sent().data).toEqual({ lineType: 'Item', lineObjectNumber: '1896-S', quantity: 2 });
    mockedAxios.mockClear();
    await call('bc_add_sales_quote_line', { company_id: COMPANY, quote_id: RECORD, lineType: 'Comment', description: 'Delivery in two parts' });
    expect(sent().data).toEqual({ lineType: 'Comment', description: 'Delivery in two parts' });
  });

  it('sends If-Match on updates: the etag when given, * otherwise', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('bc_update_customer', { company_id: COMPANY, customer_id: RECORD, fields: { phoneNumber: '+49 761 1' } });
    expect(sent().headers['If-Match']).toBe('*');
    expect(sent().data).toEqual({ phoneNumber: '+49 761 1' });
    mockedAxios.mockClear();
    const etag = 'W/"JzQ0O0VnQUFBQUo3QlRFQU1BQXdBREFBQUFBQUFBQUE5OzEyMzQ1Njc4OTA7Jw=="';
    await call('bc_update_customer', { company_id: COMPANY, customer_id: RECORD, fields: { city: 'Basel' }, etag });
    expect(sent().headers['If-Match']).toBe(etag);
    mockedAxios.mockClear();
    await call('bc_delete_sales_quote', { company_id: COMPANY, quote_id: RECORD });
    expect(sent().headers['If-Match']).toBe('*');
    expect(sent().data).toBeUndefined();
  });

  it('builds the customer body from named fields plus extra fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('bc_create_customer', {
      company_id: COMPANY,
      displayName: 'Lumen & Clay GmbH',
      type: 'Company',
      city: 'Freiburg',
      country: 'DE',
      fields: { creditLimit: 5000 },
    });
    expect(sent().data).toEqual({ displayName: 'Lumen & Clay GmbH', type: 'Company', city: 'Freiburg', country: 'DE', creditLimit: 5000 });
  });
});

const TOKEN = process.env.BC_ACCESS_TOKEN;
const LIVE_TENANT = process.env.BC_TENANT_ID;
const LIVE_ENV = process.env.BC_ENVIRONMENT;
const live = TOKEN && LIVE_TENANT && LIVE_ENV ? describe : describe.skip;

live('dynamics365-business-central adapter: live API v2.0', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      {
        baseUrl: baseFor(LIVE_TENANT as string, LIVE_ENV as string),
        authType: 'BEARER_TOKEN',
        authConfig: { token: TOKEN as string },
        headers: a.connector.headers,
      },
      tool(name).endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );
  let companyId = '';

  it('lists companies and reads the master data of the first one', async () => {
    const companies = await run('bc_list_companies');
    expect(companies.value.length).toBeGreaterThan(0);
    companyId = process.env.BC_COMPANY_ID ?? companies.value[0].id;
    const customers = await run('bc_list_customers', { company_id: companyId, top: 3, select: 'id,number,displayName' });
    expect(Array.isArray(customers.value)).toBe(true);
    if (customers.value.length) {
      const one = await run('bc_get_customer', { company_id: companyId, customer_id: customers.value[0].id });
      expect(one.number).toBe(customers.value[0].number);
      expect(typeof one['@odata.etag']).toBe('string');
    }
    for (const name of ['bc_list_vendors', 'bc_list_items', 'bc_list_accounts', 'bc_list_dimensions', 'bc_list_employees']) {
      const page = await run(name, { company_id: companyId, top: 2 });
      expect(Array.isArray(page.value)).toBe(true);
    }
  }, 120_000);

  it('reads documents and ledger entries with filters', async () => {
    const orders = await run('bc_list_sales_orders', { company_id: companyId, top: 2, expand: 'salesOrderLines' });
    expect(Array.isArray(orders.value)).toBe(true);
    const invoices = await run('bc_list_sales_invoices', { company_id: companyId, top: 2, orderby: 'invoiceDate desc' });
    expect(Array.isArray(invoices.value)).toBe(true);
    const purchase = await run('bc_list_purchase_invoices', { company_id: companyId, top: 2 });
    expect(Array.isArray(purchase.value)).toBe(true);
    const gl = await run('bc_list_general_ledger_entries', { company_id: companyId, top: 5, orderby: 'entryNumber desc' });
    expect(Array.isArray(gl.value)).toBe(true);
    const contacts = await run('bc_query', { company_id: companyId, resource: 'paymentTerms', top: 5 });
    expect(Array.isArray(contacts.value)).toBe(true);
  }, 120_000);

  (process.env.BC_LIVE_WRITE === '1' ? it : it.skip)(
    'creates and updates a test customer, creates a quote with lines, then deletes both',
    async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const items = await run('bc_list_items', { company_id: companyId, top: 1, filter: "type eq 'Inventory' and blocked eq false" });
      const itemNumber: string = items.value[0].number;
      const customer = await run('bc_create_customer', { company_id: companyId, displayName: `AnythingMCP test ${stamp}`, city: 'Freiburg' });
      let quoteId = '';
      try {
        const updated = await run('bc_update_customer', {
          company_id: companyId,
          customer_id: customer.id,
          fields: { phoneNumber: '0761 000000' },
          etag: customer['@odata.etag'],
        });
        expect(updated.phoneNumber).toBe('0761 000000');
        await expect(
          run('bc_update_customer', { company_id: companyId, customer_id: customer.id, fields: { city: 'Basel' }, etag: customer['@odata.etag'] }),
        ).rejects.toMatchObject({ response: { status: 412 } });

        const quote = await run('bc_create_sales_quote', {
          company_id: companyId,
          customerId: customer.id,
          externalDocumentNumber: 'AMCP-TEST',
          lines: [{ lineType: 'Item', lineObjectNumber: itemNumber, quantity: 2 }],
        });
        quoteId = quote.id;
        expect(quote.salesQuoteLines).toHaveLength(1);
        const line = await run('bc_add_sales_quote_line', { company_id: companyId, quote_id: quote.id, lineType: 'Comment', description: 'AnythingMCP test line' });
        expect(line.lineType).toBe('Comment');
        const read = await run('bc_get_sales_quote', { company_id: companyId, quote_id: quote.id, expand: 'salesQuoteLines' });
        expect(read.salesQuoteLines).toHaveLength(2);
      } finally {
        if (quoteId) await run('bc_delete_sales_quote', { company_id: companyId, quote_id: quoteId });
        await run('bc_delete_customer', { company_id: companyId, customer_id: customer.id });
      }
    },
    180_000,
  );
});
