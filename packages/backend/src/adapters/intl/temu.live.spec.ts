import axios from 'axios';
import { createHash } from 'node:crypto';
import * as adapter from './temu.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { ResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Temu Partner API adapter (self-developed seller app).
 *
 * Static checks always run: the router address per region, the signature
 * block (plain MD5 over the sorted body fields between the App Secret, upper
 * case, in the body field `sign`), every tool's operation name against Temu's
 * API reference, the bodies of the writes, and which tools install switched
 * off. No tool buys a shipping label, books a pickup, runs ads or refunds.
 * https://partner.temu.com/documentation
 *
 * The signature itself is pinned against Temu's documented example in
 * connectors/engines/rest.engine.digest-signing.spec.ts; here the adapter's
 * own configuration is checked against an independent implementation of the
 * same recipe (`temuSign` below, a port of Temu's Python sample).
 *
 * Live checks run only with RUN_TEMU_LIVE=1. Without keys they confirm that
 * the router refuses a call with an unknown App Key; with TEMU_APP_KEY,
 * TEMU_APP_SECRET, TEMU_ACCESS_TOKEN (and TEMU_REGION) from an allowed IP
 * address they read the token's details. Reads only.
 *
 *   RUN_TEMU_LIVE=1 TEMU_APP_KEY=... TEMU_APP_SECRET=... TEMU_ACCESS_TOKEN=... \
 *     npx jest src/adapters/intl/temu.live.spec.ts
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
  endpointMapping: { method: string; path: string; bodyMapping: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiresIpAllowlist?: boolean;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  setupGuide: { effort: string; steps: Array<{ id: string; fields?: string[]; saveAndCheck?: boolean }> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: { signature: Record<string, unknown> };
    headers: Record<string, string>;
    config: { errorWhen: unknown[] };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

const ENV: Record<string, string> = {
  TEMU_REGION: 'https://openapi-b-eu.temu.com',
  TEMU_APP_KEY: 'f9d5cc9313893a20d5aa85c654e8f503',
  TEMU_APP_SECRET: 'c7e0a1a63542be4de3cb5488f9fba8149e8fc290',
  TEMU_ACCESS_TOKEN: '2nifvmpyymvypwmcms5ct4uqqudrwgpmzbcnmkt1jzjkuaf3x56iixym',
};
const NOW = 1_760_000_000_000;

/**
 * Temu's signature, written independently of the engine after the Python
 * sample of the documentation: sort the fields by name, concatenate name and
 * value (JSON text for anything that is not a string), put the App Secret in
 * front and behind, MD5, upper case.
 */
function temuSign(body: Record<string, unknown>, secret: string): string {
  const text = Object.keys(body)
    .filter((k) => k !== 'sign')
    .sort()
    .map((k) => k + (typeof body[k] === 'string' ? (body[k] as string) : JSON.stringify(body[k])))
    .join('');
  return createHash('md5').update(`${secret}${text}${secret}`, 'utf8').digest('hex').toUpperCase();
}

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: cfg.headers,
      errorWhen: a.connector.config.errorWhen,
    } as never,
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params) },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (result: unknown = {}) =>
  mockedAxios.mockResolvedValueOnce({ status: 200, data: { success: true, errorCode: 1000000, result }, headers: {} });
/** The fields every call carries besides its own. */
const common = { app_key: ENV.TEMU_APP_KEY, access_token: ENV.TEMU_ACCESS_TOKEN, data_type: 'JSON', timestamp: NOW / 1000 };

/** Operation name per tool, from Temu's API reference, and whether it only reads. */
const OPERATIONS: Record<string, { type: string; read: boolean; required?: string[] }> = {
  temu_get_token_info: { type: 'bg.open.accesstoken.info.get', read: true },
  temu_list_orders: { type: 'bg.order.list.v2.get', read: true },
  temu_get_order: { type: 'bg.order.detail.v2.get', read: true, required: ['parent_order_sn'] },
  temu_get_order_shipping_address: { type: 'bg.order.shippinginfo.v2.get', read: true, required: ['parent_order_sn'] },
  temu_get_order_amount: { type: 'temu.order.amount.v2.query', read: true, required: ['parent_order_sn'] },
  temu_list_combinable_orders: { type: 'bg.order.combinedshipment.list.get', read: true },
  temu_list_warehouses: { type: 'bg.logistics.warehouse.list.get', read: true },
  temu_list_carriers: { type: 'bg.logistics.companies.get', read: true, required: ['region_id'] },
  temu_confirm_shipment: { type: 'bg.logistics.shipment.v2.confirm', read: false, required: ['send_type', 'packages'] },
  temu_get_shipment: { type: 'bg.logistics.shipment.v2.get', read: true, required: ['parent_order_sn', 'order_sn'] },
  temu_get_tracking: { type: 'temu.track.trackinginfo.get', read: true, required: ['package_sn'] },
  temu_list_products: { type: 'bg.local.goods.list.query', read: true },
  temu_get_product: { type: 'bg.local.goods.detail.query', read: true, required: ['goods_id'] },
  temu_list_skus: { type: 'bg.local.goods.sku.list.query', read: true },
  temu_get_stock: { type: 'temu.local.goods.sku.stock.query', read: true },
  temu_update_stock: { type: 'bg.local.goods.stock.edit', read: false, required: ['goods_id'] },
  temu_list_sku_prices: { type: 'bg.local.goods.sku.list.price.query', read: true, required: ['goods_id', 'sku_ids'] },
  temu_list_price_offers: { type: 'bg.local.goods.priceorder.query', read: true },
  temu_change_sku_price: { type: 'bg.local.goods.priceorder.change.sku.price', read: false, required: ['goods_id', 'price_changes'] },
  temu_list_categories: { type: 'bg.local.goods.cats.get', read: true },
  temu_set_sale_status: { type: 'bg.local.goods.sale.status.set', read: false, required: ['goods_id', 'on_sale'] },
  temu_list_after_sales: { type: 'bg.aftersales.parentaftersales.list.get', read: true },
  temu_list_cancel_requests: { type: 'bg.aftersales.cancel.list.get', read: true },
  temu_agree_cancel_request: { type: 'bg.aftersales.cancel.agree', read: false, required: ['parent_after_sales_sn', 'parent_order_sn'] },
};

describe('temu adapter: static contract', () => {
  let now: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    now = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => now.mockRestore());

  it('calls the router of the chosen region and needs an allowed IP address', () => {
    expect(a.slug).toBe('temu');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('temu');
    expect(a.requiresIpAllowlist).toBe(true);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{TEMU_REGION}}');
    expect(a.requiredEnvVars).toEqual(['TEMU_REGION', 'TEMU_APP_KEY', 'TEMU_APP_SECRET', 'TEMU_ACCESS_TOKEN']);
    expect(a.envVarMeta.TEMU_REGION.options).toEqual([
      { value: 'https://openapi-b-us.temu.com', label: 'United States' },
      { value: 'https://openapi-b-eu.temu.com', label: 'Europe and United Kingdom' },
      { value: 'https://openapi-b-global.temu.com', label: 'Other countries (Mexico, Japan and others)' },
    ]);
    expect(a.envVarMeta.TEMU_APP_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.TEMU_ACCESS_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    for (const name of ['TEMU_APP_KEY', 'TEMU_APP_SECRET', 'TEMU_ACCESS_TOKEN']) {
      const pattern = new RegExp(a.envVarMeta[name].pattern!);
      expect(pattern.test(ENV[name])).toBe(true);
      expect(pattern.test('has a space')).toBe(false);
    }
  });

  it('signs with a plain MD5 over the sorted body fields between the App Secret, in the body', () => {
    expect(a.connector.authType).toBe('HMAC');
    expect(a.connector.authConfig).toEqual({
      signature: {
        mode: 'digest',
        algorithm: 'md5',
        encoding: 'hex-upper',
        placement: 'body',
        paramName: 'sign',
        timestampParam: 'timestamp',
        bodyParams: { app_key: '{{TEMU_APP_KEY}}', access_token: '{{TEMU_ACCESS_TOKEN}}', data_type: 'JSON' },
        template: '{{TEMU_APP_SECRET}}${sortedParams}{{TEMU_APP_SECRET}}',
      },
    });
    // The secret signs; it is never one of the fields sent.
    expect(JSON.stringify((a.connector.authConfig.signature as { bodyParams: unknown }).bodyParams)).not.toContain('TEMU_APP_SECRET');
    expect(JSON.stringify(a.connector.headers)).not.toContain('TEMU_');
  });

  it('probes with the token details and explains 401, 403 and the rate limit', () => {
    expect(a.probe).toEqual({ tool: 'temu_get_token_info', params: {} });
    for (const key of ['401', '403', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['403']).toContain('5000003');
  });

  it('maps every tool to a POST on the router with its documented operation name', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(OPERATIONS).sort());
    for (const entry of a.tools) {
      const want = OPERATIONS[entry.name];
      expect(entry.endpointMapping.method).toBe('POST');
      expect(entry.endpointMapping.path).toBe('/openapi/router');
      expect(entry.endpointMapping.bodyMapping.type).toBe(want.type);
      expect([...(entry.parameters.required ?? [])].sort()).toEqual([...(want.required ?? [])].sort());
      // No tool can set the fields the signature block owns.
      for (const reserved of ['app_key', 'access_token', 'data_type', 'timestamp', 'sign']) {
        expect(entry.endpointMapping.bodyMapping).not.toHaveProperty(reserved);
      }
      const annotations = deriveToolAnnotations({
        name: entry.name,
        connectorType: 'REST',
        endpointMapping: entry.endpointMapping,
        annotations: entry.annotations,
      });
      expect(annotations.readOnlyHint).toBe(want.read);
    }
    expect(new Set(a.tools.map((entry) => entry.endpointMapping.bodyMapping.type)).size).toBe(a.tools.length);
  });

  it('prefixes every tool, shares no name with another adapter, and describes every parameter it uses', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^temu_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      expect(entry.description.length).toBeGreaterThan(60);
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      const used = new Set<string>();
      const walk = (v: unknown) => {
        if (typeof v === 'string' && /^\$\w+$/.test(v)) used.add(v.slice(1));
        else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
      };
      walk(entry.endpointMapping.bodyMapping);
      expect([...used].sort()).toEqual([...declared].sort());
      for (const p of Object.values(entry.parameters.properties ?? {})) expect(p.description).toBeTruthy();
    }
  });

  it('installs unlisting and the cancellation switched off, and has no label purchase, pickup, ad, refund or product edit', () => {
    expect(a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name).sort()).toEqual([
      'temu_agree_cancel_request',
      'temu_set_sale_status',
    ]);
    const types = a.tools.map((entry) => String(entry.endpointMapping.bodyMapping.type));
    for (const banned of [
      'bg.logistics.shipment.create',
      'bg.logistics.shipment.update',
      'bg.logistics.shipped.package.confirm',
      'temu.aftersales.refund.issue',
      'temu.order.cancel.outofstock.apply',
      'temu.order.cancel.appeal.apply',
      'temu.local.goods.delete',
      'bg.promotion.activity.goods.enroll',
    ]) {
      expect(types).not.toContain(banned);
    }
    for (const type of types) {
      expect(type).not.toMatch(/pickup|searchrec|\.ad\.|refund|goods\.(v\d\.)?add|goods\.update|partial\.update/);
    }
  });

  it('has a four-step guide for a seller with an app of their own that asks for every variable once', () => {
    expect(a.setupGuide.effort).toBe('own_app');
    expect(a.setupGuide.steps.map((step) => step.id)).toEqual(['create-app', 'allow-ip', 'keys', 'authorize']);
    expect(a.setupGuide.steps.flatMap((step) => step.fields ?? []).sort()).toEqual([...a.requiredEnvVars].sort());
    // Not an OAuth sign-in: nothing can be checked before the last step.
    expect(a.setupGuide.steps.some((step) => step.saveAndCheck)).toBe(false);
  });

  it('names every tool in the instructions and keeps texts free of MDX-breaking characters', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, ...a.tools.map((entry) => entry.description)]) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/—/);
    }
  });

  it('sends a call without fields of its own with the common fields and a valid sign', async () => {
    ok({ mallId: 1 });
    await call('temu_get_token_info', {});
    const req = sent();
    expect(req.url).toBe('https://openapi-b-eu.temu.com/openapi/router');
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.headers['Content-Type']).toBe('application/json');
    const expected = { type: 'bg.open.accesstoken.info.get', ...common };
    expect(req.data).toEqual({ ...expected, sign: temuSign(expected, ENV.TEMU_APP_SECRET) });
    expect(req.data.sign).toMatch(/^[0-9A-F]{32}$/);
    // Nothing in the query, and the secret nowhere in the request.
    expect(req.params ?? {}).toEqual({});
    expect(JSON.stringify(req)).not.toContain(ENV.TEMU_APP_SECRET);
  });

  it('uses the address of the region the seller picked', async () => {
    for (const option of a.envVarMeta.TEMU_REGION.options!) {
      ok();
      await call('temu_get_token_info', {}, { ...ENV, TEMU_REGION: option.value });
      expect(sent().url).toBe(`${option.value}/openapi/router`);
    }
  });

  it('lists orders with the documented field names and signs numbers and lists as their JSON text', async () => {
    ok({ totalItemNum: 0, pageItems: [] });
    await call('temu_list_orders', {
      status: 2,
      parent_order_sns: ['PO-211-21905452099192792'],
      created_after: 1759000000,
      created_before: 1760000000,
      sort_by: 'updateTime',
    });
    const expected = {
      type: 'bg.order.list.v2.get',
      pageNumber: 1,
      pageSize: 20,
      parentOrderStatus: 2,
      parentOrderSnList: ['PO-211-21905452099192792'],
      createAfter: 1759000000,
      createBefore: 1760000000,
      sortby: 'updateTime',
      ...common,
    };
    expect(sent().data).toEqual({ ...expected, sign: temuSign(expected, ENV.TEMU_APP_SECRET) });
  });

  it('confirms a shipment with the nested package list exactly as the caller gave it', async () => {
    const packages = [
      {
        carrierId: 699272611,
        trackingNumber: '270324232756',
        selfShippingWarehouseId: 'WH-1',
        orderSendInfoList: [
          { parentOrderSn: 'PO-211-21905452099192792', orderSn: '211-21905473070712792', goodsId: 601099548666279, skuId: 17592352673534, quantity: 1 },
        ],
      },
    ];
    ok({ warningMessage: [] });
    await call('temu_confirm_shipment', { packages });
    const expected = { type: 'bg.logistics.shipment.v2.confirm', sendType: 0, sendRequestList: packages, ...common };
    const data = sent().data;
    expect(data).toEqual({ ...expected, sign: temuSign(expected, ENV.TEMU_APP_SECRET) });
    // The text signed for the list is the text sent for it: same key order.
    expect(JSON.stringify(data.sendRequestList)).toBe(JSON.stringify(packages));
  });

  it('builds the stock, price, category and listing bodies as documented', async () => {
    ok();
    await call('temu_update_stock', { goods_id: 601099548666279, targets: [{ skuId: 17592352673534, stockTarget: 40 }], request_key: 'r-1' });
    expect(sent().data).toMatchObject({
      type: 'bg.local.goods.stock.edit',
      goodsId: 601099548666279,
      skuStockTargetList: [{ skuId: 17592352673534, stockTarget: 40 }],
      requestUniqueKey: 'r-1',
    });
    expect(sent().data).not.toHaveProperty('skuStockChangeList');

    ok();
    await call('temu_list_sku_prices', { goods_id: 601099548666279, sku_ids: [17592352673534] });
    expect(sent().data).toMatchObject({
      type: 'bg.local.goods.sku.list.price.query',
      querySupplierPriceBaseList: [{ goodsId: 601099548666279, skuIdList: [17592352673534] }],
    });

    ok();
    await call('temu_change_sku_price', {
      goods_id: 601099548666279,
      price_changes: [{ reason: 'cost', skuChangePriceBaseDTOList: [{ skuId: 17592352673534, newSupplierPrice: { amount: '12.50', currency: 'USD' } }] }],
    });
    expect(sent().data).toMatchObject({
      type: 'bg.local.goods.priceorder.change.sku.price',
      goodsId: 601099548666279,
      changeSkuPriceDTOList: [{ reason: 'cost', skuChangePriceBaseDTOList: [{ skuId: 17592352673534, newSupplierPrice: { amount: '12.50', currency: 'USD' } }] }],
    });

    ok();
    await call('temu_list_categories', {});
    const cats = { type: 'bg.local.goods.cats.get', parentCatId: 0, ...common };
    expect(sent().data).toEqual({ ...cats, sign: temuSign(cats, ENV.TEMU_APP_SECRET) });

    ok();
    await call('temu_list_products', { search_text: 'mug' });
    expect(sent().data).toMatchObject({ type: 'bg.local.goods.list.query', pageNo: 1, pageSize: 20, goodsStatusFilterType: 1, searchText: 'mug' });

    ok();
    await call('temu_set_sale_status', { goods_id: 601099548666279, on_sale: 0 });
    expect(sent().data).toMatchObject({ type: 'bg.local.goods.sale.status.set', goodsId: 601099548666279, onsale: 0 });
  });

  it.each([
    [3000001, 401],
    [3000034, 401],
    [3000032, 403],
    [5000003, 403],
    [4000004, 429],
    [140020002, 400],
  ])('reports errorCode %i as a failed call with status %i', async (errorCode, status) => {
    mockedAxios.mockResolvedValueOnce({ status: 200, data: { success: false, errorCode, errorMsg: 'refused' }, headers: {} });
    const failure = await call('temu_get_token_info', {}).catch((e) => e);
    expect(failure).toBeInstanceOf(ResponseBodyError);
    expect((failure as ResponseBodyError).status).toBe(status);
    expect((failure as ResponseBodyError).message).toContain(String(errorCode));
  });
});

// Opt-in: RUN_TEMU_LIVE=1. The refusal check needs no account; the read needs
// the three keys and a caller on the app's IP allow-list. Nothing is written.
const live = process.env.RUN_TEMU_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('temu: live', () => {
  const region = process.env.TEMU_REGION || 'https://openapi-b-eu.temu.com';

  it('refuses a signed call with an unknown App Key', async () => {
    const body: Record<string, unknown> = {
      type: 'bg.open.accesstoken.info.get',
      app_key: '00000000000000000000000000000000',
      access_token: 'notanaccesstoken0000000000000000',
      data_type: 'JSON',
      timestamp: Math.floor(Date.now() / 1000),
    };
    body.sign = temuSign(body, 'not-the-secret');
    const response = await liveFetch.post(`${region}/openapi/router`, body, {
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
    expect(response.data.success).toBe(false);
  });

  it('reads the token details with real keys', async () => {
    const env = {
      TEMU_REGION: region,
      TEMU_APP_KEY: process.env.TEMU_APP_KEY ?? '',
      TEMU_APP_SECRET: process.env.TEMU_APP_SECRET ?? '',
      TEMU_ACCESS_TOKEN: process.env.TEMU_ACCESS_TOKEN ?? '',
    };
    if (!env.TEMU_APP_KEY || !env.TEMU_APP_SECRET || !env.TEMU_ACCESS_TOKEN) return;
    mockedAxios.mockImplementation(liveFetch as never);
    const result = (await call('temu_get_token_info', {}, env)) as { success: boolean; result: { mallId: number } };
    expect(result.success).toBe(true);
    expect(result.result.mallId).toBeGreaterThan(0);
  });
});
