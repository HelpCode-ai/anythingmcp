import axios from 'axios';
import * as adapter from './squarespace-commerce.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Squarespace Commerce APIs adapter (orders, inventory, products v2, profiles,
 * contacts, transactions).
 *
 * Static checks always run: api.squarespace.com with the API key as a bearer
 * header and the User-Agent Squarespace requires, every tool's method and path
 * against developers.squarespace.com/commerce-apis, the fulfillment and
 * inventory adjustment bodies, the Idempotency-Key header, and that nothing
 * installs switched off because no tool refunds, cancels or changes products.
 * https://developers.squarespace.com/commerce-apis/overview
 *
 * Live checks run only with RUN_SQUARESPACE_COMMERCE_LIVE=1. Without a key they
 * confirm Squarespace refuses a wrong key; with SQUARESPACE_API_KEY they read
 * the website and one inventory page. Reads only.
 *
 *   RUN_SQUARESPACE_COMMERCE_LIVE=1 SQUARESPACE_API_KEY=... npx jest src/adapters/intl/squarespace-commerce.live.spec.ts
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
  SQUARESPACE_API_KEY: 'b7c1e1f2-1111-2222-3333-444455556666',
};
const BASE = 'https://api.squarespace.com';

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
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const EXPECTED: Record<string, [string, string]> = {
  squarespace_commerce_get_website: ['GET', '/1.0/authorization/website'],
  squarespace_commerce_list_orders: ['GET', '/1.0/commerce/orders'],
  squarespace_commerce_get_order: ['GET', '/1.0/commerce/orders/{order_id}'],
  squarespace_commerce_fulfill_order: ['POST', '/1.0/commerce/orders/{order_id}/fulfillments'],
  squarespace_commerce_list_inventory: ['GET', '/1.0/commerce/inventory'],
  squarespace_commerce_get_inventory: ['GET', '/1.0/commerce/inventory/{variant_ids}'],
  squarespace_commerce_adjust_inventory: ['POST', '/1.0/commerce/inventory/adjustments'],
  squarespace_commerce_list_products: ['GET', '/v2/commerce/products'],
  squarespace_commerce_get_products: ['GET', '/v2/commerce/products/{product_ids}'],
  squarespace_commerce_list_profiles: ['GET', '/1.0/profiles'],
  squarespace_commerce_get_profiles: ['GET', '/1.0/profiles/{profile_ids}'],
  squarespace_commerce_list_contacts: ['GET', '/v1/contacts'],
  squarespace_commerce_search_contacts: ['POST', '/v1/contacts/query'],
  squarespace_commerce_get_contact: ['GET', '/v1/contacts/{contact_id}'],
  squarespace_commerce_list_transactions: ['GET', '/1.0/commerce/transactions'],
  squarespace_commerce_get_transactions: ['GET', '/1.0/commerce/transactions/{document_ids}'],
};

describe('squarespace-commerce adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('calls api.squarespace.com with the API key as bearer and a User-Agent', () => {
    expect(a.slug).toBe('squarespace-commerce');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('squarespace-commerce');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SQUARESPACE_API_KEY}}' });
    expect(a.connector.headers?.['User-Agent']).toBeTruthy();
    expect(a.requiredEnvVars).toEqual(['SQUARESPACE_API_KEY']);
    const meta = a.envVarMeta.SQUARESPACE_API_KEY;
    expect(meta).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(meta.pattern!);
    expect(pattern.test(ENV.SQUARESPACE_API_KEY)).toBe(true);
    for (const bad of ['', 'Bearer b7c1e1f2-1111-2222-3333-444455556666', 'short']) expect([bad, pattern.test(bad)]).toEqual([bad, false]);
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const entry of a.tools) {
      const [method, path] = EXPECTED[entry.name];
      expect([entry.name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([entry.name, method, path]);
    }
  });

  it('declares a cheap probe and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({'tool': 'squarespace_commerce_get_website', 'params': {}});
    expect(tool(a.probe.tool).endpointMapping).toBeTruthy();
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^squarespace_commerce_[a-z0-9_]+$/);
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

  it('marks reads read-only and installs only no tool switched off', () => {
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, entry.endpointMapping.method === 'GET' || entry.name === 'squarespace_commerce_search_contacts']);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([]);
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

  it('lists orders with the bearer key, the User-Agent and the documented filters', async () => {
    ok({ result: [], pagination: { hasNextPage: false } });
    await call('squarespace_commerce_list_orders', { fulfillment_status: 'PENDING' });
    const req = sent();
    expect(req.url).toBe(`${BASE}/1.0/commerce/orders`);
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.SQUARESPACE_API_KEY}`);
    expect(header(req, 'User-Agent')).toBe('AnythingMCP');
    expect(req.params).toEqual({ fulfillmentStatus: 'PENDING' });
  });

  it('fulfills an order with shipments and the notification flag', async () => {
    ok({}, 204);
    const shipments = [{ shipDate: '2026-08-25T15:00:00Z', carrierName: 'UPS', service: 'Ground', trackingNumber: '1Z999', trackingUrl: 'https://ups.com/t/1Z999' }];
    await call('squarespace_commerce_fulfill_order', { order_id: '585d498fdee9f31a60284a38', shipments, should_send_notification: true });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/1.0/commerce/orders/585d498fdee9f31a60284a38/fulfillments`);
    expect(sent().data).toEqual({ shouldSendNotification: true, shipments });
  });

  it('adjusts inventory with an Idempotency-Key header and only the operations given', async () => {
    ok({}, 204);
    await call('squarespace_commerce_adjust_inventory', {
      idempotency_key: '0f6a2d4e-7b1c-4a7e-9d1b-2b3c4d5e6f70',
      set_finite_operations: [{ variantId: 'abc12345', quantity: 4 }],
    });
    expect(sent().url).toBe(`${BASE}/1.0/commerce/inventory/adjustments`);
    expect(header(sent(), 'Idempotency-Key')).toBe('0f6a2d4e-7b1c-4a7e-9d1b-2b3c4d5e6f70');
    expect(sent().data).toEqual({ setFiniteOperations: [{ variantId: 'abc12345', quantity: 4 }] });
  });

  it('reads several records by comma-separated ids', async () => {
    ok({ products: [] });
    await call('squarespace_commerce_get_products', { product_ids: '585d498fdee9f31a60284a38,585d498fdee9f31a60284a39' });
    expect(sent().url).toBe(`${BASE}/v2/commerce/products/585d498fdee9f31a60284a38,585d498fdee9f31a60284a39`);
    const pattern = new RegExp((tool('squarespace_commerce_get_products').parameters.properties!.product_ids as unknown as { pattern: string }).pattern);
    expect(pattern.test('a/../b')).toBe(false);
  });
});

// Opt-in: RUN_SQUARESPACE_COMMERCE_LIVE=1. The refusal check needs no key.
// Nothing is written.
const live = process.env.RUN_SQUARESPACE_COMMERCE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('squarespace-commerce: live', () => {
  it('refuses a wrong key', async () => {
    const response = await liveFetch.get(`${BASE}/1.0/authorization/website`, {
      headers: { Authorization: 'Bearer not-a-real-key-0123456789', 'User-Agent': 'AnythingMCP live spec' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads the website and one inventory page', async () => {
    const key = process.env.SQUARESPACE_API_KEY;
    if (!key) throw new Error('Set SQUARESPACE_API_KEY for the live check');
    const headers = { Authorization: `Bearer ${key}`, 'User-Agent': 'AnythingMCP live spec' };
    const site = await liveFetch.get(`${BASE}/1.0/authorization/website`, { headers, validateStatus: () => true });
    expect(site.status).toBe(200);
    expect(site.data.id).toBeTruthy();
    const inventory = await liveFetch.get(`${BASE}/1.0/commerce/inventory`, { headers, validateStatus: () => true });
    expect([200, 403]).toContain(inventory.status);
  });
});
