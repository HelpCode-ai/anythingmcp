import axios from 'axios';
import * as adapter from './idosell.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * IdoSell (IAI-Shop) Admin API adapter, version v8.
 *
 * Static checks always run: the panel domain in https://<domain>/api/admin/v8,
 * the key in the X-API-KEY header, every tool's method and path against the
 * IdoSell Admin API reference (idosell.readme.io), the `params` wrapper of every
 * POST and PUT body, comma-separated GET filters, the errorWhen rule for
 * errors.faultCode in a 200 answer, and that only the cancel tool installs
 * switched off. https://idosell.readme.io/docs/getting-started
 *
 * Live checks run only with RUN_IDOSELL_LIVE=1: with IDOSELL_DOMAIN they confirm
 * the panel refuses a wrong key; with IDOSELL_API_KEY as well they read the
 * shops data and one page of orders. Reads only.
 *
 *   RUN_IDOSELL_LIVE=1 IDOSELL_DOMAIN=client1234.idosell.com IDOSELL_API_KEY=... npx jest src/adapters/pl/idosell.live.spec.ts
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
  IDOSELL_DOMAIN: 'client1234.idosell.com',
  IDOSELL_API_KEY: 'YXBpLWtleS0wMTIzNDU2Nzg5YWJjZGVm',
};
const BASE = 'https://client1234.idosell.com/api/admin/v8';

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
      errorWhen: a.connector.config?.errorWhen,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const EXPECTED: Record<string, [string, string]> = {
  idosell_get_shops_data: ['GET', '/system/shopsData'],
  idosell_search_orders: ['POST', '/orders/orders/search'],
  idosell_get_orders: ['GET', '/orders/orders'],
  idosell_list_order_statuses: ['GET', '/orders/statuses'],
  idosell_get_order_history: ['GET', '/orders/history'],
  idosell_update_order: ['PUT', '/orders/orders'],
  idosell_cancel_order: ['PUT', '/orders/orders'],
  idosell_get_order_packages: ['GET', '/orders/packages'],
  idosell_add_order_packages: ['POST', '/orders/packages'],
  idosell_search_products: ['POST', '/products/products/search'],
  idosell_get_products: ['GET', '/products/products'],
  idosell_get_product_stocks: ['GET', '/products/stocks'],
  idosell_update_product_stock: ['PUT', '/products/stocks'],
  idosell_list_categories: ['GET', '/products/categories'],
  idosell_get_clients: ['GET', '/clients/clients'],
  idosell_search_clients_crm: ['POST', '/clients/crm/search'],
  idosell_get_returns: ['GET', '/returns/returns'],
  idosell_list_couriers: ['GET', '/couriers/couriers'],
};

describe('idosell adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('calls the panel domain on Admin API v8 with the X-API-KEY header', () => {
    expect(a.slug).toBe('idosell');
    expect(a.region).toBe('pl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('idosell');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://{{IDOSELL_DOMAIN}}/api/admin/v8');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-KEY', apiKey: '{{IDOSELL_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['IDOSELL_DOMAIN', 'IDOSELL_API_KEY']);
    expect(a.envVarMeta.IDOSELL_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    for (const name of a.requiredEnvVars) {
      const pattern = new RegExp(a.envVarMeta[name].pattern!);
      expect([name, pattern.test(ENV[name])]).toEqual([name, true]);
      for (const bad of ['', 'has spaces in the value']) expect([name, bad, pattern.test(bad)]).toEqual([name, bad, false]);
    }
    expect(new RegExp(a.envVarMeta.IDOSELL_DOMAIN.pattern!).test('https://client1234.idosell.com/')).toBe(false);
  });

  it('wraps every POST and PUT body in params', () => {
    for (const entry of a.tools.filter((t) => t.endpointMapping.method !== 'GET')) {
      expect([entry.name, Object.keys(entry.endpointMapping.bodyMapping ?? {})]).toEqual([entry.name, ['params']]);
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
    expect(a.probe).toEqual({'tool': 'idosell_get_shops_data', 'params': {}});
    expect(tool(a.probe.tool).endpointMapping).toBeTruthy();
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^idosell_[a-z0-9_]+$/);
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

  it('marks reads read-only and installs only idosell_cancel_order switched off', () => {
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, entry.endpointMapping.method === 'GET' || ['idosell_search_orders', 'idosell_search_products', 'idosell_search_clients_crm'].includes(entry.name)]);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['idosell_cancel_order']);
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

  it('searches orders with the key header and a params body', async () => {
    ok({ Results: [], resultsNumberAll: 0 });
    await call('idosell_search_orders', { statuses: ['new', 'on_order'], limit: 100 });
    const req = sent();
    expect(req.url).toBe(`${BASE}/orders/orders/search`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(header(req, 'X-API-KEY')).toBe(ENV.IDOSELL_API_KEY);
    expect(req.data).toEqual({ params: { ordersStatuses: ['new', 'on_order'], resultsPage: 0, resultsLimit: 100 } });
  });

  it('passes several GET values separated by commas', async () => {
    ok({ Results: [] });
    await call('idosell_get_orders', { serial_numbers: '12345,12346' });
    expect(sent().url).toBe(`${BASE}/orders/orders`);
    expect(sent().params).toEqual({ ordersSerialNumbers: '12345,12346' });
  });

  it('builds the order, parcel and stock write bodies', async () => {
    ok({});
    await call('idosell_update_order', { order_serial_number: 12345, order_status: 'packed', api_note: 'Picked' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().data).toEqual({ params: { orders: [{ orderSerialNumber: 12345, orderStatus: 'packed', apiNoteToOrder: 'Picked' }] } });
    expect((tool('idosell_update_order').parameters.properties!.order_status as unknown as { enum: string[] }).enum).not.toContain('canceled');

    ok({});
    await call('idosell_cancel_order', { order_serial_number: 12345 });
    expect(sent().data).toEqual({ params: { orders: [{ orderSerialNumber: 12345, orderStatus: 'canceled' }] } });

    ok({});
    await call('idosell_add_order_packages', { order_serial_number: '12345', packages: [{ courierId: '100', deliveryShippingNumber: 'PX123' }] });
    expect(sent().data).toEqual({ params: { orderPackages: [{ eventId: '12345', eventType: 'order', packages: [{ courierId: '100', deliveryShippingNumber: 'PX123' }] }] } });

    ok({});
    await call('idosell_update_product_stock', { product_ident: '1234', stock_id: 1, quantity: 5 });
    expect(sent().data).toEqual({
      params: {
        products: [
          {
            ident: { identType: 'id', identValue: '1234' },
            sizes: [{ ident: { identType: 'id', identValue: 'uniw' }, quantity: { stocks: [{ stock_id: 1, quantity_operation: { operation: 'set', quantity: 5 } }] } }],
          },
        ],
      },
    });
  });

  it('reports errors.faultCode in a 200 answer as a failed call', async () => {
    ok({ errors: { faultCode: 1, faultString: 'Invalid parameters' } });
    await expect(call('idosell_get_shops_data', {})).rejects.toThrow(/Invalid parameters/);
    ok({ errors: { faultCode: 0, faultString: '' }, result: 'ok' });
    await expect(call('idosell_get_shops_data', {})).resolves.toBeTruthy();
  });
});

// Opt-in: RUN_IDOSELL_LIVE=1. Nothing is written.
const live = process.env.RUN_IDOSELL_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('idosell: live', () => {
  const base = `https://${process.env.IDOSELL_DOMAIN}/api/admin/v8`;

  it('refuses a wrong key', async () => {
    if (!process.env.IDOSELL_DOMAIN) throw new Error('Set IDOSELL_DOMAIN for the live check');
    const response = await liveFetch.get(`${base}/system/shopsData`, { headers: { 'X-API-KEY': 'not-a-real-key-0123456789' }, validateStatus: () => true });
    expect([401, 403]).toContain(response.status);
  });

  it('reads the shops data and one page of orders', async () => {
    const key = process.env.IDOSELL_API_KEY;
    if (!process.env.IDOSELL_DOMAIN || !key) throw new Error('Set IDOSELL_DOMAIN and IDOSELL_API_KEY');
    const headers = { 'X-API-KEY': key, 'Content-Type': 'application/json' };
    const shops = await liveFetch.get(`${base}/system/shopsData`, { headers, validateStatus: () => true });
    expect(shops.status).toBe(200);
    const orders = await liveFetch.post(`${base}/orders/orders/search`, { params: { resultsPage: 0, resultsLimit: 1 } }, { headers, validateStatus: () => true });
    expect([200, 207]).toContain(orders.status);
  });
});
