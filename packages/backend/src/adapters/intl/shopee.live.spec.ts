import axios from 'axios';
import * as adapter from './shopee.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { ShopeeTokenService, shopeeBaseString, shopeeSign } from '../../connectors/engines/shopee-token.service';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { computeSetupState } from '../../connectors/connector-setup-status.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Shopee Seller adapter (Open Platform v2):
 *
 *   1. Static: always runs. Every tool's method, path and query through the
 *      real RestEngine, checked against Shopee's API reference
 *      (open.shopee.com, v2 module docs, Oct 2026): GET with parameters in
 *      the query, POST with a JSON body, the common parameters and the sign
 *      in the query of both. Array parameters (item_status, item_id_list) go
 *      as repeated keys, order_sn_list comma-joined, as the reference says.
 *
 *   2. Live: skipped unless RUN_SHOPEE_LIVE=1 and SHOPEE_HOST,
 *      SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_ACCESS_TOKEN and
 *      SHOPEE_SHOP_ID are set (a sandbox shop works). Reads only. Not run for
 *      this adapter's first version: no partner account was available.
 *
 *        RUN_SHOPEE_LIVE=1 SHOPEE_HOST=https://openplatform.sandbox.test-stable.shopee.sg ... \
 *          npx jest src/adapters/intl/shopee.live.spec.ts
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
  enabled?: boolean;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
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

const HOST = 'https://partner.shopeemobile.com';
// Built at run time so no literal here looks like a real key.
const PARTNER_KEY = ['shpk', '4a6f', 'test', '0000', 'demo'].join('');
const ENV = { SHOPEE_HOST: HOST, SHOPEE_PARTNER_ID: '2001887', SHOPEE_PARTNER_KEY: PARTNER_KEY };
const SHOP = { access_token: 'tok-abc', shop_id: '14701711' };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the address, the mapping and authConfig.
const execute = (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV, shop = SHOP) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  const tokens = {
    getShopParams: jest.fn().mockResolvedValue(shop),
    renewAfterRejection: jest.fn().mockResolvedValue(null),
  } as unknown as ShopeeTokenService;
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService, undefined, tokens).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
      connectorId: 'conn-shopee',
      errorWhen: a.connector.config.errorWhen,
    },
    endpointMapping,
    applySchemaDefaults(tool(name).parameters, params),
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];

const WRITES = ['shopee_update_price', 'shopee_update_stock'];

describe('shopee adapter: static spec conformance', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: '', message: '', request_id: 'r', response: {} }, headers: {} });
  });

  it('is listed in e-commerce with its own icon', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('shopee');
    expect(a.icon).toBe('shopee');
    expect(a.category).toBe('e-commerce');
    expect(a.probe.tool).toBe('shopee_get_shop_info');
    expect(a.connector.healthcheckPath).toBe('/api/v2/shop/get_shop_info');
  });

  it('signs in the query with the partner key, over partner_id + path + timestamp + token + shop', () => {
    expect(a.connector.baseUrl).toBe('{{SHOPEE_HOST}}');
    expect(a.connector.authType).toBe('HMAC');
    expect(a.connector.authConfig).toEqual({
      tokenProvider: 'shopee',
      partnerId: '{{SHOPEE_PARTNER_ID}}',
      signature: {
        algorithm: 'sha256',
        encoding: 'hex',
        secret: '{{SHOPEE_PARTNER_KEY}}',
        placement: 'query',
        paramName: 'sign',
        timestampParam: 'timestamp',
        queryParams: { partner_id: '{{SHOPEE_PARTNER_ID}}' },
        template: '${query.partner_id}${pathname}${timestamp}${query.access_token}${query.shop_id}',
      },
    });
  });

  it('sends the documented common parameters and a sign Shopee recomputes', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1655714431000);
    try {
      await execute('shopee_get_order_details', { order_sn_list: '201214JASXYXY6,201214JAJXU6G7' });
    } finally {
      now.mockRestore();
    }
    const cfg = sent();
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toBe(`${HOST}/api/v2/order/get_order_detail`);
    expect(cfg.params).toMatchObject({ partner_id: '2001887', timestamp: '1655714431', access_token: 'tok-abc', shop_id: '14701711' });
    expect(cfg.params.sign).toBe(
      shopeeSign(
        PARTNER_KEY,
        shopeeBaseString({ partnerId: 2001887, path: '/api/v2/order/get_order_detail', timestamp: 1655714431, accessToken: 'tok-abc', shopId: 14701711 }),
      ),
    );
    expect(cfg.params.order_sn_list).toBe('201214JASXYXY6,201214JAJXU6G7');
    expect(cfg.params.response_optional_fields).toContain('item_list');
    expect(JSON.stringify(cfg)).not.toContain(PARTNER_KEY);
    expect(cfg.headers.Signature).toBeUndefined();
  });

  it('asks for the host (Shopee hosts only), the partner id and the key, the key as a secret', () => {
    expect(a.requiredEnvVars).toEqual(['SHOPEE_HOST', 'SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY']);
    const host = new RegExp(a.envVarMeta.SHOPEE_HOST.pattern!);
    for (const ok of [
      'https://partner.shopeemobile.com',
      'https://partner.test-stable.shopeemobile.com',
      'https://openplatform.shopee.cn',
      'https://openplatform.shopee.com.br',
      'https://openplatform.sandbox.test-stable.shopee.sg',
      'https://openplatform.sandbox.test-stable.shopee.cn',
      'https://openplatform.test-stable.shopee.cn',
    ]) {
      expect(host.test(ok)).toBe(true);
    }
    for (const bad of [
      'http://partner.shopeemobile.com',
      'https://partner.shopeemobile.com/',
      'https://partner.shopeemobile.com/api/v2',
      'https://partner.shopeemobile.com.evil.example',
      'https://evil.example',
    ]) {
      expect(host.test(bad)).toBe(false);
    }
    expect(a.envVarMeta.SHOPEE_PARTNER_KEY.secret).toBe(true);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'SHOPEE_PARTNER_KEY')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'SHOPEE_PARTNER_ID')!.secret).toBe(false);
    expect(new RegExp(a.envVarMeta.SHOPEE_PARTNER_ID.pattern!).test('2001887')).toBe(true);
  });

  it('needs the shop authorized after install, and is ready once it is', () => {
    const base = { authType: 'HMAC', baseUrl: a.connector.baseUrl, headers: a.connector.headers, config: { adapterSlug: 'shopee' } };
    expect(computeSetupState({ ...base, authConfig: a.connector.authConfig, envVars: {} }).status).toBe('needs_input');
    expect(computeSetupState({ ...base, authConfig: a.connector.authConfig, envVars: ENV }).status).toBe('needs_authorization');
    expect(
      computeSetupState({
        ...base,
        authConfig: { ...a.connector.authConfig, accessToken: 'at', refreshToken: 'rt', shopId: '1', expiresAt: 1 },
        envVars: ENV,
      }).status,
    ).toBe('ready');
  });

  it('turns an error inside a 200 answer into an error with the right status', async () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    const cases: Array<[string, number]> = [
      ['error_sign', 401],
      ['invalid_acceess_token', 401],
      ['error_permission', 403],
      ['error_rate_limit', 429],
      ['error_param', 400],
    ];
    for (const [code, status] of cases) {
      mockedAxios.mockResolvedValueOnce({ data: { error: code, message: `m-${code}`, request_id: 'r' }, headers: {} });
      await expect(execute('shopee_get_shop_profile', {})).rejects.toMatchObject({ status, message: expect.stringContaining(`m-${code}`) });
    }
    // Empty error: success.
    mockedAxios.mockResolvedValueOnce({ data: { error: '', message: '', response: { shop_name: 'S' } }, headers: {} });
    await expect(execute('shopee_get_shop_profile', {})).resolves.toMatchObject({ response: { shop_name: 'S' } });
  });

  it('prefixes every tool with shopee_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^shopee_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('reads are read-only; the two writes ask for confirmation and install switched off', () => {
    for (const t of a.tools) {
      const read = t.endpointMapping.method === 'GET';
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${read}`);
    }
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(WRITES);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) {
      expect(tool(name).description).toMatch(/confirm with the user first/i);
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    }
    // Nothing that ships, cancels, refunds, replies or pays.
    const forbidden = /ship_order|cancel_order|handle_buyer_cancellation|accept_offer|confirm|refund|dispute|send_message|withdraw|delete|unlist_item|add_item/;
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(forbidden);
  });

  it('only points the model at tools that exist, writes no em dashes and names no third party', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bshopee_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bshopee_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(15);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Shopee Seller\n')).toBe(true);
    for (const text of ['Partner ID', 'Partner Key', 'Redirect URL Domain', 'Authorize with Provider', 'sandbox', 'openplatform.shopee.cn', '/api/shopee/callback/']) {
      expect(a.instructions).toContain(text);
    }
    const all = JSON.stringify(adapter);
    expect(all).not.toMatch(/[–—]/);
    expect(all).not.toMatch(/pipedream|github\.com|sdk/i);
  });

  // [tool, args, method, path] from the Shopee Open Platform v2 API reference.
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['shopee_get_shop_info', {}, 'GET', '/api/v2/shop/get_shop_info'],
    ['shopee_get_shop_profile', {}, 'GET', '/api/v2/shop/get_profile'],
    ['shopee_list_items', {}, 'GET', '/api/v2/product/get_item_list'],
    ['shopee_search_items', { item_name: 'mug' }, 'GET', '/api/v2/product/search_item'],
    ['shopee_get_items', { item_id_list: [1, 2] }, 'GET', '/api/v2/product/get_item_base_info'],
    ['shopee_get_items_extra_info', { item_id_list: [1] }, 'GET', '/api/v2/product/get_item_extra_info'],
    ['shopee_get_item_models', { item_id: 1 }, 'GET', '/api/v2/product/get_model_list'],
    ['shopee_update_stock', { item_id: 1, stock_list: [{ model_id: 0, seller_stock: [{ stock: 3 }] }] }, 'POST', '/api/v2/product/update_stock'],
    ['shopee_update_price', { item_id: 1, price_list: [{ model_id: 0, original_price: 9.9 }] }, 'POST', '/api/v2/product/update_price'],
    ['shopee_list_orders', { time_from: 1, time_to: 2 }, 'GET', '/api/v2/order/get_order_list'],
    ['shopee_get_order_details', { order_sn_list: 'A1' }, 'GET', '/api/v2/order/get_order_detail'],
    ['shopee_list_orders_to_ship', {}, 'GET', '/api/v2/order/get_shipment_list'],
    ['shopee_get_shipping_parameter', { order_sn: 'A1' }, 'GET', '/api/v2/logistics/get_shipping_parameter'],
    ['shopee_get_tracking_number', { order_sn: 'A1' }, 'GET', '/api/v2/logistics/get_tracking_number'],
    ['shopee_get_tracking_info', { order_sn: 'A1' }, 'GET', '/api/v2/logistics/get_tracking_info'],
    ['shopee_list_logistics_channels', {}, 'GET', '/api/v2/logistics/get_channel_list'],
    ['shopee_list_returns', {}, 'GET', '/api/v2/returns/get_return_list'],
    ['shopee_get_return', { return_sn: 'R1' }, 'GET', '/api/v2/returns/get_return_detail'],
    ['shopee_get_order_income', { order_sn: 'A1' }, 'GET', '/api/v2/payment/get_escrow_detail'],
    ['shopee_list_discounts', {}, 'GET', '/api/v2/discount/get_discount_list'],
    ['shopee_get_ads_balance', {}, 'GET', '/api/v2/ads/get_total_balance'],
    ['shopee_get_ads_daily_performance', { start_date: '01-10-2026', end_date: '15-10-2026' }, 'GET', '/api/v2/ads/get_all_cpc_ads_daily_performance'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to %s, signed over that path', async (name, params, method, path) => {
    await execute(name, params);
    const cfg = sent();
    expect(cfg.method).toBe(method);
    expect(cfg.url).toBe(`${HOST}${path}`);
    expect(cfg.params.sign).toBe(
      shopeeSign(PARTNER_KEY, `2001887${path}${cfg.params.timestamp}tok-abc14701711`),
    );
    if (method === 'GET') expect(cfg.data).toBeUndefined();
  });

  it('pages listings with repeated item_status keys and the documented defaults', async () => {
    await execute('shopee_list_items', {});
    const cfg = sent();
    expect(cfg.params).toMatchObject({ offset: 0, page_size: 50, item_status: ['NORMAL'] });
    expect(cfg.paramsSerializer({ item_status: ['NORMAL', 'UNLIST'] })).toBe('item_status=NORMAL&item_status=UNLIST');
    await execute('shopee_get_items', { item_id_list: [34001, 34002] });
    expect(sent().paramsSerializer(sent().params)).toMatch(/^item_id_list=34001&item_id_list=34002&/);
  });

  it('asks for orders in a create_time window with the status field, and returns pages from 1', async () => {
    await execute('shopee_list_orders', { time_from: 1760000000, time_to: 1761000000 });
    expect(sent().params).toMatchObject({
      time_range_field: 'create_time',
      time_from: 1760000000,
      time_to: 1761000000,
      page_size: 50,
      response_optional_fields: 'order_status',
    });
    await execute('shopee_list_returns', {});
    expect(sent().params).toMatchObject({ page_no: 1, page_size: 40 });
    await execute('shopee_list_discounts', {});
    expect(sent().params).toMatchObject({ discount_status: 'ongoing', page_no: 1, page_size: 50 });
  });

  it('sends stock and price updates as the documented JSON bodies', async () => {
    const stock_list = [{ model_id: 2001, seller_stock: [{ location_id: 'SGZ', stock: 7 }] }];
    await execute('shopee_update_stock', { item_id: 800000001, stock_list });
    expect(sent().data).toEqual({ item_id: 800000001, stock_list });
    const price_list = [{ model_id: 0, original_price: 12.5 }];
    await execute('shopee_update_price', { item_id: 800000001, price_list });
    expect(sent().data).toEqual({ item_id: 800000001, price_list });
  });
});

const LIVE = process.env.RUN_SHOPEE_LIVE === '1' && process.env.SHOPEE_ACCESS_TOKEN && process.env.SHOPEE_SHOP_ID;
const live = LIVE ? describe : describe.skip;

live('shopee adapter: live API (reads only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const env = () => ({
    SHOPEE_HOST: String(process.env.SHOPEE_HOST),
    SHOPEE_PARTNER_ID: String(process.env.SHOPEE_PARTNER_ID),
    SHOPEE_PARTNER_KEY: String(process.env.SHOPEE_PARTNER_KEY),
  });
  const shop = () => ({ access_token: String(process.env.SHOPEE_ACCESS_TOKEN), shop_id: String(process.env.SHOPEE_SHOP_ID) });

  it('reads the shop, its listings and its channels', async () => {
    const info = await execute('shopee_get_shop_info', {}, env(), shop());
    expect(info.error).toBe('');
    const items = await execute('shopee_list_items', { page_size: 5 }, env(), shop());
    expect(items.response).toBeDefined();
    const channels = await execute('shopee_list_logistics_channels', {}, env(), shop());
    expect(channels.response).toBeDefined();
  }, 60_000);
});
