import axios from 'axios';
import { existsSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import * as adapter from './skuvault.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { assertNoResponseBodyError } from '../../connectors/engines/response-error.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * SkuVault (Linnworks) read-only adapter.
 *
 * Static checks always run. They pin the login at
 * POST https://app.skuvault.com/api/gettokens (Email + Password, TenantToken
 * and UserToken) and the four read calls against the published reference
 * (https://dev.skuvault.com/reference/):
 *   POST /products/getProducts
 *   POST /inventory/getInventoryByLocation
 *   POST /inventory/getWarehouses
 *   POST /sales/getSales
 * Both tokens are sent in the JSON body. Calls run through the real
 * RestEngine and LoginTokenService with axios mocked.
 *
 * Live checks run only with RUN_SKUVAULT_LIVE=1. Without SKUVAULT_EMAIL and
 * SKUVAULT_PASSWORD they confirm gettokens still answers HTTP 200 with both
 * tokens null for a bad login, which is what the public API did on
 * 2026-11-23. With both variables set they sign in and read warehouses
 * (one call; that endpoint allows 1 request per minute):
 *
 *   RUN_SKUVAULT_LIVE=1 SKUVAULT_EMAIL=... SKUVAULT_PASSWORD=... \
 *     npx jest src/adapters/intl/skuvault.live.spec.ts
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

type Tool = {
  name: string;
  description: string;
  parameters: {
    properties?: Record<string, { description?: string; default?: unknown }>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    bodyMapping?: Record<string, string>;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

const a = adapter as unknown as {
  slug: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers: Record<string, string>;
    config?: { errorWhen?: unknown };
  };
  tools: Tool[];
};

const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({
    name: entry.name,
    connectorType: 'REST',
    endpointMapping: entry.endpointMapping,
    annotations: entry.annotations,
  });

const ENV = {
  SKUVAULT_EMAIL: 'warehouse@example.com',
  SKUVAULT_PASSWORD: 'warehouse-password',
};
const TENANT = 'tenant-token';
const USER = 'user-token';
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
const fakeBundle = async () => ({ token: TENANT, aud: USER, expiresAt: Date.now() + 2_592_000_000 });
const stubLogin = { getToken: fakeBundle, forceRelogin: fakeBundle } as unknown as LoginTokenService;

const call = (name: string, params: Record<string, unknown>) =>
  new RestEngine({} as OAuth2TokenService, stubLogin).execute(
    {
      baseUrl: a.connector.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: a.connector.headers,
    } as never,
    tool(name).endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  ) as Promise<{ body: unknown }>;

const sent = () => mockedAxios.mock.calls.at(-1)![0];

describe('skuvault adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with email and password and sends both tokens in the body', () => {
    expect(a.slug).toBe('skuvault');
    expect(a.category).toBe('inventory');
    expect(a.icon).toBe('skuvault');
    expect(a.connector.baseUrl).toBe('https://app.skuvault.com/api');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.requiredEnvVars).toEqual(['SKUVAULT_EMAIL', 'SKUVAULT_PASSWORD']);
    const auth = a.connector.authConfig;
    expect(auth.loginUrl).toBe('https://app.skuvault.com/api/gettokens');
    expect(auth.loginMethod).toBe('POST');
    expect(auth.loginBody).toEqual({ Email: '${username}', Password: '${password}' });
    expect(auth.username).toBe('{{SKUVAULT_EMAIL}}');
    expect(auth.password).toBe('{{SKUVAULT_PASSWORD}}');
    expect(auth.tokenJsonPath).toBe('TenantToken');
    expect(auth.audJsonPath).toBe('UserToken');
    expect(auth.tokenPlacement).toBe('body');
    expect(auth.tokenTTLSeconds).toBe(2592000);
    expect(auth.refreshOn401).toBe(true);
    expect(auth.headerName).toBeUndefined();
    expect(auth.headerTemplate).toBeUndefined();
    const described = describeAdapterEnvVars(a as never);
    expect(described.map((entry) => entry.name)).toEqual(a.requiredEnvVars);
    expect(described.find((entry) => entry.name === 'SKUVAULT_PASSWORD')).toMatchObject({
      kind: 'credential',
      secret: true,
      required: true,
    });
    expect(existsSync(join(__dirname, '../../../../frontend/public/logos/connectors/skuvault.svg'))).toBe(true);
  });

  it('accepts an email and refuses a blank or a URL', () => {
    const email = new RegExp(a.envVarMeta.SKUVAULT_EMAIL.pattern!);
    expect(email.test('warehouse@example.com')).toBe(true);
    for (const bad of ['', 'warehouse', 'warehouse@', 'not an email', 'https://app.skuvault.com']) {
      expect(email.test(bad)).toBe(false);
    }
  });

  it('reads TenantToken and UserToken, and treats null tokens as a refused login', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as never;
    mockedAxios.mockResolvedValueOnce({
      data: { TenantToken: TENANT, UserToken: USER },
      headers: {},
    });
    const bundle = await new LoginTokenService({} as never, config).getToken(auth);
    const login = sent();
    expect(login.method).toBe('POST');
    expect(login.url).toBe('https://app.skuvault.com/api/gettokens');
    expect(login.data).toEqual({ Email: ENV.SKUVAULT_EMAIL, Password: ENV.SKUVAULT_PASSWORD });
    expect(bundle.token).toBe(TENANT);
    expect(bundle.aud).toBe(USER);
    expect(bundle.expiresAt - Date.now()).toBeGreaterThan(2_500_000_000);
    expect(bundle.expiresAt - Date.now()).toBeLessThanOrEqual(2_592_000_000);

    mockedAxios.mockResolvedValueOnce({
      data: { TenantToken: null, UserToken: null },
      headers: {},
    });
    await expect(new LoginTokenService({} as never, config).getToken(auth, 'other-connector')).rejects.toThrow(
      /the token at "TenantToken" was null/,
    );
  });

  it('probes warehouses and explains 401, 404, 400, and throttling', () => {
    expect(a.probe).toEqual({ tool: 'skuvault_get_warehouses', params: { page_number: 0 } });
    expect(tool('skuvault_get_warehouses').parameters.required ?? []).toEqual([]);
    for (const status of ['400', '401', '404', 'rate_limited']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('keeps the four read tools on the documented paths and sends no writes', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual([
      'skuvault_get_products',
      'skuvault_get_inventory_by_location',
      'skuvault_get_warehouses',
      'skuvault_get_sales',
    ]);
    expect(tool('skuvault_get_products').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/products/getProducts',
    });
    expect(tool('skuvault_get_inventory_by_location').endpointMapping.path).toBe(
      '/inventory/getInventoryByLocation',
    );
    expect(tool('skuvault_get_warehouses').endpointMapping.path).toBe('/inventory/getWarehouses');
    expect(tool('skuvault_get_sales').endpointMapping.path).toBe('/sales/getSales');
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('POST');
      expect(entry.endpointMapping.bodyMapping).toMatchObject({
        TenantToken: '$loginToken',
        UserToken: '$loginAud',
      });
      expect(annotationsOf(entry).readOnlyHint).toBe(true);
      expect(annotationsOf(entry).destructiveHint).toBe(false);
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
      for (const property of Object.values(entry.parameters.properties ?? {})) {
        expect(property.description).toBeTruthy();
      }
    }
  });

  it('prefixes every tool with skuvault_ and shares no tool name', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^skuvault_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
  });

  it('names every tool in the instructions and writes no em dash', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    expect(a.description.length).toBeGreaterThan(40);
  });

  it('posts products, locations, warehouses, and sales with the tokens and the defaults', async () => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await call('skuvault_get_warehouses', {});
    expect(sent().url).toBe('https://app.skuvault.com/api/inventory/getWarehouses');
    expect(sent().data).toEqual({ TenantToken: TENANT, UserToken: USER, PageNumber: 0 });
    expect(sent().headers.Authorization).toBeUndefined();

    await call('skuvault_get_products', { product_skus: ['WIDGET-1'], modified_after: '2026-01-15T00:00:00Z' });
    expect(sent().url).toBe('https://app.skuvault.com/api/products/getProducts');
    expect(sent().data).toEqual({
      TenantToken: TENANT,
      UserToken: USER,
      ProductSKUs: ['WIDGET-1'],
      ModifiedAfterDateTimeUtc: '2026-01-15T00:00:00Z',
      PageNumber: 0,
      PageSize: 1000,
    });
    expect(sent().data.ProductCodes).toBeUndefined();

    await call('skuvault_get_inventory_by_location', { product_codes: ['CODE-1'], is_return_by_codes: true });
    expect(sent().data).toEqual({
      TenantToken: TENANT,
      UserToken: USER,
      ProductCodes: ['CODE-1'],
      IsReturnByCodes: true,
      PageNumber: 0,
      PageSize: 1000,
    });

    await call('skuvault_get_sales', { order_ids: ['10001'] });
    expect(sent().url).toBe('https://app.skuvault.com/api/sales/getSales');
    expect(sent().data).toEqual({
      TenantToken: TENANT,
      UserToken: USER,
      Status: 'ReadyToShip',
      OrderIds: ['10001'],
    });
  });

  it('keeps the useful product, location, warehouse, and sale fields and drops the rest', () => {
    const products = applyResponseTransform(
      {
        Products: [
          {
            Id: 'p1',
            Code: 'CODE-1',
            Sku: 'WIDGET-1',
            PrimarySku: 'WIDGET-1',
            Description: 'A widget',
            LongDescription: '<p>a very long page</p>',
            Cost: 2.5,
            RetailPrice: 9,
            SalePrice: 8,
            Brand: 'Acme',
            Supplier: 'Mill',
            QuantityOnHand: 4,
            QuantityAvailable: 3,
            IsAlternateSKU: false,
            Pictures: ['https://example.test/a.jpg'],
            Attributes: [{ Name: 'Color', Value: 'Red' }],
          },
        ],
        Errors: [],
      },
      tool('skuvault_get_products').responseMapping,
    ).value as { products: Array<Record<string, unknown>> };
    expect(products.products[0]).toMatchObject({
      id: 'p1',
      code: 'CODE-1',
      sku: 'WIDGET-1',
      description: 'A widget',
      quantity_available: 3,
      is_alternate_sku: false,
    });
    expect(products.products[0].LongDescription).toBeUndefined();
    expect(JSON.stringify(products)).not.toContain('very long page');
    expect(JSON.stringify(products)).not.toContain('example.test');

    const locations = applyResponseTransform(
      {
        Errors: [],
        Items: { 'WIDGET-1': [{ LocationCode: 'A-1', Quantity: 3, Reserve: false, WarehouseCode: 'MAIN' }] },
      },
      tool('skuvault_get_inventory_by_location').responseMapping,
    ).value;
    expect(locations).toEqual({
      errors: [],
      items: { 'WIDGET-1': [{ LocationCode: 'A-1', Quantity: 3, Reserve: false, WarehouseCode: 'MAIN' }] },
    });

    const warehouses = applyResponseTransform(
      { Warehouses: [{ Id: '9', Code: 'MAIN', Name: 'Main floor' }] },
      tool('skuvault_get_warehouses').responseMapping,
    ).value;
    expect(warehouses).toEqual({ warehouses: [{ id: '9', code: 'MAIN' }] });

    const sales = applyResponseTransform(
      {
        Sales: [
          {
            Id: 'sale-1',
            SellerSaleId: '10001',
            Status: 'ReadyToShip',
            Marketplace: 'Shopify',
            SaleDate: '2026-02-01T00:00:00Z',
            ShippingCost: { a: 4.5, s: '$' },
            ShippingInfo: {
              City: 'Austin',
              Region: 'TX',
              Country: 'US',
              PostalCode: '78701',
              Address1: '1 Secret St',
              Address2: 'Apt 2',
            },
            ContactInfo: {
              FirstName: 'Ada',
              LastName: 'Lovelace',
              Company: 'Analytical',
              Phone: '555-0100',
              Email: 'ada@example.com',
            },
            SaleItems: [{ Sku: 'WIDGET-1', Quantity: 2, UnitPrice: { a: 8, s: '$' }, Taxes: 0.6 }],
            SaleKits: [],
            Notes: 'leave at dock',
          },
        ],
      },
      tool('skuvault_get_sales').responseMapping,
    ).value as { sales: Array<Record<string, unknown>> };
    expect(sales.sales[0]).toMatchObject({
      id: 'sale-1',
      seller_sale_id: '10001',
      status: 'ReadyToShip',
      marketplace: 'Shopify',
      shipping_cost: { a: 4.5, s: '$' },
      shipping: { city: 'Austin', region: 'TX', country: 'US', postal_code: '78701' },
      contact: { first_name: 'Ada', last_name: 'Lovelace', company: 'Analytical' },
      items: [{ sku: 'WIDGET-1', quantity: 2, unit_price: { a: 8, s: '$' }, taxes: 0.6 }],
      notes: 'leave at dock',
    });
    const saleText = JSON.stringify(sales);
    expect(saleText).not.toContain('Secret St');
    expect(saleText).not.toContain('555-0100');
    expect(saleText).not.toContain('ada@example.com');
  });

  it('fails a 200 whose Errors list is not empty, and lets an empty list through', () => {
    expect(() =>
      assertNoResponseBodyError({ Errors: ['SKU not found'], Products: [] }, a.connector.config?.errorWhen),
    ).toThrow(/SKU not found/);
    expect(() =>
      assertNoResponseBodyError({ Errors: [], Products: [] }, a.connector.config?.errorWhen),
    ).not.toThrow();
  });
});

const live = process.env.RUN_SKUVAULT_LIVE === '1' ? describe : describe.skip;

live('skuvault adapter: live', () => {
  const email = process.env.SKUVAULT_EMAIL;
  const password = process.env.SKUVAULT_PASSWORD;

  it('refuses a bad login, or reads warehouses when credentials are set', async () => {
    const realAxios = mockedAxios.__actual;
    if (!email || !password) {
      const response = await realAxios({
        method: 'POST',
        url: 'https://app.skuvault.com/api/gettokens',
        data: { Email: 'not-a-user@example.com', Password: 'not-the-password' },
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 20000,
        validateStatus: () => true,
      });
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ TenantToken: null, UserToken: null });
      return;
    }

    mockedAxios.mockImplementation((request: unknown) => realAxios(request as never));
    const auth = interpolateDeep(a.connector.authConfig, {
      SKUVAULT_EMAIL: email,
      SKUVAULT_PASSWORD: password,
    });
    const login = new LoginTokenService({} as never, config);
    const bundle = await login.getToken(auth as never);
    expect(bundle.token).toEqual(expect.any(String));
    expect(bundle.aud).toEqual(expect.any(String));
    const out = (await new RestEngine({} as OAuth2TokenService, login).execute(
      {
        baseUrl: a.connector.baseUrl,
        authType: 'LOGIN_TOKEN',
        authConfig: auth,
        headers: a.connector.headers,
      } as never,
      tool('skuvault_get_warehouses').endpointMapping,
      { page_number: 0 },
    )) as { body: { Warehouses?: unknown } };
    expect(Array.isArray(out.body?.Warehouses)).toBe(true);
  });
});
