import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import * as adapter from './horoshop.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Horoshop API adapter (Ukrainian shop platform).
 *
 * Static checks always run: the login at https://<domain>/api/auth/ with the
 * API administrator's login and password, the token read from response.token
 * (600 seconds) and placed into every JSON body as `token`, every tool's
 * function path against Horoshop's public API documentation
 * (horoshop.notion.site), the body templates, the errorWhen rules for the
 * `status` envelope (UNAUTHORIZED triggers one new login), and that only the
 * cancel tool installs switched off. Calls run through the real RestEngine
 * and LoginTokenService with axios mocked.
 * https://horoshop.notion.site/API-1b6cc289707981faa189c3513d66646a
 *
 * Live checks run only with RUN_HOROSHOP_LIVE=1: with HOROSHOP_DOMAIN they
 * confirm the store refuses a wrong login; with HOROSHOP_LOGIN and
 * HOROSHOP_PASSWORD as well they log in and read the currencies. Reads only.
 *
 *   RUN_HOROSHOP_LIVE=1 HOROSHOP_DOMAIN=shop123456.horoshop.ua HOROSHOP_LOGIN=... HOROSHOP_PASSWORD=... \
 *     npx jest src/adapters/intl/horoshop.live.spec.ts
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
    bodyTemplate?: string;
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
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; options?: { value: string }[] }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
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
  walk(m.bodyTemplate ?? '');
  walk(m.headers ?? {});
  out.delete('loginToken');
  return out;
};

const ENV: Record<string, string> = {
  HOROSHOP_DOMAIN: 'shop123456.horoshop.ua',
  HOROSHOP_LOGIN: 'api',
  HOROSHOP_PASSWORD: 'q4lrfb3-secret',
};
const BASE = 'https://shop123456.horoshop.ua/api';
const TOKEN = '3199c39700714eec4f6ada0b4242335b';
const NEW_TOKEN = 'c5bc0cd25647e701bc6427f3629b27b4';

const encryption = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
const realLogin = () =>
  new LoginTokenService(
    { connectorAuthCache: { findUnique: async () => null, upsert: async () => ({}) } } as unknown as PrismaService,
    encryption,
  );
const call = (name: string, params: Record<string, unknown>, login: LoginTokenService = realLogin()) => {
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
      errorWhen: a.connector.config?.errorWhen,
      connectorId: 'conn-horoshop',
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sentAt = (index: number) => mockedAxios.mock.calls[index][0];
const authAnswer = (token: string) => ({ status: 200, data: { status: 'OK', response: { token } }, headers: { 'content-type': 'application/json' } });
const body = (index: number) => {
  const data = sentAt(index).data;
  return typeof data === 'string' ? JSON.parse(data) : data;
};

const EXPECTED: Record<string, [string, string]> = {
  horoshop_list_orders: ['POST', '/orders/get/'],
  horoshop_list_order_statuses: ['POST', '/orders/get_available_statuses/'],
  horoshop_update_order: ['POST', '/orders/update/'],
  horoshop_cancel_order: ['POST', '/orders/update/'],
  horoshop_export_products: ['POST', '/catalog/export/'],
  horoshop_import_products: ['POST', '/catalog/import/'],
  horoshop_list_categories: ['POST', '/pages/export/'],
  horoshop_list_customers: ['POST', '/users/export/'],
  horoshop_import_customers: ['POST', '/users/import/'],
  horoshop_list_delivery_options: ['POST', '/delivery/export/'],
  horoshop_list_delivery_types: ['POST', '/delivery/exportTypes/'],
  horoshop_list_payment_options: ['POST', '/payment/export/'],
  horoshop_list_payment_methods: ['POST', '/payment/exportMethods/'],
  horoshop_list_currencies: ['POST', '/currency/export/'],
  horoshop_list_stickers: ['POST', '/icons/export/'],
};

describe('horoshop adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('logs in with the API administrator and puts the token into the body, not a header', () => {
    expect(a.slug).toBe('horoshop');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('horoshop');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://{{HOROSHOP_DOMAIN}}/api');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: 'https://{{HOROSHOP_DOMAIN}}/api/auth/',
      loginMethod: 'POST',
      loginBody: { login: '${username}', password: '${password}' },
      username: '{{HOROSHOP_LOGIN}}',
      password: '{{HOROSHOP_PASSWORD}}',
      tokenJsonPath: 'response.token',
      tokenTTLSeconds: 600,
      tokenPlacement: 'body',
      refreshOnBody401: true,
    });
    expect(a.requiredEnvVars).toEqual(['HOROSHOP_DOMAIN', 'HOROSHOP_LOGIN', 'HOROSHOP_PASSWORD']);
    expect(a.envVarMeta.HOROSHOP_PASSWORD).toMatchObject({ kind: 'credential', secret: true });
    const domain = new RegExp(a.envVarMeta.HOROSHOP_DOMAIN.pattern!);
    expect(domain.test(ENV.HOROSHOP_DOMAIN)).toBe(true);
    for (const bad of ['', 'https://shop123456.horoshop.ua', 'shop123456.horoshop.ua/api', 'localhost']) expect([bad, domain.test(bad)]).toEqual([bad, false]);
  });

  it('sends every call as a JSON POST whose template starts with the token', () => {
    for (const entry of a.tools) {
      expect([entry.name, entry.endpointMapping.method]).toEqual([entry.name, 'POST']);
      expect([entry.name, entry.endpointMapping.bodyTemplate?.startsWith('{"token": "${loginToken}"')]).toEqual([entry.name, true]);
    }
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const entry of a.tools) {
      const [method, path] = EXPECTED[entry.name];
      expect([entry.name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([entry.name, method, path]);
    }
  });

  it('declares a cheap probe and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({'tool': 'horoshop_list_currencies', 'params': {}});
    expect(tool(a.probe.tool).endpointMapping).toBeTruthy();
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^horoshop_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const param of Object.values(entry.parameters.properties ?? {})) expect(param.description).toBeTruthy();
      expect(entry.description.length).toBeGreaterThan(60);
    }
  });

  it('marks reads read-only and installs only horoshop_cancel_order switched off', () => {
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, !['horoshop_update_order', 'horoshop_cancel_order', 'horoshop_import_products', 'horoshop_import_customers'].includes(entry.name)]);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['horoshop_cancel_order']);
  });

  it('names every tool in the instructions and keeps texts MDX-safe', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    const outsideTicks = (s: string) => s.replace(/`[^`]*`/g, '');
    expect(outsideTicks(a.instructions)).not.toMatch(/[{}<]/);
    for (const entry of a.tools) {
      expect(outsideTicks(entry.description)).not.toMatch(/[{}<]/);
      for (const param of Object.values(entry.parameters.properties ?? {})) expect(outsideTicks(param.description ?? '')).not.toMatch(/[{}<]/);
    }
  });

  it('logs in once, then lists orders with the token and the filters in the body', async () => {
    mockedAxios.mockResolvedValueOnce(authAnswer(TOKEN)).mockResolvedValueOnce({ status: 200, data: { status: 'OK', response: { orders: [] } }, headers: {} });
    await call('horoshop_list_orders', { from: '2026-04-01', status: [1, 2], limit: 20 });
    expect(sentAt(0).url).toBe(`${BASE}/auth/`);
    expect(body(0)).toEqual({ login: 'api', password: 'q4lrfb3-secret' });
    expect(sentAt(1).url).toBe(`${BASE}/orders/get/`);
    expect(String(sentAt(1).method).toUpperCase()).toBe('POST');
    expect(sentAt(1).headers.Authorization).toBeUndefined();
    expect(body(1)).toEqual({ token: TOKEN, from: '2026-04-01', to: null, ids: null, status: [1, 2], additionalData: false, offset: 0, limit: 20 });
  });

  it('updates one order with a status that cannot be 4 and cancels only through the switched-off tool', async () => {
    const pattern = new RegExp((tool('horoshop_update_order').parameters.properties!.status as unknown as { pattern: string }).pattern);
    for (const okStatus of ['1', '2', '3', '6', '12', '40']) expect([okStatus, pattern.test(okStatus)]).toEqual([okStatus, true]);
    expect(pattern.test('4')).toBe(false);

    mockedAxios.mockResolvedValueOnce(authAnswer(TOKEN)).mockResolvedValueOnce({ status: 200, data: { status: 'OK', response: { log: [] } }, headers: {} });
    await call('horoshop_update_order', { order_id: 24, status: '2', payed: 1 });
    expect(body(1)).toEqual({ token: TOKEN, orders: [{ order_id: 24, status: '2', payed: 1, tracking_code: null }] });

    mockedAxios.mockResolvedValueOnce(authAnswer(TOKEN)).mockResolvedValueOnce({ status: 200, data: { status: 'OK', response: { log: [] } }, headers: {} });
    await call('horoshop_cancel_order', { order_id: 24 });
    expect(body(3)).toEqual({ token: TOKEN, orders: [{ order_id: 24, status: 4 }] });
  });

  it('exports and imports products with the documented bodies', async () => {
    mockedAxios.mockResolvedValueOnce(authAnswer(TOKEN)).mockResolvedValueOnce({ status: 200, data: { status: 'OK', response: { products: [] } }, headers: {} });
    await call('horoshop_export_products', { expr: { article: ['SKU-1-BLACK'] }, included_params: ['price'] });
    expect(sentAt(1).url).toBe(`${BASE}/catalog/export/`);
    expect(body(1)).toEqual({ token: TOKEN, expr: { article: ['SKU-1-BLACK'] }, offset: 0, limit: 100, includedParams: ['price'], excludedParams: null });

    mockedAxios.mockResolvedValueOnce(authAnswer(TOKEN)).mockResolvedValueOnce({ status: 200, data: { status: 'OK', response: { log: [] } }, headers: {} });
    await call('horoshop_import_products', { products: [{ article: 'SKU-1', price: 499 }] });
    expect(body(3)).toEqual({ token: TOKEN, products: [{ article: 'SKU-1', price: 499 }] });
  });

  it('logs in again once when Horoshop answers UNAUTHORIZED in a 200 body', async () => {
    mockedAxios
      .mockResolvedValueOnce(authAnswer(TOKEN))
      .mockResolvedValueOnce({ status: 200, data: { status: 'UNAUTHORIZED', response: { message: 'token expired' } }, headers: {} })
      .mockResolvedValueOnce(authAnswer(NEW_TOKEN))
      .mockResolvedValueOnce({ status: 200, data: { status: 'OK', response: { currency: [] } }, headers: {} });
    const out = await call('horoshop_list_currencies', {});
    expect(out).toMatchObject({ status: 'OK' });
    expect(body(3).token).toBe(NEW_TOKEN);
  });

  it('reports ERROR and UNDEFINED_FUNCTION answers as failed calls', async () => {
    mockedAxios.mockResolvedValueOnce(authAnswer(TOKEN)).mockResolvedValueOnce({ status: 200, data: { status: 'ERROR', response: { message: 'Wrong parameter' } }, headers: {} });
    await expect(call('horoshop_list_customers', {})).rejects.toThrow(/Wrong parameter/);
    mockedAxios.mockResolvedValueOnce(authAnswer(TOKEN)).mockResolvedValueOnce({ status: 200, data: { status: 'UNDEFINED_FUNCTION', response: {} }, headers: {} });
    await expect(call('horoshop_list_stickers', {})).rejects.toThrow(/UNDEFINED_FUNCTION/);
    mockedAxios.mockResolvedValueOnce(authAnswer(TOKEN)).mockResolvedValueOnce({ status: 200, data: { status: 'EMPTY', response: {} }, headers: {} });
    await expect(call('horoshop_list_orders', {})).resolves.toMatchObject({ status: 'EMPTY' });
  });
});

// Opt-in: RUN_HOROSHOP_LIVE=1. Nothing is written.
const live = process.env.RUN_HOROSHOP_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('horoshop: live', () => {
  const base = `https://${process.env.HOROSHOP_DOMAIN}/api`;

  it('refuses a wrong login', async () => {
    if (!process.env.HOROSHOP_DOMAIN) throw new Error('Set HOROSHOP_DOMAIN for the live check');
    const response = await liveFetch.post(`${base}/auth/`, { login: 'not-a-user', password: 'not-a-password' }, { validateStatus: () => true });
    expect(response.data.status).not.toBe('OK');
  });

  it('logs in and reads the currencies', async () => {
    const { HOROSHOP_DOMAIN: domain, HOROSHOP_LOGIN: login, HOROSHOP_PASSWORD: password } = process.env;
    if (!domain || !login || !password) throw new Error('Set HOROSHOP_DOMAIN, HOROSHOP_LOGIN and HOROSHOP_PASSWORD');
    const auth = await liveFetch.post(`${base}/auth/`, { login, password }, { validateStatus: () => true });
    expect(auth.data.status).toBe('OK');
    const currencies = await liveFetch.post(`${base}/currency/export/`, { token: auth.data.response.token }, { validateStatus: () => true });
    expect(['OK', 'EMPTY']).toContain(currencies.data.status);
  });
});
