import axios from 'axios';
import * as adapter from './cin7-core.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Cin7 Core adapter (formerly DEAR Inventory, External API v2; not Cin7 Omni).
 *
 * Static checks always run: the api-auth-accountid and
 * api-auth-applicationkey headers, every path below
 * https://inventory.dearsystems.com/ExternalApi/v2 as published in Cin7's
 * OpenAPI spec (https://coreapi.cin7.com/openapi.yaml) and the apiary
 * blueprint, Page/Limit paging, the two-step sale and purchase creation, no
 * payment, invoice or delete tools, and the stock adjustment installed
 * switched off.
 *
 * Live checks run only with RUN_CIN7_CORE_LIVE=1. Without credentials they
 * confirm wrong keys are refused; with CIN7_CORE_ACCOUNT_ID and
 * CIN7_CORE_APPLICATION_KEY they read /me and one page of sales. Reads only.
 *
 *   RUN_CIN7_CORE_LIVE=1 CIN7_CORE_ACCOUNT_ID=... CIN7_CORE_APPLICATION_KEY=... \
 *     npx jest src/adapters/intl/cin7-core.live.spec.ts
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
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
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

const ENV: Record<string, string> = {
  CIN7_CORE_ACCOUNT_ID: 'a1b2c3d4-e5f6-4711-8a9b-0c1d2e3f4a5b',
  CIN7_CORE_APPLICATION_KEY: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
};
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const SALE = '916ab4c0-6ccb-4c93-873d-0603859050e4';

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
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
const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });

const READ_PATHS = new Set([
  '/me', '/ref/location', '/product', '/ref/productavailability', '/saleList', '/sale', '/sale/order', '/sale/fulfilment',
  '/sale/invoice', '/sale/payment', '/purchaseList', '/advanced-purchase', '/purchase/order', '/customer', '/supplier',
  '/ref/tax', '/ref/paymentterm', '/stockadjustmentList', '/stockadjustment', '/stockTransferList', '/stockTransfer',
]);

describe('cin7-core adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the account id and application key headers to the v2 base', () => {
    expect(a.slug).toBe('cin7-core');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('erp');
    expect(a.icon).toBe('cin7-core');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'api-auth-applicationkey', apiKey: '{{CIN7_CORE_APPLICATION_KEY}}' });
    expect(a.connector.headers?.['api-auth-accountid']).toBe('{{CIN7_CORE_ACCOUNT_ID}}');
    expect(a.requiredEnvVars).toEqual(['CIN7_CORE_ACCOUNT_ID', 'CIN7_CORE_APPLICATION_KEY']);
    expect(a.envVarMeta.CIN7_CORE_APPLICATION_KEY).toMatchObject({ kind: 'credential', secret: true });
    const account = new RegExp(a.envVarMeta.CIN7_CORE_ACCOUNT_ID.pattern!);
    expect(account.test(ENV.CIN7_CORE_ACCOUNT_ID)).toBe(true);
    for (const bad of ['', 'AcmeTradingNZ', '12345']) expect(account.test(bad)).toBe(false);
    expect(new RegExp(a.envVarMeta.CIN7_CORE_APPLICATION_KEY.pattern!).test(ENV.CIN7_CORE_APPLICATION_KEY)).toBe(true);
  });

  it('explains Core versus Omni and the 60 calls per minute limit', () => {
    expect(a.instructions).toContain('cin7-omni');
    expect(a.instructions).toMatch(/DEAR/);
    expect(a.instructions).toMatch(/60 calls per minute/);
    expect(a.verifyHints['401']).toMatch(/Cin7 Omni/);
    expect(a.probe).toEqual({ tool: 'cin7_core_get_me', params: {} });
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^cin7_core_[a-z0-9_]+$/);
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

  it('reads on known paths, writes no payments, invoices or deletes, and installs the stock adjustment switched off', () => {
    for (const entry of a.tools) {
      const { method, path } = entry.endpointMapping;
      expect(annotationsOf(entry).readOnlyHint).toBe(method === 'GET');
      if (method === 'GET') expect(READ_PATHS.has(path)).toBe(true);
      expect(method).not.toBe('DELETE');
      if (/payment|invoice|creditnote/i.test(path)) expect(method).toBe('GET');
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off).toEqual(['cin7_core_create_stock_adjustment']);
    for (const name of ['cin7_core_create_sale_order', 'cin7_core_create_purchase_order', 'cin7_core_create_stock_adjustment', 'cin7_core_create_stock_transfer']) {
      expect(tool(name).parameters.properties!.status.default).toBe('DRAFT');
    }
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists sales with both auth headers and Page/Limit paging', async () => {
    ok();
    await call('cin7_core_list_sales', { search: 'SO-00001', status: 'ORDERED' });
    const req = sent();
    expect(req.url).toBe(`${BASE}/saleList`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.headers['api-auth-accountid']).toBe(ENV.CIN7_CORE_ACCOUNT_ID);
    expect(req.headers['api-auth-applicationkey']).toBe(ENV.CIN7_CORE_APPLICATION_KEY);
    expect(req.params).toEqual({ Search: 'SO-00001', Status: 'ORDERED', Page: 1, Limit: 100 });

    ok();
    await call('cin7_core_get_sale', { sale_id: SALE });
    expect(sent().url).toBe(`${BASE}/sale`);
    expect(sent().params).toEqual({ ID: SALE });

    ok();
    await call('cin7_core_get_product_availability', { sku: 'AF308', location: 'Main Warehouse' });
    expect(sent().url).toBe(`${BASE}/ref/productavailability`);
    expect(sent().params).toEqual({ Sku: 'AF308', Location: 'Main Warehouse', Page: 1, Limit: 100 });

    ok();
    await call('cin7_core_get_purchase_order', { purchase_id: SALE });
    expect(sent().url).toBe(`${BASE}/purchase/order`);
    expect(sent().params).toEqual({ TaskID: SALE });
  });

  it('creates a sale header, then its order lines, as Cin7 Core documents', async () => {
    ok();
    await call('cin7_core_create_sale', { customer: 'Acme Ltd', location: 'Main Warehouse', customer_reference: 'PO-77' });
    expect(sent().url).toBe(`${BASE}/sale`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ Customer: 'Acme Ltd', Location: 'Main Warehouse', SkipQuote: true, CustomerReference: 'PO-77' });

    ok();
    const lines = [{ SKU: 'Bread', Name: 'Baked Bread', Quantity: 1, Price: 8, Tax: 0, TaxRule: 'Tax on Sales' }];
    await call('cin7_core_create_sale_order', { sale_id: SALE, lines });
    expect(sent().url).toBe(`${BASE}/sale/order`);
    expect(sent().data).toEqual({ SaleID: SALE, Status: 'DRAFT', Lines: lines });

    ok();
    await call('cin7_core_create_stock_transfer', {
      from_location: 'Main Warehouse',
      to_location: 'Shop',
      completion_date: '2026-11-09T00:00:00',
      lines: [{ SKU: 'AF308', TransferQuantity: 5 }],
    });
    expect(sent().url).toBe(`${BASE}/stockTransfer`);
    expect(sent().data).toEqual({
      FromLocation: 'Main Warehouse',
      ToLocation: 'Shop',
      Status: 'DRAFT',
      CompletionDate: '2026-11-09T00:00:00',
      Lines: [{ SKU: 'AF308', TransferQuantity: 5 }],
    });
  });
});

// Opt-in: RUN_CIN7_CORE_LIVE=1. The refusal check needs no account; the reads
// need CIN7_CORE_ACCOUNT_ID and CIN7_CORE_APPLICATION_KEY. Nothing is written.
const live = process.env.RUN_CIN7_CORE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Cin7 Core: live', () => {
  it('refuses wrong keys', async () => {
    const response = await liveFetch.get(`${BASE}/me`, {
      headers: { 'api-auth-accountid': ENV.CIN7_CORE_ACCOUNT_ID, 'api-auth-applicationkey': ENV.CIN7_CORE_APPLICATION_KEY },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads the account and one page of sales', async () => {
    const accountId = process.env.CIN7_CORE_ACCOUNT_ID;
    const key = process.env.CIN7_CORE_APPLICATION_KEY;
    if (!accountId || !key) throw new Error('Set CIN7_CORE_ACCOUNT_ID and CIN7_CORE_APPLICATION_KEY for the live check');
    const headers = { 'api-auth-accountid': accountId, 'api-auth-applicationkey': key };
    const me = await liveFetch.get(`${BASE}/me`, { headers, validateStatus: () => true });
    expect(me.status).toBe(200);
    const sales = await liveFetch.get(`${BASE}/saleList`, { headers, params: { Page: 1, Limit: 1 }, validateStatus: () => true });
    expect(sales.status).toBe(200);
    expect(sales.data).toHaveProperty('Total');
  });
});
