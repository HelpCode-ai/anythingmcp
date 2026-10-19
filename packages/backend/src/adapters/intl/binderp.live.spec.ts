import axios from 'axios';
import * as adapter from './binderp.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Two layers of verification for the Bind ERP adapter:
 *
 *   1. Static: always runs. Pins the Bearer API key, the OData query options,
 *      every tool's method and path (from Bind's developer portal operation
 *      list), path-id encoding, and the writes (CFDI invoices among them)
 *      that ship switched off.
 *
 *   2. Live: skipped unless BINDERP_API_TOKEN is set. Reads only.
 *
 *        BINDERP_API_TOKEN=... npx jest src/adapters/intl/binderp.live.spec.ts
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

// A JWT-shaped string built at run time, so nothing here looks like a real key.
const TOKEN = ['eyJhbGciOiJIUzI1NiJ9', 'eyJ0ZXN0IjoidHJ1ZSJ9', 'c2lnbmF0dXJl'].join('.');
const ENV = { BINDERP_API_TOKEN: TOKEN };
const BASE = 'https://api.bind.com.mx';
const G = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
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
  'binderp_add_comment',
  'binderp_create_client',
  'binderp_create_invoice',
  'binderp_create_order',
  'binderp_create_product',
  'binderp_create_prospect',
  'binderp_create_quote',
  'binderp_update_client',
];

describe('binderp adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the API key as a Bearer token', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{BINDERP_API_TOKEN}}' });
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('binderp_get_company_profile', ENV, {});
    expect(sent().url).toBe(`${BASE}/api/CompanyProfile`);
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(a.probe).toEqual({ tool: 'binderp_get_company_profile' });
    const p = new RegExp(a.envVarMeta.BINDERP_API_TOKEN.pattern!);
    expect(p.test(TOKEN)).toBe(true);
    expect(p.test(`Bearer ${TOKEN}`)).toBe(false);
    expect(a.envVarMeta.BINDERP_API_TOKEN.secret).toBe(true);
  });

  it('maps filter, orderby, top and skip onto the OData $ options', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    await execute('binderp_list_invoices', ENV, { filter: "RFC eq 'XAXX010101000'", orderby: 'Date desc', top: 5, skip: 10 });
    expect(sent().url).toBe(`${BASE}/api/Invoices`);
    expect(sent().params).toEqual({ $filter: "RFC eq 'XAXX010101000'", $orderby: 'Date desc', $top: 5, $skip: 10 });
    mockedAxios.mockClear();
    await execute('binderp_list_clients', ENV, {});
    expect(sent().params).toEqual({});
  });

  // [tool, args, url]
  const table: Array<[string, Record<string, unknown>, string]> = [
    ['binderp_get_user_profile', {}, '/api/UserProfile'],
    ['binderp_get_client', { id: G }, `/api/Clients/${G}`],
    ['binderp_list_client_addresses', { id: G }, `/api/Clients/${G}/Addresses`],
    ['binderp_get_product', { id: G }, `/api/Products/${G}`],
    ['binderp_get_invoice', { idOrNumber: '1024' }, '/api/Invoices/1024'],
    ['binderp_get_invoice_xml', { id: G }, `/api/Invoices/${G}/xml`],
    ['binderp_list_invoice_payments', { invoiceID: G }, `/api/Invoices/Payment/${G}`],
    ['binderp_get_order', { id: G }, `/api/Orders/${G}`],
    ['binderp_get_quote', { id: G }, `/api/Quotes/${G}`],
    ['binderp_get_purchase_order', { id: G }, `/api/Purchases/${G}`],
    ['binderp_get_expense', { id: G }, `/api/Expenses/${G}`],
    ['binderp_list_purchase_orders', {}, '/api/Purchases/GetPurchaseOrders'],
    ['binderp_list_merchandise_receptions', {}, '/api/Inventory/GetMerchandiseReceptions'],
    ['binderp_list_transfers', {}, '/api/TransferMerchandise'],
  ];
  it.each(table)('%s reads %s', async (name, args, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute(name, ENV, args);
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(`${BASE}${path}`);
  });

  it('sends the warehouse and price list as query parameters', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await execute('binderp_list_products_with_price_and_inventory', ENV, { warehouseId: G, priceListId: G });
    expect(sent().url).toBe(`${BASE}/api/ProductsPriceAndInventory`);
    expect(sent().params).toEqual({ warehouseId: G, priceListId: G });
    mockedAxios.mockClear();
    await execute('binderp_get_inventory', ENV, { warehouseID: G, top: 2 });
    expect(sent().params).toEqual({ warehouseID: G, $top: 2 });
  });

  it('encodes path ids, so an id cannot reach another route', async () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('{'))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('binderp_get_invoice', ENV, { idOrNumber: '../Clients' });
    expect(sent().url).toBe(`${BASE}/api/Invoices/..%2FClients`);
  });

  it('marks every GET read-only and installs every write, CFDI invoices included, switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    }
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(WRITES_OFF);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(WRITES_OFF);
    expect(tool('binderp_create_invoice').description).toMatch(/SAT/);
    expect(annotationsOf(tool('binderp_create_invoice')).destructiveHint).toBe(true);
  });

  it('has no payment, bank, inventory adjustment or credit note tools', () => {
    const paths = a.tools.map((t) => `${t.endpointMapping.method} ${t.endpointMapping.path}`);
    for (const p of ['POST /api/Invoices/Payment', 'POST /api/BankAccounts', 'POST /api/Inventory', 'POST /api/CreditNotes', 'POST /api/AccountingJournals']) {
      expect(paths).not.toContain(p);
    }
  });

  it('sends only the fields given on a write', async () => {
    mockedAxios.mockResolvedValue({ data: G });
    await execute('binderp_create_prospect', ENV, { Name: 'Ana', Company: 'Acme' });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${BASE}/api/Prospects`);
    expect(sent().data).toEqual({ Name: 'Ana', Company: 'Acme' });
  });

  it('prefixes every tool, points the model only at tools that exist and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    expect(names.size).toBe(a.tools.length);
    for (const n of names) expect(n).toMatch(/^binderp_[a-z_]+$/);
    for (const m of a.instructions.matchAll(/\bbinderp_[a-z_]+/g)) expect(names).toContain(m[0]);
    expect(a.instructions).toMatch(/Generar API Key/);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.BINDERP_API_TOKEN ? describe : describe.skip;
live('binderp adapter: live reads', () => {
  const env = { BINDERP_API_TOKEN: process.env.BINDERP_API_TOKEN! };
  beforeAll(() => mockedAxios.mockImplementation((cfg: unknown) => (mockedAxios.__actual as any).request(cfg)));
  it.each([
    ['binderp_get_company_profile', {}],
    ['binderp_list_warehouses', { top: 2 }],
    ['binderp_list_clients', { top: 2 }],
    ['binderp_list_products', { top: 2 }],
    ['binderp_list_invoices', { top: 2, orderby: 'Date desc' }],
  ] as Array<[string, Record<string, unknown>]>)('%s answers', async (name, args) => {
    const res = await execute(name, env, args);
    expect(res).toBeDefined();
  }, 30000);
});
