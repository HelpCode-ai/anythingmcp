import axios from 'axios';
// The default import is the module object itself, so a spy on it is seen by
// the engine (a namespace import would be a copy).
import nodeCrypto from 'node:crypto';
import * as adapter from './shein.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { SheinTokenService, sheinSignature } from '../../connectors/engines/shein-token.service';
import {
  assertNoResponseBodyError,
  describeErrorWhenProblems,
  ResponseBodyError,
} from '../../connectors/engines/response-error.util';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * SHEIN Seller adapter (SHEIN Open Platform, open.sheincorp.com).
 *
 *   1. Static: always runs. Every tool's method, path and required parameters
 *      against SHEIN's API documentation (read Nov 2026), the signing block,
 *      the token provider block, the switched-off set, the error rules, the
 *      setup guide and the texts. Requests go through the real RestEngine
 *      with axios mocked and the real SheinTokenService (its pure part: the
 *      stored shop keys filled into the signature block). The headers are
 *      checked against SHEIN's "Signature Rules" recipe written out in this
 *      file, and that recipe against the page's worked example.
 *
 *   2. Live: skipped unless RUN_SHEIN_LIVE=1 and SHEIN_API_HOST,
 *      SHEIN_OPEN_KEY_ID and SHEIN_SECRET_KEY (the decrypted key of an
 *      authorized shop) are set, from an address on the app's IP whitelist.
 *      Reads only. Not run for this adapter's first version: no SHEIN app was
 *      available.
 *
 *        RUN_SHEIN_LIVE=1 SHEIN_API_HOST=https://openapi.sheincorp.com SHEIN_OPEN_KEY_ID=... \
 *          SHEIN_SECRET_KEY=... npx jest src/adapters/intl/shein.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

type Param = {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: { type?: string; pattern?: string; properties?: Record<string, Param>; required?: string[] };
  pattern?: string;
  properties?: Record<string, Param>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, Param>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyIntegers?: string[];
  };
  annotations?: Record<string, unknown>;
};
type GuideStep = {
  id: string;
  title: string;
  body?: string;
  action?: { label: string; url: string };
  values?: Array<{ label: string; value: string; pick?: boolean }>;
  fields?: string[];
  confirm?: string;
  problems?: Array<{ q: string; a: string }>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  prerequisites: string;
  requiresIpAllowlist?: boolean;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<
    string,
    { kind?: string; secret?: boolean; pattern?: string; options?: Array<{ value: string; label: string }> }
  >;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  setupGuide: { effort: string; minutes: number; examples: string[]; needs: string[]; why: string; steps: GuideStep[] };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, any>;
    headers: Record<string, string>;
    config: { errorWhen: unknown; largeIntegers?: string };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({
    name: t.name,
    connectorType: 'REST',
    endpointMapping: t.endpointMapping,
    annotations: t.annotations,
  } as never);

// The worked example of SHEIN's "Signature Rules" page (/documents/system/passwdrule).
const DOC = {
  openKeyId: 'B96C15416C9240DF96BAA0BC9B367C6D',
  secretKey: '6BEC9C4B668B4B14B17EEF106BB98AE5',
  path: '/open-api/order/purchase-order-info',
  timestamp: 1740709414000,
  randomKey: 'test1',
  signature: 'test1ZDZjYTJjNzg5ZjUzMDdkZTU2N2Y3NzcxN2ZjZjA5OGIxMTRhZWI0MTU1MzQxNjZlNjFkMGQxOTJiYTk1YWNjYQ==',
};
const HOST = 'https://openapi.sheincorp.com';
const ENV = { SHEIN_API_HOST: HOST, SHEIN_APP_ID: 'F9D87342D803BA78E1EE49997162', SHEIN_APP_SECRET: '0D8BD3F0AC9F12B0B6B6876527D0175F' };
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** SHEIN's recipe, written out independently of the engine and the provider. */
const recipe = (openKeyId: string, key: string, path: string, timestamp: number, nonce: string) => {
  const hex = nodeCrypto.createHmac('sha256', key + nonce).update(`${openKeyId}&${timestamp}&${path}`, 'utf8').digest('hex');
  return nonce + Buffer.from(hex, 'utf8').toString('base64');
};

// A connector after the authorization: the shop's keys stored next to the adapter's block.
const storedAuthConfig = () => ({ ...interpolateDeep(a.connector.authConfig, ENV), openKeyId: DOC.openKeyId, secretKey: DOC.secretKey });
const realProvider = () =>
  new SheinTokenService({} as never, { get: () => 'test-encryption-key-32-chars!!!!' } as never);

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the address, the mapping and authConfig.
const execute = (name: string, params: Record<string, unknown>, authConfig: Record<string, unknown> = storedAuthConfig()) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  const engine = new RestEngine(
    {} as OAuth2TokenService,
    {} as LoginTokenService,
    undefined,
    undefined,
    undefined,
    undefined,
    realProvider(),
  );
  return engine.execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig,
      headers: config.headers,
      connectorId: 'conn-1',
      errorWhen: a.connector.config.errorWhen,
      largeIntegers: a.connector.config.largeIntegers,
    } as never,
    endpointMapping as never,
    applySchemaDefaults(tool(name).parameters, params),
  );
};
const sent = () => mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];

// [tool, HTTP method, API path, required parameters] from SHEIN's API documentation.
const TABLE: Array<[string, string, string, string[]]> = [
  ['shein_get_store_info', 'POST', '/open-api/openapi-business-backend/query-store-info', []],
  ['shein_list_sites', 'POST', '/open-api/goods/query-site-list', []],
  ['shein_list_orders', 'POST', '/open-api/order/order-list', ['start_time', 'end_time']],
  ['shein_get_orders', 'POST', '/open-api/order/order-detail', ['order_nos']],
  ['shein_get_order_address', 'POST', '/open-api/order/export-address', ['order_no']],
  ['shein_list_warehouse_addresses', 'POST', '/open-api/gsp/warehouse-address', []],
  ['shein_list_shipping_channels', 'POST', '/open-api/order/express-channel', []],
  ['shein_upload_tracking_numbers', 'POST', '/open-api/order/import-batch-multiple-express', ['order_no', 'items']],
  ['shein_get_logistics_track', 'GET', '/open-api/gsp/logistics-track', []],
  ['shein_confirm_out_of_stock', 'POST', '/open-api/order/confirm-no-stock', ['order_no', 'order_goods_id']],
  ['shein_search_products', 'POST', '/open-api/goods/searchProduct', []],
  ['shein_list_products', 'POST', '/open-api/openapi-business-backend/product/query', []],
  ['shein_get_product', 'POST', '/open-api/goods/spu-info', ['spu_name']],
  ['shein_get_category_tree', 'POST', '/open-api/goods/query-category-tree', []],
  ['shein_get_attribute_templates', 'POST', '/open-api/goods/query-attribute-template', ['product_type_ids']],
  ['shein_list_brands', 'POST', '/open-api/goods/query-brand-list', []],
  ['shein_list_warehouses', 'GET', '/open-api/msc/warehouse/list', []],
  ['shein_get_stock', 'POST', '/open-api/stock/stock-query', []],
  ['shein_update_stock', 'POST', '/open-api/stock/change-inventory/v2', ['items']],
  ['shein_update_prices', 'POST', '/open-api/openapi-business-backend/product/price/save', ['items']],
  ['shein_get_sku_sales', 'POST', '/open-api/goods/query-sku-sales', ['sku_codes']],
  ['shein_set_skc_shelf_status', 'POST', '/open-api/goods/modify-skc-shelf', ['entries']],
  ['shein_list_after_sales_orders', 'POST', '/open-api/after-sales-order/list', ['start_time', 'end_time']],
  ['shein_get_after_sales_orders', 'POST', '/open-api/after-sales-order/details', ['after_sales_order_nos']],
  ['shein_list_return_orders', 'POST', '/open-api/return-order/list', ['start_time', 'end_time']],
  ['shein_get_return_orders', 'POST', '/open-api/return-order/details', ['return_order_nos']],
  ['shein_sign_return_order', 'POST', '/open-api/return-order/sign-return-order', ['return_order_no', 'goods_ids']],
];

// Installed switched off: a cancellation, taking products off shelf, settling a return.
const SWITCHED_OFF = ['shein_confirm_out_of_stock', 'shein_set_skc_shelf_status', 'shein_sign_return_order'];
// Everything that changes the shop or an order.
const WRITES = [
  'shein_confirm_out_of_stock',
  'shein_get_order_address',
  'shein_set_skc_shelf_status',
  'shein_sign_return_order',
  'shein_update_prices',
  'shein_update_stock',
  'shein_upload_tracking_numbers',
];

// Arguments for the tools with required parameters.
const ARGS: Record<string, Record<string, unknown>> = {
  shein_list_orders: { start_time: '2026-11-14 00:00:00', end_time: '2026-11-15 00:00:00' },
  shein_get_orders: { order_nos: ['GSONPE05Y0004Q7'] },
  shein_get_order_address: { order_no: 'GSON8H44Y0004CU' },
  shein_upload_tracking_numbers: {
    order_no: 'GSON8F44T00000M',
    items: [{ expressCode: 'EPC15B7844A21', expressIdCode: 'TForce', goodsId: '3000000000065815', status: 2 }],
  },
  shein_get_logistics_track: { order_no: 'GSH12110300000M', package_no: 'GU25042815276285952' },
  shein_confirm_out_of_stock: { order_no: 'GSON8F44T00000N', order_goods_id: '3000000000065821', sku_code: 'I95xuum0vjv5' },
  shein_get_product: { spu_name: 'MM2404163183' },
  shein_get_attribute_templates: { product_type_ids: ['2512'] },
  shein_get_stock: { sku_codes: ['I1omh30jb5ld'] },
  shein_update_stock: {
    items: [
      { idempotencyKey: 'biz-20260529-001', skuCode: 'I569gfcaeopb', invType: 'VI', warehouseCode: 'PS30720142', changeType: 'ADD', changeQuantity: 100 },
    ],
  },
  shein_update_prices: { items: [{ productCode: 'I11mesukkwwr', site: 'shein-mx', currencyCode: 'MXN', shopPrice: 1 }] },
  shein_get_sku_sales: { sku_codes: ['I6il0w9szgmx'] },
  shein_set_skc_shelf_status: { entries: [{ skc_name: 'sw23042063320557', site_list: ['shein-fr'], shelf_state: 2 }] },
  shein_list_after_sales_orders: { start_time: '2026-09-01 00:00:00', end_time: '2026-09-02 23:59:40' },
  shein_get_after_sales_orders: { after_sales_order_nos: ['AC260908501761'] },
  shein_list_return_orders: { start_time: '2024-05-23 00:00:00', end_time: '2024-05-24 23:59:40' },
  shein_get_return_orders: { return_order_nos: ['NPVYE07KE2'] },
  shein_sign_return_order: { return_order_no: 'NRMFM000MT', goods_ids: ['4277386877782017'] },
};

const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

describe('shein adapter: static spec conformance', () => {
  let now: jest.SpyInstance;
  let random: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { code: '0', msg: 'OK', info: {} }, headers: {} });
    now = jest.spyOn(Date, 'now').mockReturnValue(DOC.timestamp);
    // The documented example fixes its random key to "test1".
    const picks = [...DOC.randomKey].map((c) => ALPHABET.indexOf(c));
    let n = 0;
    random = jest.spyOn(nodeCrypto, 'randomInt').mockImplementation((() => picks[n++ % picks.length]) as never);
  });
  afterEach(() => {
    now.mockRestore();
    random.mockRestore();
  });

  it('is listed in e-commerce as SHEIN Seller, with its own icon and a probe without parameters', () => {
    expect(a.slug).toBe('shein');
    expect(a.name).toBe('SHEIN Seller');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('shein');
    expect(a.connector.type).toBe('REST');
    expect(a.requiresIpAllowlist).toBe(true);
    expect(a.probe.tool).toBe('shein_get_store_info');
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('asks for the API address (two choices), the App ID and the App Secret, the secret as a secret', () => {
    expect(a.requiredEnvVars).toEqual(['SHEIN_API_HOST', 'SHEIN_APP_ID', 'SHEIN_APP_SECRET']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(Object.keys(a.envVarMeta).sort()).toEqual([...a.requiredEnvVars].sort());

    // The production addresses of SHEIN's "API call" page, per application type.
    const host = a.envVarMeta.SHEIN_API_HOST;
    expect(host.kind).toBe('address');
    expect(host.secret).toBeUndefined();
    expect(host.options!.map((o) => o.value)).toEqual(['https://openapi.sheincorp.com', 'https://openapi.sheincorp.cn']);
    const pattern = new RegExp(host.pattern!);
    for (const option of host.options!) expect(pattern.test(option.value)).toBe(true);
    for (const bad of [
      'http://openapi.sheincorp.com',
      'https://openapi.sheincorp.com/',
      'https://openapi-test01.sheincorp.cn',
      'https://openapi-sem.sheincorp.com',
      'https://openapi.sheincorp.com.evil.example',
    ]) {
      expect(pattern.test(bad)).toBe(false);
    }
    expect(a.envVarMeta.SHEIN_APP_ID.secret).toBeUndefined();
    expect(new RegExp(a.envVarMeta.SHEIN_APP_ID.pattern!).test(ENV.SHEIN_APP_ID)).toBe(true);
    expect(new RegExp(a.envVarMeta.SHEIN_APP_ID.pattern!).test('app id')).toBe(false);
    expect(a.envVarMeta.SHEIN_APP_SECRET.kind).toBe('credential');
    expect(a.envVarMeta.SHEIN_APP_SECRET.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.SHEIN_APP_SECRET.pattern!).test(ENV.SHEIN_APP_SECRET)).toBe(true);
    expect(new RegExp(a.envVarMeta.SHEIN_APP_SECRET.pattern!).test('has a space in it here')).toBe(false);
  });

  it("signs SHEIN's way with the shop's keys from the shein provider, never from a variable", () => {
    expect(a.connector.baseUrl).toBe('{{SHEIN_API_HOST}}');
    expect(a.connector.authType).toBe('HMAC');
    expect(a.connector.authConfig).toEqual({
      tokenProvider: 'shein',
      shein: {
        appId: '{{SHEIN_APP_ID}}',
        appSecret: '{{SHEIN_APP_SECRET}}',
        authorizeUrl: 'https://openapi-sem.sheincorp.com/#/empower',
        tokenBaseUrl: '{{SHEIN_API_HOST}}',
        tokenPath: '/open-api/auth/get-by-token',
      },
      signature: {
        algorithm: 'sha256',
        encoding: 'hex-base64',
        secret: '${secretKey}${nonce}',
        nonceLength: 5,
        template: '${openKeyId}&${timestamp}&${pathname}',
        timestampFormat: 'ms',
        headerName: 'x-lt-signature',
        headerTemplate: '${nonce}${signature}',
        timestampHeader: 'x-lt-timestamp',
        extraHeaders: { 'x-lt-openKeyId': '${openKeyId}' },
      },
    });
    // English error messages, JSON bodies.
    expect(a.connector.headers).toMatchObject({ language: 'en', 'Content-Type': 'application/json;charset=UTF-8' });
    // No shop-key variable: the provider holds the keys.
    expect([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])].join(' ')).not.toMatch(/OPEN_KEY|SECRET_KEY|TOKEN/);
    for (const t of a.tools) {
      const mapped = JSON.stringify(t.endpointMapping);
      expect(`${t.name}:${/openKeyId|secretKey|x-lt-/.test(mapped)}`).toBe(`${t.name}:false`);
    }
  });

  it("follows the worked example of SHEIN's Signature Rules page", () => {
    expect(recipe(DOC.openKeyId, DOC.secretKey, DOC.path, DOC.timestamp, DOC.randomKey)).toBe(DOC.signature);
    expect(sheinSignature(DOC.openKeyId, DOC.secretKey, DOC.path, String(DOC.timestamp), DOC.randomKey)).toBe(DOC.signature);
  });

  it('maps every tool to its documented method and path, with its required parameters', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(TABLE.map(([name]) => name).sort());
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    for (const [name, method, path, required] of TABLE) {
      const t = tool(name);
      expect(`${name} ${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${name} ${method} ${path}`);
      expect(`${name}:${[...(t.parameters.required ?? [])].sort().join(',')}`).toBe(`${name}:${[...required].sort().join(',')}`);
      for (const r of required) expect(t.parameters.properties).toHaveProperty(r);
    }
    expect(new Set(a.tools.map((t) => t.endpointMapping.path)).size).toBe(a.tools.length);
  });

  it('sends POST parameters as a JSON body and GET parameters in the query, every declared parameter reaching the request', () => {
    for (const t of a.tools) {
      expect(t.name).toMatch(/^shein_[a-z_]+$/);
      const m = t.endpointMapping;
      if (m.method === 'GET') {
        expect(`${t.name}:${m.bodyMapping === undefined}`).toBe(`${t.name}:true`);
      } else {
        expect(`${t.name}:${typeof m.bodyMapping}:${m.queryParams === undefined}`).toBe(`${t.name}:object:true`);
      }
      const mapped = JSON.stringify({ q: m.queryParams, b: m.bodyMapping });
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        expect(`${t.name}:${p}:${mapped.includes(`"$${p}"`)}`).toBe(`${t.name}:${p}:true`);
      }
    }
  });

  it('signs every tool over its own path with the documented headers, the shop key and no secret sent', async () => {
    for (const [name, method, path] of TABLE) {
      await execute(name, ARGS[name] ?? {});
      const cfg = sent();
      expect(`${name} ${cfg.method} ${cfg.url}`).toBe(`${name} ${method} ${HOST}${path}`);
      expect(cfg.headers).toMatchObject({
        'x-lt-openKeyId': DOC.openKeyId,
        'x-lt-timestamp': String(DOC.timestamp),
        language: 'en',
      });
      expect(`${name}:${cfg.headers['x-lt-signature']}`).toBe(
        `${name}:${recipe(DOC.openKeyId, DOC.secretKey, path, DOC.timestamp, DOC.randomKey)}`,
      );
      expect(JSON.stringify(cfg)).not.toContain(DOC.secretKey);
      expect(JSON.stringify(cfg)).not.toContain(ENV.SHEIN_APP_SECRET);
      // A JSON body: the object axios serializes, or its JSON text when the tool writes 64-bit ids as numbers.
      if (method === 'POST') {
        const kind = tool(name).endpointMapping.bodyIntegers ? 'string' : 'object';
        expect(`${name}:${typeof cfg.data}`).toBe(`${name}:${kind}`);
      }
    }
  });

  it('signs the path without the query (logistics track), and sends the query unsigned', async () => {
    await execute('shein_get_logistics_track', { order_no: 'GSH12110300000M', package_no: 'GU25042815276285952' });
    const cfg = sent();
    expect(cfg.params).toEqual({ orderNo: 'GSH12110300000M', packageNo: 'GU25042815276285952' });
    expect(cfg.headers['x-lt-signature']).toBe(
      recipe(DOC.openKeyId, DOC.secretKey, '/open-api/gsp/logistics-track', DOC.timestamp, DOC.randomKey),
    );
  });

  it('writes the bodies with the names and the defaults of the documentation', async () => {
    await execute('shein_list_orders', { start_time: '2026-11-14 00:00:00', end_time: '2026-11-15 00:00:00', order_status: 2 });
    expect(sent().data).toEqual({
      queryType: 1,
      startTime: '2026-11-14 00:00:00',
      endTime: '2026-11-15 00:00:00',
      page: 1,
      pageSize: 30,
      orderStatus: 2,
    });
    await execute('shein_get_orders', { order_nos: ['GSONPE05Y0004Q7'] });
    expect(sent().data).toEqual({ orderNoList: ['GSONPE05Y0004Q7'] });
    await execute('shein_get_order_address', { order_no: 'GSON8H44Y0004CU' });
    expect(sent().data).toEqual({ orderNo: 'GSON8H44Y0004CU', handleType: 1 });
    await execute('shein_upload_tracking_numbers', ARGS.shein_upload_tracking_numbers);
    // The request example of the upload page, byte for byte: goodsId a JSON number.
    expect(sent().data).toBe(
      '{"orderNo":"GSON8F44T00000M","infoList":[{"expressCode":"EPC15B7844A21","expressIdCode":"TForce","goodsId":3000000000065815,"status":2}]}',
    );
    await execute('shein_search_products', { skc_names: ['sw23042063320557'] });
    expect(JSON.parse(sent().data)).toEqual({ pageNum: 1, pageSize: 10, skcNameList: ['sw23042063320557'] });
    await execute('shein_search_products', { category_ids: ['10002'] });
    expect(sent().data).toBe('{"pageNum":1,"pageSize":10,"categoryIds":[10002]}');
    await execute('shein_get_product', { spu_name: 'MM2404163183' });
    expect(sent().data).toEqual({ spuName: 'MM2404163183', languageList: ['en'] });
    await execute('shein_get_attribute_templates', { product_type_ids: ['2147503175'] });
    expect(sent().data).toBe('{"product_type_id_list":[2147503175]}');
    await execute('shein_get_stock', { sku_codes: ['I1omh30jb5ld'] });
    expect(sent().data).toEqual({ skuCodeList: ['I1omh30jb5ld'], warehouseType: 2 });
    await execute('shein_update_stock', ARGS.shein_update_stock);
    expect(sent().data).toEqual({ updateSkuInventoryQuantityRequests: (ARGS.shein_update_stock as { items: unknown[] }).items });
    await execute('shein_update_prices', ARGS.shein_update_prices);
    expect(sent().data).toEqual({
      productPriceList: [{ productCode: 'I11mesukkwwr', site: 'shein-mx', currencyCode: 'MXN', shopPrice: 1 }],
    });
    await execute('shein_set_skc_shelf_status', ARGS.shein_set_skc_shelf_status);
    expect(sent().data).toEqual({ skc_site_info_list: [{ skc_name: 'sw23042063320557', site_list: ['shein-fr'], shelf_state: 2 }] });
    await execute('shein_list_after_sales_orders', { ...ARGS.shein_list_after_sales_orders, statuses: [1, 2] });
    expect(sent().data).toEqual({
      queryType: 1,
      startTime: '2026-09-01 00:00:00',
      endTime: '2026-09-02 23:59:40',
      page: 1,
      pageSize: 30,
      aftersalesOrderSubStatusList: [1, 2],
    });
    await execute('shein_sign_return_order', ARGS.shein_sign_return_order);
    expect(sent().data).toBe('{"returnOrderNo":"NRMFM000MT","goodsIdList":[4277386877782017]}');
    await execute('shein_confirm_out_of_stock', ARGS.shein_confirm_out_of_stock);
    expect(sent().data).toBe('{"orderNo":"GSON8F44T00000N","orderGoodsId":3000000000065821,"skuCode":"I95xuum0vjv5"}');
    await execute('shein_get_store_info', {});
    expect(sent().data).toEqual({});
  });

  it('reads 64-bit ids as exact text and sends them back as the same number, never rounded', async () => {
    const BIG = '5230236437987443003';
    expect(a.connector.config.largeIntegers).toBe('string');
    // An order detail answer as SHEIN's documentation shows it (goodsId 5230236437987443003), through the engine's parser.
    mockedAxios.mockImplementation(async (cfg: { transformResponse: Array<(d: unknown, h: unknown) => unknown> }) => ({
      status: 200,
      headers: {},
      data: cfg.transformResponse.reduce(
        (d, fn) => fn(d, { 'content-type': 'application/json' }),
        Buffer.from(
          `{"code":"0","msg":"OK","info":[{"orderNo":"GSO1CL53800M5D4","orderGoodsInfoList":[{"goodsId":${BIG},"skuCode":"I73dnsqbbier","goodsWeight":120}]}]}`,
          'utf8',
        ) as unknown,
      ),
    }));
    const order = (await execute('shein_get_orders', { order_nos: ['GSO1CL53800M5D4'] })) as {
      info: Array<{ orderGoodsInfoList: Array<{ goodsId: unknown; goodsWeight: unknown }> }>;
    };
    const line = order.info[0].orderGoodsInfoList[0];
    expect(line.goodsId).toBe(BIG);
    expect(line.goodsWeight).toBe(120);
    // The same id, as the model passes it on, goes out as the same JSON number.
    await execute('shein_upload_tracking_numbers', {
      order_no: 'GSO1CL53800M5D4',
      items: [{ expressCode: '1Z999AA10123456784', expressIdCode: 'UPS', goodsId: line.goodsId, status: 2 }],
    });
    expect(sent().data).toBe(
      `{"orderNo":"GSO1CL53800M5D4","infoList":[{"expressCode":"1Z999AA10123456784","expressIdCode":"UPS","goodsId":${BIG},"status":2}]}`,
    );
    await execute('shein_sign_return_order', { return_order_no: 'R1', goods_ids: [BIG] });
    expect(sent().data).toBe(`{"returnOrderNo":"R1","goodsIdList":[${BIG}]}`);
    await execute('shein_confirm_out_of_stock', { order_no: 'GSO1CL53800M5D4', order_goods_id: BIG });
    expect(sent().data).toBe(`{"orderNo":"GSO1CL53800M5D4","orderGoodsId":${BIG}}`);
  });

  it('takes every 64-bit id as digits in text, never as a JSON number a client could round', () => {
    const props = (name: string) => tool(name).parameters.properties!;
    const idParams: Array<[string, { type?: string; pattern?: string } | undefined]> = [
      ['shein_upload_tracking_numbers.items[].goodsId', props('shein_upload_tracking_numbers').items.items!.properties!.goodsId],
      ['shein_confirm_out_of_stock.order_goods_id', props('shein_confirm_out_of_stock').order_goods_id],
      ['shein_sign_return_order.goods_ids[]', props('shein_sign_return_order').goods_ids.items],
      ['shein_get_attribute_templates.product_type_ids[]', props('shein_get_attribute_templates').product_type_ids.items],
      ['shein_search_products.category_ids[]', props('shein_search_products').category_ids.items],
    ];
    for (const [where, p] of idParams) {
      expect(`${where}:${p?.type}:${p?.pattern}`).toBe(`${where}:string:^(0|[1-9][0-9]{0,19})$`);
    }
    expect(tool('shein_upload_tracking_numbers').endpointMapping.bodyIntegers).toEqual(['infoList[].goodsId']);
    expect(tool('shein_confirm_out_of_stock').endpointMapping.bodyIntegers).toEqual(['orderGoodsId']);
    expect(tool('shein_sign_return_order').endpointMapping.bodyIntegers).toEqual(['goodsIdList[]']);
    expect(tool('shein_get_attribute_templates').endpointMapping.bodyIntegers).toEqual(['product_type_id_list[]']);
    expect(tool('shein_search_products').endpointMapping.bodyIntegers).toEqual(['categoryIds[]']);
    // No integer parameter anywhere is an id.
    const integerIds: string[] = [];
    const scan = (where: string, list?: Record<string, Param>) => {
      for (const [name, p] of Object.entries(list ?? {})) {
        const typ = p.type === 'array' ? p.items?.type : p.type;
        if (typ === 'integer' && /ids?$/i.test(name)) integerIds.push(`${where}.${name}`);
        scan(`${where}.${name}`, p.items?.properties ?? p.properties);
      }
    };
    for (const t of a.tools) scan(t.name, t.parameters.properties);
    expect(integerIds).toEqual([]);
  });

  it('sends nothing before the shop is authorized', async () => {
    const { openKeyId: _o, secretKey: _s, ...unauthorized } = storedAuthConfig();
    await expect(execute('shein_get_store_info', {}, unauthorized)).rejects.toMatchObject({ status: 401 });
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('installs the cancellation, the shelf change and the return receipt switched off, and nothing else', () => {
    expect(
      a.tools
        .filter((t) => t.enabled === false)
        .map((t) => t.name)
        .sort(),
    ).toEqual(SWITCHED_OFF);
    for (const t of a.tools) {
      if (!SWITCHED_OFF.includes(t.name)) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
    for (const name of SWITCHED_OFF) {
      expect(tool(name).description).toMatch(/switched off/i);
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    }
    // No payments, finance actions, paid logistics bookings, label purchases, campaigns or deletions.
    const forbidden = /place-express-order|pickup|print|delete|campaign|finance|purchase|idms|feed|publish|revoke|discuss|switch-self-shipping/;
    for (const t of a.tools) {
      expect(`${t.name}:${forbidden.test(t.endpointMapping.path)}`).toBe(`${t.name}:false`);
    }
  });

  it('marks reads as read-only and every write as a write that asks for confirmation', () => {
    expect([...WRITES].sort()).toEqual(WRITES);
    for (const t of a.tools) {
      const write = WRITES.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${!write}`);
      if (write) expect(`${t.name}:${/confirm with the user first/i.test(t.description)}`).toBe(`${t.name}:true`);
    }
  });

  it("turns SHEIN's documented error codes into the right kind of failure", () => {
    const rules = a.connector.config.errorWhen;
    expect(describeErrorWhenProblems(rules)).toEqual([]);
    const status = (body: Record<string, unknown>) => {
      try {
        assertNoResponseBodyError(body, rules);
      } catch (e) {
        return (e as ResponseBodyError).status;
      }
      return 200;
    };
    const err = (code: string | number, msg = 'x') => status({ code, msg, info: null, traceId: 't' });
    expect(err('openapi00001', 'Signature Error: The generated signature is incorrect, please check')).toBe(401);
    expect(err('openapi00004', 'The user [123] has expired')).toBe(401);
    expect(err('openapi00002', 'IP is not in the whitelist')).toBe(403);
    expect(err('openapi00003', 'The application does not have access permission to this interface')).toBe(403);
    expect(err('openapi00006', 'Rate limit triggered, please try again later')).toBe(429);
    expect(err(832213, 'The request has been rate-limited.')).toBe(429);
    expect(err('130002', 'This IP has reached the limit of 60 requests per minute.')).toBe(429);
    expect(err('9999400', 'Page size range 1~30')).toBe(400);
    expect(err('33051002', 'Request timed out: Please request to generate a temporary token again')).toBe(400);
    // code 0 is success, as text or as a number; partial failures stay in info.
    expect(status({ code: '0', msg: 'OK', info: {} })).toBe(200);
    expect(status({ code: 0, msg: '', info: [] })).toBe(200);
    expect(status({ code: '0', msg: 'OK', info: { failedList: [{ skuCode: 'x', code: 'e', reason: 'r' }] } })).toBe(200);
    try {
      assertNoResponseBodyError({ code: 'openapi00002', msg: 'IP is not in the whitelist' }, rules);
      throw new Error('expected an error');
    } catch (e) {
      expect((e as Error).message).toContain('openapi00002');
      expect((e as Error).message).toContain('whitelist');
    }
  });

  it('keeps braces and angle brackets inside backticks, writes no dashes and names no third party', () => {
    const texts: Array<[string, string]> = [
      ['instructions', a.instructions],
      ['description', a.description],
      ['prerequisites', a.prerequisites],
    ];
    const collect = (where: string, props: Record<string, Param> | undefined) => {
      for (const [name, p] of Object.entries(props ?? {})) {
        expect(`${where}.${name}:${Boolean(p.description)}`).toBe(`${where}.${name}:true`);
        texts.push([`${where}.${name}`, p.description ?? '']);
        collect(`${where}.${name}[]`, p.items?.properties);
      }
    };
    for (const t of a.tools) {
      texts.push([t.name, t.description]);
      collect(t.name, t.parameters.properties);
    }
    for (const [where, text] of texts) {
      expect(`${where}:${(text.match(/`/g) ?? []).length % 2}`).toBe(`${where}:0`);
      expect(`${where}:${/[{}<]/.test(outsideBackticks(text))}`).toBe(`${where}:false`);
    }
    const all = JSON.stringify(adapter);
    expect(all).not.toMatch(/[–—]/);
    expect(all).not.toMatch(/github\.com|\bsdk\b|TODO/i);
  });

  it('names every tool in the instructions and only points at tools that exist', () => {
    expect(a.instructions.startsWith('## SHEIN\n')).toBe(true);
    const names = new Set(a.tools.map((t) => t.name));
    for (const name of names) expect(`${name}:${a.instructions.includes(`\`${name}\``)}`).toBe(`${name}:true`);
    const mentioned = [...JSON.stringify(adapter).matchAll(/\bshein_[a-z_]+/g)].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(names.size);
    for (const name of mentioned) expect(names).toContain(name);
    for (const text of [
      '/api/shein-auth/callback',
      'https://cloud.anythingmcp.com/api/shein-auth/callback',
      'App ID',
      'App Secret',
      'Seller Self-Developed',
      'IP whitelist',
      'Authorize with Provider',
      'openapi00004',
      '`SHEIN_API_HOST`',
      'UTC+8',
    ]) {
      expect(a.instructions).toContain(text);
    }
  });

  it('guides the setup in four steps: create the app, permissions and address, paste the keys, authorize', () => {
    const g = a.setupGuide;
    expect(g.effort).toBe('own_app');
    expect(g.minutes).toBeGreaterThanOrEqual(10);
    expect(g.examples.length).toBeGreaterThanOrEqual(3);
    expect(g.examples.length).toBeLessThanOrEqual(4);
    expect(g.needs.length).toBeGreaterThan(0);
    expect(g.why).toBeTruthy();
    expect(g.steps.map((s) => s.id)).toEqual(['create-app', 'permissions', 'keys', 'authorize']);
    expect(new Set(g.steps.map((s) => s.title)).size).toBe(4);
    const [create, permissions, keys, authorize] = g.steps;

    // 1. The app at SHEIN, with the redirect address the authorization link carries.
    expect(create.action!.url).toBe('https://open.sheincorp.com');
    expect(create.values).toContainEqual(expect.objectContaining({ value: '{{redirectUri}}' }));
    expect(create.values).toContainEqual(expect.objectContaining({ value: 'Seller Self-Developed', pick: true }));
    expect(create.confirm).toBeTruthy();
    expect(create.fields).toBeUndefined();

    // 2. A plain confirm step: permission packages and the IP whitelist.
    expect(permissions.body).toContain('IP whitelist');
    expect(permissions.body).toContain('API Permission Package');
    expect(permissions.confirm).toBeTruthy();
    expect(permissions.fields).toBeUndefined();

    // 3. Every required variable, each asked for once.
    expect([...(keys.fields ?? [])].sort()).toEqual([...a.requiredEnvVars].sort());
    expect(g.steps.flatMap((s) => s.fields ?? [])).toHaveLength(a.requiredEnvVars.length);

    // 4. Authorize: no fields; Continue saves and opens SHEIN's page.
    expect(authorize.fields).toBeUndefined();
    expect(authorize.confirm).toBeUndefined();
    expect(authorize.body).toContain('main account');

    for (const s of g.steps) {
      for (const key of ['image', 'saveAndCheck', 'waitForProvider']) expect(s).not.toHaveProperty(key);
      if (s.action) expect(s.action.url).toMatch(/^https:\/\/\S+$/);
      for (const v of s.values ?? []) expect(v.value.replace('{{redirectUri}}', '')).not.toContain('{{');
      for (const text of [s.title, s.body ?? '', s.confirm ?? '', ...(s.problems ?? []).flatMap((p) => [p.q, p.a])]) {
        expect(`${s.id}:${/[{}<]/.test(outsideBackticks(text))}`).toBe(`${s.id}:false`);
      }
    }
  });
});

const live =
  process.env.RUN_SHEIN_LIVE === '1' &&
  process.env.SHEIN_API_HOST &&
  process.env.SHEIN_OPEN_KEY_ID &&
  process.env.SHEIN_SECRET_KEY
    ? describe
    : describe.skip;
live('shein adapter: live (read-only)', () => {
  const call = async (path: string, body: Record<string, unknown> = {}) => {
    const timestamp = Date.now();
    const nonce = nodeCrypto.randomBytes(8).toString('hex').slice(0, 5);
    const res = await fetch(`${process.env.SHEIN_API_HOST}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        language: 'en',
        'x-lt-openKeyId': process.env.SHEIN_OPEN_KEY_ID!,
        'x-lt-timestamp': String(timestamp),
        'x-lt-signature': recipe(process.env.SHEIN_OPEN_KEY_ID!, process.env.SHEIN_SECRET_KEY!, path, timestamp, nonce),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, any>;
    expect(`${path}:${json.code}:${json.code === '0' ? '' : json.msg}`).toBe(`${path}:0:`);
    return json;
  };
  it('reads the shop and its sites', async () => {
    const store = await call('/open-api/openapi-business-backend/query-store-info');
    expect(store.info).toHaveProperty('storeInfo');
    const sites = await call('/open-api/goods/query-site-list');
    expect(sites.info).toBeDefined();
  });
});
