import axios from 'axios';
import * as adapter from './lightspeed-ecom.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Lightspeed eCom (C-Series, formerly SEOshop) adapter.
 *
 * Static checks always run: the cluster choice (EU api.webshopapp.com, US
 * api.shoplightspeed.com) and the shop language in the base URL, HTTP Basic
 * with the API key and secret, every tool's method and path against
 * developers.lightspeedhq.com/ecom, the wrapped request bodies (order,
 * shipment, product, variant), and that only the cancel tool installs switched
 * off. This is not the Lightspeed Retail X-Series adapter.
 * https://developers.lightspeedhq.com/ecom/introduction/introduction/
 *
 * Live checks run only with RUN_LIGHTSPEED_ECOM_LIVE=1: without credentials they
 * confirm the EU cluster refuses a wrong key; with LIGHTSPEED_ECOM_CLUSTER,
 * LIGHTSPEED_ECOM_LANGUAGE, LIGHTSPEED_ECOM_API_KEY and LIGHTSPEED_ECOM_API_SECRET
 * they read the shop and count the orders. Reads only.
 *
 *   RUN_LIGHTSPEED_ECOM_LIVE=1 LIGHTSPEED_ECOM_CLUSTER=https://api.webshopapp.com LIGHTSPEED_ECOM_LANGUAGE=en \
 *     LIGHTSPEED_ECOM_API_KEY=... LIGHTSPEED_ECOM_API_SECRET=... npx jest src/adapters/intl/lightspeed-ecom.live.spec.ts
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
  LIGHTSPEED_ECOM_CLUSTER: 'https://api.webshopapp.com',
  LIGHTSPEED_ECOM_LANGUAGE: 'nl',
  LIGHTSPEED_ECOM_API_KEY: '0123456789abcdef0123456789abcdef',
  LIGHTSPEED_ECOM_API_SECRET: 'fedcba9876543210fedcba9876543210',
};
const BASE = 'https://api.webshopapp.com/nl';

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: cfg.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: cfg.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });

const EXPECTED: Record<string, [string, string]> = {
  lightspeed_ecom_get_shop: ['GET', '/shop.json'],
  lightspeed_ecom_list_orders: ['GET', '/orders.json'],
  lightspeed_ecom_count_orders: ['GET', '/orders/count.json'],
  lightspeed_ecom_get_order: ['GET', '/orders/{order_id}.json'],
  lightspeed_ecom_list_order_products: ['GET', '/orders/{order_id}/products.json'],
  lightspeed_ecom_update_order: ['PUT', '/orders/{order_id}.json'],
  lightspeed_ecom_cancel_order: ['PUT', '/orders/{order_id}.json'],
  lightspeed_ecom_list_shipments: ['GET', '/shipments.json'],
  lightspeed_ecom_get_shipment: ['GET', '/shipments/{shipment_id}.json'],
  lightspeed_ecom_update_shipment: ['PUT', '/shipments/{shipment_id}.json'],
  lightspeed_ecom_list_products: ['GET', '/products.json'],
  lightspeed_ecom_count_products: ['GET', '/products/count.json'],
  lightspeed_ecom_get_product: ['GET', '/products/{product_id}.json'],
  lightspeed_ecom_update_product: ['PUT', '/products/{product_id}.json'],
  lightspeed_ecom_list_variants: ['GET', '/variants.json'],
  lightspeed_ecom_get_variant: ['GET', '/variants/{variant_id}.json'],
  lightspeed_ecom_update_variant: ['PUT', '/variants/{variant_id}.json'],
  lightspeed_ecom_list_customers: ['GET', '/customers.json'],
  lightspeed_ecom_get_customer: ['GET', '/customers/{customer_id}.json'],
  lightspeed_ecom_list_invoices: ['GET', '/invoices.json'],
};

describe('lightspeed-ecom adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('builds the base URL from the cluster choice and language and uses HTTP Basic', () => {
    expect(a.slug).toBe('lightspeed-ecom');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('lightspeed-ecom');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{LIGHTSPEED_ECOM_CLUSTER}}/{{LIGHTSPEED_ECOM_LANGUAGE}}');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{LIGHTSPEED_ECOM_API_KEY}}', password: '{{LIGHTSPEED_ECOM_API_SECRET}}' });
    expect(a.envVarMeta.LIGHTSPEED_ECOM_CLUSTER.options?.map((o) => o.value)).toEqual(['https://api.webshopapp.com', 'https://api.shoplightspeed.com']);
    expect(a.envVarMeta.LIGHTSPEED_ECOM_API_SECRET).toMatchObject({ kind: 'credential', secret: true });
    for (const name of ['LIGHTSPEED_ECOM_LANGUAGE', 'LIGHTSPEED_ECOM_API_KEY', 'LIGHTSPEED_ECOM_API_SECRET']) {
      const pattern = new RegExp(a.envVarMeta[name].pattern!);
      expect([name, pattern.test(ENV[name])]).toEqual([name, true]);
      for (const bad of ['', 'has spaces in it', 'https://api.webshopapp.com']) expect([name, bad, pattern.test(bad)]).toEqual([name, bad, false]);
    }
  });

  it('leaves the Lightspeed Retail adapter alone: different slug, host and tool prefix', () => {
    const retail = getAdapter('lightspeed-retail');
    expect(retail).toBeTruthy();
    for (const entry of retail!.tools) expect(entry.name.startsWith('lightspeed_ecom_')).toBe(false);
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const entry of a.tools) {
      const [method, path] = EXPECTED[entry.name];
      expect([entry.name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([entry.name, method, path]);
    }
  });

  it('declares a cheap probe and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({'tool': 'lightspeed_ecom_get_shop', 'params': {}});
    expect(tool(a.probe.tool).endpointMapping).toBeTruthy();
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^lightspeed_ecom_[a-z0-9_]+$/);
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

  it('marks reads read-only and installs only lightspeed_ecom_cancel_order switched off', () => {
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, entry.endpointMapping.method === 'GET']);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['lightspeed_ecom_cancel_order']);
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

  it('lists orders with Basic auth, page and limit', async () => {
    ok({ orders: [] });
    await call('lightspeed_ecom_list_orders', { created_at_min: '2026-01-01 00:00:00', limit: 250 });
    const req = sent();
    expect(req.url).toBe(`${BASE}/orders.json`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.auth).toEqual({ username: ENV.LIGHTSPEED_ECOM_API_KEY, password: ENV.LIGHTSPEED_ECOM_API_SECRET });
    expect(req.params).toEqual({ created_at_min: '2026-01-01 00:00:00', limit: 250, page: 1 });
  });

  it('wraps updates in order, shipment, product and variant objects', async () => {
    ok({});
    await call('lightspeed_ecom_update_order', { order_id: 1623550, payment_status: 'paid', memo: 'Wrap it' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/orders/1623550.json`);
    expect(sent().data).toEqual({ order: { paymentStatus: 'paid', memo: 'Wrap it' } });

    ok({});
    await call('lightspeed_ecom_cancel_order', { order_id: 1623550, do_notify_cancelled: true });
    expect(sent().data).toEqual({ order: { status: 'cancelled', doNotifyCancelled: true } });

    ok({});
    await call('lightspeed_ecom_update_shipment', { shipment_id: 42, status: 'shipped', tracking_code: '3SMF2209773', do_notify_tracking_code: true });
    expect(sent().url).toBe(`${BASE}/shipments/42.json`);
    expect(sent().data).toEqual({ shipment: { status: 'shipped', trackingCode: '3SMF2209773', doNotifyTrackingCode: true } });

    ok({});
    await call('lightspeed_ecom_update_variant', { variant_id: 7, price_incl: 12.1, stock_level: 100 });
    expect(sent().data).toEqual({ variant: { priceIncl: 12.1, stockLevel: 100 } });

    ok({});
    await call('lightspeed_ecom_update_product', { product_id: 9, visibility: 'hidden' });
    expect(sent().data).toEqual({ product: { visibility: 'hidden' } });
  });

  it('offers no way to cancel through update_order or ship-cancel through update_shipment', () => {
    const status = (name: string) => (tool(name).parameters.properties!.status as unknown as { enum?: string[] }).enum;
    expect(status('lightspeed_ecom_update_order')).toEqual(['on_hold', 'off_hold']);
    expect(status('lightspeed_ecom_update_shipment')).toEqual(['shipped', 'not_shipped']);
  });
});

// Opt-in: RUN_LIGHTSPEED_ECOM_LIVE=1. The refusal check needs no account.
// Nothing is written.
const live = process.env.RUN_LIGHTSPEED_ECOM_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('lightspeed-ecom: live', () => {
  it('refuses a wrong key on the EU cluster', async () => {
    const response = await liveFetch.get('https://api.webshopapp.com/en/shop.json', {
      auth: { username: '0123456789abcdef0123456789abcdef', password: '0123456789abcdef0123456789abcdef' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads the shop and counts the orders', async () => {
    const { LIGHTSPEED_ECOM_CLUSTER: cluster, LIGHTSPEED_ECOM_LANGUAGE: lang, LIGHTSPEED_ECOM_API_KEY: key, LIGHTSPEED_ECOM_API_SECRET: secret } = process.env;
    if (!cluster || !lang || !key || !secret) throw new Error('Set the four LIGHTSPEED_ECOM_* variables for the live check');
    const auth = { username: key, password: secret };
    const shop = await liveFetch.get(`${cluster}/${lang}/shop.json`, { auth, validateStatus: () => true });
    expect(shop.status).toBe(200);
    expect(shop.data.shop).toBeTruthy();
    const count = await liveFetch.get(`${cluster}/${lang}/orders/count.json`, { auth, validateStatus: () => true });
    expect(count.status).toBe(200);
    expect(typeof count.data.count).toBe('number');
  });
});
