import axios from 'axios';
import { createHmac } from 'node:crypto';
import * as adapter from './miravia.json';
import { RestEngine, sortedParamsString } from '../../connectors/engines/rest.engine';
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
 * Miravia Seller adapter (Miravia Open Platform, open.miravia.com).
 *
 *   1. Static: always runs. Every tool's method, path and required
 *      parameters against the API reference (read Nov 2026), the exact set
 *      of tools installed switched off, the signing and token-provider
 *      config, the error rules, the setup guide and the text rules. Requests
 *      go through the real RestEngine with axios mocked and a fake token
 *      service that hands out the shop's access token.
 *
 *      The signature is the one of "Call API with HTTP request" (docId 216):
 *      API path, then every parameter sorted by name as name + value,
 *      HMAC-SHA256 with the App Secret, upper-case hex. That page prints a
 *      worked example (app key 123456, secret helloworld, token test,
 *      timestamp 1517820392000, /order/get with order_id 1234); its digest is
 *      pinned below.
 *
 *   2. Live: skipped unless RUN_MIRAVIA_LIVE=1 and MIRAVIA_APP_KEY,
 *      MIRAVIA_APP_SECRET and MIRAVIA_ACCESS_TOKEN are set. Reads only (the
 *      seller, a page of orders). Not run for this adapter's first version:
 *      no Miravia app was available.
 *
 *        RUN_MIRAVIA_LIVE=1 MIRAVIA_APP_KEY=... MIRAVIA_APP_SECRET=... MIRAVIA_ACCESS_TOKEN=... \
 *          npx jest src/adapters/es/miravia.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

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
  description: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<
    string,
    { label?: string; kind?: string; secret?: boolean; help?: string; link?: string; pattern?: string; patternMessage?: string }
  >;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  setupGuide: {
    effort: string;
    minutes: number;
    examples: string[];
    needs: string[];
    why: string;
    steps: GuideStep[];
  };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, any>;
    headers: Record<string, string>;
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
  deriveToolAnnotations({
    name: t.name,
    connectorType: 'REST',
    endpointMapping: t.endpointMapping,
    annotations: t.annotations,
  } as never);

// The values of Miravia's documented signature example (docId 216).
const DOC_APP_KEY = '123456';
const DOC_SECRET = 'helloworld';
const DOC_TOKEN = 'test';
const DOC_TIMESTAMP = 1517820392000;
const DOC_SIGNATURE = '4190D32361CFB9581350222F345CB77F3B19F0E31D162316848A2C1FFD5FAB4A';
const ENV = { MIRAVIA_APP_KEY: DOC_APP_KEY, MIRAVIA_APP_SECRET: DOC_SECRET };
const BASE = 'https://api.miravia.es/rest';

const tokens = {
  getCredentialParams: jest.fn(),
  renewAfterRejection: jest.fn(),
};

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the address, the mapping and authConfig.
const execute = (name: string, params: Record<string, unknown>) => {
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
    tokens as unknown as IopTokenService,
  );
  return engine.execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: config.headers,
      connectorId: 'conn-1',
      errorWhen: a.connector.config.errorWhen,
    } as never,
    endpointMapping as never,
    applySchemaDefaults(tool(name).parameters, params),
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];
const formBody = (cfg: { data: string }) => Object.fromEntries(new URLSearchParams(cfg.data));
/** The documented signature, written out independently of the engine. */
const iopSign = (apiPath: string, sortedParams: string) =>
  createHmac('sha256', DOC_SECRET).update(`${apiPath}${sortedParams}`, 'utf8').digest('hex').toUpperCase();
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

// Method and path of every tool, as listed in Miravia's API reference.
const ENDPOINTS: Record<string, [string, string]> = {
  miravia_get_seller: ['GET', '/seller/get'],
  miravia_get_shipping_permission: ['GET', '/seller/shipping_permission/get'],
  miravia_list_orders: ['GET', '/orders/get'],
  miravia_get_order: ['GET', '/order/get'],
  miravia_get_order_items: ['GET', '/order/items/get'],
  miravia_get_multiple_order_items: ['GET', '/orders/items/get'],
  miravia_pack_order: ['POST', '/order/pack'],
  miravia_update_tracking: ['POST', '/order/package/tracking/update'],
  miravia_set_ready_to_ship: ['POST', '/order/package/rts'],
  miravia_fulfill_order: ['POST', '/v2/order/fulfill'],
  miravia_list_shipment_providers: ['GET', '/order/shipment/sof/providers/get'],
  miravia_get_shipping_label: ['GET', '/order/package/document/get'],
  miravia_confirm_package_collected: ['POST', '/order/package/sof/confirm/collected'],
  miravia_confirm_package_delivered: ['POST', '/order/package/sof/confirm/delivered'],
  miravia_list_products: ['GET', '/products/get'],
  miravia_get_product: ['GET', '/product/item/get'],
  miravia_search_products: ['GET', '/v2/product/get'],
  miravia_update_price_quantity: ['POST', '/product/price_quantity/update'],
  miravia_update_sellable_stock: ['POST', '/product/stock/sellable/update'],
  miravia_update_price: ['POST', '/v2/product/price/update'],
  miravia_update_quantity: ['POST', '/v2/product/quantity/update'],
  miravia_create_product: ['POST', '/product/create'],
  miravia_update_product: ['POST', '/product/update'],
  miravia_create_or_update_product: ['POST', '/v2/product/createAndUpdate'],
  miravia_remove_product: ['POST', '/product/remove'],
  miravia_deactivate_product: ['POST', '/product/deactivate'],
  miravia_update_product_status: ['POST', '/product/status/update'],
  miravia_update_sku_status: ['POST', '/v2/product/status/update'],
  miravia_get_category_tree: ['GET', '/category/tree/get'],
  miravia_search_categories: ['GET', '/category/search/keyword'],
  miravia_get_category_attributes: ['GET', '/category/attributes/get'],
  miravia_list_brands: ['GET', '/category/brands/query'],
  miravia_search_brands: ['GET', '/category/brand/search'],
  miravia_check_order_cancellation: ['GET', '/order/reverse/cancel/validate'],
  miravia_cancel_order: ['POST', '/v2/order/cancel'],
  miravia_create_order_cancellation: ['GET', '/order/reverse/cancel/create'],
  miravia_list_reverse_orders: ['GET', '/reverse/getreverseordersforseller'],
  miravia_list_reverse_reasons: ['GET', '/order/reverse/reason/list'],
  miravia_accept_return_refund: ['POST', '/v2/order/returnRefund/accept'],
  miravia_reject_return_refund: ['POST', '/v2/order/returnRefund/reject'],
};

// The parameters each tool requires; tools that are not listed require none.
const REQUIRED: Record<string, string[]> = {
  miravia_get_order: ['order_id'],
  miravia_get_order_items: ['order_id'],
  miravia_get_multiple_order_items: ['order_ids'],
  miravia_pack_order: ['order_id', 'order_item_ids'],
  miravia_update_tracking: ['package_id', 'tracking_number', 'shipment_provider_code'],
  miravia_set_ready_to_ship: ['package_id'],
  miravia_fulfill_order: ['payload'],
  miravia_get_shipping_label: ['package_id'],
  miravia_confirm_package_collected: ['package_id'],
  miravia_confirm_package_delivered: ['package_id'],
  miravia_update_price_quantity: ['payload'],
  miravia_update_sellable_stock: ['payload'],
  miravia_update_price: ['payload'],
  miravia_update_quantity: ['payload'],
  miravia_create_product: ['payload'],
  miravia_update_product: ['payload'],
  miravia_create_or_update_product: ['payload'],
  miravia_deactivate_product: ['payload'],
  miravia_update_product_status: ['status'],
  miravia_update_sku_status: ['payload'],
  miravia_search_categories: ['keyword'],
  miravia_get_category_attributes: ['primary_category_id'],
  miravia_search_brands: ['brand_name'],
  miravia_check_order_cancellation: ['order_id', 'order_item_ids'],
  miravia_cancel_order: ['payload'],
  miravia_create_order_cancellation: ['order_id', 'order_item_ids', 'reason_id'],
  miravia_list_reverse_reasons: ['reverse_order_line_id'],
  miravia_accept_return_refund: ['payload'],
  miravia_reject_return_refund: ['payload'],
};

// Installed switched off: cancellations, return and refund decisions, product
// removal and everything that takes a product offline, and the two delivery
// confirmations that cannot be undone.
const SWITCHED_OFF = [
  'miravia_accept_return_refund',
  'miravia_cancel_order',
  'miravia_confirm_package_collected',
  'miravia_confirm_package_delivered',
  'miravia_create_order_cancellation',
  'miravia_deactivate_product',
  'miravia_reject_return_refund',
  'miravia_remove_product',
  'miravia_update_product_status',
  'miravia_update_sku_status',
];

// Tools that take Miravia's documented JSON document as one string parameter.
const PAYLOAD_TOOLS = Object.keys(REQUIRED).filter((name) => REQUIRED[name].includes('payload'));

describe('miravia adapter: static spec conformance', () => {
  let now: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { code: '0', data: {}, request_id: 'r' }, headers: {} });
    tokens.getCredentialParams.mockReset();
    tokens.getCredentialParams.mockResolvedValue({ access_token: DOC_TOKEN });
    tokens.renewAfterRejection.mockReset();
    now = jest.spyOn(Date, 'now').mockReturnValue(DOC_TIMESTAMP);
  });
  afterEach(() => now.mockRestore());

  it('is listed in e-commerce for Spain with its own icon and a probe without parameters', () => {
    expect(a.slug).toBe('miravia');
    expect(a.name).toBe('Miravia Seller');
    expect(a.region).toBe('es');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('miravia');
    expect(a.connector.type).toBe('REST');
    expect(a.probe).toEqual({ tool: 'miravia_get_seller' });
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['401', '403', '404', 'rate_limited']) {
      expect(`${key}:${typeof a.verifyHints[key]}`).toBe(`${key}:string`);
    }
  });

  it('signs IOP style on /rest, API path first, upper-case hex, millisecond timestamp in the query', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('HMAC');
    expect(a.connector.authConfig.signature).toEqual({
      algorithm: 'sha256',
      encoding: 'hex-upper',
      secret: '{{MIRAVIA_APP_SECRET}}',
      placement: 'query',
      paramName: 'sign',
      timestampParam: 'timestamp',
      timestampFormat: 'ms',
      queryParams: { app_key: '{{MIRAVIA_APP_KEY}}', sign_method: 'sha256' },
      template: '${apiPath}${sortedParams}',
    });
  });

  it('gets the shop token from the iop provider: no access-token variable anywhere', () => {
    expect(a.connector.authConfig.tokenProvider).toBe('iop');
    expect(a.connector.authConfig.iop).toEqual({
      appKey: '{{MIRAVIA_APP_KEY}}',
      authorizeUrl: 'https://auth.miravia.com/apps/oauth/authorize',
      tokenBaseUrl: BASE,
      tokenPath: '/auth/token/create',
      refreshPath: '/auth/token/refresh',
      authorizeParams: { force_auth: 'true' },
    });
    expect(Object.keys(a.connector.authConfig).sort()).toEqual(['iop', 'signature', 'tokenProvider']);
    expect(a.requiredEnvVars).toEqual(['MIRAVIA_APP_KEY', 'MIRAVIA_APP_SECRET']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.authConfig.signature.queryParams.access_token).toBeUndefined();
    expect(JSON.stringify(a.connector)).not.toMatch(/ACCESS_TOKEN/);
    // The only variables referenced are the app key and the app secret.
    const referenced = new Set(Array.from(JSON.stringify(a.connector).matchAll(/\{\{([A-Z0-9_]+)\}\}/g), (m) => m[1]));
    expect([...referenced].sort()).toEqual(['MIRAVIA_APP_KEY', 'MIRAVIA_APP_SECRET']);
  });

  it('describes both variables: label, kind, help, link and a pattern with its message', () => {
    expect(Object.keys(a.envVarMeta).sort()).toEqual(['MIRAVIA_APP_KEY', 'MIRAVIA_APP_SECRET']);
    for (const [name, meta] of Object.entries(a.envVarMeta)) {
      for (const field of ['label', 'kind', 'help', 'link', 'pattern', 'patternMessage'] as const) {
        expect(`${name}.${field}:${typeof meta[field]}`).toBe(`${name}.${field}:string`);
      }
      expect(meta.link).toMatch(/^https:\/\/open\.miravia\.com\//);
    }
    expect(a.envVarMeta.MIRAVIA_APP_KEY.secret).toBeUndefined();
    expect(a.envVarMeta.MIRAVIA_APP_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(new RegExp(a.envVarMeta.MIRAVIA_APP_KEY.pattern!).test('511078')).toBe(true);
    expect(new RegExp(a.envVarMeta.MIRAVIA_APP_KEY.pattern!).test('51 1078')).toBe(false);
    expect(new RegExp(a.envVarMeta.MIRAVIA_APP_SECRET.pattern!).test('aBcD1234eFgH5678iJkL9012mNoP3456')).toBe(true);
    expect(new RegExp(a.envVarMeta.MIRAVIA_APP_SECRET.pattern!).test('with space 1234567890')).toBe(false);
  });

  it('maps every tool to its documented method and path, with the documented required parameters', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(ENDPOINTS).sort());
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(
        `${t.name}:${ENDPOINTS[t.name][0]} ${ENDPOINTS[t.name][1]}`,
      );
      expect(`${t.name}:${[...(t.parameters.required ?? [])].sort()}`).toBe(
        `${t.name}:${[...(REQUIRED[t.name] ?? [])].sort()}`,
      );
      for (const required of t.parameters.required ?? []) {
        expect(`${t.name}:${required}:${required in (t.parameters.properties ?? {})}`).toBe(`${t.name}:${required}:true`);
      }
    }
  });

  it('installs exactly the cancellations, refund decisions, removals and offline switches switched off', () => {
    expect(
      a.tools
        .filter((t) => t.enabled === false)
        .map((t) => t.name)
        .sort(),
    ).toEqual(SWITCHED_OFF);
    for (const t of a.tools) {
      if (SWITCHED_OFF.includes(t.name)) {
        expect(`${t.name}:${/switched off/i.test(t.description)}`).toBe(`${t.name}:true`);
        expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:false`);
      } else {
        expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      }
    }
    // No instant-messaging, media-upload or feed tools.
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/^\/(im|media|image|images|feed)\//);
  });

  it('sends reads as GET and writes as form POST, and marks them so', () => {
    for (const t of a.tools) {
      expect(t.name).toMatch(/^miravia_[a-z_]+$/);
      const method = t.endpointMapping.method;
      if (method === 'POST') {
        expect(`${t.name}:${t.endpointMapping.bodyEncoding}`).toBe(`${t.name}:form-urlencoded`);
        expect(`${t.name}:${typeof t.endpointMapping.bodyMapping}`).toBe(`${t.name}:object`);
        expect(`${t.name}:${t.endpointMapping.queryParams}`).toBe(`${t.name}:undefined`);
        expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:false`);
      } else {
        expect(`${t.name}:${method}`).toBe(`${t.name}:GET`);
        expect(`${t.name}:${t.endpointMapping.bodyMapping}`).toBe(`${t.name}:undefined`);
        // Miravia's V1 cancellation is a GET that cancels: never read-only.
        const expected = t.name !== 'miravia_create_order_cancellation';
        expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${expected}`);
      }
      // Every declared parameter reaches the request.
      const mapped = JSON.stringify({ q: t.endpointMapping.queryParams, b: t.endpointMapping.bodyMapping });
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        const reached = mapped.includes(`"$${p}"`) || mapped.includes(`\${${p}}`);
        expect(`${t.name}:${p}:${reached}`).toBe(`${t.name}:${p}:true`);
        expect(`${t.name}:${p}:${typeof t.parameters.properties![p].description}`).toBe(`${t.name}:${p}:string`);
      }
    }
    const destructive = annotationsOf(tool('miravia_create_order_cancellation'));
    expect(destructive.destructiveHint).toBe(true);
  });

  it("reproduces the signature of Miravia's documented example (docId 216)", async () => {
    await execute('miravia_get_order', { order_id: '1234' });
    expect(tokens.getCredentialParams).toHaveBeenCalled();
    const cfg = sent();
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toBe(`${BASE}/order/get`);
    expect(cfg.data).toBeUndefined();
    expect(cfg.params).toEqual({
      order_id: '1234',
      app_key: DOC_APP_KEY,
      sign_method: 'sha256',
      access_token: DOC_TOKEN,
      timestamp: String(DOC_TIMESTAMP),
      sign: DOC_SIGNATURE,
    });
    // The documented string, written out by hand: API path, then name + value sorted by name.
    expect(cfg.params.sign).toBe(
      iopSign('/order/get', 'access_tokentestapp_key123456order_id1234sign_methodsha256timestamp1517820392000'),
    );
    // The secret signs and is never sent; nothing goes into a signature header.
    expect(JSON.stringify(cfg)).not.toContain(DOC_SECRET);
    expect(cfg.headers.Signature).toBeUndefined();
    expect(cfg.headers.Authorization).toBeUndefined();
  });

  it('signs every tool over its own API path, with the token, key, method, timestamp and sign in the query', async () => {
    const samples: Record<string, Record<string, unknown>> = {
      miravia_get_order: { order_id: '1' },
      miravia_get_order_items: { order_id: '1' },
      miravia_get_multiple_order_items: { order_ids: '1,2' },
      miravia_pack_order: { order_id: '1', order_item_ids: ['2'] },
      miravia_update_tracking: { package_id: 'FP0001', tracking_number: 'T123', shipment_provider_code: 'DBSSP1' },
      miravia_set_ready_to_ship: { package_id: 'FP0001' },
      miravia_get_shipping_label: { package_id: 'FP0001' },
      miravia_confirm_package_collected: { package_id: 'FP0001' },
      miravia_confirm_package_delivered: { package_id: 'FP0001' },
      miravia_update_product_status: { status: 'ACTIVATE', item_id: '1' },
      miravia_search_categories: { keyword: 'vestidos' },
      miravia_get_category_attributes: { primary_category_id: '62198631' },
      miravia_search_brands: { brand_name: 'Nike' },
      miravia_check_order_cancellation: { order_id: '1', order_item_ids: '["2"]' },
      miravia_create_order_cancellation: { order_id: '1', order_item_ids: '["2"]', reason_id: '10000021' },
      miravia_list_reverse_reasons: { reverse_order_line_id: '160986356104' },
      miravia_remove_product: { item_ids: '1' },
    };
    for (const t of a.tools) {
      const params = PAYLOAD_TOOLS.includes(t.name) ? { payload: '{"a":1}' } : (samples[t.name] ?? {});
      await execute(t.name, params);
      const cfg = sent();
      const [method, path] = ENDPOINTS[t.name];
      expect(`${t.name}:${cfg.method} ${cfg.url}`).toBe(`${t.name}:${method} ${BASE}${path}`);
      expect(cfg.params).toMatchObject({
        app_key: DOC_APP_KEY,
        sign_method: 'sha256',
        access_token: DOC_TOKEN,
        timestamp: String(DOC_TIMESTAMP),
      });
      const body = method === 'POST' ? formBody(cfg) : {};
      expect(`${t.name}:${cfg.params.sign}`).toBe(
        `${t.name}:${iopSign(path, sortedParamsString({ ...cfg.params, ...body }, [], 'sign'))}`,
      );
      if (method === 'POST') {
        expect(cfg.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(cfg.data).not.toContain('sign=');
        expect(cfg.data).not.toContain('access_token=');
      } else {
        expect(`${t.name}:${cfg.data}`).toBe(`${t.name}:undefined`);
      }
    }
  });

  it("lists orders with the reference's parameter names, limt included, newest first by default", async () => {
    await execute('miravia_list_orders', { created_after: '2026-11-01T00:00:00+01:00', marketplace: 'ae', status: 'pending' });
    const common = ['sign', 'app_key', 'sign_method', 'access_token', 'timestamp'];
    const business = Object.fromEntries(Object.entries(sent().params).filter(([key]) => !common.includes(key)));
    expect(business).toEqual({
      created_after: '2026-11-01T00:00:00+01:00',
      marketplace: 'ae',
      status: 'pending',
      sort_by: 'created_at',
      sort_direction: 'DESC',
      offset: 0,
      limt: 20,
    });
    // Miravia's API reference spells the page-size parameter `limt`.
    expect(tool('miravia_list_orders').endpointMapping.queryParams).toMatchObject({ limt: '$limit' });
    expect(tool('miravia_list_orders').parameters.properties!.limit).toMatchObject({ maximum: 100 });
    expect(tool('miravia_list_orders').parameters.properties!.marketplace.enum).toEqual(['miravia', 'ae']);
    expect(tool('miravia_list_orders').parameters.properties!.status.enum).toEqual([
      'unpaid',
      'pending',
      'repacked',
      'packed',
      'ready_to_ship',
      'shipped',
      'delivered',
      'returned',
      'canceled',
      'failed',
      'lost',
    ]);
  });

  it('writes id lists and JSON-valued query parameters the way the reference shows them', async () => {
    await execute('miravia_get_multiple_order_items', { order_ids: '4987609516102,4987609316102' });
    expect(sent().params.order_ids).toBe('[4987609516102,4987609316102]');

    await execute('miravia_get_shipping_label', { package_id: 'FP0529221002' });
    expect(sent().params.getDocumentReq).toBe('{"doc_type":"PDF","packages":[{"package_id":"FP0529221002"}]}');
    await execute('miravia_get_shipping_label', { package_id: 'FP0529221002', doc_type: 'HTML' });
    expect(JSON.parse(sent().params.getDocumentReq)).toEqual({ doc_type: 'HTML', packages: [{ package_id: 'FP0529221002' }] });

    await execute('miravia_list_shipment_providers', {});
    expect(sent().params.getDBSShipmentProviderReq).toBeUndefined();
    await execute('miravia_list_shipment_providers', { seller_id: '4000000176001' });
    expect(sent().params.getDBSShipmentProviderReq).toBe('{"sellerId":4000000176001}');

    await execute('miravia_list_products', { seller_skus: '["SKU-1","SKU-2"]', item_ids: '1357296984086901,263638312812323', options: '1' });
    expect(sent().params).toMatchObject({
      filter: 'all',
      sku_seller_list: '["SKU-1","SKU-2"]',
      item_id_list: '[1357296984086901,263638312812323]',
      options: '1',
      offset: 0,
      limit: 20,
    });
    await execute('miravia_list_products', {});
    expect(sent().params.item_id_list).toBeUndefined();
    expect(sent().params.sku_seller_list).toBeUndefined();

    await execute('miravia_search_products', { product_ids: '1357296984086901', extra_info_filter: '["quality_control_log"]', marketplace: 'miravia' });
    expect(sent().params).toMatchObject({
      product_ids: '[1357296984086901]',
      extraInfo_filter: '["quality_control_log"]',
      marketplace: 'miravia',
      page: 1,
      page_size: 20,
    });

    await execute('miravia_get_product', { seller_sku: 'SKU-1' });
    expect(sent().params.seller_sku).toBe('SKU-1');
    expect(sent().params.item_id).toBeUndefined();

    await execute('miravia_list_reverse_orders', { trade_order_id: '5187600516102', reverse_status_list: '["REFUND_PENDING"]', reverse_order_line_time_start: 1722406255 });
    expect(sent().params).toMatchObject({
      page_no: 1,
      page_size: 10,
      trade_order_id: '5187600516102',
      reverse_status_list: '["REFUND_PENDING"]',
      reverse_order_line_time_range_start_time_stamp: 1722406255,
    });

    await execute('miravia_list_reverse_reasons', { reverse_order_line_id: '160986356104' });
    expect(sent().params.reverseOrderLineId).toBe('160986356104');

    await execute('miravia_get_category_tree', {});
    expect(sent().params.language_code).toBe('es_ES');
    await execute('miravia_list_brands', {});
    expect(sent().params).toMatchObject({ start_row: 0, page_size: 40 });

    await execute('miravia_check_order_cancellation', { order_id: '123456789', order_item_ids: '["12345","67890"]' });
    expect(sent().params).toMatchObject({ order_id: '123456789', order_item_id_list: '["12345","67890"]' });
  });

  it('packs, registers tracking and sets ready-to-ship with the documented request objects as JSON form fields', async () => {
    // An AliExpress order: orderItemId:quantity entries (Miravia's AliExpress guide, docId 358).
    await execute('miravia_pack_order', { order_id: '8201985108082056', order_item_ids: ['8201985108092056:1', '8202415590042056:1'] });
    let cfg = sent();
    expect(cfg.method).toBe('POST');
    expect(Object.keys(formBody(cfg))).toEqual(['packReq']);
    expect(JSON.parse(formBody(cfg).packReq)).toEqual({
      pack_order_list: [{ order_item_list: ['8201985108092056:1', '8202415590042056:1'], order_id: '8201985108082056' }],
      delivery_type: 'dropship',
    });
    // A Miravia order with the allocation type of the order guide, and a warehouse for DBA parcels.
    await execute('miravia_pack_order', { order_id: '33247076004', order_item_ids: ['33247176004'], shipping_allocate_type: 'TFS', warehouse_code: 'WH-1' });
    expect(JSON.parse(formBody(sent()).packReq)).toEqual({
      pack_order_list: [{ order_item_list: ['33247176004'], order_id: '33247076004', warehouse_code: 'WH-1' }],
      delivery_type: 'dropship',
      shipping_allocate_type: 'TFS',
    });

    await execute('miravia_update_tracking', {
      package_id: 'FP0900221001',
      tracking_number: '9356463170722110',
      shipment_provider_code: 'DBSSP100000016',
    });
    cfg = sent();
    expect(formBody(cfg).updateTrackingInfoReq).toBe(
      '{"update_packages":[{"tracking_number":"9356463170722110","package_id":"FP0900221001","shipment_provider_code":"DBSSP100000016"}]}',
    );
    // Written out by hand: the form field is signed with the query, sorted by name.
    expect(cfg.params.sign).toBe(
      iopSign(
        '/order/package/tracking/update',
        'access_tokentest' +
          'app_key123456' +
          'sign_methodsha256' +
          'timestamp1517820392000' +
          'updateTrackingInfoReq{"update_packages":[{"tracking_number":"9356463170722110","package_id":"FP0900221001","shipment_provider_code":"DBSSP100000016"}]}',
      ),
    );
    // AliExpress orders: carrier code and name as well.
    await execute('miravia_update_tracking', {
      package_id: 'FP0120612652953045',
      tracking_number: '160620251628',
      shipment_provider_code: 'SDA_IT_EUR',
      carrier_code: '100001',
      carrier_name: 'DHL Express',
    });
    expect(JSON.parse(formBody(sent()).updateTrackingInfoReq)).toEqual({
      update_packages: [
        {
          tracking_number: '160620251628',
          package_id: 'FP0120612652953045',
          shipment_provider_code: 'SDA_IT_EUR',
          carrier_code: '100001',
          carrier_name: 'DHL Express',
        },
      ],
    });

    await execute('miravia_set_ready_to_ship', { package_id: 'FP0900221001' });
    expect(formBody(sent()).readyToShipReq).toBe('{"packages":[{"package_id":"FP0900221001"}]}');
    await execute('miravia_confirm_package_collected', { package_id: 'FP000211230017' });
    expect(formBody(sent()).dbsCollectedReq).toBe('{"packages":[{"package_id":"FP000211230017"}]}');
    await execute('miravia_confirm_package_delivered', { package_id: 'FP000211230017', epod_url: 'https://example.com/pod.pdf' });
    expect(formBody(sent()).dbs_delivered_req).toBe(
      '{"packages":[{"package_id":"FP000211230017","epod_url":"https://example.com/pod.pdf"}]}',
    );
  });

  it("passes Miravia's JSON documents through unchanged as the payload form field, covered by the signature", async () => {
    const payload =
      '{"order_id":"3241804772774","order_item_id_list":[3241804872774],"shipping_provider_code":"DBSSP100000358","tracking_number":"3184279271540910191"}';
    await execute('miravia_fulfill_order', { payload });
    const cfg = sent();
    expect(formBody(cfg)).toEqual({ payload });
    expect(cfg.params.sign).toBe(
      iopSign(
        '/v2/order/fulfill',
        `access_tokentestapp_key123456payload${payload}sign_methodsha256timestamp1517820392000`,
      ),
    );
    for (const name of PAYLOAD_TOOLS) {
      const t = tool(name);
      expect(`${name}:${Object.keys(t.parameters.properties ?? {})}`).toBe(`${name}:payload`);
      expect(`${name}:${JSON.stringify(t.endpointMapping.bodyMapping)}`).toBe(`${name}:{"payload":"$payload"}`);
      // The parameter description carries an example in backticks that is valid JSON.
      const examples = Array.from(String(t.parameters.properties!.payload.description).matchAll(/`([^`]+)`/g), (m) => m[1]);
      const jsonExamples = examples.filter((e) => /^[[{]/.test(e));
      expect(`${name}:${jsonExamples.length > 0}`).toBe(`${name}:true`);
      for (const example of jsonExamples) expect(() => JSON.parse(example)).not.toThrow();
    }
  });

  it('sends the plain product switches as form fields', async () => {
    await execute('miravia_update_product_status', { status: 'DEACTIVATE', item_id: '1370653862750666', marketplace: 'ae_ES' });
    expect(formBody(sent())).toEqual({ status: 'DEACTIVATE', item_id: '1370653862750666', marketplace: 'ae_ES' });
    expect(tool('miravia_update_product_status').parameters.properties!.status.enum).toEqual(['ACTIVATE', 'DEACTIVATE']);
    const marketplace = new RegExp(tool('miravia_update_product_status').parameters.properties!.marketplace.pattern);
    for (const ok of ['miravia', 'miravia_ES', 'miravia_PT', 'ae', 'ae_ES', 'ae_IT', 'ae_PT']) expect(marketplace.test(ok)).toBe(true);
    expect(marketplace.test('amazon')).toBe(false);

    await execute('miravia_remove_product', { sku_ids: '["SkuId_1269656765_5230534246"]' });
    expect(formBody(sent())).toEqual({ seller_sku_list: '["SkuId_1269656765_5230534246"]' });
    await execute('miravia_remove_product', { item_ids: '12345,123' });
    expect(formBody(sent())).toEqual({ item_id_list: '[12345,123]' });
  });

  it('turns an error inside a 200 answer into an error with the right status', async () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    const status = (body: Record<string, unknown>) => {
      try {
        assertNoResponseBodyError(body, a.connector.config.errorWhen);
      } catch (e) {
        return (e as ResponseBodyError).status;
      }
      return 200;
    };
    const refused = (code: string) => status({ type: 'ISV', code, message: 'm', request_id: 'r' });
    // The token, the signature, the app key: authentication. The engine renews on IllegalAccessToken.
    expect(refused('IllegalAccessToken')).toBe(401);
    expect(refused('IllegalRefreshToken')).toBe(401);
    expect(refused('IncompleteSignature')).toBe(401);
    expect(refused('InvalidAppKey')).toBe(401);
    expect(refused('IllegalTimestamp')).toBe(401);
    expect(refused('InvalidCode')).toBe(401);
    // Permission and IP whitelist.
    expect(refused('InsufficientPermission')).toBe(403);
    expect(refused('AppWhiteIpLimit')).toBe(403);
    // A business code that merely contains the word is not an authorization failure.
    expect(refused('GET_SHIPPING_TYPE_PERMISSION_FAILED')).toBe(400);
    // Call limits.
    expect(refused('AppCallLimit')).toBe(429);
    expect(refused('AppApiCallLimit')).toBe(429);
    expect(refused('ApiCallLimit')).toBe(429);
    expect(refused('901')).toBe(429);
    // Not found, and everything else.
    expect(refused('404')).toBe(404);
    expect(refused('98')).toBe(400);
    expect(refused('16')).toBe(400);
    expect(refused('MissingParameter')).toBe(400);
    expect(refused('ServiceTimeout')).toBe(400);
    // Success, in both shapes Miravia uses, and a failed fulfilment result.
    expect(status({ code: '0', data: { seller_id: 10 }, request_id: 'r' })).toBe(200);
    expect(status({ code: 0, data: [], request_id: 'r' })).toBe(200);
    expect(status({ code: '0', result: { success: true, data: { packages: [] } } })).toBe(200);
    expect(status({ code: '0', result: { success: false, error_code: '30012', error_msg: 'package not found!' } })).toBe(400);

    mockedAxios.mockResolvedValueOnce({
      data: { type: 'ISV', code: '16', message: 'E016: "x" Invalid Order ID', request_id: 'r' },
      headers: {},
    });
    await expect(execute('miravia_get_order', { order_id: '1' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Invalid Order ID'),
    });
    mockedAxios.mockResolvedValueOnce({ data: { code: '0', data: { seller_id: 10, name: 'abc shop' }, request_id: 'r' }, headers: {} });
    await expect(execute('miravia_get_seller', {})).resolves.toMatchObject({ data: { name: 'abc shop' } });
  });

  it('keeps braces and angle brackets inside backticks, and uses no em dashes', () => {
    const texts: Array<[string, string]> = [
      ['description', a.description],
      ['instructions', a.instructions],
      ['prerequisites', a.prerequisites],
      ['setupGuide.why', a.setupGuide.why],
    ];
    for (const [key, hint] of Object.entries(a.verifyHints)) texts.push([`verifyHints.${key}`, hint]);
    for (const [name, meta] of Object.entries(a.envVarMeta)) texts.push([`envVarMeta.${name}`, `${meta.help} ${meta.patternMessage}`]);
    for (const t of a.tools) {
      texts.push([t.name, t.description]);
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) texts.push([`${t.name}.${p}`, String(def.description)]);
    }
    for (const step of a.setupGuide.steps) {
      texts.push([`step ${step.id}`, `${step.title} ${step.body ?? ''} ${step.confirm ?? ''}`]);
      for (const p of step.problems ?? []) texts.push([`step ${step.id} problem`, `${p.q} ${p.a}`]);
      for (const v of step.values ?? []) {
        if (v.value !== '{{redirectUri}}') texts.push([`step ${step.id} value`, `${v.label} ${v.value} ${v.note ?? ''}`]);
      }
    }
    for (const [where, text] of texts) {
      expect(`${where}:${/[{}<]/.test(outsideBackticks(text))}`).toBe(`${where}:false`);
      expect(`${where}:${(text.match(/`/g) ?? []).length % 2}`).toBe(`${where}:0`);
      expect(`${where}:${/[–—]/.test(text)}`).toBe(`${where}:false`);
    }
    for (const t of a.tools) expect(`${t.name}:${t.description.length >= 60}`).toBe(`${t.name}:true`);
  });

  it('names every tool in the instructions and explains setup, tokens and the AliExpress alliance', () => {
    expect(a.instructions.startsWith('## Miravia Seller\n')).toBe(true);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(`\`${t.name}\``)}`).toBe(`${t.name}:true`);
    for (const heading of ['**Setup**', '**Tokens**', '**Where to start**', '**Miravia and AliExpress (M2A)**', '**V1 and V2 calls**', '**Switched off at install**']) {
      expect(`${heading}:${a.instructions.includes(heading)}`).toBe(`${heading}:true`);
    }
    // The callback URL to register, and the sign-in the seller compares with the App Console.
    expect(a.instructions).toContain('`/api/iop-auth/callback`');
    expect(a.instructions).toContain('`https://cloud.anythingmcp.com/api/iop-auth/callback`');
    expect(a.instructions).toContain('`https://auth.miravia.com/apps/oauth/authorize`');
    expect(a.instructions).toMatch(/Seller In House App/);
    // Token lifetime as Miravia documents it, renewed automatically.
    expect(a.instructions).toMatch(/14 days/);
    expect(a.instructions).toMatch(/712 days/);
    expect(a.instructions).toMatch(/Authorize\*\* again/);
    // Every switched-off tool is listed as such.
    const offSection = a.instructions.split('**Switched off at install**')[1].split('\n')[0];
    for (const name of SWITCHED_OFF) expect(`${name}:${offSection.includes(`\`${name}\``)}`).toBe(`${name}:true`);
  });

  it('guides the setup in four steps: app, keys, going online, authorize', () => {
    const guide = a.setupGuide;
    expect(guide.effort).toBe('own_app');
    expect(Number.isInteger(guide.minutes) && guide.minutes > 0).toBe(true);
    expect(guide.examples.length >= 3 && guide.examples.length <= 4).toBe(true);
    expect(guide.needs.length).toBeGreaterThan(0);
    expect(guide.why.length).toBeGreaterThan(0);
    expect(guide.steps.map((s) => s.id)).toEqual(['create-app', 'keys', 'go-online', 'authorize']);
    const [app, keys, online, authorize] = guide.steps;

    // 1. The in-house app at Miravia, with this connector's callback URL.
    expect(app.action!.url).toBe('https://open.miravia.com/apps/');
    expect(app.values).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Callback URL', value: '{{redirectUri}}' })]));
    expect(app.values).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'Seller In House App', pick: true })]));
    expect(typeof app.confirm).toBe('string');
    expect(app.fields).toBeUndefined();

    // 2. Both keys; no saveAndCheck (it only exists for OAuth2 adapters).
    expect(keys.fields).toEqual(['MIRAVIA_APP_KEY', 'MIRAVIA_APP_SECRET']);
    expect(keys.saveAndCheck).toBeUndefined();

    // 3. Miravia's validation and online request: a plain step with a confirmation.
    expect(typeof online.confirm).toBe('string');
    expect(online.fields).toBeUndefined();
    expect(online.waitForProvider).toBeUndefined();
    expect(online.body).toMatch(/Integration validation/);
    expect(online.body).toMatch(/Apply Online/);
    expect(online.body).toMatch(/does not say how long/);

    // 4. Authorize: nothing to enter, the documented problems.
    expect(authorize.fields).toBeUndefined();
    expect(authorize.confirm).toBeUndefined();
    expect((authorize.problems ?? []).length).toBeGreaterThan(0);

    // Every required variable is asked for exactly once; no screenshots; https links only.
    const asked = guide.steps.flatMap((s) => s.fields ?? []);
    expect([...asked].sort()).toEqual([...a.requiredEnvVars].sort());
    for (const step of guide.steps) {
      expect(`${step.id}:${step.image}`).toBe(`${step.id}:undefined`);
      expect(`${step.id}:${step.saveAndCheck}:${step.waitForProvider}`).toBe(`${step.id}:undefined:undefined`);
      if (step.action) expect(step.action.url).toMatch(/^https:\/\/open\.miravia\.com\//);
      for (const v of step.values ?? []) {
        if (v.value.includes('{{')) expect(v.value).toBe('{{redirectUri}}');
      }
    }
    expect(new Set(guide.steps.map((s) => s.title)).size).toBe(guide.steps.length);
  });
});

const live =
  process.env.RUN_MIRAVIA_LIVE === '1' &&
  process.env.MIRAVIA_APP_KEY &&
  process.env.MIRAVIA_APP_SECRET &&
  process.env.MIRAVIA_ACCESS_TOKEN
    ? describe
    : describe.skip;
live('miravia adapter: live (read-only)', () => {
  const call = async (path: string, extra: Record<string, string> = {}) => {
    const params: Record<string, string> = {
      app_key: process.env.MIRAVIA_APP_KEY!,
      access_token: process.env.MIRAVIA_ACCESS_TOKEN!,
      sign_method: 'sha256',
      timestamp: String(Date.now()),
      ...extra,
    };
    params.sign = createHmac('sha256', process.env.MIRAVIA_APP_SECRET!)
      .update(`${path}${sortedParamsString(params)}`, 'utf8')
      .digest('hex')
      .toUpperCase();
    const res = await fetch(`${a.connector.baseUrl}${path}?${new URLSearchParams(params)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(`${path}:${body.code}`).toBe(`${path}:0`);
    return body;
  };
  it('reads the seller and a page of orders', async () => {
    const seller = await call(tool('miravia_get_seller').endpointMapping.path);
    expect(seller.data).toHaveProperty('seller_id');
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const orders = await call(tool('miravia_list_orders').endpointMapping.path, { created_after: since, limt: '5' });
    expect(orders.data).toHaveProperty('orders');
  }, 60_000);
});
