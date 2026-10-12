import axios from 'axios';
import * as adapter from './netsuite.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Oracle NetSuite adapter:
 *
 *   1. Static: always runs. Pins the OAuth 2.0 authorization code settings
 *      (account-specific authorize and token hosts, HTTP Basic at the token
 *      endpoint, scope rest_webservices), the account id in its URL form, every
 *      tool's method and URL through the real RestEngine (axios mocked), the
 *      SuiteQL request (Prefer: transient, q in the body, limit and offset),
 *      the record API bodies of the writes, and the read-only and
 *      switched-off sets.
 *
 *   2. Live: skipped unless NETSUITE_ACCOUNT_ID (URL form, e.g. 1234567-sb1)
 *      and NETSUITE_ACCESS_TOKEN (an OAuth 2.0 access token of an integration
 *      record with the REST Web Services scope; it lasts 60 minutes) are set:
 *
 *        NETSUITE_ACCOUNT_ID=... NETSUITE_ACCESS_TOKEN=... \
 *          npx jest src/adapters/intl/netsuite.live.spec.ts
 *
 *      Reads the record types and the customer schema, runs SuiteQL with
 *      paging, and reads the first customer, vendor, employee, item, sales
 *      order, invoice, purchase order, bill and journal entry it finds.
 *
 *      NETSUITE_LIVE_WRITE=1 also creates a customer "AnythingMCP live spec
 *      (safe to delete)" (in NETSUITE_TEST_SUBSIDIARY_ID when set, for OneWorld
 *      accounts), changes it, and, when NETSUITE_TEST_ITEM_ID is set, creates a
 *      Pending Approval sales order for it. Both are deleted in `finally`.
 *      Use a sandbox account.
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

type Mapping = {
  method: string;
  path: string;
  encodePathParams?: boolean;
  headers?: Record<string, string>;
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
  exposeHeaders?: string[];
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: Mapping;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
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
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);

// Mirrors DynamicMcpTools: {{VAR}} interpolated everywhere, env vars also
// passed as params. The OAuth access token goes out as a bearer token, which
// is what OAUTH2 auth puts on the request too.
const prepare = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return [
    { baseUrl: config.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ] as const;
};
const execute = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) =>
  engine().execute(...prepare(name, env, token, params)) as Promise<any>;
const executeWithMeta = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) =>
  engine().executeWithMeta(...prepare(name, env, token, params));

const ENV = { NETSUITE_ACCOUNT_ID: '1234567-sb1' };
const BASE = 'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest';
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, 'test-token', params);
const sent = () => mockedAxios.mock.calls[0][0];

const OFF = ['netsuite_create_sales_order', 'netsuite_update_record'];
const WRITES = ['netsuite_create_customer', 'netsuite_create_sales_order', 'netsuite_update_record'];

describe('netsuite adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified against the official API spec on 12 Oct 2026)', () => { expect(a.unlisted).toBeUndefined(); });

  it('signs in with OAuth 2.0 authorization code at the account hosts, HTTP Basic at the token endpoint', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{NETSUITE_CLIENT_ID}}',
      clientSecret: '{{NETSUITE_CLIENT_SECRET}}',
      authorizationUrl: 'https://{{NETSUITE_ACCOUNT_ID}}.app.netsuite.com/app/login/oauth2/authorize.nl',
      tokenUrl: 'https://{{NETSUITE_ACCOUNT_ID}}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
      tokenAuthMethod: 'client_secret_basic',
      scopes: 'rest_webservices',
    });
    expect(needsBrowserAuthorization(a as never)).toBe(true);
    const resolved = interpolateDeep(a.connector.authConfig, { ...ENV, NETSUITE_CLIENT_ID: 'id', NETSUITE_CLIENT_SECRET: 'secret' });
    expect(resolved.authorizationUrl).toBe('https://1234567-sb1.app.netsuite.com/app/login/oauth2/authorize.nl');
    expect(resolved.tokenUrl).toBe('https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token');
    expect(a.connector.baseUrl).toBe('https://{{NETSUITE_ACCOUNT_ID}}.suitetalk.api.netsuite.com/services/rest');
    expect(a.requiredEnvVars).toEqual(['NETSUITE_ACCOUNT_ID', 'NETSUITE_CLIENT_ID', 'NETSUITE_CLIENT_SECRET']);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'NETSUITE_CLIENT_SECRET')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'NETSUITE_ACCOUNT_ID')!.kind).toBe('address');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('seven days');
    // TBA is out by design; the instructions say why.
    expect(a.instructions).toContain('2027.1');
  });

  it('takes the account id in its web address form only', () => {
    const re = new RegExp(a.envVarMeta.NETSUITE_ACCOUNT_ID.pattern!);
    for (const ok of ['1234567', '1234567-sb1', '1234567-sb2', 'tstdrv1234567', '1234567-rp']) expect(re.test(ok)).toBe(true);
    for (const bad of ['1234567_SB1', '1234567-SB1', '1234567_sb1', 'https://1234567.app.netsuite.com', '1234567.suitetalk.api.netsuite.com', '']) {
      expect(re.test(bad)).toBe(false);
    }
    const hex = new RegExp(a.envVarMeta.NETSUITE_CLIENT_ID.pattern!);
    expect(hex.test('a'.repeat(64))).toBe(true);
    expect(hex.test(`${'a'.repeat(64)} `)).toBe(false);
  });

  it('probes with the record type list, which needs no record permission', () => {
    expect(a.probe).toEqual({ tool: 'netsuite_list_record_types' });
    expect(a.connector.healthcheckPath).toBe('/record/v1/metadata-catalog?select=customer');
  });

  it('prefixes every tool with netsuite_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^netsuite_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks SuiteQL and every GET read-only, and installs the risky writes switched off', () => {
    for (const t of a.tools) {
      const readOnly = !WRITES.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${readOnly}`);
    }
    expect(tool('netsuite_suiteql_query').endpointMapping.method).toBe('POST');
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    expect(annotationsOf(tool('netsuite_update_record')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('netsuite_create_customer')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('netsuite_create_sales_order')).destructiveHint).toBe(false);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bnetsuite_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bnetsuite_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['netsuite_suiteql_query', { query: 'SELECT id FROM customer' }, 'POST', '/query/v1/suiteql'],
    ['netsuite_list_record_types', {}, 'GET', '/record/v1/metadata-catalog'],
    ['netsuite_describe_record_type', { record_type: 'salesOrder' }, 'GET', '/record/v1/metadata-catalog/salesOrder'],
    ['netsuite_list_records', { record_type: 'customer' }, 'GET', '/record/v1/customer'],
    ['netsuite_get_record', { record_type: 'contact', id: '7' }, 'GET', '/record/v1/contact/7'],
    ['netsuite_get_customer', { id: '42' }, 'GET', '/record/v1/customer/42'],
    ['netsuite_get_vendor', { id: '43' }, 'GET', '/record/v1/vendor/43'],
    ['netsuite_get_employee', { id: '5' }, 'GET', '/record/v1/employee/5'],
    ['netsuite_get_item', { item_type: 'inventoryItem', id: '99' }, 'GET', '/record/v1/inventoryItem/99'],
    ['netsuite_get_sales_order', { id: '100' }, 'GET', '/record/v1/salesOrder/100'],
    ['netsuite_get_invoice', { id: '101' }, 'GET', '/record/v1/invoice/101'],
    ['netsuite_get_purchase_order', { id: '102' }, 'GET', '/record/v1/purchaseOrder/102'],
    ['netsuite_get_vendor_bill', { id: '103' }, 'GET', '/record/v1/vendorBill/103'],
    ['netsuite_get_journal_entry', { id: '104' }, 'GET', '/record/v1/journalEntry/104'],
    ['netsuite_create_customer', { company_name: 'Acme' }, 'POST', '/record/v1/customer'],
    ['netsuite_create_sales_order', { customer_id: '42', lines: [{ item: { id: '99' }, quantity: 1 }] }, 'POST', '/record/v1/salesOrder'],
    ['netsuite_update_record', { record_type: 'customer', id: '42', fields: { email: 'a@example.com' } }, 'PATCH', '/record/v1/customer/42'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
    expect(sent().headers.Authorization).toBe('Bearer test-token');
  });

  it('encodes record ids and external ids into the path', async () => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await call('netsuite_get_customer', { id: 'eid:CUST/1' });
    expect(sent().url).toBe(`${BASE}/record/v1/customer/eid%3ACUST%2F1`);
  });

  it('runs SuiteQL with Prefer: transient, the query as q and 100 rows from offset 0 by default', async () => {
    mockedAxios.mockResolvedValue({ data: { items: [], hasMore: false }, headers: {} });
    await call('netsuite_suiteql_query', { query: "SELECT id, companyname FROM customer WHERE isinactive = 'F' ORDER BY id" });
    expect(sent().headers).toEqual(expect.objectContaining({ Prefer: 'transient', 'Content-Type': 'application/json', Accept: 'application/json' }));
    expect(sent().data).toEqual({ q: "SELECT id, companyname FROM customer WHERE isinactive = 'F' ORDER BY id" });
    expect(sent().params).toEqual({ limit: 100, offset: 0 });
    mockedAxios.mockClear();
    await call('netsuite_suiteql_query', { query: 'SELECT id FROM item ORDER BY id', limit: 1000, offset: 2000 });
    expect(sent().params).toEqual({ limit: 1000, offset: 2000 });
  });

  it('asks for JSON Schema when describing a record type', async () => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await call('netsuite_describe_record_type', { record_type: 'customer' });
    expect(sent().headers.Accept).toBe('application/schema+json');
  });

  it('expands transaction lines by default and other records only on request', async () => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await call('netsuite_get_sales_order', { id: '100' });
    expect(sent().params).toEqual({ expandSubResources: true });
    mockedAxios.mockClear();
    await call('netsuite_get_journal_entry', { id: '104', expand_lines: false });
    expect(sent().params).toEqual({ expandSubResources: false });
    mockedAxios.mockClear();
    await call('netsuite_get_record', { record_type: 'customer', id: '42', fields: 'companyName,email' });
    expect(sent().params).toEqual({ expandSubResources: false, fields: 'companyName,email' });
    mockedAxios.mockClear();
    await call('netsuite_list_records', { record_type: 'customer', q: 'email START_WITH "anna"' });
    expect(sent().params).toEqual({ q: 'email START_WITH "anna"', limit: 100, offset: 0 });
  });

  it('creates customers in record API form and hands back the location header', async () => {
    mockedAxios.mockResolvedValue({
      status: 204,
      data: '',
      headers: { location: `${BASE}/record/v1/customer/555` },
    });
    const out = await executeWithMeta('netsuite_create_customer', ENV, 'test-token', {
      company_name: 'Acme GmbH',
      email: 'ap@example.com',
      subsidiary: { id: '2' },
      external_id: 'CRM-1',
      fields: { currency: { id: '1' }, custentity_region: 'EU' },
    });
    expect(sent().data).toEqual({
      currency: { id: '1' },
      custentity_region: 'EU',
      companyName: 'Acme GmbH',
      email: 'ap@example.com',
      subsidiary: { id: '2' },
      externalId: 'CRM-1',
    });
    expect(out.headers).toEqual({ location: `${BASE}/record/v1/customer/555` });
    mockedAxios.mockClear();
    // No subsidiary key at all when none is given (a non-OneWorld account).
    await call('netsuite_create_customer', { is_person: true, first_name: 'Anna', last_name: 'Rossi' });
    expect(sent().data).toEqual({ isPerson: true, firstName: 'Anna', lastName: 'Rossi' });
  });

  it('creates sales orders as Pending Approval with the lines in the item sublist', async () => {
    mockedAxios.mockResolvedValue({ status: 204, data: '', headers: {} });
    const lines = [{ item: { id: '99' }, quantity: 2, rate: 19.5 }];
    await call('netsuite_create_sales_order', { customer_id: '42', lines, po_number: 'PO-7', fields: { location: { id: '3' } } });
    expect(sent().data).toEqual({
      location: { id: '3' },
      entity: { id: '42' },
      otherRefNum: 'PO-7',
      orderStatus: { id: 'A' },
      item: { items: lines },
    });
  });

  it('patches only the given fields', async () => {
    mockedAxios.mockResolvedValue({ status: 204, data: '', headers: {} });
    await call('netsuite_update_record', { record_type: 'vendor', id: '43', fields: { email: 'ap@example.com', terms: { id: '2' } } });
    expect(sent().method).toBe('PATCH');
    expect(sent().data).toEqual({ email: 'ap@example.com', terms: { id: '2' } });
  });
});

const ACCOUNT = process.env.NETSUITE_ACCOUNT_ID;
const TOKEN = process.env.NETSUITE_ACCESS_TOKEN;
const live = ACCOUNT && TOKEN ? describe : describe.skip;

live('netsuite adapter: live REST API', () => {
  const write = process.env.NETSUITE_LIVE_WRITE === '1';
  const env = { NETSUITE_ACCOUNT_ID: ACCOUNT as string };
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, TOKEN as string, params);
  const first = async (query: string): Promise<any> => (await run('netsuite_suiteql_query', { query, limit: 1 })).items[0];
  // Clean-up only: the adapter ships no delete tool.
  const remove = (recordType: string, id: string) =>
    engine().execute(
      {
        baseUrl: `https://${ACCOUNT}.suitetalk.api.netsuite.com/services/rest`,
        authType: 'BEARER_TOKEN',
        authConfig: { token: TOKEN },
        headers: a.connector.headers,
      },
      { method: 'DELETE', path: `/record/v1/${recordType}/${id}` },
      {},
    );

  it('lists record types, describes the customer and pages through SuiteQL', async () => {
    const types = await run('netsuite_list_record_types', { select: 'customer,salesOrder' });
    expect(Array.isArray(types.items)).toBe(true);
    const schema = await run('netsuite_describe_record_type', { record_type: 'customer' });
    expect(schema.properties ?? schema.type).toBeDefined();
    const page1 = await run('netsuite_suiteql_query', { query: 'SELECT id, entityid FROM customer ORDER BY id', limit: 5 });
    expect(Array.isArray(page1.items)).toBe(true);
    expect(typeof page1.hasMore).toBe('boolean');
    if (page1.hasMore) {
      const page2 = await run('netsuite_suiteql_query', { query: 'SELECT id, entityid FROM customer ORDER BY id', limit: 5, offset: 5 });
      expect(page2.items[0].id).not.toBe(page1.items[0].id);
    }
    const ids = await run('netsuite_list_records', { record_type: 'customer', limit: 5 });
    expect(Array.isArray(ids.items)).toBe(true);
  }, 120_000);

  it('reads the first record of every dedicated tool that has one', async () => {
    const reads: Array<[string, string]> = [
      ['netsuite_get_customer', 'SELECT id FROM customer ORDER BY id'],
      ['netsuite_get_vendor', 'SELECT id FROM vendor ORDER BY id'],
      ['netsuite_get_employee', 'SELECT id FROM employee ORDER BY id'],
      ['netsuite_get_sales_order', "SELECT id FROM transaction WHERE type = 'SalesOrd' ORDER BY id DESC"],
      ['netsuite_get_invoice', "SELECT id FROM transaction WHERE type = 'CustInvc' ORDER BY id DESC"],
      ['netsuite_get_purchase_order', "SELECT id FROM transaction WHERE type = 'PurchOrd' ORDER BY id DESC"],
      ['netsuite_get_vendor_bill', "SELECT id FROM transaction WHERE type = 'VendBill' ORDER BY id DESC"],
      ['netsuite_get_journal_entry', "SELECT id FROM transaction WHERE type = 'Journal' ORDER BY id DESC"],
    ];
    for (const [name, query] of reads) {
      const row = await first(query);
      if (!row) continue;
      const record = await run(name, { id: String(row.id) });
      expect(String(record.id)).toBe(String(row.id));
    }
    const item = await first("SELECT id, itemtype FROM item WHERE itemtype = 'InvtPart' ORDER BY id");
    if (item) {
      expect(String((await run('netsuite_get_item', { item_type: 'inventoryItem', id: String(item.id) })).id)).toBe(String(item.id));
    }
    const contact = await first('SELECT id FROM contact ORDER BY id');
    if (contact) {
      expect(String((await run('netsuite_get_record', { record_type: 'contact', id: String(contact.id) })).id)).toBe(String(contact.id));
    }
  }, 180_000);

  (write ? it : it.skip)('creates, changes and deletes a test customer and sales order', async () => {
    const subsidiary = process.env.NETSUITE_TEST_SUBSIDIARY_ID;
    const created = await executeWithMeta('netsuite_create_customer', env, TOKEN as string, {
      company_name: 'AnythingMCP live spec (safe to delete)',
      email: 'live-spec@example.com',
      ...(subsidiary ? { subsidiary: { id: subsidiary } } : {}),
    });
    const customerId = String(created.headers.location).split('/').pop() as string;
    expect(customerId).toMatch(/^\d+$/);
    let orderId: string | undefined;
    try {
      await run('netsuite_update_record', { record_type: 'customer', id: customerId, fields: { comments: 'Changed by the AnythingMCP live spec' } });
      expect((await run('netsuite_get_customer', { id: customerId })).comments).toBe('Changed by the AnythingMCP live spec');
      const itemId = process.env.NETSUITE_TEST_ITEM_ID;
      if (itemId) {
        const order = await executeWithMeta('netsuite_create_sales_order', env, TOKEN as string, {
          customer_id: customerId,
          lines: [{ item: { id: itemId }, quantity: 1 }],
          memo: 'AnythingMCP live spec (safe to delete)',
        });
        orderId = String(order.headers.location).split('/').pop();
        const read = await run('netsuite_get_sales_order', { id: orderId });
        expect(read.orderStatus.id).toBe('A');
        expect(read.item.items.length).toBe(1);
      }
    } finally {
      if (orderId) await remove('salesOrder', orderId);
      await remove('customer', customerId);
    }
  }, 180_000);
});
