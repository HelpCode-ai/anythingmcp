import axios from 'axios';
import * as adapter from './xentral.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { rebuildCatalogCredentials } from '../../connectors/catalog-env-rebuild.util';
import { diffBaseUrl } from '../../connectors/catalog-resync.service';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Xentral adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with a Personal Access Token
 *      against the instance root, the versioned path of every tool (v3 for
 *      sales documents, v2 for products and customers, v1 for stock,
 *      warehouses, suppliers, liabilities, payment methods and projects), the
 *      exact query string the filters produce (Xentral only takes them as
 *      `filter[0][key]=…&filter[0][op]=…&filter[0][value]=…`; a flat
 *      `filter=` string is answered with "filter must be an array"), the
 *      sales order draft body, which tools are read-only or switched off, and
 *      what the move from Basic auth does to a connector installed earlier.
 *
 *   2. Live: skipped unless XENTRAL_URL and XENTRAL_TOKEN are set. Read-only:
 *
 *        XENTRAL_URL=https://acme.xentral.biz XENTRAL_TOKEN=... \
 *          npx jest src/adapters/de/xentral.live.spec.ts
 *
 *      Reads products with stock and storage locations, warehouses, customers
 *      with addresses, suppliers, sales orders, delivery notes with shipments,
 *      invoices and credit notes with their balances, purchase orders,
 *      liabilities, payment methods and projects.
 *
 *      XENTRAL_LIVE_WRITE=1 (use a test project, see "Testing the APIs" in the
 *      Xentral docs) also creates a sales order DRAFT for the first customer
 *      and product, or XENTRAL_TEST_CUSTOMER_ID / XENTRAL_TEST_PRODUCT_ID /
 *      XENTRAL_TEST_PROJECT_ID, reads it back and deletes it in `finally`. A
 *      draft has no order number and reserves nothing.
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
  name: string;
  icon: string;
  category: string;
  region: string;
  unlisted?: boolean;
  instructions: string;
  description: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarAliases?: unknown;
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  verifyHints: Record<string, string>;
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

const INSTANCE = 'https://acme.xentral.biz';
// Built at run time: a literal that looks like a real token trips push protection.
const FAKE_TOKEN = ['pat', 'test', 'only'].join('-');

// Mirrors DynamicMcpTools: {{VAR}} interpolated, defaults filled in, env vars
// passed as params, the token sent as a Bearer header.
const execute = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: { token }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const ENV = { XENTRAL_URL: INSTANCE };
const call = (name: string, params: Record<string, unknown> = {}) => execute(name, ENV, FAKE_TOKEN, params);
const sent = () => mockedAxios.mock.calls[0][0];
/** The query string exactly as it goes on the wire. */
const wire = () => sent().paramsSerializer(sent().params) as string;
/** The same, percent-decoded, to compare with Xentral's documented examples. */
const query = () => decodeURIComponent(wire());

describe('xentral adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('keeps the catalog identity the site and the catalog depend on', () => {
    expect(a.slug).toBe('xentral');
    expect(a.name).toBe('Xentral ERP');
    expect(a.icon).toBe('xentral');
    expect(a.category).toBe('erp');
    expect(a.region).toBe('de');
    expect(a.unlisted).toBeUndefined();
    expect(getAdapter('xentral')).toBeDefined();
  });

  it('authenticates with a Personal Access Token as Bearer against the instance root', async () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{XENTRAL_TOKEN}}' });
    expect(a.connector.baseUrl).toBe('{{XENTRAL_URL}}');
    expect(a.connector.headers).toEqual({ Accept: 'application/json' });
    expect(a.requiredEnvVars).toEqual(['XENTRAL_URL', 'XENTRAL_TOKEN']);
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call('xentral_list_products');
    expect(sent().headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(sent().url).toBe(`${INSTANCE}/api/v2/products`);
  });

  it('accepts only the instance root as XENTRAL_URL and keeps the token secret', () => {
    const url = new RegExp(a.envVarMeta.XENTRAL_URL.pattern!);
    for (const ok of [INSTANCE, 'https://erp.example.de']) expect(url.test(ok)).toBe(true);
    for (const bad of [`${INSTANCE}/`, `${INSTANCE}/api/v1`, 'http://acme.xentral.biz', 'acme.xentral.biz']) {
      expect(url.test(bad)).toBe(false);
    }
    expect(new RegExp(a.envVarMeta.XENTRAL_TOKEN.pattern!).test(`Bearer ${FAKE_TOKEN}`)).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'XENTRAL_TOKEN')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'XENTRAL_URL')!.kind).toBe('address');
  });

  it('documents the token path, rate limit and common errors', () => {
    expect(a.instructions).toMatch(/Administration\*\* at the bottom left, then \*\*Account settings\*\*.*Developer settings.*Personal Access Tokens/s);
    expect(a.instructions).toMatch(/100 requests per minute/);
    for (const status of ['401', '403', '404', '409']) expect(a.instructions).toContain(`- ${status}`);
    expect(a.instructions).toContain('filter must be an array');
    expect(a.instructions).not.toMatch(/Einstellungen → Benutzer → API|XENTRAL_USER|XENTRAL_PASSWORD/);
    expect(Object.keys(a.verifyHints).sort()).toEqual(['401', '403', '404', 'rate_limited']);
  });

  it('probes and health-checks with a product list', () => {
    expect(a.probe.tool).toBe('xentral_list_products');
    expect(tool('xentral_list_products').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/api/v2/products');
  });

  it('prefixes every tool with xentral_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^xentral_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only, the delete destructive and switched off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(a.tools.filter((t) => t.endpointMapping.method === 'GET').map((t) => t.name).sort());
    expect(readOnly.length).toBe(28);
    expect(annotationsOf(tool('xentral_create_sales_order')).readOnlyHint).not.toBe(true);
    expect(tool('xentral_create_sales_order').description).toMatch(/draft/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['xentral_delete_sales_order_draft']);
    expect(annotationsOf(tool('xentral_delete_sales_order_draft')).destructiveHint).toBe(true);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bxentral_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bxentral_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['xentral_list_products', {}, 'GET', '/api/v2/products'],
    ['xentral_get_product', { id: '17' }, 'GET', '/api/v2/products/17'],
    ['xentral_get_product_stock', { id: '17' }, 'GET', '/api/v1/products/17/stocks'],
    ['xentral_list_product_storage_locations', { id: '17' }, 'GET', '/api/v1/products/17/storageLocations'],
    ['xentral_list_warehouses', {}, 'GET', '/api/v1/warehouses'],
    ['xentral_list_storage_locations', { warehouseId: '2' }, 'GET', '/api/v1/warehouses/2/storageLocations'],
    ['xentral_list_storage_location_items', { warehouseId: '2', storageLocationId: '5' }, 'GET', '/api/v2/warehouses/2/storageLocations/5/items'],
    ['xentral_list_customers', {}, 'GET', '/api/v2/customers'],
    ['xentral_get_customer', { id: '9' }, 'GET', '/api/v2/customers/9'],
    ['xentral_list_customer_addresses', { customerId: '9' }, 'GET', '/api/v2/customers/9/addresses'],
    ['xentral_list_suppliers', {}, 'GET', '/api/v1/suppliers'],
    ['xentral_get_supplier', { id: '11' }, 'GET', '/api/v1/suppliers/11'],
    ['xentral_list_sales_orders', {}, 'GET', '/api/v3/salesOrders'],
    ['xentral_get_sales_order', { id: '21' }, 'GET', '/api/v3/salesOrders/21'],
    ['xentral_create_sales_order', { addressId: '9', lineItems: [{ product: { id: '17' }, quantity: 1 }] }, 'POST', '/api/v3/salesOrders'],
    ['xentral_delete_sales_order_draft', { id: '21' }, 'DELETE', '/api/v3/salesOrders/21'],
    ['xentral_list_delivery_notes', {}, 'GET', '/api/v3/deliveryNotes'],
    ['xentral_get_delivery_note', { id: '31' }, 'GET', '/api/v3/deliveryNotes/31'],
    ['xentral_list_delivery_note_shipments', { id: '31' }, 'GET', '/api/v1/deliveryNotes/31/shipments'],
    ['xentral_list_invoices', {}, 'GET', '/api/v3/invoices'],
    ['xentral_get_invoice', { id: '41' }, 'GET', '/api/v3/invoices/41'],
    ['xentral_get_invoice_balance', { id: '41' }, 'GET', '/api/v1/invoices/41/balance'],
    ['xentral_list_credit_notes', {}, 'GET', '/api/v3/creditNotes'],
    ['xentral_get_credit_note', { id: '51' }, 'GET', '/api/v3/creditNotes/51'],
    ['xentral_get_credit_note_balance', { id: '51' }, 'GET', '/api/v1/creditNotes/51/balance'],
    ['xentral_list_purchase_orders', {}, 'GET', '/api/v3/purchaseOrders'],
    ['xentral_get_purchase_order', { id: '61' }, 'GET', '/api/v3/purchaseOrders/61'],
    ['xentral_list_liabilities', {}, 'GET', '/api/v1/liabilities'],
    ['xentral_list_payment_methods', {}, 'GET', '/api/v1/paymentMethods'],
    ['xentral_list_projects', {}, 'GET', '/api/v1/projects'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
    expect(a.tools.length).toBe(30);
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url: `${INSTANCE}${path}`, headers: expect.objectContaining({ Authorization: `Bearer ${FAKE_TOKEN}` }) }),
    );
  });

  it('encodes a document filter exactly as Xentral documents it', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call('xentral_list_invoices', { filter: [{ key: 'status', op: 'equals', value: 'released' }] });
    expect(query()).toBe('filter[0][key]=status&filter[0][op]=equals&filter[0][value]=released&page=1&perPage=25');
    expect(`${sent().url}?${wire()}`).toBe(
      `${INSTANCE}/api/v3/invoices?filter%5B0%5D%5Bkey%5D=status&filter%5B0%5D%5Bop%5D=equals&filter%5B0%5D%5Bvalue%5D=released&page=1&perPage=25`,
    );
  });

  it('indexes several conditions and list values, and sends search, sort, include and the pagination header', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call('xentral_list_invoices', {
      search: 'Muster GmbH',
      filter: [
        { key: 'paymentStatus', op: 'in', value: ['pending', 'partiallyPaid'] },
        { key: 'documentDate', op: 'greaterThanOrEquals', value: '2026-01-01' },
      ],
      sort: '-documentDate,customerNumber',
      include: 'lineItems,address',
      page: 2,
      perPage: 50,
      pagination: 'table',
    });
    expect(query()).toBe(
      'search=Muster+GmbH' +
        '&filter[0][key]=paymentStatus&filter[0][op]=in&filter[0][value][0]=pending&filter[0][value][1]=partiallyPaid' +
        '&filter[1][key]=documentDate&filter[1][op]=greaterThanOrEquals&filter[1][value]=2026-01-01' +
        '&sort=-documentDate,customerNumber&include=lineItems,address&page=2&perPage=50',
    );
    expect(sent().headers['x-pagination']).toBe('table');
  });

  it('leaves out the pagination header and empty options', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call('xentral_list_sales_orders');
    expect(query()).toBe('page=1&perPage=25');
    expect(sent().headers).not.toHaveProperty('x-pagination');
  });

  it('pages the v1 and v2 lists with page[number] and page[size]', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call('xentral_list_products', {
      filter: [{ key: 'name', op: 'contains', value: 'Schraube' }, { key: 'updatedAt', op: 'greaterThan', value: '2026-10-01T00:00:00+02:00' }],
      order: [{ field: 'name', dir: 'asc' }],
    });
    expect(query()).toBe(
      'filter[0][key]=name&filter[0][op]=contains&filter[0][value]=Schraube' +
        '&filter[1][key]=updatedAt&filter[1][op]=greaterThan&filter[1][value]=2026-10-01T00:00:00+02:00' +
        '&order[0][field]=name&order[0][dir]=asc&page[number]=1&page[size]=25',
    );
    // The offset's plus sign stays a plus, not a space.
    expect(wire()).toContain('filter%5B1%5D%5Bvalue%5D=2026-10-01T00:00:00%2B02:00');
  });

  it('pages every v1/v2 list the same way and v3 lists with page and perPage', async () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET')) {
      const props = t.parameters.properties ?? {};
      if (!('page' in props)) continue;
      if (t.endpointMapping.path.startsWith('/api/v3/')) {
        expect(`${t.name}:${JSON.stringify(t.endpointMapping.queryParams)}`).toContain('"page":"$page","perPage":"$perPage"');
        expect(t.endpointMapping.headers).toEqual({ 'x-pagination': '$pagination' });
      } else {
        expect(`${t.name}:${JSON.stringify(t.endpointMapping.queryParams?.page)}`).toBe(`${t.name}:{"number":"$page","size":"$pageSize"}`);
        expect(props.pageSize.maximum).toBe(50);
      }
    }
  });

  it('only offers filter fields and operators the endpoint accepts', () => {
    const keys = (name: string) => tool(name).parameters.properties!.filter.items.properties.key.enum as string[];
    const ops = (name: string) => tool(name).parameters.properties!.filter.items.properties.op.enum as string[];
    expect(keys('xentral_list_invoices')).toEqual(expect.arrayContaining(['paymentStatus', 'customerNumber', 'documentDate', 'status']));
    expect(keys('xentral_list_purchase_orders')).toEqual(expect.arrayContaining(['supplierNumber', 'status']));
    expect(keys('xentral_list_purchase_orders')).not.toContain('customerNumber');
    expect(keys('xentral_list_products')).toEqual(expect.arrayContaining(['number', 'name', 'ean']));
    // The customer list has no partial match.
    expect(ops('xentral_list_customers').sort()).toEqual(['equals', 'greaterThan', 'in', 'lessThan', 'notEquals', 'notIn']);
    expect(tool('xentral_list_customers').description).toMatch(/exactly/);
    for (const t of a.tools) {
      const f = t.parameters.properties?.filter;
      if (!f) continue;
      expect(`${t.name}:${f.type}:${f.items.required}`).toBe(`${t.name}:array:key,op`);
    }
  });

  it('asks for the line items on single documents unless told otherwise', async () => {
    mockedAxios.mockResolvedValue({ data: { data: {} } });
    await call('xentral_get_invoice', { id: '41' });
    expect(query()).toBe('include=lineItems');
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { data: {} } });
    await call('xentral_get_sales_order', { id: '21', include: 'lineItems,trafficLights' });
    expect(query()).toBe('include=lineItems,trafficLights');
  });

  it('creates a sales order draft with the address, the lines and only the fields given', async () => {
    mockedAxios.mockResolvedValue({ data: { data: { id: '21' } } });
    const lineItems = [{ product: { id: '17' }, quantity: 2, price: { net: { amount: 12.5, currency: 'EUR' } } }];
    await call('xentral_create_sales_order', { addressId: '9', lineItems, customerOrderNumber: 'PO-7', project: { id: '1' } });
    expect(sent().method).toBe('POST');
    expect(sent().data).toEqual({ address: { id: '9' }, lineItems, project: { id: '1' }, customerOrderNumber: 'PO-7' });
    expect(tool('xentral_create_sales_order').parameters.required).toEqual(['addressId', 'lineItems']);
  });

  it('leaves the earlier Basic-auth install alone instead of half-converting it', () => {
    // The one catalog install from before this version was never configured:
    // Basic auth with the old variables, base URL still a template. Its auth
    // type no longer matches the template, so new variables never rewrite its
    // credentials; it has to be reinstalled to use a token.
    const rebuilt = rebuildCatalogCredentials({
      adapter: a as never,
      connectorAuthType: 'BASIC_AUTH',
      storedAuthConfig: { username: '{{XENTRAL_USER}}', password: '{{XENTRAL_PASSWORD}}' },
      storedBaseUrl: '{{XENTRAL_URL}}/api/v1',
      storedHeaders: null,
      previousEnvVars: {},
      nextEnvVars: { XENTRAL_URL: INSTANCE, XENTRAL_TOKEN: FAKE_TOKEN },
    });
    expect(rebuilt.authConfig).toBeUndefined();
    // Setting XENTRAL_URL does move its base URL to the instance root the new
    // paths are relative to.
    expect(rebuilt.baseUrl).toBe(INSTANCE);
    // A templated base URL is never proposed as a catalog base URL change.
    expect(diffBaseUrl(a.connector.baseUrl, '{{XENTRAL_URL}}/api/v1', null)).toBeNull();
    // No aliases: a password is not a token.
    expect(a.envVarAliases).toBeUndefined();
  });
});

const LIVE_URL = process.env.XENTRAL_URL;
const LIVE_TOKEN = process.env.XENTRAL_TOKEN;
const live = LIVE_URL && LIVE_TOKEN ? describe : describe.skip;

live('xentral adapter: live API', () => {
  const env = { XENTRAL_URL: (LIVE_URL ?? '').replace(/\/+$/, '') };
  const write = process.env.XENTRAL_LIVE_WRITE === '1';
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, LIVE_TOKEN as string, params);
  const first = (res: any) => (Array.isArray(res?.data) ? res.data[0] : undefined);

  it('reads products with stock and storage locations', async () => {
    const products = await run('xentral_list_products', { pageSize: 10 });
    expect(Array.isArray(products.data)).toBe(true);
    const product = first(products);
    if (!product) return;
    const byNumber = await run('xentral_list_products', { filter: [{ key: 'number', op: 'equals', value: product.number }] });
    expect(byNumber.data.map((p: { id: string }) => String(p.id))).toContain(String(product.id));
    expect((await run('xentral_get_product', { id: product.id })).data.id).toBeDefined();
    expect((await run('xentral_get_product_stock', { id: product.id })).data.totals).toBeDefined();
    expect(Array.isArray((await run('xentral_list_product_storage_locations', { id: product.id })).data)).toBe(true);
  }, 60_000);

  it('reads warehouses, storage locations and what lies there', async () => {
    const warehouse = first(await run('xentral_list_warehouses'));
    if (!warehouse) return;
    const location = first(await run('xentral_list_storage_locations', { warehouseId: warehouse.id }));
    if (!location) return;
    const items = await run('xentral_list_storage_location_items', { warehouseId: warehouse.id, storageLocationId: location.id });
    expect(items).toBeDefined();
  }, 60_000);

  it('reads customers with addresses and suppliers', async () => {
    const customer = first(await run('xentral_list_customers', { pageSize: 10 }));
    if (customer) {
      const byNumber = await run('xentral_list_customers', { filter: [{ key: 'number', op: 'equals', value: customer.number }] });
      expect(byNumber.data.map((c: { id: string }) => String(c.id))).toContain(String(customer.id));
      expect((await run('xentral_get_customer', { id: customer.id })).data).toBeDefined();
      expect(Array.isArray((await run('xentral_list_customer_addresses', { customerId: customer.id })).data)).toBe(true);
    }
    const supplier = first(await run('xentral_list_suppliers', { pageSize: 10 }));
    if (supplier) expect((await run('xentral_get_supplier', { id: supplier.id })).data).toBeDefined();
  }, 60_000);

  it('reads sales documents with filters, search and their details', async () => {
    const since = `${new Date().getFullYear() - 1}-01-01`;
    for (const [list, get, filter] of [
      ['xentral_list_sales_orders', 'xentral_get_sales_order', [{ key: 'status', op: 'in', value: ['released', 'completed'] }]],
      ['xentral_list_delivery_notes', 'xentral_get_delivery_note', [{ key: 'documentDate', op: 'greaterThanOrEquals', value: since }]],
      ['xentral_list_invoices', 'xentral_get_invoice', [{ key: 'paymentStatus', op: 'in', value: ['pending', 'partiallyPaid', 'paid'] }]],
      ['xentral_list_credit_notes', 'xentral_get_credit_note', [{ key: 'documentDate', op: 'greaterThanOrEquals', value: since }]],
      ['xentral_list_purchase_orders', 'xentral_get_purchase_order', [{ key: 'status', op: 'notEquals', value: 'draft' }]],
    ] as Array<[string, string, unknown[]]>) {
      const page = await run(list, { filter, perPage: 5, sort: '-documentDate', pagination: 'table' });
      expect(Array.isArray(page.data)).toBe(true);
      const doc = first(page);
      if (!doc) continue;
      const one = await run(get, { id: doc.id });
      expect(String(one.data.id)).toBe(String(doc.id));
      if (doc.documentNumber) {
        const found = await run(list, { search: doc.documentNumber, perPage: 5 });
        expect(found.data.map((d: { id: string }) => String(d.id))).toContain(String(doc.id));
      }
      if (list === 'xentral_list_invoices') expect((await run('xentral_get_invoice_balance', { id: doc.id })).data).toBeDefined();
      if (list === 'xentral_list_credit_notes') expect((await run('xentral_get_credit_note_balance', { id: doc.id })).data).toBeDefined();
      if (list === 'xentral_list_delivery_notes') expect(Array.isArray((await run('xentral_list_delivery_note_shipments', { id: doc.id })).data)).toBe(true);
    }
  }, 180_000);

  it('reads liabilities, payment methods and projects', async () => {
    for (const name of ['xentral_list_liabilities', 'xentral_list_payment_methods', 'xentral_list_projects']) {
      expect(Array.isArray((await run(name)).data)).toBe(true);
    }
  }, 60_000);

  (write ? it : it.skip)('creates a sales order draft, reads it back and deletes it', async () => {
    const customerId = process.env.XENTRAL_TEST_CUSTOMER_ID ?? first(await run('xentral_list_customers'))?.id;
    const productId = process.env.XENTRAL_TEST_PRODUCT_ID ?? first(await run('xentral_list_products'))?.id;
    expect(customerId && productId).toBeTruthy();
    const project = process.env.XENTRAL_TEST_PROJECT_ID ? { id: process.env.XENTRAL_TEST_PROJECT_ID } : undefined;
    const created = await run('xentral_create_sales_order', {
      addressId: String(customerId),
      lineItems: [{ product: { id: String(productId) }, quantity: 1 }],
      project,
      customerOrderNumber: 'AnythingMCP live spec',
      internalComment: 'Created by the AnythingMCP live spec; safe to delete.',
    });
    const id = created.data?.id ?? created.id;
    expect(id).toBeDefined();
    try {
      const read = await run('xentral_get_sales_order', { id });
      expect(read.data.status).toBe('draft');
      expect(read.data.lineItems.length).toBe(1);
    } finally {
      await run('xentral_delete_sales_order_draft', { id });
    }
    await expect(run('xentral_get_sales_order', { id })).rejects.toMatchObject({ response: { status: 404 } });
  }, 90_000);
});
