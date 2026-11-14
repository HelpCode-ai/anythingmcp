import axios from 'axios';
import { createHmac } from 'node:crypto';
import * as adapter from './aliexpress-seller.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import type { IopTokenService } from '../../connectors/engines/iop-token.service';
import {
  assertNoResponseBodyError,
  describeErrorWhenProblems,
  ResponseBodyError,
} from '../../connectors/engines/response-error.util';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * AliExpress Seller adapter (AliExpress Open Platform, seller APIs, an app of
 * the seller's own in the category "Seller-inhouse Developer").
 *
 *   1. Static: always runs. Every tool through the real RestEngine at a fixed
 *      clock, with a fake token service standing in for the "iop" token
 *      provider, checked against the Open Platform docs
 *      (openservice.aliexpress.com, read Nov 2026): "Seller authorization
 *      introduction" docId 1364, "HTTP request sample" docId 1385, "Register
 *      an application" docId 1361, and the API pages of AE-Order & Transaction,
 *      AE-Logistics, AE-Product Management, AE-Category&Attributes,
 *      AE-Refund&return, AE-Freight, AE-Seller and AE-Settlement. Business
 *      APIs go to https://api-sg.aliexpress.com/sync with `method`, `app_key`,
 *      `access_token`, a millisecond `timestamp`, `sign_method=sha256` and
 *      `sign` over every parameter sorted by name (no path in front). Object
 *      and list parameters go as JSON text; in a POST they are form fields
 *      that the signature covers.
 *
 *   2. Live: skipped unless RUN_ALIEXPRESS_SELLER_LIVE=1 and
 *      ALIEXPRESS_SELLER_APP_KEY, ALIEXPRESS_SELLER_APP_SECRET and
 *      ALIEXPRESS_SELLER_LIVE_TOKEN (an access token of the shop, for this run
 *      only: the adapter itself has no such variable) are set. Reads only.
 *      Not run for this adapter's first version: no seller app was available.
 *
 *        RUN_ALIEXPRESS_SELLER_LIVE=1 ALIEXPRESS_SELLER_APP_KEY=... ALIEXPRESS_SELLER_APP_SECRET=... \
 *          ALIEXPRESS_SELLER_LIVE_TOKEN=... npx jest src/adapters/intl/aliexpress-seller
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
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
  };
  annotations?: Record<string, unknown>;
};
type GuideStep = {
  id: string;
  title: string;
  body?: string;
  action?: { label: string; url: string };
  values?: Array<{ label: string; value: string; note?: string; pick?: boolean }>;
  image?: unknown;
  fields?: string[];
  problems?: Array<{ q: string; a: string }>;
  confirm?: string;
  saveAndCheck?: boolean;
  waitForProvider?: boolean;
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
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { label?: string; kind?: string; secret?: boolean; help?: string; link?: string; pattern?: string; patternMessage?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, any>;
    headers: Record<string, string>;
    config: { errorWhen: unknown };
  };
  setupGuide: {
    effort: string;
    minutes: number;
    examples: string[];
    needs: string[];
    why: string;
    steps: GuideStep[];
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations } as never);

// Built at run time so no literal here looks like a real secret or token.
const SECRET = ['ae', 'seller', 'test', 'secret', '0000', '1111'].join('');
const TOKEN = ['5000', '0000', 'seller', 'demo', 'token'].join('');
const ENV = { ALIEXPRESS_SELLER_APP_KEY: '512345', ALIEXPRESS_SELLER_APP_SECRET: SECRET };
const NOW = 1_763_100_000_123;
const ORDER = '8198352049851315';
const ITEM = '8198352049851316';

/** What the "iop" token provider gives the engine: the shop's access token, added to the signed query. */
const fakeTokens = (accessToken: string) =>
  ({
    getCredentialParams: jest.fn().mockResolvedValue({ access_token: accessToken }),
    renewAfterRejection: jest.fn(),
  }) as unknown as IopTokenService;

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the address, the mapping and authConfig.
const execute = (
  name: string,
  params: Record<string, unknown>,
  env: Record<string, string> = ENV,
  accessToken: string = TOKEN,
) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine(
    {} as OAuth2TokenService,
    {} as LoginTokenService,
    undefined,
    undefined,
    undefined,
    fakeTokens(accessToken),
  ).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
      connectorId: 'conn-1',
      errorWhen: a.connector.config.errorWhen,
    } as never,
    endpointMapping as never,
    applySchemaDefaults(tool(name).parameters, params),
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];
const formOf = (cfg: { data?: unknown }): Record<string, string> =>
  typeof cfg.data === 'string' ? Object.fromEntries(new URLSearchParams(cfg.data)) : {};

/**
 * The documented signature, written independently of the engine: every
 * parameter except `sign`, sorted by name in ASCII order, concatenated as
 * name + value, HMAC-SHA256 with the App Secret, upper-case hex.
 */
const iopSign = (concatenated: string, secret: string = SECRET) =>
  createHmac('sha256', secret).update(concatenated, 'utf8').digest('hex').toUpperCase();
const concatSorted = (params: Record<string, unknown>) =>
  Object.keys(params)
    .filter((k) => k !== 'sign')
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
    .map((k) => `${k}${String(params[k])}`)
    .join('');

// [tool, arguments, HTTP method, documented API name].
const ORDER_ITEMS = [{ tradeOrderItemId: ITEM }];
const PRICES = [
  { product_id: '1000005237852', multiple_sku_update_list: [{ sku_code: '123abc', price: '19.99', discount_price: '14.99' }] },
];
const STOCK = [{ product_id: '1000005237852', multiple_sku_update_list: [{ sku_code: '123abc', inventory: 99 }] }];
const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['aliexpress_seller_get_seller_profile', {}, 'GET', 'aliexpress.merchant.profile.get'],
  ['aliexpress_seller_get_shop_info', {}, 'GET', 'aliexpress.solution.merchant.profile.get'],
  ['aliexpress_seller_list_orders', { create_date_start: '2026-11-01 00:00:00', order_status: 'WAIT_SELLER_SEND_GOODS' }, 'POST', 'aliexpress.trade.seller.orderlist.get'],
  ['aliexpress_seller_get_order', { order_id: ORDER }, 'GET', 'aliexpress.trade.new.redefining.findorderbyid'],
  ['aliexpress_seller_get_order_receipt_info', { order_id: ORDER }, 'GET', 'aliexpress.solution.order.receiptinfo.get'],
  ['aliexpress_seller_list_order_shipping_services', { order_id: ORDER, order_item_ids: `${ITEM},8198352049851317` }, 'GET', 'aliexpress.asf.order.shipping.service.get'],
  ['aliexpress_seller_list_shipment_providers', { order_id: ORDER, order_item_ids: ITEM }, 'GET', 'aliexpress.asf.package.shipping.service.get'],
  ['aliexpress_seller_list_seller_addresses', {}, 'GET', 'aliexpress.asf.seller.address.get'],
  ['aliexpress_seller_list_packages', { order_id: ORDER }, 'GET', 'aliexpress.asf.fulfillment.package.query'],
  ['aliexpress_seller_declare_shipment', { order_id: ORDER, order_items: ORDER_ITEMS, shipment_provider_code: 'SPAIN_LOCAL_CORREOORDINARIO', tracking_number: 'PK123456789ES' }, 'POST', 'aliexpress.asf.dbs.declareship'],
  ['aliexpress_seller_modify_shipment', { order_id: ORDER, old_tracking_number: 'PK123456789ES', new_tracking_number: 'PK987654321ES', new_shipment_provider_code: 'SPAIN_LOCAL_CORREOORDINARIO' }, 'POST', 'aliexpress.asf.dbs.declare.ship.modify'],
  ['aliexpress_seller_pack_order', { order_id: ORDER, order_items: ORDER_ITEMS, address_id: '3000012313213', send_option: 'DOOR_PICKUP' }, 'POST', 'aliexpress.asf.shipment.pack'],
  ['aliexpress_seller_ship_platform_package', { order_id: ORDER, package_id: 'FP000000001' }, 'POST', 'aliexpress.asf.platform.logistics.rts'],
  ['aliexpress_seller_cancel_package', { order_id: ORDER, package_id: 'FP000000001' }, 'POST', 'aliexpress.asf.platform.logistics.repack'],
  ['aliexpress_seller_list_products', {}, 'POST', 'aliexpress.solution.product.list.get'],
  ['aliexpress_seller_get_product', { product_id: '1307422965' }, 'GET', 'aliexpress.solution.product.info.get'],
  ['aliexpress_seller_update_prices', { products: PRICES }, 'POST', 'aliexpress.solution.batch.product.price.update'],
  ['aliexpress_seller_update_stock', { products: STOCK }, 'POST', 'aliexpress.solution.batch.product.inventory.update'],
  ['aliexpress_seller_set_products_online', { product_ids: '109827;109828' }, 'POST', 'aliexpress.postproduct.redefining.onlineaeproduct'],
  ['aliexpress_seller_set_products_offline', { product_ids: '109827;109828' }, 'POST', 'aliexpress.postproduct.redefining.offlineaeproduct'],
  ['aliexpress_seller_list_categories', {}, 'GET', 'aliexpress.category.tree.list'],
  ['aliexpress_seller_list_publishable_categories', {}, 'GET', 'aliexpress.solution.seller.category.tree.query'],
  ['aliexpress_seller_list_freight_templates', {}, 'GET', 'aliexpress.freight.redefining.listfreighttemplate'],
  ['aliexpress_seller_list_disputes', {}, 'POST', 'aliexpress.issue.issuelist.get'],
  ['aliexpress_seller_get_dispute', { issue_id: '1122339900', buyer_login_id: 'tom' }, 'GET', 'aliexpress.issue.detail.get'],
  ['aliexpress_seller_accept_dispute_solution', { issue_id: '1122339900', buyer_login_id: 'tom', solution_id: '445566' }, 'POST', 'aliexpress.issue.solution.agree'],
  ['aliexpress_seller_list_settlement_bills', { statement_status: 'TO_RELEASE' }, 'GET', 'aliexpress.fund.merchant.period.settlebilldetail.query'],
];

// The parameters the API reference marks as required (or that make the call meaningful), per tool.
const REQUIRED: Record<string, string[]> = {
  aliexpress_seller_get_seller_profile: [],
  aliexpress_seller_get_shop_info: [],
  aliexpress_seller_list_orders: [],
  aliexpress_seller_get_order: ['order_id'],
  aliexpress_seller_get_order_receipt_info: ['order_id'],
  aliexpress_seller_list_order_shipping_services: ['order_id', 'order_item_ids'],
  aliexpress_seller_list_shipment_providers: ['order_id', 'order_item_ids'],
  aliexpress_seller_list_seller_addresses: [],
  aliexpress_seller_list_packages: [],
  aliexpress_seller_declare_shipment: ['order_id', 'order_items', 'shipment_provider_code', 'tracking_number'],
  aliexpress_seller_modify_shipment: ['order_id', 'old_tracking_number', 'new_tracking_number', 'new_shipment_provider_code'],
  aliexpress_seller_pack_order: ['order_id', 'order_items', 'address_id'],
  aliexpress_seller_ship_platform_package: ['order_id'],
  aliexpress_seller_cancel_package: ['order_id'],
  aliexpress_seller_list_products: [],
  aliexpress_seller_get_product: ['product_id'],
  aliexpress_seller_update_prices: ['products'],
  aliexpress_seller_update_stock: ['products'],
  aliexpress_seller_set_products_online: ['product_ids'],
  aliexpress_seller_set_products_offline: ['product_ids'],
  aliexpress_seller_list_categories: [],
  aliexpress_seller_list_publishable_categories: [],
  aliexpress_seller_list_freight_templates: [],
  aliexpress_seller_list_disputes: [],
  aliexpress_seller_get_dispute: ['issue_id', 'buyer_login_id'],
  aliexpress_seller_accept_dispute_solution: ['issue_id', 'buyer_login_id', 'solution_id'],
  aliexpress_seller_list_settlement_bills: ['statement_status'],
};

// Everything that changes something at AliExpress.
const WRITES = [
  'aliexpress_seller_accept_dispute_solution',
  'aliexpress_seller_cancel_package',
  'aliexpress_seller_declare_shipment',
  'aliexpress_seller_modify_shipment',
  'aliexpress_seller_pack_order',
  'aliexpress_seller_set_products_offline',
  'aliexpress_seller_set_products_online',
  'aliexpress_seller_ship_platform_package',
  'aliexpress_seller_update_prices',
  'aliexpress_seller_update_stock',
];
// Installed switched off: platform logistics (orders a logistics service), taking
// products off sale, and the binding dispute decision.
const SWITCHED_OFF = [
  'aliexpress_seller_accept_dispute_solution',
  'aliexpress_seller_cancel_package',
  'aliexpress_seller_pack_order',
  'aliexpress_seller_set_products_offline',
  'aliexpress_seller_ship_platform_package',
];

/** Text with its `code spans` removed: what the website renders as MDX. */
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');
const descriptionsIn = (node: unknown, out: string[] = []): string[] => {
  if (node && typeof node === 'object') {
    const description = (node as { description?: unknown }).description;
    if (typeof description === 'string') out.push(description);
    for (const value of Object.values(node as Record<string, unknown>)) descriptionsIn(value, out);
  }
  return out;
};

describe('aliexpress-seller adapter: static spec conformance', () => {
  let now: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { result: {} }, headers: {} });
    now = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => now.mockRestore());

  it('is listed in e-commerce with the AliExpress icon, two variables and a probe without parameters', () => {
    expect(a.slug).toBe('aliexpress-seller');
    expect(a.name).toBe('AliExpress Seller');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('aliexpress');
    expect(a.requiredEnvVars).toEqual(['ALIEXPRESS_SELLER_APP_KEY', 'ALIEXPRESS_SELLER_APP_SECRET']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(Object.keys(a.envVarMeta).sort()).toEqual([...a.requiredEnvVars].sort());
    for (const name of a.requiredEnvVars) {
      const meta = a.envVarMeta[name];
      for (const key of ['label', 'kind', 'help', 'link', 'pattern', 'patternMessage'] as const) {
        expect(`${name}.${key}:${typeof meta[key]}`).toBe(`${name}.${key}:string`);
      }
    }
    expect(a.envVarMeta.ALIEXPRESS_SELLER_APP_SECRET.secret).toBe(true);
    expect(a.envVarMeta.ALIEXPRESS_SELLER_APP_KEY.secret).toBeUndefined();
    expect(new RegExp(a.envVarMeta.ALIEXPRESS_SELLER_APP_KEY.pattern!).test('512345')).toBe(true);
    expect(new RegExp(a.envVarMeta.ALIEXPRESS_SELLER_APP_KEY.pattern!).test('my-app')).toBe(false);
    expect(new RegExp(a.envVarMeta.ALIEXPRESS_SELLER_APP_SECRET.pattern!).test(SECRET)).toBe(true);
    expect(a.probe.tool).toBe('aliexpress_seller_get_seller_profile');
    expect(a.probe.params ?? {}).toEqual({});
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['401', '403', '404', 'rate_limited']) expect(typeof a.verifyHints[key]).toBe('string');
  });

  it('signs IOP style and leaves the access token to the iop token provider', () => {
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api-sg.aliexpress.com');
    expect(a.connector.authType).toBe('HMAC');
    expect(a.connector.authConfig).toEqual({
      tokenProvider: 'iop',
      iop: {
        appKey: '{{ALIEXPRESS_SELLER_APP_KEY}}',
        authorizeUrl: 'https://api-sg.aliexpress.com/oauth/authorize',
        tokenBaseUrl: 'https://api-sg.aliexpress.com/rest',
        tokenPath: '/auth/token/create',
        refreshPath: '/auth/token/refresh',
        authorizeParams: { force_auth: 'true' },
      },
      signature: {
        algorithm: 'sha256',
        encoding: 'hex-upper',
        secret: '{{ALIEXPRESS_SELLER_APP_SECRET}}',
        placement: 'query',
        paramName: 'sign',
        timestampParam: 'timestamp',
        timestampFormat: 'ms',
        queryParams: { app_key: '{{ALIEXPRESS_SELLER_APP_KEY}}', sign_method: 'sha256' },
        template: '${sortedParams}',
      },
    });
    // The provider adds access_token: it is neither a variable nor a static query parameter.
    expect(a.connector.authConfig.signature.queryParams.access_token).toBeUndefined();
    expect(JSON.stringify(adapter)).not.toMatch(/ACCESS_TOKEN/);
    expect(a.connector.authConfig.iop.authorizeUrl).not.toContain('?');
    expect(a.connector.authConfig.iop.tokenBaseUrl.endsWith('/rest')).toBe(true);
  });

  it('uses only its own variables and its own tool prefix', () => {
    const variables = [...JSON.stringify(adapter).matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]);
    expect(variables.length).toBeGreaterThan(2);
    for (const name of variables) {
      if (name === 'redirectUri') continue;
      expect(name.startsWith('ALIEXPRESS_SELLER_')).toBe(true);
      expect(a.requiredEnvVars).toContain(name);
    }
    const names = a.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^aliexpress_seller_[a-z_]+$/);
  });

  it('lists every tool in the API table, each on /sync with its documented API name', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
    expect(Object.keys(REQUIRED).sort()).toEqual(a.tools.map((t) => t.name).sort());
    for (const [name, , method, api] of table) {
      const t = tool(name);
      expect(`${name}:${t.endpointMapping.path}`).toBe(`${name}:/sync`);
      expect(`${name}:${t.endpointMapping.method}`).toBe(`${name}:${method}`);
      expect(`${name}:${String(t.endpointMapping.queryParams?.method)}`).toBe(`${name}:${api}`);
      expect(`${name}:${JSON.stringify(t.parameters.required ?? [])}`).toBe(`${name}:${JSON.stringify(REQUIRED[name])}`);
      for (const required of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(required);
      // A POST sends its parameters as form fields, a GET in the query.
      if (method === 'POST') {
        expect(`${name}:${t.endpointMapping.bodyEncoding}`).toBe(`${name}:form-urlencoded`);
        expect(Object.keys(t.endpointMapping.bodyMapping ?? {}).length).toBeGreaterThan(0);
        expect(Object.keys(t.endpointMapping.queryParams ?? {})).toEqual(['method']);
      } else {
        expect(t.endpointMapping.bodyMapping).toBeUndefined();
      }
    }
  });

  it.each(table)('%s sends %j as %s %s, signed over every parameter', async (name, params, method, api) => {
    await execute(name, params);
    const cfg = sent();
    expect(cfg.method).toBe(method);
    expect(cfg.url).toBe('https://api-sg.aliexpress.com/sync');
    expect(cfg.params).toMatchObject({
      method: api,
      app_key: '512345',
      sign_method: 'sha256',
      access_token: TOKEN,
      timestamp: String(NOW),
    });
    const body = formOf(cfg);
    if (method === 'GET') {
      expect(cfg.data).toBeUndefined();
    } else {
      expect(Object.keys(body).length).toBeGreaterThan(0);
      expect(cfg.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(String(cfg.data)).not.toContain('sign=');
    }
    expect(cfg.params.sign).toMatch(/^[0-9A-F]{64}$/);
    expect(cfg.params.sign).toBe(iopSign(concatSorted({ ...cfg.params, ...body })));
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
  });

  it('reads an order with the token and the documented signature, written out by hand', async () => {
    await execute('aliexpress_seller_get_order', { order_id: ORDER });
    const cfg = sent();
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toBe('https://api-sg.aliexpress.com/sync');
    const { sign, ...rest } = cfg.params;
    expect(rest).toEqual({
      method: 'aliexpress.trade.new.redefining.findorderbyid',
      param1: `{"order_id":${ORDER}}`,
      app_key: '512345',
      sign_method: 'sha256',
      access_token: TOKEN,
      timestamp: String(NOW),
    });
    expect(sign).toBe(
      iopSign(
        `access_token${TOKEN}app_key512345methodaliexpress.trade.new.redefining.findorderbyid` +
          `param1{"order_id":${ORDER}}sign_methodsha256timestamp${NOW}`,
      ),
    );
    // Nothing in a header, the secret nowhere on the wire.
    expect(cfg.headers.Signature).toBeUndefined();
    expect(cfg.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
  });

  it('reproduces the worked example of the docs (docId 1385, case 1) with this signing config', async () => {
    now.mockReturnValue(1517820392000);
    const docEnv = { ALIEXPRESS_SELLER_APP_KEY: '123456', ALIEXPRESS_SELLER_APP_SECRET: 'helloworld' };
    await new RestEngine(
      {} as OAuth2TokenService,
      {} as LoginTokenService,
      undefined,
      undefined,
      undefined,
      fakeTokens('test'),
    ).execute(
      {
        baseUrl: a.connector.baseUrl,
        authType: a.connector.authType,
        authConfig: interpolateDeep(a.connector.authConfig, docEnv),
        headers: a.connector.headers,
        connectorId: 'conn-1',
      } as never,
      {
        method: 'GET',
        path: '/sync',
        queryParams: {
          method: 'aliexpress.logistics.redefining.getonlinelogisticsinfo',
          aliexpress_category_id: '$category',
        },
      } as never,
      { category: '200135143' },
    );
    const cfg = sent();
    expect(cfg.params).toEqual({
      method: 'aliexpress.logistics.redefining.getonlinelogisticsinfo',
      aliexpress_category_id: '200135143',
      app_key: '123456',
      sign_method: 'sha256',
      access_token: 'test',
      timestamp: '1517820392000',
      sign: 'F7F7926B67316C9D1E8E15F7E66940ED3059B1638C497D77973F30046EFB5BBB',
    });
  });

  it('declares a shipment as signed form fields, the sub-orders as a JSON list', async () => {
    await execute('aliexpress_seller_declare_shipment', {
      order_id: ORDER,
      order_items: ORDER_ITEMS,
      shipment_provider_code: 'SPAIN_LOCAL_CORREOORDINARIO',
      tracking_number: 'PK123456789ES',
    });
    const cfg = sent();
    expect(cfg.method).toBe('POST');
    const body = formOf(cfg);
    expect(body).toEqual({
      tradeOrderId: ORDER,
      tradeOrderItemIdList: `[{"tradeOrderItemId":"${ITEM}"}]`,
      shipmentProviderCode: 'SPAIN_LOCAL_CORREOORDINARIO',
      trackingNumber: 'PK123456789ES',
      locale: 'en_US',
    });
    expect(Object.keys(cfg.params).sort()).toEqual(['access_token', 'app_key', 'method', 'sign', 'sign_method', 'timestamp']);
    // Written out by hand: query and body together, sorted by name.
    expect(cfg.params.sign).toBe(
      iopSign(
        `access_token${TOKEN}app_key512345localeen_USmethodaliexpress.asf.dbs.declareship` +
          'shipmentProviderCodeSPAIN_LOCAL_CORREOORDINARIOsign_methodsha256' +
          `timestamp${NOW}trackingNumberPK123456789EStradeOrderId${ORDER}` +
          `tradeOrderItemIdList[{"tradeOrderItemId":"${ITEM}"}]`,
      ),
    );
    // The optional carrier code goes out only when given.
    expect(body.carrierCode).toBeUndefined();
    await execute('aliexpress_seller_declare_shipment', {
      order_id: ORDER,
      order_items: ORDER_ITEMS,
      shipment_provider_code: 'OTHER',
      tracking_number: 'PK123456789ES',
      carrier_code: 'CORREOS',
      locale: 'es_ES',
    });
    expect(formOf(sent())).toMatchObject({ carrierCode: 'CORREOS', locale: 'es_ES' });
  });

  it('sends order and dispute filters as one JSON parameter, with paging defaults', async () => {
    await execute('aliexpress_seller_list_orders', {
      create_date_start: '2026-11-01 00:00:00',
      order_status_list: ['WAIT_SELLER_SEND_GOODS', 'SELLER_PART_SEND_GOODS'],
    });
    let body = formOf(sent());
    expect(Object.keys(body)).toEqual(['param_aeop_order_query']);
    expect(JSON.parse(body.param_aeop_order_query)).toEqual({
      current_page: 1,
      page_size: 20,
      create_date_start: '2026-11-01 00:00:00',
      order_status_list: ['WAIT_SELLER_SEND_GOODS', 'SELLER_PART_SEND_GOODS'],
    });
    expect(tool('aliexpress_seller_list_orders').parameters.properties!.page_size.maximum).toBe(50);

    await execute('aliexpress_seller_list_disputes', { order_id: ORDER, issue_status: 'processing', page: 2 });
    body = formOf(sent());
    expect(Object.keys(body)).toEqual(['query_dto']);
    expect(JSON.parse(body.query_dto)).toEqual({ current_page: 2, page_size: 20, issue_status: 'processing', order_no: ORDER });
    expect(tool('aliexpress_seller_list_disputes').parameters.properties!.page_size.maximum).toBe(50);

    await execute('aliexpress_seller_list_products', { subject: 'mug' });
    body = formOf(sent());
    expect(Object.keys(body)).toEqual(['aeop_a_e_product_list_query']);
    expect(JSON.parse(body.aeop_a_e_product_list_query)).toEqual({
      product_status_type: 'onSelling',
      current_page: 1,
      page_size: 20,
      subject: 'mug',
    });
    expect(tool('aliexpress_seller_list_products').parameters.properties!.page_size.maximum).toBe(99);
  });

  it('keeps long ids exact: the order id as a JSON number, sub-order ids as a JSON list of numbers', async () => {
    await execute('aliexpress_seller_get_order_receipt_info', { order_id: ORDER });
    expect(sent().params.param1).toBe(`{"order_id":${ORDER}}`);
    await execute('aliexpress_seller_list_order_shipping_services', { order_id: ORDER, order_item_ids: `${ITEM},8198352049851317` });
    expect(sent().params).toMatchObject({
      tradeOrderId: ORDER,
      tradeOrderItemIdList: `[${ITEM},8198352049851317]`,
      locale: 'en_US',
    });
    await execute('aliexpress_seller_list_shipment_providers', { order_id: ORDER, order_item_ids: ITEM, page: 1, page_size: 20 });
    expect(sent().params).toMatchObject({ tradeOrderItemIdList: `[${ITEM}]`, pageNo: 1, pageSize: 20 });
    // Ids are digits only, so nothing but numbers can reach the JSON text.
    for (const name of ['aliexpress_seller_get_order', 'aliexpress_seller_get_order_receipt_info']) {
      const pattern = new RegExp(tool(name).parameters.properties!.order_id.pattern);
      expect(pattern.test(ORDER)).toBe(true);
      expect(pattern.test('1,"x":2')).toBe(false);
    }
    const list = new RegExp(tool('aliexpress_seller_list_order_shipping_services').parameters.properties!.order_item_ids.pattern);
    expect(list.test(`${ITEM},8198352049851317`)).toBe(true);
    expect(list.test(`${ITEM}, 8198352049851317`)).toBe(false);
    expect(list.test(`${ITEM}],"x":[1`)).toBe(false);
  });

  it('sends the documented defaults of the simple reads', async () => {
    await execute('aliexpress_seller_list_seller_addresses', {});
    expect(sent().params).toMatchObject({ addressType: 'pickup,refund', locale: 'en_US' });
    await execute('aliexpress_seller_list_categories', {});
    expect(sent().params).toMatchObject({ category_id: '0' });
    expect(sent().params.only_with_permission).toBeUndefined();
    await execute('aliexpress_seller_list_publishable_categories', {});
    expect(sent().params).toMatchObject({ category_id: '0', filter_no_permission: true });
    await execute('aliexpress_seller_list_packages', { created_from: '1756349803958', created_to: '1756436203958' });
    expect(sent().params).toMatchObject({ createStartTime: '1756349803958', createEndTime: '1756436203958', current: 1, pageSize: 20 });
    expect(sent().params.tradeOrderId).toBeUndefined();
    await execute('aliexpress_seller_list_settlement_bills', { statement_status: 'RELEASED' });
    expect(sent().params).toMatchObject({ statement_status: 'RELEASED', lang: 'en_US', current: 1, page_size: 20 });
    await execute('aliexpress_seller_get_dispute', { issue_id: '1122339900', buyer_login_id: 'tom' });
    expect(sent().params).toMatchObject({ issue_id: '1122339900', buyer_login_id: 'tom' });
  });

  it('sends price and stock updates as the documented JSON list', async () => {
    await execute('aliexpress_seller_update_prices', { products: PRICES });
    let body = formOf(sent());
    expect(Object.keys(body)).toEqual(['mutiple_product_update_list']);
    expect(JSON.parse(body.mutiple_product_update_list)).toEqual(PRICES);
    await execute('aliexpress_seller_update_stock', { products: STOCK });
    body = formOf(sent());
    expect(Object.keys(body)).toEqual(['mutiple_product_update_list']);
    expect(JSON.parse(body.mutiple_product_update_list)).toEqual(STOCK);
    for (const name of ['aliexpress_seller_update_prices', 'aliexpress_seller_update_stock']) {
      const products = tool(name).parameters.properties!.products;
      expect(products.maxItems).toBe(20);
      expect(products.items.properties.multiple_sku_update_list.maxItems).toBe(200);
    }
    await execute('aliexpress_seller_set_products_offline', { product_ids: '109827;109828' });
    expect(formOf(sent())).toEqual({ product_ids: '109827;109828' });
  });

  it('every declared parameter reaches the request and every mapped one is declared', () => {
    for (const t of a.tools) {
      const mapped = JSON.stringify({ q: t.endpointMapping.queryParams, b: t.endpointMapping.bodyMapping });
      const declared = Object.keys(t.parameters.properties ?? {});
      for (const p of declared) {
        const reached = mapped.includes(`"$${p}"`) || mapped.includes(`\${${p}}`);
        expect(`${t.name}:${p}:${reached}`).toBe(`${t.name}:${p}:true`);
      }
      for (const m of mapped.matchAll(/"\$([a-z_]+)"|\$\{([a-z_]+)\}/g)) {
        const p = m[1] ?? m[2];
        expect(`${t.name}:${p}:${declared.includes(p)}`).toBe(`${t.name}:${p}:true`);
      }
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}:${p}:${typeof (def as { description?: unknown }).description}`).toBe(`${t.name}:${p}:string`);
      }
    }
  });

  it('reads are read-only; the writes are marked, and the risky ones install switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(SWITCHED_OFF);
    for (const t of a.tools) {
      const write = WRITES.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${!write}`);
      if (!write) {
        expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
        expect(t.description).toMatch(/Read-only/);
      }
      if (t.enabled === false) expect(t.description).toMatch(/Installed switched off/i);
      if (write) expect(t.description).toMatch(/confirm|let the user decide/i);
    }
    // Declaring a shipment with the seller's own carrier costs nothing and stays on.
    for (const name of ['aliexpress_seller_declare_shipment', 'aliexpress_seller_modify_shipment', 'aliexpress_seller_update_prices', 'aliexpress_seller_update_stock']) {
      expect(tool(name).enabled).toBeUndefined();
    }
    // Every platform logistics write is off.
    for (const t of a.tools) {
      const api = String(t.endpointMapping.queryParams?.method);
      if (/platform\.logistics|shipment\.pack/.test(api)) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:false`);
      // Nothing posts, edits or deletes a product, buys a label or moves money.
      expect(api).not.toMatch(/product\.(post|edit|delete)|batch\.product\.delete|document\.query|createwarehouseorder|\.pay|withdraw|loan/);
    }
  });

  it('turns gateway refusals into the right status, an ended authorization into 401', () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    const status = (body: unknown) => {
      try {
        assertNoResponseBodyError(body, a.connector.config.errorWhen);
      } catch (e) {
        return (e as ResponseBodyError).status;
      }
      return 200;
    };
    const refusal = (code: string) => status({ error_response: { type: 'ISV', code, msg: 'x', request_id: 'r' } });
    expect(refusal('IllegalAccessToken')).toBe(401);
    expect(refusal('InvalidAppkey')).toBe(401);
    expect(refusal('InvalidAppKey')).toBe(401);
    expect(refusal('IncompleteSignature')).toBe(401);
    expect(refusal('InsufficientPermission')).toBe(403);
    expect(refusal('AppWhiteIpLimit')).toBe(403);
    expect(refusal('ApiCallLimit')).toBe(429);
    expect(refusal('MissingParameter')).toBe(400);
    expect(refusal('isp.50001')).toBe(400);
    // A normal answer, also one whose result carries its own verdict, is passed through.
    expect(status({ aliexpress_merchant_profile_get_response: { profile: { seller_id: 200042360 } }, code: '0' })).toBe(200);
    expect(status({ aliexpress_asf_dbs_declareship_response: { result: { success: false, errorCode: 'X' } } })).toBe(200);
  });

  it('writes texts the website can render: no braces outside code, no dashes, no third party', () => {
    const texts = [
      a.description,
      a.instructions,
      a.prerequisites,
      ...Object.values(a.verifyHints),
      ...Object.values(a.envVarMeta).flatMap((m) => [m.label ?? '', m.help ?? '', m.patternMessage ?? '']),
      ...a.tools.flatMap((t) => [t.description, ...descriptionsIn(t.parameters)]),
      a.setupGuide.why,
      ...a.setupGuide.examples,
      ...a.setupGuide.needs,
      ...a.setupGuide.steps.flatMap((s) => [
        s.title,
        s.body ?? '',
        s.confirm ?? '',
        s.action?.label ?? '',
        ...(s.problems ?? []).flatMap((p) => [p.q, p.a]),
        ...(s.values ?? []).flatMap((v) => [v.label, v.note ?? '', v.value === '{{redirectUri}}' ? '' : v.value]),
      ]),
    ];
    expect(texts.length).toBeGreaterThan(150);
    for (const text of texts) {
      expect((text.match(/`/g) ?? []).length % 2).toBe(0);
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
    }
    for (const t of a.tools) expect(t.description.length).toBeGreaterThan(80);
    const all = JSON.stringify(adapter);
    expect(all).not.toMatch(/[–—]/);
    expect(all).not.toMatch(/pipedream|github\.com|\bsdk\b/i);
  });

  it('documents the setup, the review, the token lifetime and every tool in the instructions', () => {
    expect(a.instructions.startsWith('## AliExpress Seller\n')).toBe(true);
    const names = new Set(a.tools.map((t) => t.name));
    for (const name of names) expect(`${name}:${a.instructions.includes(`\`${name}\``)}`).toBe(`${name}:true`);
    const mentioned = [
      ...a.instructions.matchAll(/\baliexpress_seller_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...JSON.stringify(t).matchAll(/\baliexpress_seller_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const text of [
      '**Setup**',
      '**Where to start**',
      'Seller-inhouse Developer',
      'App Console',
      'App Key',
      'App Secret',
      '`ALIEXPRESS_SELLER_APP_KEY`',
      '`ALIEXPRESS_SELLER_APP_SECRET`',
      '`/api/iop-auth/callback`',
      '`https://cloud.anythingmcp.com/api/iop-auth/callback`',
      'Auth Management',
      'whitelist',
      '**Authorize**',
      'Sign in And Authorize',
      '`expires_in`',
      '`refresh_expires_in`',
      'US Pacific Time',
      '`error_response`',
      'IllegalAccessToken',
      'buyer-message',
    ]) {
      expect(`${text}:${a.instructions.includes(text)}`).toBe(`${text}:true`);
    }
    // The approval by AliExpress is said plainly, where a seller reads before starting.
    for (const text of [a.instructions, a.prerequisites]) {
      expect(text).toMatch(/reviews the developer profile/);
      expect(text).toMatch(/approve that app category/);
    }
  });

  it('guides the setup in four steps and asks for both keys', () => {
    const g = a.setupGuide;
    expect(g.effort).toBe('own_app');
    expect(Number.isInteger(g.minutes) && g.minutes >= 1 && g.minutes <= 120).toBe(true);
    expect(g.examples.length).toBeGreaterThanOrEqual(3);
    expect(g.examples.length).toBeLessThanOrEqual(4);
    expect(g.needs.length).toBeGreaterThan(0);
    expect(g.why.length).toBeGreaterThan(50);
    expect(g.steps.map((s) => s.id)).toEqual(['create-app', 'keys', 'review', 'authorize']);
    expect(new Set(g.steps.map((s) => s.title.toLowerCase())).size).toBe(4);
    const [create, keys, review, authorize] = g.steps;

    // 1. The app at AliExpress: a button to the console, the category to pick, the callback URL, a tick.
    expect(create.action?.url).toMatch(/^https:\/\/openservice\.aliexpress\.com\//);
    expect(create.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'App category', value: 'Seller-inhouse Developer', pick: true }),
        expect.objectContaining({ label: 'Callback URL', value: '{{redirectUri}}' }),
      ]),
    );
    for (const v of create.values ?? []) expect(v.value.replace('{{redirectUri}}', '')).not.toMatch(/\{\{/);
    expect(typeof create.confirm).toBe('string');
    expect(create.fields).toBeUndefined();

    // 2. Both keys, pasted here. saveAndCheck exists for OAuth2 adapters only.
    expect(keys.fields).toEqual(['ALIEXPRESS_SELLER_APP_KEY', 'ALIEXPRESS_SELLER_APP_SECRET']);
    expect(keys.saveAndCheck).toBeUndefined();

    // 3. The review by AliExpress and the whitelist, as a plain step with a tick.
    expect(typeof review.confirm).toBe('string');
    expect(review.waitForProvider).toBeUndefined();
    expect(review.fields).toBeUndefined();
    expect(review.body).toMatch(/developer profile/);
    expect(review.body).toMatch(/Seller-inhouse Developer/);
    expect(review.body).toMatch(/whitelist/);
    expect(review.body).toMatch(/2 to 5 working days/);

    // 4. Authorize: nothing to fill in, the documented problems at hand.
    expect(authorize.fields).toBeUndefined();
    expect(authorize.confirm).toBeUndefined();
    expect(authorize.action).toBeUndefined();
    expect((authorize.problems ?? []).length).toBeGreaterThanOrEqual(3);
    expect(authorize.body).toMatch(/Sign in And Authorize/);

    // Every required variable is asked for in exactly one step; no screenshots, https links only.
    const asked = g.steps.flatMap((s) => s.fields ?? []);
    expect([...asked].sort()).toEqual([...a.requiredEnvVars].sort());
    for (const s of g.steps) {
      expect(s.image).toBeUndefined();
      expect(s.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      if (s.action) expect(s.action.url).toMatch(/^https:\/\/\S+$/);
      for (const p of s.problems ?? []) expect(p.q.length > 0 && p.a.length > 0).toBe(true);
    }
  });
});

const LIVE =
  process.env.RUN_ALIEXPRESS_SELLER_LIVE === '1' &&
  process.env.ALIEXPRESS_SELLER_APP_KEY &&
  process.env.ALIEXPRESS_SELLER_APP_SECRET &&
  process.env.ALIEXPRESS_SELLER_LIVE_TOKEN;
const live = LIVE ? describe : describe.skip;

live('aliexpress-seller adapter: live API (reads only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const env = () => ({
    ALIEXPRESS_SELLER_APP_KEY: String(process.env.ALIEXPRESS_SELLER_APP_KEY),
    ALIEXPRESS_SELLER_APP_SECRET: String(process.env.ALIEXPRESS_SELLER_APP_SECRET),
  });
  const token = () => String(process.env.ALIEXPRESS_SELLER_LIVE_TOKEN);

  it('reads the seller profile, the freight templates and a page of products', async () => {
    const profile = await execute('aliexpress_seller_get_seller_profile', {}, env(), token());
    expect(profile).toHaveProperty('aliexpress_merchant_profile_get_response');
    const templates = await execute('aliexpress_seller_list_freight_templates', {}, env(), token());
    expect(templates).toHaveProperty('aliexpress_freight_redefining_listfreighttemplate_response');
    const products = await execute('aliexpress_seller_list_products', { page_size: 5 }, env(), token());
    expect(products).toHaveProperty('aliexpress_solution_product_list_get_response');
  }, 60_000);
});
