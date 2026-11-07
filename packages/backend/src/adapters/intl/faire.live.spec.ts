import axios from 'axios';
import * as adapter from './faire.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Faire adapter:
 *
 *   1. Static: always runs. Pins the OAuth header pair Faire's External API v2
 *      documents (X-FAIRE-OAUTH-ACCESS-TOKEN plus X-FAIRE-APP-CREDENTIALS) on
 *      https://www.faire.com/external-api/v2, checks every tool is a read-only
 *      GET to the right URL, that inventory uses the /product-inventory
 *      endpoints (the old inventory-levels ones were removed on 2026-06-01),
 *      and that the list mappings keep the cursor and the useful fields.
 *
 *   2. Live: skipped unless RUN_FAIRE_LIVE=1.
 *      With FAIRE_OAUTH_ACCESS_TOKEN and FAIRE_APP_CREDENTIALS, they read the
 *      brand profile, list orders and products, open the first of each and
 *      read inventory for the first variant. Nothing is written.
 *
 *        RUN_FAIRE_LIVE=1 npx jest src/adapters/intl/faire.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: unknown;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const FAKE_TOKEN = 'oaa_' + 'a'.repeat(40);
const FAKE_CREDS = Buffer.from('app_123:secret_456').toString('base64');
const ENV: Record<string, string> = { FAIRE_OAUTH_ACCESS_TOKEN: FAKE_TOKEN, FAIRE_APP_CREDENTIALS: FAKE_CREDS };
const BASE = 'https://www.faire.com/external-api/v2';

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => {
  const req = sent();
  return new URLSearchParams(req.paramsSerializer ? req.paramsSerializer(req.params) : '');
};
const header = (name: string) => {
  const h = sent().headers as Record<string, string>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
};

describe('faire adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed and categorized as e-commerce', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('faire');
    expect(a.docsUrl).toMatch(/^https:\/\/faire\.github\.io\//);
  });

  it('sends the documented OAuth header pair as variable references', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'X-FAIRE-OAUTH-ACCESS-TOKEN',
      apiKey: '{{FAIRE_OAUTH_ACCESS_TOKEN}}',
      extraHeaders: { 'X-FAIRE-APP-CREDENTIALS': '{{FAIRE_APP_CREDENTIALS}}' },
    });
    expect(a.requiredEnvVars).toEqual(['FAIRE_OAUTH_ACCESS_TOKEN', 'FAIRE_APP_CREDENTIALS']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.FAIRE_OAUTH_ACCESS_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(meta.FAIRE_APP_CREDENTIALS).toMatchObject({ kind: 'credential', secret: true });
  });

  it('accepts a Base64 credential pair but not the raw id:secret', () => {
    const creds = new RegExp(a.envVarMeta.FAIRE_APP_CREDENTIALS.pattern!);
    expect(creds.test(FAKE_CREDS)).toBe(true);
    for (const bad of ['', 'app_123:secret_456', 'abc def']) expect(creds.test(bad)).toBe(false);
    const token = new RegExp(a.envVarMeta.FAIRE_OAUTH_ACCESS_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', 'short', `Bearer ${FAKE_TOKEN}`]) expect(token.test(bad)).toBe(false);
  });

  it('probes with the brand profile and explains auth, scope and rate-limit failures', () => {
    expect(a.probe.tool).toBe('faire_get_brand_profile');
    for (const key of ['401', '403', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool with faire_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^faire_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('has exactly 7 tools and all are read-only GET methods', () => {
    expect(a.tools.length).toBe(7);
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.bodyMapping).toBeUndefined();
      expect(annotationsOf(t)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it('only points the model at tools that exist, and descriptions meet minimum length', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bfaire_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bfaire_[a-z_]+/g)]),
      ...a.tools.flatMap((t) => Object.values(t.parameters.properties ?? {}).flatMap((p) => [...(p.description ?? '').matchAll(/\bfaire_[a-z_]+/g)])),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('instructions meet the 800-character minimum and cover auth, IDs, paging and money', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    for (const text of ['X-FAIRE-OAUTH-ACCESS-TOKEN', 'X-FAIRE-APP-CREDENTIALS', 'READ_ORDERS', 'bo_', 'p_', 'cursor', 'amount_minor', '429']) {
      expect(a.instructions).toContain(text);
    }
  });

  const table: Array<[string, Record<string, unknown>, string]> = [
    ['faire_get_brand_profile', {}, '/brands/profile'],
    ['faire_list_orders', {}, '/orders'],
    ['faire_get_order', { order_id: 'bo_bxdmjbwxid' }, '/orders/bo_bxdmjbwxid'],
    ['faire_list_products', {}, '/products'],
    ['faire_get_product', { product_id: 'p_123' }, '/products/p_123'],
    ['faire_get_inventory_by_skus', { skus: 'CANDLE-RED-L' }, '/product-inventory/by-skus'],
    ['faire_get_inventory_by_variant_ids', { ids: 'po_123' }, '/product-inventory/by-product-variant-ids'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends GET to the right URL with both Faire headers', async (name, params, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${BASE}${path}`);
    expect(header('X-FAIRE-OAUTH-ACCESS-TOKEN')).toBe(FAKE_TOKEN);
    expect(header('X-FAIRE-APP-CREDENTIALS')).toBe(FAKE_CREDS);
    expect(header('X-FAIRE-ACCESS-TOKEN')).toBeUndefined();
    expect(JSON.stringify(req)).not.toContain('{{');
    expect(JSON.stringify(req)).not.toContain('${');
  });

  it('does not call the removed inventory-levels endpoints', () => {
    expect(JSON.stringify(adapter)).not.toContain('inventory-levels');
  });

  it('lists orders with filters, a 50 default page size and a cursor', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('faire_list_orders', {
      cursor: 'abc',
      updated_at_min: '2026-10-01T00:00:00.000Z',
      excluded_states: 'DELIVERED,CANCELED',
      ship_after_max: '2026-11-10T00:00:00.000Z',
    });
    const q = query();
    expect(q.get('limit')).toBe('50');
    expect(q.get('cursor')).toBe('abc');
    expect(q.get('updated_at_min')).toBe('2026-10-01T00:00:00.000Z');
    expect(q.get('excluded_states')).toBe('DELIVERED,CANCELED');
    expect(q.get('ship_after_max')).toBe('2026-11-10T00:00:00.000Z');
    expect(q.has('created_at_min')).toBe(false);
    expect(tool('faire_list_orders').parameters.properties!.limit.maximum).toBe(50);
  });

  it('lists products by SKU and reads inventory by SKUs or variant IDs', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('faire_list_products', { sku: 'CANDLE-RED-L' });
    expect(query().get('sku')).toBe('CANDLE-RED-L');
    expect(query().has('include_deleted')).toBe(false);

    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('faire_get_inventory_by_skus', { skus: 'A-1,B-2' });
    expect(query().get('skus')).toBe('A-1,B-2');

    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('faire_get_inventory_by_variant_ids', { ids: 'po_1,po_2' });
    expect(query().get('ids')).toBe('po_1,po_2');
  });

  it('keeps the cursor and the useful order fields, and drops the street address and phone', () => {
    const raw = {
      page: 1,
      limit: 50,
      cursor: 'next-1',
      orders: [
        {
          id: 'bo_abc',
          display_id: 'ABC',
          state: 'NEW',
          created_at: '2026-11-01T00:00:00.000Z',
          retailer_id: 'r_1',
          address: { name: 'Jo', address1: '1 Main St', phone_number: '+1555', city: 'Austin', country_code: 'USA', company_name: 'Shop' },
          items: [{ id: 'oi_1', sku: 'A-1', quantity: 6, price: { amount_minor: 1250, currency: 'USD' }, state: 'NEW', customizations: [] }],
          shipments: [{ carrier: 'UPS', tracking_code: '1Z', maker_cost_cents: 900 }],
          payout_costs: { total_payout: { amount_minor: 6000, currency: 'USD' }, commission_bps: 1500 },
        },
      ],
    };
    const out = applyResponseTransform(raw, tool('faire_list_orders').responseMapping as never).value as any;
    expect(out.cursor).toBe('next-1');
    const o = out.orders[0];
    expect(o).toMatchObject({ id: 'bo_abc', state: 'NEW', retailer_id: 'r_1', ship_to_city: 'Austin', ship_to_company: 'Shop' });
    expect(o.total_payout).toEqual({ amount_minor: 6000, currency: 'USD' });
    expect(o.items[0]).toMatchObject({ sku: 'A-1', quantity: 6, price: { amount_minor: 1250, currency: 'USD' } });
    expect(o.shipments[0]).toMatchObject({ carrier: 'UPS', tracking_code: '1Z' });
    expect(JSON.stringify(out)).not.toContain('1 Main St');
    expect(JSON.stringify(out)).not.toContain('+1555');
  });

  it('keeps the cursor and variant SKU, stock and prices on products', () => {
    const raw = {
      cursor: 'next-2',
      products: [
        {
          id: 'p_1',
          name: 'Candle',
          description: 'x'.repeat(5000),
          lifecycle_state: 'PUBLISHED',
          sale_state: 'FOR_SALE',
          images: [{ url: 'https://img' }],
          variants: [
            { id: 'po_1', sku: 'A-1', available_quantity: 12, prices: [{ wholesale_price: { amount_minor: 800, currency: 'USD' } }], images: [{ url: 'https://img' }] },
          ],
        },
      ],
    };
    const out = applyResponseTransform(raw, tool('faire_list_products').responseMapping as never).value as any;
    expect(out.cursor).toBe('next-2');
    expect(out.products[0]).toMatchObject({ id: 'p_1', name: 'Candle', lifecycle_state: 'PUBLISHED' });
    expect(out.products[0].variants[0]).toMatchObject({ id: 'po_1', sku: 'A-1', available_quantity: 12 });
    expect(out.products[0].variants[0].prices[0].wholesale_price.amount_minor).toBe(800);
    expect(JSON.stringify(out)).not.toContain('xxxxxxxxxx');
    expect(JSON.stringify(out)).not.toContain('https://img');
  });
});

const live = process.env.RUN_FAIRE_LIVE === '1' ? describe : describe.skip;
live('faire adapter: live', () => {
  const liveEnv = (): Record<string, string> => {
    for (const name of ['FAIRE_OAUTH_ACCESS_TOKEN', 'FAIRE_APP_CREDENTIALS']) {
      if (!process.env[name]?.trim()) throw new Error(`Set ${name} before running Faire live tests`);
    }
    return {
      FAIRE_OAUTH_ACCESS_TOKEN: process.env.FAIRE_OAUTH_ACCESS_TOKEN!,
      FAIRE_APP_CREDENTIALS: process.env.FAIRE_APP_CREDENTIALS!,
    };
  };

  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it('reads the brand profile', async () => {
    const profile = await call('faire_get_brand_profile', {}, liveEnv());
    expect(profile?.brand_id).toMatch(/^b_/);
  }, 30000);

  it('lists orders and opens the first one', async () => {
    const env = liveEnv();
    const orders = await call('faire_list_orders', { limit: 5 }, env);
    expect(Array.isArray(orders?.orders)).toBe(true);
    if (!orders.orders.length) return;
    const order = await call('faire_get_order', { order_id: orders.orders[0].id }, env);
    expect(order?.id).toBe(orders.orders[0].id);
  }, 30000);

  it('lists products, opens the first one and reads inventory for its first variant', async () => {
    const env = liveEnv();
    const products = await call('faire_list_products', { limit: 5 }, env);
    expect(Array.isArray(products?.products)).toBe(true);
    if (!products.products.length) return;
    const product = await call('faire_get_product', { product_id: products.products[0].id }, env);
    expect(product?.id).toBe(products.products[0].id);
    const variant = product.variants?.[0];
    if (!variant) return;
    const byId = await call('faire_get_inventory_by_variant_ids', { ids: variant.id }, env);
    expect(typeof byId?.inventories).toBe('object');
    if (variant.sku) {
      const bySku = await call('faire_get_inventory_by_skus', { skus: variant.sku }, env);
      expect(typeof bySku?.inventories).toBe('object');
    }
  }, 60000);
});
