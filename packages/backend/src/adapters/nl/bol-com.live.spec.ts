import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './bol-com.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * bol.com Retailer API adapter (v10, offers on v11).
 *
 * Static checks always run: the client-credentials token request (id and
 * secret in a Basic header at login.bol.com), the v10 media type on every
 * call and the v11 media type on the offer tools, every tool's method and
 * URL against bol's published OpenAPI specs (Retailer API v10, Offers v11,
 * Process status v10, Product content v10), the write bodies, and which
 * tools install switched off. No tool buys shipping labels, handles returns
 * or moves money.
 * https://api.bol.com/retailer/public/Retailer-API/index.html
 *
 * Live checks run only with RUN_BOL_COM_LIVE=1. Without credentials they
 * confirm the token endpoint refuses wrong credentials; with BOL_CLIENT_ID
 * and BOL_CLIENT_SECRET they read one page of orders and offers. Reads only.
 *
 *   RUN_BOL_COM_LIVE=1 BOL_CLIENT_ID=... BOL_CLIENT_SECRET=... \
 *     npx jest src/adapters/nl/bol-com.live.spec.ts
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
  BOL_CLIENT_ID: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
  BOL_CLIENT_SECRET: 'test-secret-value-0123456789abcdef',
};
const V10 = 'application/vnd.retailer.v10+json';
const V11 = 'application/vnd.retailer.v11+json';

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
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
const ok = (status = 200) => mockedAxios.mockResolvedValueOnce({ status, data: {}, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('bol-com adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('uses client credentials at login.bol.com and the v10 media type', () => {
    expect(a.slug).toBe('bol-com');
    expect(a.region).toBe('nl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('bol-com');
    expect(a.connector.baseUrl).toBe('https://api.bol.com');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{BOL_CLIENT_ID}}',
      clientSecret: '{{BOL_CLIENT_SECRET}}',
      tokenUrl: 'https://login.bol.com/token',
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(a.connector.headers).toMatchObject({ Accept: V10, 'Content-Type': V10 });
    expect(a.requiredEnvVars).toEqual(['BOL_CLIENT_ID', 'BOL_CLIENT_SECRET']);
    expect(a.envVarMeta.BOL_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(new RegExp(a.envVarMeta.BOL_CLIENT_ID.pattern!).test(ENV.BOL_CLIENT_ID)).toBe(true);
    expect(new RegExp(a.envVarMeta.BOL_CLIENT_SECRET.pattern!).test(ENV.BOL_CLIENT_SECRET)).toBe(true);
    for (const bad of ['', 'has space here 123456']) expect(new RegExp(a.envVarMeta.BOL_CLIENT_SECRET.pattern!).test(bad)).toBe(false);
  });

  it('sends the client id and secret as Basic auth with grant_type in the form body', async () => {
    const service = new OAuth2TokenService(
      {} as PrismaService,
      { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService,
    );
    const post = jest
      .spyOn(mockedAxios as unknown as typeof axios, 'post')
      .mockResolvedValue({ data: { access_token: 'eyJ.token', expires_in: 299, token_type: 'Bearer' } });
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).resolves.toBe('eyJ.token');
    const [url, body, options] = post.mock.calls[0] as unknown as [string, string, { headers: Record<string, string> }];
    expect(url).toBe('https://login.bol.com/token');
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({ grant_type: 'client_credentials' });
    expect(options.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${ENV.BOL_CLIENT_ID}:${ENV.BOL_CLIENT_SECRET}`).toString('base64')}`,
    );
    post.mockRestore();
  });

  it('probes the order list and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'bol_com_list_orders', params: {} });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^bol_com_[a-z0-9_]+$/);
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

  it('uses the v11 media type only on the offer tools', () => {
    for (const entry of a.tools) {
      const isOffer = entry.endpointMapping.path.startsWith('/retailer/offers');
      if (isOffer) expect(entry.endpointMapping.headers).toEqual({ Accept: V11, 'Content-Type': V11 });
      else expect(entry.endpointMapping.headers?.Accept).toBeUndefined();
    }
  });

  it('marks reads read-only, installs cancellation and offer deletion switched off, and moves no money', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET';
      expect(annotationsOf(entry).readOnlyHint).toBe(read);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['bol_com_cancel_order_item', 'bol_com_delete_offer']);
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).not.toMatch(/shipping-labels|invoices\/|commissions$/);
      if (entry.endpointMapping.path.startsWith('/retailer/returns')) expect(entry.endpointMapping.method).toBe('GET');
      if (entry.endpointMapping.path.startsWith('/retailer/invoices')) expect(entry.endpointMapping.method).toBe('GET');
    }
    expect(JSON.stringify(tool('bol_com_create_shipment').endpointMapping)).not.toContain('shippingLabelId');
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists open FBR orders with the bearer token and the v10 media type', async () => {
    ok();
    await call('bol_com_list_orders', {});
    const req = sent();
    expect(req.url).toBe('https://api.bol.com/retailer/orders');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
    expect(header(req, 'Accept')).toBe(V10);
    expect(req.params).toEqual({ status: 'OPEN', 'fulfilment-method': 'FBR', page: 1 });
  });

  it('reads orders, offers and inventory on the documented paths', async () => {
    ok();
    await call('bol_com_get_order', { order_id: 'A4K8290LP0' });
    expect(sent().url).toBe('https://api.bol.com/retailer/orders/A4K8290LP0');

    ok();
    await call('bol_com_get_offer', { offer_id: '13722de8-8182-d161-5422-4a0a1caab5c8' });
    expect(sent().url).toBe('https://api.bol.com/retailer/offers/13722de8-8182-d161-5422-4a0a1caab5c8');
    expect(header(sent(), 'Accept')).toBe(V11);

    ok();
    await call('bol_com_list_inventory', { query: '8718526069334', stock: 'SUFFICIENT' });
    expect(sent().url).toBe('https://api.bol.com/retailer/inventory');
    expect(sent().params).toEqual({ query: '8718526069334', stock: 'SUFFICIENT', page: 1 });

    ok();
    await call('bol_com_list_shipments', { order_id: '1042823870' });
    expect(sent().url).toBe('https://api.bol.com/retailer/shipments');
    expect(sent().params).toEqual({ 'order-id': '1042823870', page: 1 });

    ok();
    await call('bol_com_get_process_status', { process_status_id: '1234567' });
    expect(sent().url).toBe('https://api.bol.com/shared/process-status/1234567');

    ok();
    await call('bol_com_get_commission', { ean: '8712626055143', unit_price: 24.99 });
    expect(sent().url).toBe('https://api.bol.com/retailer/commission/8712626055143');
    expect(sent().params).toEqual({ 'unit-price': 24.99, condition: 'NEW' });
  });

  it('builds the shipment, cancellation and offer bodies as bol documents them', async () => {
    ok(202);
    await call('bol_com_create_shipment', {
      order_items: [{ orderItemId: '6107434013', quantity: 1 }],
      transporter_code: 'TNT',
      track_and_trace: '3SAOLD1234567',
    });
    expect(sent().url).toBe('https://api.bol.com/retailer/shipments');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({
      orderItems: [{ orderItemId: '6107434013', quantity: 1 }],
      transport: { transporterCode: 'TNT', trackAndTrace: '3SAOLD1234567' },
    });

    ok(202);
    await call('bol_com_cancel_order_item', { order_item_id: '6107434013', reason_code: 'OUT_OF_STOCK' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe('https://api.bol.com/retailer/orders/cancellation');
    expect(sent().data).toEqual({ orderItems: [{ orderItemId: '6107434013', reasonCode: 'OUT_OF_STOCK' }] });

    ok(201);
    await call('bol_com_create_offer', {
      ean: '8712626055143',
      condition: { category: 'NEW' },
      pricing: [{ quantity: 1, unitPrice: 19.99 }],
      stock_amount: 5,
      fulfilment: { method: 'FBR', schedule: 'BOL_DELIVERY_PROMISE' },
      reference: 'SKU-1',
    });
    expect(sent().url).toBe('https://api.bol.com/retailer/offers');
    expect(header(sent(), 'Content-Type')).toBe(V11);
    expect(sent().data).toEqual({
      ean: '8712626055143',
      condition: { category: 'NEW' },
      pricing: { bundlePrices: [{ quantity: 1, unitPrice: 19.99 }] },
      stock: { amount: 5, managedByRetailer: true },
      fulfilment: { method: 'FBR', schedule: 'BOL_DELIVERY_PROMISE' },
      reference: 'SKU-1',
    });

    ok(204);
    await call('bol_com_update_offer', { offer_id: 'abc', stock: { amount: 12 } });
    expect(String(sent().method).toUpperCase()).toBe('PATCH');
    expect(sent().url).toBe('https://api.bol.com/retailer/offers/abc');
    expect(sent().data).toEqual({ stock: { amount: 12 } });
  });
});

// Opt-in: RUN_BOL_COM_LIVE=1. The refusal check needs no account; the reads
// need BOL_CLIENT_ID and BOL_CLIENT_SECRET. Nothing is written.
const live = process.env.RUN_BOL_COM_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('bol.com: live', () => {
  it('refuses wrong client credentials at the token endpoint', async () => {
    const response = await liveFetch.post('https://login.bol.com/token', 'grant_type=client_credentials', {
      headers: {
        Authorization: `Basic ${Buffer.from('not-a-client:not-a-secret').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      validateStatus: () => true,
    });
    expect([400, 401]).toContain(response.status);
  });

  it('reads one page of orders and offers', async () => {
    const id = process.env.BOL_CLIENT_ID;
    const secret = process.env.BOL_CLIENT_SECRET;
    if (!id || !secret) throw new Error('Set BOL_CLIENT_ID and BOL_CLIENT_SECRET for the live check');
    const token = await liveFetch.post('https://login.bol.com/token', 'grant_type=client_credentials', {
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    });
    const auth = { Authorization: `Bearer ${token.data.access_token}` };
    const orders = await liveFetch.get('https://api.bol.com/retailer/orders', {
      headers: { ...auth, Accept: V10 },
      validateStatus: () => true,
    });
    expect(orders.status).toBe(200);
    const offers = await liveFetch.get('https://api.bol.com/retailer/offers', {
      headers: { ...auth, Accept: V11 },
      params: { 'page-size': 25 },
      validateStatus: () => true,
    });
    expect(offers.status).toBe(200);
  });
});
