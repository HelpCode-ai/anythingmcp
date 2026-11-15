import axios from 'axios';
import * as adapter from './fyndiq.json';
import * as cdonAdapter from './cdon.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Fyndiq Merchants API adapter: the CDON Group Merchants API on Fyndiq's own
 * host, with Fyndiq's own credentials.
 *
 * Static checks always run: HTTP Basic auth with the merchant id and token,
 * every tool's method and path against the CDON Group Merchants API reference
 * (https://docs.cdon.com/), that the tool set is the CDON one minus what the
 * reference marks "CDON only" (shipping configurations, carrier services,
 * payment reports), the bulk article bodies, and which tools install switched
 * off (cancel, which refunds the customer; delete; the 100-action bulk call).
 * The deprecated Fyndiq-only v1 article writes are not used.
 *
 * Live checks run only with RUN_FYNDIQ_LIVE=1. Without credentials they
 * confirm the API refuses wrong ones; with FYNDIQ_MERCHANT_ID and FYNDIQ_TOKEN
 * they read one new order and one article. Reads only.
 *
 *   RUN_FYNDIQ_LIVE=1 FYNDIQ_MERCHANT_ID=... FYNDIQ_TOKEN=... \
 *     npx jest src/adapters/intl/fyndiq.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    bodyEncoding?: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
type EnvMeta = {
  label?: string;
  pattern?: string;
  patternMessage?: string;
  kind?: string;
  secret?: boolean;
  link?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
};
type Adapter = {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, EnvMeta>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  prerequisites: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const a = adapter as unknown as Adapter;
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
// The website renders descriptions and instructions as MDX: braces and angle
// brackets are only safe inside backticks.
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

const BASE = 'https://merchants-api.fyndiq.se/api';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = ['tok', 'q'.repeat(32), '7'].join('-');
const ENV: Record<string, string> = { FYNDIQ_MERCHANT_ID: '4f3c2b1a-0d9e-4c7b-8a6f-5e4d3c2b1a09', FYNDIQ_TOKEN: FAKE_TOKEN };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
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
const ok = (status = 200, data: unknown = {}) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const method = () => String(sent().method).toUpperCase();

// Every tool with its HTTP method and path, as documented by the vendor.
const ROUTES: Record<string, string> = {
  fyndiq_list_orders: 'GET /v1/orders',
  fyndiq_get_order: 'GET /v1/orders/{order_id}',
  fyndiq_accept_order: 'PUT /v1/orders/{order_id}/accept',
  fyndiq_fulfill_order: 'PUT /v1/orders/{order_id}/fulfill',
  fyndiq_cancel_order: 'PUT /v1/orders/{order_id}/cancel',
  fyndiq_get_order_receipt: 'GET /v1/orders/{order_id}/receipt',
  fyndiq_list_articles: 'GET /v1/articles',
  fyndiq_get_article: 'GET /v1/articles/{article_id}',
  fyndiq_get_article_by_sku: 'GET /v1/articles/sku/{sku}',
  fyndiq_create_article: 'POST /v2/articles/bulk',
  fyndiq_update_article: 'PUT /v2/articles/bulk',
  fyndiq_update_article_price: 'PUT /v2/articles/bulk',
  fyndiq_update_article_quantity: 'PUT /v2/articles/bulk',
  fyndiq_delete_article: 'PUT /v2/articles/bulk',
  fyndiq_bulk_update_articles: 'PUT /v2/articles/bulk',
  fyndiq_get_batch_statuses: 'POST /v1/statuses/batch',
  fyndiq_get_sku_statuses: 'POST /v1/statuses/sku',
  fyndiq_list_categories: 'GET /v1/categories/{market}/{language}/',
};
const SWITCHED_OFF = [
  'fyndiq_cancel_order',
  'fyndiq_delete_article',
  'fyndiq_bulk_update_articles',
];

describe('fyndiq adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('uses HTTP Basic auth with the merchant id and token on the Fyndiq host', async () => {
    expect(a.slug).toBe('fyndiq');
    expect(a.name).toBe('Fyndiq');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('fyndiq');
    expect(a.docsUrl).toBe('https://docs.cdon.com/');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{FYNDIQ_MERCHANT_ID}}', password: '{{FYNDIQ_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['FYNDIQ_MERCHANT_ID', 'FYNDIQ_TOKEN']);
    expect(a.envVarMeta.FYNDIQ_MERCHANT_ID).toMatchObject({ kind: 'credential' });
    expect(a.envVarMeta.FYNDIQ_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(new RegExp(a.envVarMeta.FYNDIQ_MERCHANT_ID.pattern!).test(ENV.FYNDIQ_MERCHANT_ID)).toBe(true);
    expect(new RegExp(a.envVarMeta.FYNDIQ_MERCHANT_ID.pattern!).test('12345')).toBe(true);
    expect(new RegExp(a.envVarMeta.FYNDIQ_TOKEN.pattern!).test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', 'has space here 123456']) expect(new RegExp(a.envVarMeta.FYNDIQ_TOKEN.pattern!).test(bad)).toBe(false);
    expect(new RegExp(a.envVarMeta.FYNDIQ_MERCHANT_ID.pattern!).test('merchant id')).toBe(false);

    ok(200, []);
    await call('fyndiq_list_orders', {});
    expect(sent().url).toBe(`${BASE}/v1/orders`);
    expect(method()).toBe('GET');
    expect(sent().auth).toEqual({ username: ENV.FYNDIQ_MERCHANT_ID, password: FAKE_TOKEN });
    expect(header(sent(), 'Authorization')).toBeUndefined();
    expect(header(sent(), 'Accept')).toBe('application/json');
    expect(sent().params).toEqual({ limit: 100, page: 1 });
  });

  it('probes the order list and explains 400, 401, 403, 404, 422 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'fyndiq_list_orders', params: { limit: 1 } });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['400', '401', '403', '404', '422', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    // Credentials are per marketplace: the hint names the sister marketplace.
    expect(a.verifyHints['401']).toContain('CDON');
  });

  it('maps every tool to the documented method and path', () => {
    const actual = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(actual).toEqual(ROUTES);
    expect(a.tools).toHaveLength(18);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^fyndiq_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      const reads = used(entry);
      for (const arg of reads) expect(`${entry.name}:${arg}:${declared.has(arg) || envNames.has(arg)}`).toBe(`${entry.name}:${arg}:true`);
      for (const arg of declared) expect(`${entry.name}:${arg}:${reads.has(arg)}`).toBe(`${entry.name}:${arg}:true`);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(80);
      for (const [name, prop] of Object.entries(entry.parameters.properties ?? {})) {
        expect(`${entry.name}.${name}: ${prop.description ?? ''}`.length).toBeGreaterThan(entry.name.length + name.length + 12);
      }
    }
  });

  it('keeps braces and angle brackets inside backticks and uses no em dash', () => {
    const texts = [a.description, a.instructions, a.prerequisites, ...a.tools.map((entry) => entry.description)];
    for (const text of texts) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/—/);
    }
  });

  it('marks reads read-only, also the status POSTs, and installs cancel, delete and the bulk call switched off', () => {
    const readPosts = ['fyndiq_get_batch_statuses', 'fyndiq_get_sku_statuses'];
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET' || readPosts.includes(entry.name);
      expect(`${entry.name}:${annotationsOf(entry).readOnlyHint}`).toBe(`${entry.name}:${read}`);
    }
    for (const name of readPosts) expect(tool(name).endpointMapping.method).toBe('POST');
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([...SWITCHED_OFF].sort());
    for (const entry of a.tools) {
      const { method: verb, path } = entry.endpointMapping;
      // Cancelling refunds the customer.
      if (path.endsWith('/cancel')) expect(entry.enabled).toBe(false);
      if (JSON.stringify(entry.endpointMapping.bodyMapping ?? {}).includes('delete_article')) expect(entry.enabled).toBe(false);
      expect(verb).not.toBe('DELETE');
      // The deprecated single-article v1 writes are not used: v1 article paths are reads.
      if (path.startsWith('/v1/articles')) expect(verb).toBe('GET');
      // No test orders in production.
      expect(`${verb} ${path}`).not.toBe('POST /v1/orders');
    }
    // The reference marks these "CDON only": no Fyndiq tool may call them.
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).not.toMatch(/payment-reports|shipping-configurations|carrier-codes/);
      expect(JSON.stringify(entry.parameters)).not.toContain('shipping_configurations');
    }
    // Same tools as the CDON adapter, name for name, with the same request shape.
    const cdonTools = (cdonAdapter as unknown as Adapter).tools;
    const cdonOnly = ['cdon_list_carrier_services', 'cdon_list_shipping_configurations', 'cdon_list_payment_files', 'cdon_get_payment_file', 'cdon_list_settlement_notes'];
    expect(cdonTools.map((t) => t.name).filter((n) => !cdonOnly.includes(n)).map((n) => n.replace(/^cdon_/, 'fyndiq_'))).toEqual(a.tools.map((t) => t.name));
    for (const entry of a.tools) {
      const twin = cdonTools.find((t) => t.name === entry.name.replace(/^fyndiq_/, 'cdon_'))!;
      expect(entry.endpointMapping).toEqual(twin.endpointMapping);
      expect(entry.enabled).toEqual(twin.enabled);
      expect(entry.parameters.required).toEqual(twin.parameters.required);
    }
  });

  it('names every tool and the setup facts in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.startsWith('## Fyndiq\n')).toBe(true);
    expect(a.instructions.length).toBeGreaterThanOrEqual(1500);
    for (const fact of ['seller@fyndiq.com', 'merchants-api.fyndiq.se', 'CREATED', 'NOT_FULFILLED', 'amount_including_vat', 'batch_id', '9,000 calls per minute', 'X-RateLimit-Policy-Violated', 'CDON only', 'does not work on CDON']) {
      expect(a.instructions).toContain(fact);
    }
    expect(a.instructions).not.toContain('cdon_');
  });

  it('reads orders, articles, statuses and categories on the documented paths', async () => {
    ok(200, []);
    await call('fyndiq_list_orders', { state: 'FULFILLED', limit: 1000, page: 3 });
    expect(sent().params).toEqual({ state: 'FULFILLED', limit: 1000, page: 3 });

    ok();
    await call('fyndiq_get_order', { order_id: 'f2a8c0de-1' });
    expect(sent().url).toBe(`${BASE}/v1/orders/f2a8c0de-1`);

    ok();
    await call('fyndiq_get_order_receipt', { order_id: 'f2a8c0de-1' });
    expect(sent().url).toBe(`${BASE}/v1/orders/f2a8c0de-1/receipt`);

    ok(200, []);
    await call('fyndiq_list_articles', { for_sale: true });
    expect(sent().url).toBe(`${BASE}/v1/articles`);
    expect(sent().params).toEqual({ for_sale: true, limit: 100, page: 1 });

    ok();
    await call('fyndiq_get_article', { article_id: 'a1b2c3' });
    expect(sent().url).toBe(`${BASE}/v1/articles/a1b2c3`);

    ok();
    await call('fyndiq_get_article_by_sku', { sku: 'TSHIRT/RED M' });
    expect(sent().url).toBe(`${BASE}/v1/articles/sku/TSHIRT%2FRED%20M`);

    ok(200, []);
    await call('fyndiq_list_categories', { market: 'SE' });
    expect(sent().url).toBe(`${BASE}/v1/categories/SE/en-US/`);

    ok(200, []);
    await call('fyndiq_list_categories', { market: 'FI', language: 'fi-FI' });
    expect(sent().url).toBe(`${BASE}/v1/categories/FI/fi-FI/`);

    ok();
    await call('fyndiq_get_batch_statuses', { batch_ids: ['41675f63-0187-429a-a651-70e8174fe725'], status: 'failed' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/v1/statuses/batch`);
    expect(sent().params).toEqual({ status: 'failed' });
    expect(sent().data).toEqual({ batch_ids: ['41675f63-0187-429a-a651-70e8174fe725'] });

    ok();
    await call('fyndiq_get_sku_statuses', { skus: ['TSHIRT-RED-M'] });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/v1/statuses/sku`);
    expect(sent().params).toEqual({});
    expect(sent().data).toEqual({ skus: ['TSHIRT-RED-M'] });
  });

  it('accepts and fulfils an order with PUT, with and without tracking', async () => {
    ok(202);
    await call('fyndiq_accept_order', { order_id: 'f2a8c0de-1' });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/v1/orders/f2a8c0de-1/accept`);
    expect(sent().data ?? {}).toEqual({});

    const parcels = [{ carrier_name: 'Postnord', tracking_number: 'abc123' }, { tracking_number: 'ghi789' }];
    ok(202);
    await call('fyndiq_fulfill_order', { order_id: 'f2a8c0de-1', tracking_information: parcels });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/v1/orders/f2a8c0de-1/fulfill`);
    expect(sent().data).toEqual({ tracking_information: parcels });

    ok(202);
    await call('fyndiq_fulfill_order', { order_id: 'f2a8c0de-1' });
    expect(sent().data ?? {}).toEqual({});
  });

  it('sends one action per call to the bulk article endpoint for price, stock and update', async () => {
    const price = [{ market: 'SE', value: { amount_including_vat: 349, currency: 'SEK', vat_rate: 25 } }];
    ok(202);
    await call('fyndiq_update_article_price', { sku: 'TSHIRT-BLUE-L', price });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/v2/articles/bulk`);
    expect(sent().data).toEqual({ actions: [{ sku: 'TSHIRT-BLUE-L', action: 'update_article_price', body: { price } }] });

    ok(202);
    await call('fyndiq_update_article_quantity', { sku: 'TSHIRT-GREEN-S', quantity: 0 });
    expect(method()).toBe('PUT');
    expect(sent().data).toEqual({ actions: [{ sku: 'TSHIRT-GREEN-S', action: 'update_article_quantity', body: { quantity: 0 } }] });

    const content = {
      status: 'paused',
      main_image: 'https://example.com/images/tshirt-red-m.jpg',
      markets: ['SE', 'DK'],
      shipping_time: [{ market: 'SE', min: 1, max: 3 }],
      title: [{ language: 'sv-SE', value: 'Röd T-shirt, storlek M' }],
      description: [{ language: 'sv-SE', value: 'En bekväm röd t-shirt i bomull.' }],
    };
    ok(202);
    await call('fyndiq_update_article', { sku: 'TSHIRT-RED-M', article: content });
    expect(method()).toBe('PUT');
    expect(sent().data).toEqual({ actions: [{ sku: 'TSHIRT-RED-M', action: 'update_article', body: content }] });

    const article = { sku: 'TSHIRT-RED-M', quantity: 5, price, ...content, status: 'for sale' };
    ok(202);
    await call('fyndiq_create_article', { article });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/v2/articles/bulk`);
    expect(sent().data).toEqual({ articles: [article] });
    expect((tool('fyndiq_create_article').parameters.properties!.article as unknown as { required?: string[] }).required).toEqual([
      'sku',
      'status',
      'quantity',
      'main_image',
      'markets',
      'price',
      'shipping_time',
      'title',
      'description',
    ]);
  });

  it('builds the switched-off cancel, delete and bulk requests', async () => {
    ok(202);
    await call('fyndiq_cancel_order', { order_id: 'f2a8c0de-1' });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/v1/orders/f2a8c0de-1/cancel`);
    expect(sent().data ?? {}).toEqual({});

    ok(202);
    await call('fyndiq_delete_article', { sku: 'TSHIRT-OUTDATED-XL' });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/v2/articles/bulk`);
    expect(sent().data).toEqual({ actions: [{ sku: 'TSHIRT-OUTDATED-XL', action: 'delete_article' }] });

    const actions = [
      { sku: 'A-1', action: 'update_article_quantity', body: { quantity: 25 } },
      { sku: 'A-2', action: 'delete_article' },
    ];
    ok(202);
    await call('fyndiq_bulk_update_articles', { actions });
    expect(sent().data).toEqual({ actions });
  });
});

// Opt-in: RUN_FYNDIQ_LIVE=1. The refusal check needs no account; the reads need
// FYNDIQ_MERCHANT_ID and FYNDIQ_TOKEN. Nothing is written.
const live = process.env.RUN_FYNDIQ_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Fyndiq: live', () => {
  it('refuses wrong credentials', async () => {
    const response = await liveFetch.get(`${BASE}/v1/orders`, {
      auth: { username: 'not-a-merchant', password: 'not-a-token' },
      headers: { Accept: 'application/json' },
      params: { limit: 1 },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads one new order and one article', async () => {
    const username = process.env.FYNDIQ_MERCHANT_ID;
    const password = process.env.FYNDIQ_TOKEN;
    if (!username || !password) throw new Error('Set FYNDIQ_MERCHANT_ID and FYNDIQ_TOKEN for the live check');
    const options = { auth: { username, password }, headers: { Accept: 'application/json' }, params: { limit: 1 }, validateStatus: () => true };
    const orders = await liveFetch.get(`${BASE}/v1/orders`, options);
    expect(orders.status).toBe(200);
    expect(Array.isArray(orders.data)).toBe(true);
    const articles = await liveFetch.get(`${BASE}/v1/articles`, options);
    expect(articles.status).toBe(200);
    expect(Array.isArray(articles.data)).toBe(true);
  });
});
