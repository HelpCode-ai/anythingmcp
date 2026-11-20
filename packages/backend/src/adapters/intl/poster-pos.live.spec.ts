import axios from 'axios';
import * as adapter from './poster-pos.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { assertNoResponseBodyError, ResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Poster POS adapter (Poster Web API at joinposter.com/api).
 *
 * Static checks always run: the account token in the `token` query
 * parameter, every tool's method name against Poster's published API
 * documentation (github.com/joinposter/docs), the query names Poster uses
 * (dateFrom/dateTo on most reports, date_from/date_to on a few), the form
 * bodies of the writes, the rules that turn Poster's errors inside HTTP 200
 * into failed calls, and which tools install switched off. No tool opens,
 * pays or closes an order, and none changes loyalty points.
 * https://dev.joinposter.com/en/docs/v3/web/index
 *
 * Live checks run only with RUN_POSTER_POS_LIVE=1. Without credentials they
 * confirm how the API refuses a missing and a wrong token; with
 * POSTER_ACCESS_TOKEN they read the settings and the locations. Reads only.
 *
 *   RUN_POSTER_POS_LIVE=1 POSTER_ACCESS_TOKEN=... \
 *     npx jest src/adapters/intl/poster-pos.live.spec.ts
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
    bodyEncoding?: string;
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
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config: { errorWhen: unknown };
  };
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

const ENV: Record<string, string> = { POSTER_ACCESS_TOKEN: '687409:4164553abf6a031302898da7800b59fb' };
const BASE = 'https://joinposter.com/api';
const AUTH = { token: ENV.POSTER_ACCESS_TOKEN };

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
const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: { response: [] }, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const formOf = (req: { data?: unknown }) => Object.fromEntries(new URLSearchParams(String(req.data ?? '')));

// Tool, HTTP method and Poster API method, as in Poster's documentation.
const CONTRACT: Array<[string, string, string]> = [
  ['poster_pos_get_settings', 'GET', 'settings.getAllSettings'],
  ['poster_pos_list_spots', 'GET', 'access.getSpots'],
  ['poster_pos_list_registers', 'GET', 'access.getTablets'],
  ['poster_pos_list_employees', 'GET', 'access.getEmployees'],
  ['poster_pos_list_categories', 'GET', 'menu.getCategories'],
  ['poster_pos_list_products', 'GET', 'menu.getProducts'],
  ['poster_pos_get_product', 'GET', 'menu.getProduct'],
  ['poster_pos_list_ingredients', 'GET', 'menu.getIngredients'],
  ['poster_pos_list_transactions', 'GET', 'dash.getTransactions'],
  ['poster_pos_get_transaction', 'GET', 'dash.getTransaction'],
  ['poster_pos_list_transaction_products', 'GET', 'dash.getTransactionProducts'],
  ['poster_pos_list_orders', 'GET', 'transactions.getTransactions'],
  ['poster_pos_get_sales_analytics', 'GET', 'dash.getAnalytics'],
  ['poster_pos_get_product_sales', 'GET', 'dash.getProductsSales'],
  ['poster_pos_get_category_sales', 'GET', 'dash.getCategoriesSales'],
  ['poster_pos_get_waiter_sales', 'GET', 'dash.getWaitersSales'],
  ['poster_pos_get_client_sales', 'GET', 'dash.getClientsSales'],
  ['poster_pos_get_spot_sales', 'GET', 'dash.getSpotsSales'],
  ['poster_pos_get_payments_report', 'GET', 'dash.getPaymentsReport'],
  ['poster_pos_list_cash_shifts', 'GET', 'finance.getCashShifts'],
  ['poster_pos_list_clients', 'GET', 'clients.getClients'],
  ['poster_pos_get_client', 'GET', 'clients.getClient'],
  ['poster_pos_list_client_groups', 'GET', 'clients.getGroups'],
  ['poster_pos_create_client', 'POST', 'clients.createClient'],
  ['poster_pos_update_client', 'POST', 'clients.updateClient'],
  ['poster_pos_remove_client', 'POST', 'clients.removeClient'],
  ['poster_pos_list_storages', 'GET', 'storage.getStorages'],
  ['poster_pos_list_stock_leftovers', 'GET', 'storage.getStorageLeftovers'],
  ['poster_pos_get_stock_movement_report', 'GET', 'storage.getReportMovement'],
  ['poster_pos_list_suppliers', 'GET', 'storage.getSuppliers'],
  ['poster_pos_list_supplies', 'GET', 'storage.getSupplies'],
  ['poster_pos_list_supply_ingredients', 'GET', 'storage.getSupplyIngredients'],
  ['poster_pos_list_wastes', 'GET', 'storage.getWastes'],
  ['poster_pos_list_stock_transfers', 'GET', 'storage.getMoves'],
  ['poster_pos_create_supplier', 'POST', 'storage.createSupplier'],
];

describe('poster-pos adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the account token as the token query parameter on joinposter.com/api', () => {
    expect(a.slug).toBe('poster-pos');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('poster-pos');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ token: '{{POSTER_ACCESS_TOKEN}}' });
    // A JSON Content-Type on the connector would label the form bodies as JSON.
    expect(Object.keys(a.connector.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('content-type');
    expect(a.requiredEnvVars).toEqual(['POSTER_ACCESS_TOKEN']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.envVarMeta.POSTER_ACCESS_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta.POSTER_ACCESS_TOKEN.pattern!);
    for (const good of [ENV.POSTER_ACCESS_TOKEN, '861052:02391570ff9af128e93c5a771055ba88']) expect(pattern.test(good)).toBe(true);
    for (const bad of ['', '4164553abf6a031302898da7800b59fb', '687409: 4164553abf6a031302898da7800b59fb', 'token=687409:4164553abf6a031302898da7800b59fb']) {
      expect(pattern.test(bad)).toBe(false);
    }
  });

  it('probes the settings and explains 401, 403, 404 and the rate limit', () => {
    expect(a.probe).toEqual({ tool: 'poster_pos_get_settings' });
    expect(tool('poster_pos_get_settings').parameters.required ?? []).toEqual([]);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to the documented API method', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(CONTRACT.map(([name]) => name).sort());
    for (const [name, method, apiMethod] of CONTRACT) {
      const entry = tool(name);
      expect(entry.endpointMapping.method).toBe(method);
      expect(entry.endpointMapping.path).toBe(`/${apiMethod}`);
      if (method === 'POST') {
        expect(entry.endpointMapping.bodyEncoding).toBe('form-urlencoded');
        expect(entry.endpointMapping.bodyMapping).toBeDefined();
        expect(entry.endpointMapping.queryParams).toBeUndefined();
      } else {
        expect(entry.endpointMapping.bodyMapping).toBeUndefined();
      }
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^poster_pos_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(declared.has('token')).toBe(false);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('marks reads read-only, installs the customer removal switched off and never touches points or orders', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET';
      expect(annotationsOf(entry).readOnlyHint).toBe(read);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off).toEqual(['poster_pos_remove_client']);
    const writes = a.tools.filter((entry) => entry.endpointMapping.method !== 'GET').map((entry) => entry.name);
    expect(writes.sort()).toEqual([
      'poster_pos_create_client',
      'poster_pos_create_supplier',
      'poster_pos_remove_client',
      'poster_pos_update_client',
    ]);
    for (const entry of a.tools) {
      const path = entry.endpointMapping.path;
      for (const forbidden of ['Bonus', 'EWallet', 'PayedSum', 'payments.', 'incomingOrders.', 'createTransaction', 'closeTransaction', 'finance.create', 'finance.update']) {
        expect(path).not.toContain(forbidden);
      }
      const body = entry.endpointMapping.bodyMapping ?? {};
      expect(body).not.toHaveProperty('bonus');
      expect(body).not.toHaveProperty('total_payed_sum');
    }
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('turns the errors Poster answers with HTTP 200 into failed calls', () => {
    const rules = a.connector.config.errorWhen;
    const failure = (body: unknown) => {
      try {
        assertNoResponseBodyError(body, rules);
        return undefined;
      } catch (e) {
        return e as ResponseBodyError;
      }
    };
    expect(failure({ error: { code: 10, message: 'Access token is not defined' } })?.status).toBe(401);
    const wrong = failure({ error: { code: 11, message: 'Bad access token' } });
    expect(wrong?.status).toBe(401);
    expect(wrong?.message).toContain('Bad access token');
    expect(failure({ error: { code: 20, message: 'Method is not allowed' } })?.status).toBe(403);
    expect(failure({ error: { code: 32, message: 'ID does not exist' } })?.status).toBe(404);
    expect(failure({ error: { code: 700, message: 'Rate restriction' } })?.status).toBe(429);
    expect(failure({ error: { code: 34, message: 'Absence of required properties' } })?.status).toBe(400);
    // The second shape Poster uses: the code directly under error.
    const archived = failure({ error: 19, message: 'Database is archived' });
    expect(archived?.status).toBe(403);
    expect(archived?.message).toContain('Database is archived');
    expect(failure({ error: 42, message: 'Something else' })?.status).toBe(400);
    expect(failure({ response: [] })).toBeUndefined();
    expect(failure({ response: 4082 })).toBeUndefined();
    expect(failure({ response: { COMPANY_ID: 'demo', company_name: 'Demo' } })).toBeUndefined();
  });

  it('reads the settings and the menu with the token in the query', async () => {
    ok();
    await call('poster_pos_get_settings', {});
    let req = sent();
    expect(req.url).toBe(`${BASE}/settings.getAllSettings`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.params).toEqual(AUTH);
    expect(header(req, 'Authorization')).toBeUndefined();

    ok();
    await call('poster_pos_list_products', { category_id: 15, type: 'products' });
    req = sent();
    expect(req.url).toBe(`${BASE}/menu.getProducts`);
    expect(req.params).toEqual({ ...AUTH, category_id: 15, type: 'products' });

    ok();
    await call('poster_pos_get_product', { product_id: 175 });
    expect(sent().url).toBe(`${BASE}/menu.getProduct`);
    expect(sent().params).toEqual({ ...AUTH, product_id: 175 });
  });

  it('uses the date parameter names each Poster method documents', async () => {
    const range = { date_from: '20261101', date_to: '20261130' };

    ok();
    await call('poster_pos_list_transactions', { ...range, status: 2, include_products: true, timezone: 'client' });
    expect(sent().url).toBe(`${BASE}/dash.getTransactions`);
    expect(sent().params).toEqual({
      ...AUTH,
      dateFrom: '20261101',
      dateTo: '20261130',
      status: 2,
      include_products: true,
      timezone: 'client',
    });

    ok();
    await call('poster_pos_get_product_sales', { ...range, spot_id: 1 });
    expect(sent().url).toBe(`${BASE}/dash.getProductsSales`);
    expect(sent().params).toEqual({ ...AUTH, date_from: '20261101', date_to: '20261130', spot_id: 1 });

    ok();
    await call('poster_pos_get_payments_report', range);
    expect(sent().params).toEqual({ ...AUTH, date_from: '20261101', date_to: '20261130' });

    ok();
    await call('poster_pos_get_category_sales', range);
    expect(sent().url).toBe(`${BASE}/dash.getCategoriesSales`);
    expect(sent().params).toEqual({ ...AUTH, dateFrom: '20261101', dateTo: '20261130' });

    ok();
    await call('poster_pos_get_sales_analytics', { ...range, select: 'profit', interpolate: 'week', type: 'spots', id: 1 });
    expect(sent().url).toBe(`${BASE}/dash.getAnalytics`);
    expect(sent().params).toEqual({
      ...AUTH,
      dateFrom: '20261101',
      dateTo: '20261130',
      interpolate: 'week',
      select: 'profit',
      type: 'spots',
      id: 1,
    });

    ok();
    await call('poster_pos_list_cash_shifts', { ...range, timezone: 'client' });
    expect(sent().url).toBe(`${BASE}/finance.getCashShifts`);
    expect(sent().params).toEqual({ ...AUTH, dateFrom: '20261101', dateTo: '20261130', timezones: 'client' });

    ok();
    await call('poster_pos_list_orders', { date_from: '2026-11-01', date_to: '2026-11-30' });
    expect(sent().url).toBe(`${BASE}/transactions.getTransactions`);
    expect(sent().params).toEqual({ ...AUTH, date_from: '2026-11-01', date_to: '2026-11-30', per_page: 100, page: 1 });
  });

  it('reads customers and stock on the documented methods', async () => {
    ok();
    await call('poster_pos_list_clients', { phone: '+380501234567', num: 10, offset: 0 });
    expect(sent().url).toBe(`${BASE}/clients.getClients`);
    expect(sent().params).toEqual({ ...AUTH, phone: '+380501234567', num: 10, offset: 0 });

    ok();
    await call('poster_pos_list_stock_leftovers', { storage_id: 1, type: 4, zero_leftovers: true });
    expect(sent().url).toBe(`${BASE}/storage.getStorageLeftovers`);
    expect(sent().params).toEqual({ ...AUTH, storage_id: 1, type: 4, zero_leftovers: true });

    ok();
    await call('poster_pos_list_supply_ingredients', { supply_id: 77 });
    expect(sent().url).toBe(`${BASE}/storage.getSupplyIngredients`);
    expect(sent().params).toEqual({ ...AUTH, supply_id: 77 });
  });

  it('sends the writes as a form with the token still in the query', async () => {
    ok();
    await call('poster_pos_create_client', {
      client_name: 'Olena Popova',
      client_groups_id_client: 7,
      phone: '+380519911122',
      email: 'olena@example.org',
      birthday: '1986-11-23',
      client_sex: 2,
    });
    let req = sent();
    expect(req.url).toBe(`${BASE}/clients.createClient`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.params).toEqual(AUTH);
    expect(header(req, 'Content-Type')).toMatch(/application\/x-www-form-urlencoded/);
    expect(typeof req.data).toBe('string');
    expect(formOf(req)).toEqual({
      client_name: 'Olena Popova',
      client_groups_id_client: '7',
      phone: '+380519911122',
      email: 'olena@example.org',
      birthday: '1986-11-23',
      client_sex: '2',
    });

    ok();
    await call('poster_pos_update_client', { client_id: 4082, comment: 'Prefers the terrace' });
    req = sent();
    expect(req.url).toBe(`${BASE}/clients.updateClient`);
    expect(formOf(req)).toEqual({ client_id: '4082', comment: 'Prefers the terrace' });

    ok();
    await call('poster_pos_remove_client', { client_id: 4082 });
    req = sent();
    expect(req.url).toBe(`${BASE}/clients.removeClient`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(formOf(req)).toEqual({ client_id: '4082' });

    ok();
    await call('poster_pos_create_supplier', { supplier_name: 'Fresh Farm', supplier_phone: '+380671234567', supplier_comment: 'Meat' });
    req = sent();
    expect(req.url).toBe(`${BASE}/storage.createSupplier`);
    expect(req.params).toEqual(AUTH);
    expect(formOf(req)).toEqual({ supplier_name: 'Fresh Farm', supplier_phone: '+380671234567', supplier_comment: 'Meat' });
  });
});

// Opt-in: RUN_POSTER_POS_LIVE=1. The refusal checks need no account; the
// reads need POSTER_ACCESS_TOKEN. Nothing is written.
const live = process.env.RUN_POSTER_POS_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Poster POS: live', () => {
  it('answers a missing and a wrong token with an error inside HTTP 200', async () => {
    const missing = await liveFetch.get(`${BASE}/settings.getAllSettings`, { validateStatus: () => true });
    expect(missing.status).toBe(200);
    expect(missing.data.error.code).toBe(10);
    const wrong = await liveFetch.get(`${BASE}/settings.getAllSettings`, {
      params: { token: '1:abc' },
      validateStatus: () => true,
    });
    expect(wrong.status).toBe(200);
    expect(wrong.data.error.code).toBe(11);
    expect(() => assertNoResponseBodyError(wrong.data, a.connector.config.errorWhen)).toThrow(ResponseBodyError);
  });

  it('reads the settings and the locations', async () => {
    const token = process.env.POSTER_ACCESS_TOKEN;
    if (!token) throw new Error('Set POSTER_ACCESS_TOKEN for the live check');
    const settings = await liveFetch.get(`${BASE}/settings.getAllSettings`, { params: { token }, validateStatus: () => true });
    expect(settings.status).toBe(200);
    expect(settings.data.error).toBeUndefined();
    expect(settings.data.response.company_name).toBeDefined();
    const spots = await liveFetch.get(`${BASE}/access.getSpots`, { params: { token }, validateStatus: () => true });
    expect(spots.status).toBe(200);
    expect(Array.isArray(spots.data.response)).toBe(true);
  });
});
