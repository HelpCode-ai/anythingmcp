import axios from 'axios';
import * as adapter from './tiktok-shop.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { TikTokShopTokenService, tiktokShopSign } from '../../connectors/engines/tiktok-shop-token.service';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { computeSetupState } from '../../connectors/connector-setup-status.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the TikTok Shop Seller adapter (Open API):
 *
 *   1. Static: always runs. Every tool's method, path, query and body
 *      through the real RestEngine, checked against TikTok Shop's API
 *      reference (partner.tiktokshop.com/docv2, API Reference pages, Nov
 *      2026): app_key, timestamp and sign in the query, shop_cipher where
 *      the API takes it, the token in the x-tts-access-token header, JSON
 *      bodies for POST and PUT, a multipart body for the image upload.
 *
 *   2. Live: skipped unless RUN_TIKTOK_SHOP_LIVE=1 and TIKTOK_SHOP_APP_KEY,
 *      TIKTOK_SHOP_APP_SECRET, TIKTOK_SHOP_ACCESS_TOKEN and
 *      TIKTOK_SHOP_SHOP_CIPHER are set (a Partner Center development shop
 *      works). Reads only. Not run for this adapter's first version: no
 *      Partner Center app was available.
 *
 *        RUN_TIKTOK_SHOP_LIVE=1 TIKTOK_SHOP_APP_KEY=... TIKTOK_SHOP_APP_SECRET=... \
 *          TIKTOK_SHOP_ACCESS_TOKEN=... TIKTOK_SHOP_SHOP_CIPHER=... \
 *          npx jest src/adapters/intl/tiktok-shop.live.spec.ts
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
jest.mock('../../common/outbound-fetch.util', () => ({
  ...jest.requireActual('../../common/outbound-fetch.util'),
  fetchOutbound: jest.fn(async () => ({
    body: Buffer.from('fake-png'),
    headers: { 'content-type': 'image/png' },
    finalUrl: 'https://example.org/p.png',
  })),
}));
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, any>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const HOST = 'https://open-api.tiktokglobalshop.com';
// Built at run time so no literal here looks like a real secret.
const SECRET = ['tts', 'test', 'secret', '0000', 'demo'].join('');
const ENV = { TIKTOK_SHOP_APP_KEY: '38abcd', TIKTOK_SHOP_APP_SECRET: SECRET, TIKTOK_SHOP_SERVICE_ID: '7256213' };
const SHOP = { accessToken: 'TTP_tok', shopCipher: 'GCP_cipher' };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the address, the mapping and authConfig.
const execute = (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV, shop = SHOP) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  const tokens = {
    getShopCredentials: jest.fn().mockResolvedValue(shop),
    renewAfterRejection: jest.fn().mockResolvedValue(null),
  } as unknown as TikTokShopTokenService;
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService, undefined, undefined, tokens).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
      connectorId: 'conn-tts',
      errorWhen: a.connector.config.errorWhen,
    },
    endpointMapping,
    applySchemaDefaults(tool(name).parameters, params),
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];

const WRITES = [
  'tiktok_shop_activate_products',
  'tiktok_shop_create_product',
  'tiktok_shop_deactivate_products',
  'tiktok_shop_edit_product',
  'tiktok_shop_mark_package_shipped',
  'tiktok_shop_partial_edit_product',
  'tiktok_shop_ship_package',
  'tiktok_shop_update_inventory',
  'tiktok_shop_update_order_shipping_info',
  'tiktok_shop_update_price',
];
// POSTs that only read (TikTok searches with a JSON filter body), and the upload.
const POST_READS = [
  'tiktok_shop_get_inventory',
  'tiktok_shop_recommend_category',
  'tiktok_shop_search_cancellations',
  'tiktok_shop_search_orders',
  'tiktok_shop_search_packages',
  'tiktok_shop_search_products',
  'tiktok_shop_search_returns',
];

describe('tiktok-shop adapter: static spec conformance', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { code: 0, message: 'Success', data: {}, request_id: 'r' }, headers: {} });
  });

  it('is listed in e-commerce with its own icon and probes the authorized shops', () => {
    expect(a.slug).toBe('tiktok-shop');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('tiktok-shop');
    expect(a.probe.tool).toBe('tiktok_shop_get_authorized_shops');
    expect(a.connector.healthcheckPath).toBe('/authorization/202309/shops');
    expect(a.connector.baseUrl).toBe(HOST);
  });

  it("signs in the query with the app secret, TikTok's way, through its own token provider", () => {
    expect(a.connector.authType).toBe('HMAC');
    expect(a.connector.authConfig).toMatchObject({
      tokenProvider: 'tiktok-shop',
      appKey: '{{TIKTOK_SHOP_APP_KEY}}',
      serviceId: '{{TIKTOK_SHOP_SERVICE_ID}}',
      signature: {
        algorithm: 'sha256',
        encoding: 'hex',
        secret: '{{TIKTOK_SHOP_APP_SECRET}}',
        placement: 'query',
        paramName: 'sign',
        timestampParam: 'timestamp',
        queryParams: { app_key: '{{TIKTOK_SHOP_APP_KEY}}' },
        excludeMultipartBody: true,
        template: '{{TIKTOK_SHOP_APP_SECRET}}${pathname}${sortedParams}${body}{{TIKTOK_SHOP_APP_SECRET}}',
      },
    });
  });

  it('asks for the app key, secret and service id, the secret as a secret', () => {
    expect(a.requiredEnvVars).toEqual(['TIKTOK_SHOP_APP_KEY', 'TIKTOK_SHOP_APP_SECRET', 'TIKTOK_SHOP_SERVICE_ID']);
    expect(a.optionalEnvVars).toEqual(['TIKTOK_SHOP_MARKET', 'TIKTOK_SHOP_SHOP_ID']);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'TIKTOK_SHOP_APP_SECRET')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'TIKTOK_SHOP_SERVICE_ID')!.secret).toBe(false);
    expect(new RegExp(a.envVarMeta.TIKTOK_SHOP_MARKET.pattern!).test('US')).toBe(true);
    expect(new RegExp(a.envVarMeta.TIKTOK_SHOP_MARKET.pattern!).test('UK')).toBe(false);
  });

  it('needs the shop authorized after install, and is ready once it is', () => {
    const base = { authType: 'HMAC', baseUrl: a.connector.baseUrl, headers: a.connector.headers, config: { adapterSlug: 'tiktok-shop' } };
    expect(computeSetupState({ ...base, authConfig: a.connector.authConfig, envVars: {} }).status).toBe('needs_input');
    expect(computeSetupState({ ...base, authConfig: a.connector.authConfig, envVars: ENV }).status).toBe('needs_authorization');
    expect(
      computeSetupState({
        ...base,
        authConfig: { ...a.connector.authConfig, accessToken: 'at', refreshToken: 'rt', shopCipher: 'c', expiresAt: 1 },
        envVars: ENV,
      }).status,
    ).toBe('ready');
  });

  it('turns an error code inside a 200 answer into an error with the right status', async () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    const cases: Array<[number, number]> = [
      [106001, 401],
      [105002, 401],
      [36009004, 401],
      [105005, 403],
      [36009033, 403],
      [36009002, 429],
      [21001001, 400],
    ];
    for (const [code, status] of cases) {
      mockedAxios.mockResolvedValueOnce({ data: { code, message: `m-${code}`, request_id: 'r' }, headers: {} });
      await expect(execute('tiktok_shop_list_warehouses', {})).rejects.toMatchObject({ status, message: expect.stringContaining(`m-${code}`) });
    }
    mockedAxios.mockResolvedValueOnce({ data: { code: 0, message: 'Success', data: { warehouses: [] } }, headers: {} });
    await expect(execute('tiktok_shop_list_warehouses', {})).resolves.toMatchObject({ data: { warehouses: [] } });
  });

  it('prefixes every tool with tiktok_shop_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^tiktok_shop_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('reads are read-only; writes ask for confirmation and install switched off', () => {
    for (const t of a.tools) {
      const read = t.endpointMapping.method === 'GET' || POST_READS.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${read}`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm/i);
    expect(tool('tiktok_shop_upload_product_image').enabled).not.toBe(false);
    // Nothing that cancels, refunds, approves returns, answers buyers or deletes.
    const forbidden = /cancellations\/[^/]+\/(approve|reject)|returns\/[^/]+\/(approve|reject)|refunds\/|customer_service|^DELETE /;
    for (const t of a.tools) expect(`${t.endpointMapping.method} ${t.endpointMapping.path}`).not.toMatch(forbidden);
  });

  it('only points the model at tools that exist, writes no em dashes and names no third party', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\btiktok_shop_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\btiktok_shop_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(20);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## TikTok Shop Seller\n')).toBe(true);
    for (const text of ['App key', 'App secret', 'Service ID', 'Redirect URL', '/api/tiktok-shop/callback', 'account manager', 'Authorize with Provider', '106001', 'x-tts-access-token']) {
      expect(a.instructions).toContain(text);
    }
    const all = JSON.stringify(adapter);
    expect(all).not.toMatch(/[–—]/);
    expect(all).not.toMatch(/pipedream|github\.com|sdk/i);
  });

  // [tool, args, method, path, shop_cipher sent] from the TikTok Shop API reference.
  const table: Array<[string, Record<string, unknown>, string, string, boolean]> = [
    ['tiktok_shop_get_authorized_shops', {}, 'GET', '/authorization/202309/shops', false],
    ['tiktok_shop_search_orders', { page_size: 20 }, 'POST', '/order/202309/orders/search', true],
    ['tiktok_shop_get_orders', { ids: '1,2' }, 'GET', '/order/202507/orders', true],
    ['tiktok_shop_get_order_price_detail', { order_id: '1' }, 'GET', '/order/202407/orders/1/price_detail', true],
    ['tiktok_shop_search_products', { page_size: 20 }, 'POST', '/product/202502/products/search', true],
    ['tiktok_shop_get_product', { product_id: '9' }, 'GET', '/product/202309/products/9', true],
    ['tiktok_shop_get_inventory', { product_ids: ['9'] }, 'POST', '/product/202309/inventory/search', true],
    ['tiktok_shop_recommend_category', { product_title: 'Mug' }, 'POST', '/product/202309/categories/recommend', true],
    ['tiktok_shop_get_categories', {}, 'GET', '/product/202309/categories', true],
    ['tiktok_shop_get_category_attributes', { category_id: '600001' }, 'GET', '/product/202309/categories/600001/attributes', true],
    ['tiktok_shop_get_category_rules', { category_id: '600001' }, 'GET', '/product/202309/categories/600001/rules', true],
    ['tiktok_shop_get_brands', { page_size: 50 }, 'GET', '/product/202309/brands', true],
    ['tiktok_shop_list_warehouses', {}, 'GET', '/logistics/202309/warehouses', true],
    ['tiktok_shop_get_delivery_options', { warehouse_id: '7' }, 'GET', '/logistics/202309/warehouses/7/delivery_options', true],
    ['tiktok_shop_get_shipping_providers', { delivery_option_id: '5' }, 'GET', '/logistics/202309/delivery_options/5/shipping_providers', true],
    ['tiktok_shop_search_packages', { page_size: 20 }, 'POST', '/fulfillment/202309/packages/search', true],
    ['tiktok_shop_get_package', { package_id: '3' }, 'GET', '/fulfillment/202309/packages/3', true],
    ['tiktok_shop_get_package_handover_time_slots', { package_id: '3' }, 'GET', '/fulfillment/202309/packages/3/handover_time_slots', true],
    ['tiktok_shop_get_shipping_document', { package_id: '3', document_type: 'SHIPPING_LABEL' }, 'GET', '/fulfillment/202309/packages/3/shipping_documents', true],
    ['tiktok_shop_get_order_tracking', { order_id: '1' }, 'GET', '/fulfillment/202309/orders/1/tracking', true],
    ['tiktok_shop_search_returns', {}, 'POST', '/return_refund/202602/returns/search', true],
    ['tiktok_shop_search_cancellations', {}, 'POST', '/return_refund/202602/cancellations/search', true],
    ['tiktok_shop_get_statements', {}, 'GET', '/finance/202309/statements', true],
    ['tiktok_shop_get_order_transactions', { order_id: '1' }, 'GET', '/finance/202501/orders/1/statement_transactions', true],
    ['tiktok_shop_upload_product_image', { image_url: 'https://example.org/p.png' }, 'POST', '/product/202309/images/upload', false],
    ['tiktok_shop_ship_package', { package_id: '3', handover_method: 'DROP_OFF' }, 'POST', '/fulfillment/202309/packages/3/ship', true],
    ['tiktok_shop_mark_package_shipped', { order_id: '1', tracking_number: 'JX12345', shipping_provider_id: '66' }, 'POST', '/fulfillment/202610/orders/1/packages', true],
    ['tiktok_shop_update_order_shipping_info', { order_id: '1', tracking_number: 'JX12345', shipping_provider_id: '66' }, 'POST', '/fulfillment/202309/orders/1/shipping_info/update', true],
    ['tiktok_shop_create_product', { title: 'Mug', description: '<p>Mug</p>', category_id: '600001', main_images: [{ uri: 'u' }], skus: [] }, 'POST', '/product/202309/products', true],
    ['tiktok_shop_edit_product', { product_id: '9', title: 'Mug', description: '<p>Mug</p>', category_id: '600001', main_images: [{ uri: 'u' }], skus: [] }, 'PUT', '/product/202509/products/9', true],
    ['tiktok_shop_partial_edit_product', { product_id: '9', title: 'Mug 2' }, 'POST', '/product/202509/products/9/partial_edit', true],
    ['tiktok_shop_update_inventory', { product_id: '9', skus: [{ id: 's', inventory: [{ warehouse_id: '7', quantity: 5 }] }] }, 'POST', '/product/202309/products/9/inventory/update', true],
    ['tiktok_shop_update_price', { product_id: '9', skus: [{ id: 's', price: { amount: '9.99', currency: 'GBP' } }] }, 'POST', '/product/202309/products/9/prices/update', true],
    ['tiktok_shop_activate_products', { product_ids: ['9'] }, 'POST', '/product/202309/products/activate', true],
    ['tiktok_shop_deactivate_products', { product_ids: ['9'] }, 'POST', '/product/202309/products/deactivate', true],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s %s, signed over that path', async (name, params, method, path, withCipher) => {
    await execute(name, params);
    const cfg = sent();
    expect(cfg.method).toBe(method);
    expect(cfg.url).toBe(`${HOST}${path}`);
    expect(cfg.headers['x-tts-access-token']).toBe('TTP_tok');
    expect(cfg.params.app_key).toBe('38abcd');
    expect(cfg.params.shop_cipher).toBe(withCipher ? 'GCP_cipher' : undefined);
    const { sign, ...query } = cfg.params as Record<string, string>;
    const multipart = tool(name).endpointMapping.bodyEncoding === 'form-data';
    const body = cfg.data === undefined || multipart ? '' : JSON.stringify(cfg.data);
    expect(sign).toBe(tiktokShopSign({ secret: SECRET, path, query, body }));
    if (method === 'GET') expect(cfg.data).toBeUndefined();
    expect(JSON.stringify(cfg.params)).not.toContain(SECRET);
  });

  it('sends the order search filters in the body and paging in the query', async () => {
    await execute('tiktok_shop_search_orders', { page_size: 50, order_status: 'AWAITING_SHIPMENT', update_time_ge: 1700000000, page_token: 'pt' });
    const cfg = sent();
    expect(cfg.params).toMatchObject({ page_size: 50, page_token: 'pt' });
    expect(cfg.data).toEqual({ order_status: 'AWAITING_SHIPMENT', update_time_ge: 1700000000 });
  });

  it('marks a package shipped with one tracking entry, as the 202610 reference documents', async () => {
    await execute('tiktok_shop_mark_package_shipped', {
      order_id: '1',
      tracking_number: 'JX12345',
      shipping_provider_id: '66',
      order_line_list: [{ order_line_id: '11' }],
    });
    expect(sent().data).toEqual({
      order_line_list: [{ order_line_id: '11' }],
      shipping_info_list: [{ tracking_number: 'JX12345', shipping_provider_id: '66' }],
    });
  });

  it('sends stock and price updates as the documented JSON bodies', async () => {
    const skus = [{ id: 's1', inventory: [{ warehouse_id: '7', quantity: 12 }] }];
    await execute('tiktok_shop_update_inventory', { product_id: '9', skus });
    expect(sent().data).toEqual({ skus });
    const priced = [{ id: 's1', price: { amount: '9.99', currency: 'GBP' } }];
    await execute('tiktok_shop_update_price', { product_id: '9', skus: priced });
    expect(sent().data).toEqual({ skus: priced });
  });

  it('asks statements sorted by statement_time, which TikTok requires', async () => {
    await execute('tiktok_shop_get_statements', {});
    expect(sent().params.sort_field).toBe('statement_time');
  });
});

const LIVE =
  process.env.RUN_TIKTOK_SHOP_LIVE === '1' &&
  process.env.TIKTOK_SHOP_APP_KEY &&
  process.env.TIKTOK_SHOP_APP_SECRET &&
  process.env.TIKTOK_SHOP_ACCESS_TOKEN &&
  process.env.TIKTOK_SHOP_SHOP_CIPHER;
const live = LIVE ? describe : describe.skip;

live('tiktok-shop adapter: live API (reads only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const env = () => ({
    TIKTOK_SHOP_APP_KEY: String(process.env.TIKTOK_SHOP_APP_KEY),
    TIKTOK_SHOP_APP_SECRET: String(process.env.TIKTOK_SHOP_APP_SECRET),
    TIKTOK_SHOP_SERVICE_ID: String(process.env.TIKTOK_SHOP_SERVICE_ID ?? 'unused'),
  });
  const shop = () => ({
    accessToken: String(process.env.TIKTOK_SHOP_ACCESS_TOKEN),
    shopCipher: String(process.env.TIKTOK_SHOP_SHOP_CIPHER),
  });

  it('reads the authorized shops, warehouses and recent orders', async () => {
    const shops = await execute('tiktok_shop_get_authorized_shops', {}, env(), shop());
    expect(shops.code).toBe(0);
    const warehouses = await execute('tiktok_shop_list_warehouses', {}, env(), shop());
    expect(warehouses.code).toBe(0);
    const orders = await execute('tiktok_shop_search_orders', { page_size: 5 }, env(), shop());
    expect(orders.code).toBe(0);
  }, 60_000);
});
