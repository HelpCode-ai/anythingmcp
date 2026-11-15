import axios from 'axios';
import * as adapter from './ceneo-orders.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Ceneo "Kup na Ceneo" orders adapter (developers.ceneo.pl).
 *
 * The part of the Ceneo API that takes a bearer token: the order calls of
 * BasketService.svc and the two v3 category calls. The functions that take
 * the API key as a parameter (price analysis, bids, offer updates, limits)
 * are the separate `ceneo` adapter, which this one shares no tool with.
 *
 * Static checks always run: the sign-in (LOGIN_TOKEN: the API key in
 * `Authorization: Basic`, the 15-minute token read from the `access_token`
 * response header, through the real LoginTokenService), every tool's path
 * against Ceneo's Swagger file, the annotations (this API changes data with
 * GET requests, so the write tools are marked as writes by hand), and which
 * tools install switched off (order confirmation and order cancellation).
 * https://developers.ceneo.pl/swagger/ui/index
 *
 * Live checks run only with RUN_CENEO_ORDERS_LIVE=1. Without a key they
 * confirm Ceneo refuses a made-up one; with CENEO_API_KEY they fetch a token
 * and read the order states and the newest orders. Reads only.
 *
 *   RUN_CENEO_ORDERS_LIVE=1 CENEO_API_KEY=... npx jest src/adapters/pl/ceneo-orders.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; pattern?: string }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
    download?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; example?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: Record<string, unknown>;
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
  walk(m.download ?? {});
  return out;
};
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

const BASE = 'https://developers.ceneo.pl';
const TOKEN_URL = `${BASE}/AuthorizationService.svc/GetToken?grantType='client_credentials'`;
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['0F1E2D3C', '4B5A', '6978', '8796', 'A5B4C3D2E1F0'].join('-');
const FAKE_TOKEN = ['tok', 't'.repeat(40)].join('-');
const ORDER_ID = 'a68fad07-7402-49ed-a373-ac59881911aa';
const ENV: Record<string, string> = { CENEO_API_KEY: FAKE_KEY };
const order = (suffix = '') => `${BASE}/BasketService.svc/Orders(guid'${ORDER_ID}')${suffix}`;

// A signed-in connector: the engine asks the login service for the token.
const signedIn = { getToken: jest.fn().mockResolvedValue({ token: FAKE_TOKEN }) } as unknown as LoginTokenService;
// The real login service, with nothing stored yet.
const realLogin = () => {
  const prisma = {
    connectorAuthCache: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
  };
  const login = new LoginTokenService(prisma as never, { get: jest.fn().mockReturnValue('k'.repeat(48)) } as never);
  return { login, prisma };
};

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>, login: LoginTokenService = signedIn, connectorId?: string) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, login).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
      ...(connectorId ? { connectorId } : {}),
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200, data: unknown = {}) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// Every tool with its method, its path below the base URL and its required arguments,
// as the vendor documents them.
const EXPECTED: Array<[string, string, string, string[]]> = [
  ['ceneo_orders_list_orders', 'GET', '/BasketService.svc/Orders', []],
  ['ceneo_orders_get_order', 'GET', "/BasketService.svc/Orders(guid'{order_id}')", ['order_id']],
  ['ceneo_orders_get_order_items', 'GET', "/BasketService.svc/Orders(guid'{order_id}')/OrderItems", ['order_id']],
  ['ceneo_orders_get_order_shipping_data', 'GET', "/BasketService.svc/Orders(guid'{order_id}')/ShippingData", ['order_id']],
  ['ceneo_orders_get_order_invoice_data', 'GET', "/BasketService.svc/Orders(guid'{order_id}')/InvoiceData", ['order_id']],
  ['ceneo_orders_get_order_pickup_point', 'GET', "/BasketService.svc/Orders(guid'{order_id}')/PickupPoint", ['order_id']],
  ['ceneo_orders_list_order_states', 'GET', '/BasketService.svc/OrderStates', []],
  ['ceneo_orders_list_parcel_carriers', 'GET', '/BasketService.svc/ParcelCarriers', []],
  ['ceneo_orders_list_cancellation_reasons', 'GET', '/BasketService.svc/OrderCancellationReasons', []],
  ['ceneo_orders_confirm_order', 'GET', '/BasketService.svc/ConfirmOrder', ['order_id']],
  ['ceneo_orders_set_order_shipment', 'GET', '/BasketService.svc/SetOrderShipment', ['order_id', 'tracking_number', 'carrier_id']],
  ['ceneo_orders_send_order', 'GET', '/BasketService.svc/SendOrder', ['order_id']],
  ['ceneo_orders_cancel_order', 'GET', '/BasketService.svc/CancelOrder', ['order_id', 'reason_id']],
  ['ceneo_orders_list_categories', 'GET', '/api/v3/GetCategories', []],
  ['ceneo_orders_get_top_category_products', 'GET', '/api/v3/GetTopCategoryProducts', ['category_name']],
];
// GET requests that change data, with the destructive one marked.
const WRITES: Record<string, { destructive: boolean }> = {
  ceneo_orders_confirm_order: { destructive: false },
  ceneo_orders_set_order_shipment: { destructive: false },
  ceneo_orders_send_order: { destructive: false },
  ceneo_orders_cancel_order: { destructive: true },
};

describe('ceneo-orders adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with the API key for a 15-minute token that Ceneo answers in a response header', () => {
    expect(a.slug).toBe('ceneo-orders');
    expect(a.name).toBe('Ceneo: Kup na Ceneo orders');
    expect(a.region).toBe('pl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('ceneo-orders');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toEqual({
      loginUrl: TOKEN_URL,
      loginMethod: 'GET',
      loginHeaders: { Authorization: 'Basic {{CENEO_API_KEY}}' },
      loginBody: {},
      username: '{{CENEO_API_KEY}}',
      password: '{{CENEO_API_KEY}}',
      tokenSource: 'header',
      tokenHeaderName: 'access_token',
      tokenTTLSeconds: 900,
      proactiveRefreshSeconds: 120,
      refreshOn401: true,
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
    });
    expect(a.connector.headers).toEqual({ Accept: 'application/json' });
    expect(a.requiredEnvVars).toEqual(['CENEO_API_KEY']);
    expect(a.envVarMeta.CENEO_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta.CENEO_API_KEY.pattern!);
    expect(pattern.test(FAKE_KEY)).toBe(true);
    expect(pattern.test(a.envVarMeta.CENEO_API_KEY.example!)).toBe(true);
    for (const bad of ['', `Basic ${FAKE_KEY}`, 'not-a-key', `${FAKE_KEY} `]) expect(pattern.test(bad)).toBe(false);
  });

  it('logs in through the real login service: the key in the header, the token from the access_token header', async () => {
    const { login, prisma } = realLogin();
    // Ceneo's GetToken: an empty body, the token and its lifetime in the headers.
    mockedAxios.mockResolvedValueOnce({ status: 200, data: '', headers: { access_token: FAKE_TOKEN, expires_in: '900', token_type: 'bearer' } });
    ok(200, { d: { results: [] } });
    const before = Date.now();

    await call('ceneo_orders_list_order_states', {}, login, 'conn-ceneo-orders');

    expect(mockedAxios).toHaveBeenCalledTimes(2);
    const [[loginCall], [apiCall]] = mockedAxios.mock.calls;
    expect(loginCall.method).toBe('GET');
    expect(loginCall.url).toBe(TOKEN_URL);
    expect(header(loginCall, 'Authorization')).toBe(`Basic ${FAKE_KEY}`);
    // Nothing but the header carries the key: no query parameters, no body.
    expect(loginCall.params).toEqual({});
    expect(loginCall.data).toBeUndefined();

    expect(apiCall.url).toBe(`${BASE}/BasketService.svc/OrderStates`);
    expect(header(apiCall, 'Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(apiCall.params).toEqual({ $format: 'json' });
    // The key itself goes to the token call only.
    expect(JSON.stringify([apiCall.url, apiCall.params, apiCall.headers])).not.toContain(FAKE_KEY);

    // Kept for its 15 minutes: the next call does not log in again.
    const stored = prisma.connectorAuthCache.upsert.mock.calls[0][0];
    expect(stored.where).toEqual({ connectorId: 'conn-ceneo-orders' });
    const expiresAt = new Date(stored.create.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
    ok(200, { d: [] });
    await call('ceneo_orders_list_parcel_carriers', {}, login, 'conn-ceneo-orders');
    expect(mockedAxios).toHaveBeenCalledTimes(3);
    expect(sent().url).toBe(`${BASE}/BasketService.svc/ParcelCarriers`);
    expect(header(sent(), 'Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('finds the token whatever case the header name arrives in', async () => {
    const { login } = realLogin();
    mockedAxios.mockResolvedValueOnce({ status: 200, data: '', headers: { Access_Token: FAKE_TOKEN } });
    ok(200, { d: { results: [] } });
    await call('ceneo_orders_list_orders', {}, login, 'conn-ceneo-orders-case');
    expect(header(sent(), 'Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('fails the sign-in when Ceneo answers without the access_token header, and calls no tool', async () => {
    const { login } = realLogin();
    mockedAxios.mockResolvedValueOnce({ status: 200, data: '', headers: { token_type: 'bearer' } });

    await expect(call('ceneo_orders_list_orders', {}, login, 'conn-ceneo-orders-2')).rejects.toThrow(
      'LOGIN_TOKEN: header "access_token" not found in the login response headers',
    );
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  it('holds only calls that take the bearer token, and never sends the key as a parameter', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('GET');
      expect([entry.name, /^\/(BasketService\.svc|api\/v3)\//.test(entry.endpointMapping.path)]).toEqual([entry.name, true]);
      expect(entry.endpointMapping.path).not.toContain('/api/v2/function/');
      expect(entry.endpointMapping.queryParams?.apiKey).toBeUndefined();
      expect(JSON.stringify(entry.endpointMapping)).not.toContain('CENEO_API_KEY');
    }
    // The key-as-parameter functions answer inside a Response envelope; nothing here does.
    expect(a.connector.config).toBeUndefined();
  });

  it('asks the order service for JSON and guards the order id that sits inside the path', () => {
    for (const entry of a.tools) {
      const path = entry.endpointMapping.path;
      if (path.startsWith('/BasketService.svc/Orders') || /\/(OrderStates|ParcelCarriers|OrderCancellationReasons)$/.test(path)) {
        expect([entry.name, entry.endpointMapping.queryParams?.$format]).toEqual([entry.name, 'json']);
      }
      if (path.includes('{order_id}')) {
        expect(path).toContain("(guid'{order_id}')");
        expect([entry.name, entry.endpointMapping.encodePathParams]).toEqual([entry.name, true]);
      }
      const orderId = entry.parameters.properties?.order_id;
      if (orderId) {
        const guid = new RegExp(orderId.pattern!);
        expect(guid.test(ORDER_ID)).toBe(true);
        expect(guid.test(ORDER_ID.toUpperCase())).toBe(true);
        for (const bad of ['1234567ABC', `${ORDER_ID}')/OrderItems`, '']) expect(guid.test(bad)).toBe(false);
      }
    }
  });

  it('marks the GET requests that change data as writes', () => {
    for (const [name, { destructive }] of Object.entries(WRITES)) {
      expect([name, tool(name).annotations]).toEqual([name, { readOnlyHint: false, destructiveHint: destructive, idempotentHint: true }]);
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: destructive });
      expect(tool(name).description).toContain('it is a write');
    }
    for (const entry of a.tools) {
      if (!(entry.name in WRITES)) expect([entry.name, entry.annotations]).toEqual([entry.name, { readOnlyHint: true }]);
    }
  });

  it('probes the order states and explains 400, 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'ceneo_orders_list_order_states', params: {} });
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('exposes every tool on the documented method and path, with its required arguments', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(EXPECTED.map(([name]) => name));
    for (const [name, method, path, required] of EXPECTED) {
      const entry = tool(name);
      expect([name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([name, method, path]);
      expect(entry.parameters.required ?? []).toEqual(required);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^ceneo_orders_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, schema] of Object.entries(entry.parameters.properties ?? {})) expect([param, Boolean(schema.description)]).toEqual([param, true]);
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
      // No text points at a tool of the other Ceneo connector by its old name.
      const texts = [entry.description, ...Object.values(entry.parameters.properties ?? {}).map((p) => p.description ?? '')];
      for (const text of texts) expect(text.replace(/ceneo_orders_/g, '')).not.toMatch(/ceneo_[a-z]/);
    }
  });

  it('derives read-only for the reads only and installs confirmation and cancellation switched off', () => {
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, !(entry.name in WRITES)]);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['ceneo_orders_cancel_order', 'ceneo_orders_confirm_order']);
    for (const name of off) expect(tool(name).description).toContain('Installed switched off');
    for (const entry of a.tools) {
      if (!off.includes(entry.name)) expect(entry.description).not.toContain('switched off');
    }
  });

  it('says what it needs, names every tool and points to the Ceneo connector for offers and bids', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    expect(a.instructions).toContain('"Kup na Ceneo"');
    expect(a.instructions).toContain('**Setup');
    expect(a.instructions).toContain('**Where to start**');
    expect(a.instructions).toMatch(/Price analysis, position bids, quick offer updates and the call limits are in the separate \*\*Ceneo\*\* connector \(`ceneo`\)/);
    expect(a.prerequisites).toContain('"Kup na Ceneo"');
    const texts = [a.description, a.instructions, ...a.tools.flatMap((entry) => [entry.description, ...Object.values(entry.parameters.properties ?? {}).map((p) => p.description ?? '')])];
    for (const text of texts) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/—/);
    }
  });

  it('lists orders with OData options and reads one order and its parts by GUID', async () => {
    ok();
    await call('ceneo_orders_list_orders', {});
    expect(sent().url).toBe(`${BASE}/BasketService.svc/Orders`);
    expect(sent().params).toEqual({ $orderby: 'CreatedDate desc', $format: 'json' });
    expect(header(sent(), 'Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(header(sent(), 'Accept')).toBe('application/json');

    ok();
    await call('ceneo_orders_list_orders', { filter: 'OrderStateId eq 1', orderby: 'OrderValue desc', skip: 20 });
    expect(sent().params).toEqual({ $filter: 'OrderStateId eq 1', $orderby: 'OrderValue desc', $skip: 20, $format: 'json' });

    for (const [name, suffix] of [
      ['ceneo_orders_get_order', ''],
      ['ceneo_orders_get_order_items', '/OrderItems'],
      ['ceneo_orders_get_order_shipping_data', '/ShippingData'],
      ['ceneo_orders_get_order_invoice_data', '/InvoiceData'],
      ['ceneo_orders_get_order_pickup_point', '/PickupPoint'],
    ]) {
      ok();
      await call(name, { order_id: ORDER_ID });
      expect([name, sent().url]).toEqual([name, order(suffix)]);
      expect(sent().params).toEqual({ $format: 'json' });
      expect(String(sent().method).toUpperCase()).toBe('GET');
    }

    // An id that tries to leave its place in the path stays one path segment.
    ok();
    await call('ceneo_orders_get_order', { order_id: 'x/../../api/v3/GetCategories?a=b' });
    expect(sent().url).toBe(`${BASE}/BasketService.svc/Orders(guid'x%2F..%2F..%2Fapi%2Fv3%2FGetCategories%3Fa%3Db')`);
  });

  it('reads the dictionaries and the category calls', async () => {
    for (const [name, url, params] of [
      ['ceneo_orders_list_order_states', `${BASE}/BasketService.svc/OrderStates`, { $format: 'json' }],
      ['ceneo_orders_list_parcel_carriers', `${BASE}/BasketService.svc/ParcelCarriers`, { $format: 'json' }],
      ['ceneo_orders_list_cancellation_reasons', `${BASE}/BasketService.svc/OrderCancellationReasons`, { $format: 'json' }],
    ] as const) {
      ok();
      await call(name, {});
      expect([name, sent().url, sent().params]).toEqual([name, url, params]);
    }

    ok();
    await call('ceneo_orders_list_categories', {});
    expect(sent().url).toBe(`${BASE}/api/v3/GetCategories`);
    expect(sent().params ?? {}).toEqual({});

    ok();
    await call('ceneo_orders_get_top_category_products', { category_name: 'Komputery' });
    expect(sent().url).toBe(`${BASE}/api/v3/GetTopCategoryProducts`);
    expect(sent().params).toEqual({ categoryName: 'Komputery', top: 100 });
  });

  it('sends the order changes as the GET requests Ceneo documents', async () => {
    ok();
    await call('ceneo_orders_confirm_order', { order_id: ORDER_ID });
    expect(sent().url).toBe(`${BASE}/BasketService.svc/ConfirmOrder`);
    expect(sent().params).toEqual({ id: ORDER_ID });

    ok();
    await call('ceneo_orders_set_order_shipment', { order_id: ORDER_ID, tracking_number: 'ABC_123-XYZ', carrier_id: 2 });
    expect(sent().url).toBe(`${BASE}/BasketService.svc/SetOrderShipment`);
    expect(sent().params).toEqual({ orderId: ORDER_ID, trackingNumber: 'ABC_123-XYZ', carrierId: 2 });

    ok();
    await call('ceneo_orders_send_order', { order_id: ORDER_ID });
    expect(sent().url).toBe(`${BASE}/BasketService.svc/SendOrder`);
    expect(sent().params).toEqual({ id: ORDER_ID });

    // The reason travels as the small JSON object of Ceneo's own example.
    ok();
    await call('ceneo_orders_cancel_order', { order_id: ORDER_ID, reason_id: 1 });
    expect(sent().url).toBe(`${BASE}/BasketService.svc/CancelOrder`);
    expect(sent().params).toEqual({ id: ORDER_ID, reason: '{"Id":"1"}' });

    for (const req of mockedAxios.mock.calls.map(([config]) => config)) {
      expect(String(req.method).toUpperCase()).toBe('GET');
      expect(req.data).toBeUndefined();
      expect(header(req, 'Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
    }
  });
});

// Opt-in: RUN_CENEO_ORDERS_LIVE=1. The refusal check needs no account; the
// reads need CENEO_API_KEY of a shop with "Kup na Ceneo". Nothing is written.
const live = process.env.RUN_CENEO_ORDERS_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('ceneo-orders: live', () => {
  const liveToken = async () => {
    const key = process.env.CENEO_API_KEY;
    if (!key) throw new Error('Set CENEO_API_KEY for the live check');
    const response = await liveFetch.get(TOKEN_URL, {
      headers: { Authorization: `Basic ${key}` },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    const token = String(response.headers.access_token ?? '');
    expect(token).not.toBe('');
    return { token, headers: response.headers };
  };

  it('refuses the token call for a made-up key', async () => {
    const response = await liveFetch.get(TOKEN_URL, {
      headers: { Authorization: 'Basic not-a-key' },
      validateStatus: () => true,
    });
    expect([400, 401, 403]).toContain(response.status);
    expect(response.headers.access_token).toBeUndefined();
  });

  it('refuses an order call without a token', async () => {
    const response = await liveFetch.get(`${BASE}/BasketService.svc/OrderStates`, {
      params: { $format: 'json' },
      validateStatus: () => true,
    });
    expect([400, 401, 403]).toContain(response.status);
  });

  it('answers the token in the access_token header, for 900 seconds', async () => {
    const { headers } = await liveToken();
    expect(String(headers.token_type).toLowerCase()).toBe('bearer');
    expect(Number(headers.expires_in)).toBe(900);
  });

  it('reads the order states and the newest orders with the token', async () => {
    const { token } = await liveToken();
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const states = await liveFetch.get(`${BASE}/BasketService.svc/OrderStates`, {
      params: { $format: 'json' },
      headers,
      validateStatus: () => true,
    });
    expect(states.status).toBe(200);
    expect(states.data.d).toBeDefined();

    const orders = await liveFetch.get(`${BASE}/BasketService.svc/Orders`, {
      params: { $orderby: 'CreatedDate desc', $format: 'json' },
      headers,
      validateStatus: () => true,
    });
    expect(orders.status).toBe(200);
    expect(orders.data.d).toBeDefined();
  });
});
