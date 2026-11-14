import axios from 'axios';
import { createHmac } from 'node:crypto';
import * as adapter from './lazada.json';
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
 * Lazada Seller adapter (Lazada Open Platform, open.lazada.com).
 *
 *   1. Static: always runs. Every tool's method, path and required parameters
 *      against the API reference (read Nov 2026), the signing block, the
 *      token provider block, the switched-off set, the error rules, the
 *      setup guide and the texts. Requests go through the real RestEngine
 *      with axios mocked and a fake token service: GET parameters in the
 *      query, POST parameters as form fields, `app_key`, `access_token`, a
 *      millisecond `timestamp`, `sign_method=sha256` and `sign` in the query.
 *      The signature is the one of Lazada's "HTTP request sample" (doc
 *      108069): API path + every parameter sorted by name as name + value,
 *      HMAC-SHA256 with the App Secret, upper-case hex. That page's worked
 *      example (secret "helloworld") is pinned literally.
 *
 *   2. Live: skipped unless RUN_LAZADA_LIVE=1 and LAZADA_HOST, LAZADA_APP_KEY,
 *      LAZADA_APP_SECRET and LAZADA_ACCESS_TOKEN (a seller token of that app
 *      and country) are set. Reads only. Not run for this adapter's first
 *      version: no Lazada app was available.
 *
 *        RUN_LAZADA_LIVE=1 LAZADA_HOST=https://api.lazada.sg LAZADA_APP_KEY=... \
 *          LAZADA_APP_SECRET=... LAZADA_ACCESS_TOKEN=... npx jest src/adapters/intl/lazada.live.spec.ts
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
  enum?: string[];
  items?: { properties?: Record<string, Param> };
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
    bodyEncoding?: string;
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

// The values of Lazada's documented example ("HTTP request sample", doc 108069).
const HOST = 'https://api.lazada.sg';
const DOC_SECRET = 'helloworld';
const DOC_TIMESTAMP = 1517820392000;
const ENV = { LAZADA_HOST: HOST, LAZADA_APP_KEY: '123456', LAZADA_APP_SECRET: DOC_SECRET };

const fakeTokens = () =>
  ({
    getCredentialParams: jest.fn().mockResolvedValue({ access_token: 'test' }),
    renewAfterRejection: jest.fn(),
  }) as unknown as IopTokenService;

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the address, the mapping and authConfig.
const execute = (name: string, params: Record<string, unknown>, tokens: IopTokenService = fakeTokens()) => {
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
    tokens,
  );
  return engine.execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: config.headers,
      connectorId: 'conn-1',
    } as never,
    endpointMapping as never,
    applySchemaDefaults(tool(name).parameters, params),
  );
};
const sent = () => mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];

/**
 * Lazada's signature, written out independently of the engine: the API path,
 * then every parameter but `sign` sorted by name (ASCII) as name + value.
 */
const lazadaSign = (apiPath: string, params: Record<string, unknown>, secret = DOC_SECRET) =>
  createHmac('sha256', secret)
    .update(
      apiPath +
        Object.keys(params)
          .filter((k) => k !== 'sign')
          .sort()
          .map((k) => `${k}${String(params[k])}`)
          .join(''),
      'utf8',
    )
    .digest('hex')
    .toUpperCase();

// [tool, HTTP method, API path, required parameters] from the Lazada API reference.
const TABLE: Array<[string, string, string, string[]]> = [
  ['lazada_get_seller', 'GET', '/seller/get', []],
  ['lazada_get_seller_performance', 'GET', '/seller/performance/get', []],
  ['lazada_list_orders', 'GET', '/orders/get', []],
  ['lazada_get_order', 'GET', '/order/get', ['order_id']],
  ['lazada_get_order_items', 'GET', '/order/items/get', ['order_id']],
  ['lazada_get_multiple_order_items', 'GET', '/orders/items/get', ['order_ids']],
  ['lazada_get_order_trace', 'GET', '/logistic/order/trace', ['order_id']],
  ['lazada_get_order_document', 'GET', '/order/document/get', ['doc_type', 'order_item_ids']],
  ['lazada_get_shipment_providers', 'POST', '/order/shipment/providers/get', ['orders']],
  ['lazada_pack_order_items', 'POST', '/order/fulfill/pack', ['pack_order_list', 'shipping_allocate_type']],
  ['lazada_set_ready_to_ship', 'POST', '/order/package/rts', ['packages']],
  ['lazada_get_shipping_label', 'POST', '/order/package/document/get', ['packages']],
  ['lazada_list_products', 'GET', '/products/get', []],
  ['lazada_get_product', 'GET', '/product/item/get', ['item_id']],
  ['lazada_update_price_quantity', 'POST', '/product/price_quantity/update', ['payload']],
  ['lazada_create_product', 'POST', '/product/create', ['payload']],
  ['lazada_update_product', 'POST', '/product/update', ['payload']],
  ['lazada_migrate_image', 'POST', '/image/migrate', ['payload']],
  ['lazada_get_category_tree', 'GET', '/category/tree/get', []],
  ['lazada_get_category_attributes', 'GET', '/category/attributes/get', ['primary_category_id']],
  ['lazada_list_brands', 'GET', '/category/brands/query', []],
  ['lazada_list_qc_alert_products', 'GET', '/product/qc/alert/list', []],
  ['lazada_deactivate_product', 'POST', '/product/deactivate', ['request_body']],
  ['lazada_remove_product', 'POST', '/product/remove', []],
  ['lazada_get_payout_status', 'GET', '/finance/payout/status/get', ['created_after']],
  ['lazada_list_transactions', 'GET', '/finance/transaction/details/get', ['start_time', 'end_time']],
  ['lazada_list_review_ids', 'GET', '/review/seller/history/list', ['item_id', 'start_time', 'end_time']],
  ['lazada_get_reviews', 'GET', '/review/seller/list/v2', ['review_ids']],
  ['lazada_reply_to_review', 'GET', '/review/seller/reply/add', ['review_id', 'content']],
  ['lazada_list_reverse_orders', 'GET', '/reverse/getreverseordersforseller', []],
  ['lazada_get_reverse_order', 'GET', '/order/reverse/return/detail/list', ['reverse_order_id']],
  ['lazada_validate_order_cancellation', 'GET', '/order/reverse/cancel/validate', ['order_id', 'order_item_ids']],
  ['lazada_cancel_order_items', 'GET', '/order/reverse/cancel/create', ['order_id', 'order_item_ids', 'reason_id']],
];

// Installed switched off: a cancellation, a product taken offline, a product removed.
const SWITCHED_OFF = ['lazada_cancel_order_items', 'lazada_deactivate_product', 'lazada_remove_product'];
// Everything that changes the shop. The review reply and the cancellation are
// documented as GET calls, so the method alone does not tell.
const WRITES = [
  'lazada_cancel_order_items',
  'lazada_create_product',
  'lazada_deactivate_product',
  'lazada_migrate_image',
  'lazada_pack_order_items',
  'lazada_remove_product',
  'lazada_reply_to_review',
  'lazada_set_ready_to_ship',
  'lazada_update_price_quantity',
  'lazada_update_product',
];

const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

describe('lazada adapter: static spec conformance', () => {
  let now: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { code: '0', data: {}, request_id: 'r' }, headers: {} });
    now = jest.spyOn(Date, 'now').mockReturnValue(DOC_TIMESTAMP);
  });
  afterEach(() => now.mockRestore());

  it('is listed in e-commerce as Lazada Seller, with its own icon and a probe without parameters', () => {
    expect(a.slug).toBe('lazada');
    expect(a.name).toBe('Lazada Seller');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('lazada');
    expect(a.connector.type).toBe('REST');
    expect(a.probe.tool).toBe('lazada_get_seller');
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('asks for the country address (six choices), the App Key and the App Secret, the secret as a secret', () => {
    expect(a.requiredEnvVars).toEqual(['LAZADA_HOST', 'LAZADA_APP_KEY', 'LAZADA_APP_SECRET']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(Object.keys(a.envVarMeta).sort()).toEqual([...a.requiredEnvVars].sort());

    // The API addresses of Lazada's "API endpoint URLs" page (doc 108065), without the /rest path.
    const host = a.envVarMeta.LAZADA_HOST;
    expect(host.kind).toBe('address');
    expect(host.secret).toBeUndefined();
    expect(host.options).toEqual([
      { value: 'https://api.lazada.sg', label: 'Singapore' },
      { value: 'https://api.lazada.co.th', label: 'Thailand' },
      { value: 'https://api.lazada.com.my', label: 'Malaysia' },
      { value: 'https://api.lazada.vn', label: 'Vietnam' },
      { value: 'https://api.lazada.com.ph', label: 'Philippines' },
      { value: 'https://api.lazada.co.id', label: 'Indonesia' },
    ]);
    const pattern = new RegExp(host.pattern!);
    for (const option of host.options!) expect(pattern.test(option.value)).toBe(true);
    for (const bad of [
      'http://api.lazada.sg',
      'https://api.lazada.sg/',
      'https://api.lazada.sg/rest',
      'https://api.lazada.sg.evil.example',
      'https://auth.lazada.com',
      'https://evil.example',
    ]) {
      expect(pattern.test(bad)).toBe(false);
    }

    expect(a.envVarMeta.LAZADA_APP_KEY.secret).toBeUndefined();
    expect(new RegExp(a.envVarMeta.LAZADA_APP_KEY.pattern!).test('101406')).toBe(true);
    expect(new RegExp(a.envVarMeta.LAZADA_APP_KEY.pattern!).test('app key')).toBe(false);
    expect(a.envVarMeta.LAZADA_APP_SECRET.kind).toBe('credential');
    expect(a.envVarMeta.LAZADA_APP_SECRET.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.LAZADA_APP_SECRET.pattern!).test('has a space')).toBe(false);
  });

  it('signs IOP style on the /rest gateway and gets the seller token from the iop provider', () => {
    expect(a.connector.baseUrl).toBe('{{LAZADA_HOST}}/rest');
    expect(a.connector.authType).toBe('HMAC');
    expect(a.connector.authConfig).toEqual({
      tokenProvider: 'iop',
      iop: {
        appKey: '{{LAZADA_APP_KEY}}',
        authorizeUrl: 'https://auth.lazada.com/oauth/authorize',
        tokenBaseUrl: 'https://auth.lazada.com/rest',
        tokenPath: '/auth/token/create',
        refreshPath: '/auth/token/refresh',
        authorizeParams: { force_auth: 'true' },
      },
      signature: {
        algorithm: 'sha256',
        encoding: 'hex-upper',
        secret: '{{LAZADA_APP_SECRET}}',
        placement: 'query',
        paramName: 'sign',
        timestampParam: 'timestamp',
        timestampFormat: 'ms',
        queryParams: { app_key: '{{LAZADA_APP_KEY}}', sign_method: 'sha256' },
        template: '${apiPath}${sortedParams}',
      },
    });
    // A form body gets its own Content-Type from the engine.
    expect(Object.keys(a.connector.headers).map((h) => h.toLowerCase())).not.toContain('content-type');
  });

  it('has no access-token variable: the provider adds the token to every call', () => {
    expect(a.connector.authConfig.signature.queryParams).not.toHaveProperty('access_token');
    expect(JSON.stringify(a.connector)).not.toMatch(/ACCESS_TOKEN|REFRESH_TOKEN/);
    expect([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])].join(' ')).not.toMatch(/TOKEN/);
    for (const t of a.tools) {
      const mapped = JSON.stringify({ q: t.endpointMapping.queryParams, b: t.endpointMapping.bodyMapping });
      expect(`${t.name}:${/access_token|app_key|sign_method|timestamp|"sign"/.test(mapped)}`).toBe(`${t.name}:false`);
    }
  });

  it('maps every tool to its documented method and path, with its required parameters', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(TABLE.map(([name]) => name).sort());
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    for (const [name, method, path, required] of TABLE) {
      const t = tool(name);
      expect(`${name} ${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${name} ${method} ${path}`);
      expect(`${name}:${[...(t.parameters.required ?? [])].sort().join(',')}`).toBe(
        `${name}:${[...required].sort().join(',')}`,
      );
      for (const r of required) expect(t.parameters.properties).toHaveProperty(r);
    }
    // One tool per API: no path twice.
    expect(new Set(a.tools.map((t) => t.endpointMapping.path)).size).toBe(a.tools.length);
  });

  it('sends GET parameters in the query and POST parameters as form fields, and every declared parameter', () => {
    for (const t of a.tools) {
      expect(t.name).toMatch(/^lazada_[a-z_]+$/);
      const m = t.endpointMapping;
      if (m.method === 'GET') {
        expect(`${t.name}:${m.bodyMapping === undefined}`).toBe(`${t.name}:true`);
      } else {
        expect(`${t.name}:${m.method}:${m.bodyEncoding}`).toBe(`${t.name}:POST:form-urlencoded`);
        expect(`${t.name}:${m.queryParams === undefined}`).toBe(`${t.name}:true`);
      }
      const mapped = JSON.stringify({ q: m.queryParams, b: m.bodyMapping });
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        const reached = mapped.includes(`"$${p}"`) || mapped.includes(`\${${p}}`);
        expect(`${t.name}:${p}:${reached}`).toBe(`${t.name}:${p}:true`);
      }
    }
  });

  it('installs the cancellation, the deactivation and the removal switched off, and nothing else', () => {
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
    // No instant messaging, no paid logistics booking, no return or refund decision, no payout.
    const forbiddenPrefix = /^\/(?:im|logistics\/epis|wallet|lazadapay)\//;
    const forbiddenPart = /\/reverse\/return\/update|onlyrefund|seller\/decide|consign|withdraw/;
    for (const t of a.tools) {
      const path = t.endpointMapping.path;
      expect(`${t.name}:${forbiddenPrefix.test(path) || forbiddenPart.test(path)}`).toBe(`${t.name}:false`);
    }
  });

  it('marks reads as read-only and every write as a write that asks for confirmation', () => {
    expect([...WRITES].sort()).toEqual(WRITES);
    for (const t of a.tools) {
      const write = WRITES.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${!write}`);
      // lazada_migrate_image only copies a picture into the seller's image storage.
      if (write && t.name !== 'lazada_migrate_image') {
        expect(`${t.name}:${/confirm with the user first/i.test(t.description)}`).toBe(`${t.name}:true`);
      }
    }
    // The two reads Lazada takes as a JSON object in a form field.
    for (const name of ['lazada_get_shipment_providers', 'lazada_get_shipping_label']) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(annotationsOf(tool(name)).readOnlyHint).toBe(true);
    }
  });

  it('reproduces the signature of the documented example (GetOrder, secret "helloworld")', async () => {
    const tokens = fakeTokens();
    await execute('lazada_get_order', { order_id: '1234' }, tokens);
    const cfg = sent();
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toBe('https://api.lazada.sg/rest/order/get');
    expect(cfg.params).toMatchObject({
      order_id: '1234',
      app_key: '123456',
      sign_method: 'sha256',
      access_token: 'test',
      timestamp: '1517820392000',
    });
    // The digest printed on Lazada's "HTTP request sample" page, step 5.
    expect(cfg.params.sign).toBe('4190D32361CFB9581350222F345CB77F3B19F0E31D162316848A2C1FFD5FAB4A');
    expect(cfg.params.sign).toBe(
      createHmac('sha256', 'helloworld')
        .update('/order/getaccess_tokentestapp_key123456order_id1234sign_methodsha256timestamp1517820392000', 'utf8')
        .digest('hex')
        .toUpperCase(),
    );
    expect(cfg.data).toBeUndefined();
    expect((tokens as unknown as { getCredentialParams: jest.Mock }).getCredentialParams).toHaveBeenCalled();
    // The secret signs and is never sent.
    expect(JSON.stringify(cfg)).not.toContain(DOC_SECRET);
  });

  it('signs every tool over its own API path, with the token and the app key in the query', async () => {
    const args: Record<string, Record<string, unknown>> = {
      lazada_get_order: { order_id: '1' },
      lazada_get_order_items: { order_id: '1' },
      lazada_get_multiple_order_items: { order_ids: '1,2' },
      lazada_get_order_trace: { order_id: '1' },
      lazada_get_order_document: { doc_type: 'invoice', order_item_ids: '11,12' },
      lazada_get_shipment_providers: { orders: [{ order_id: 1, order_item_ids: [11] }] },
      lazada_pack_order_items: { pack_order_list: [{ order_id: 1, order_item_list: [11] }], shipping_allocate_type: 'TFS' },
      lazada_set_ready_to_ship: { packages: [{ package_id: 'FP1' }] },
      lazada_get_shipping_label: { packages: [{ package_id: 'FP1' }] },
      lazada_get_product: { item_id: '5' },
      lazada_update_price_quantity: { payload: '<Request/>' },
      lazada_create_product: { payload: '{"Request":{}}' },
      lazada_update_product: { payload: '{"Request":{}}' },
      lazada_migrate_image: { payload: '<Request/>' },
      lazada_get_category_attributes: { primary_category_id: '3' },
      lazada_deactivate_product: { request_body: '{"Request":{}}' },
      lazada_remove_product: { sku_id_list: '["SkuId_1_2"]' },
      lazada_get_payout_status: { created_after: '2026-01-01' },
      lazada_list_transactions: { start_time: '2026-01-01', end_time: '2026-01-05' },
      lazada_list_review_ids: { item_id: '5', start_time: 1662134400000, end_time: 1662739200000 },
      lazada_get_reviews: { review_ids: '7,8' },
      lazada_reply_to_review: { review_id: '7', content: 'Thank you' },
      lazada_get_reverse_order: { reverse_order_id: '9' },
      lazada_validate_order_cancellation: { order_id: '1', order_item_ids: '11' },
      lazada_cancel_order_items: { order_id: '1', order_item_ids: '11', reason_id: '10000021' },
    };
    for (const [name, method, path] of TABLE) {
      await execute(name, args[name] ?? {});
      const cfg = sent();
      expect(`${name} ${cfg.method} ${cfg.url}`).toBe(`${name} ${method} ${HOST}/rest${path}`);
      expect(cfg.params).toMatchObject({
        app_key: '123456',
        sign_method: 'sha256',
        access_token: 'test',
        timestamp: String(DOC_TIMESTAMP),
      });
      const form = method === 'POST' ? Object.fromEntries(new URLSearchParams(String(cfg.data))) : {};
      if (method === 'POST') {
        expect(`${name}:${cfg.headers['Content-Type']}`).toBe(`${name}:application/x-www-form-urlencoded`);
        // The signature travels in the query, never in the form.
        expect(Object.keys(form)).not.toContain('sign');
      } else {
        expect(`${name}:${cfg.data}`).toBe(`${name}:undefined`);
      }
      expect(`${name}:${cfg.params.sign}`).toBe(`${name}:${lazadaSign(path, { ...cfg.params, ...form })}`);
      expect(cfg.params.sign).toMatch(/^[0-9A-F]{64}$/);
    }
  });

  it('lists orders in a time window with the documented names and the defaults of this adapter', async () => {
    await execute('lazada_list_orders', { created_after: '2026-11-01T00:00:00+08:00', status: 'pending' });
    const { sign, ...rest } = sent().params;
    expect(rest).toMatchObject({
      created_after: '2026-11-01T00:00:00+08:00',
      status: 'pending',
      offset: 0,
      limit: 50,
      app_key: '123456',
      sign_method: 'sha256',
      access_token: 'test',
      timestamp: String(DOC_TIMESTAMP),
    });
    // Filters the caller left out are not sent (and so not signed).
    for (const absent of ['created_before', 'update_after', 'update_before', 'sort_by', 'sort_direction']) {
      expect(rest).not.toHaveProperty(absent);
    }
    expect(sign).toBe(lazadaSign('/orders/get', rest));
    expect(tool('lazada_list_orders').parameters.properties!.limit).toMatchObject({ maximum: 100 });
    expect(tool('lazada_list_orders').parameters.properties!.status.enum).toEqual([
      'unpaid',
      'pending',
      'canceled',
      'ready_to_ship',
      'delivered',
      'returned',
      'shipped',
      'failed',
      'topack',
      'toship',
      'shipping',
      'lost',
    ]);
  });

  it('writes id lists as the bracketed lists the reference shows', async () => {
    await execute('lazada_get_multiple_order_items', { order_ids: '42922,32793' });
    expect(sent().params.order_ids).toBe('[42922,32793]');
    await execute('lazada_get_order_document', { doc_type: 'shippingLabel', order_item_ids: '279709,279710' });
    expect(sent().params).toMatchObject({ doc_type: 'shippingLabel', order_item_ids: '[279709,279710]' });
    await execute('lazada_get_reviews', { review_ids: '111111111111,111111111112' });
    expect(sent().params.id_list).toBe('[111111111111,111111111112]');
    await execute('lazada_validate_order_cancellation', { order_id: '5', order_item_ids: '51,52' });
    expect(sent().params).toMatchObject({ order_id: '5', order_item_id_list: '[51,52]' });
  });

  it('maps the snake_case parameters to the names the API uses', async () => {
    await execute('lazada_list_brands', {});
    expect(sent().params).toMatchObject({ startRow: 0, pageSize: 100 });
    await execute('lazada_reply_to_review', { review_id: '11111111111', content: 'Thank you for your review' });
    expect(sent().params).toMatchObject({ id: '11111111111', content: 'Thank you for your review' });
    await execute('lazada_list_reverse_orders', {
      request_type_list: '["RETURN"]',
      qc_decision: 'scrap',
      order_created_from: 1662430200000,
      request_modified_to: 1665366696000,
    });
    expect(sent().params).toMatchObject({
      page_no: 1,
      page_size: 10,
      request_type_list: '["RETURN"]',
      QC_Decision: 'scrap',
      TradeOrderLineCreatedTimeRangeStart: 1662430200000,
      ReverseOrderLineModifiedTimeRangeEnd: 1665366696000,
    });
    expect(sent().params).not.toHaveProperty('reverse_status_list');
    await execute('lazada_list_products', { sku_seller_list: '["MUG-01", "MUG-02"]' });
    expect(sent().params).toMatchObject({ filter: 'all', offset: 0, limit: 20, sku_seller_list: '["MUG-01", "MUG-02"]' });
    await execute('lazada_get_category_tree', {});
    expect(sent().params).toMatchObject({ language_code: 'en_US' });
  });

  it('packs, sets ready to ship and reads labels with the documented JSON objects as form fields', async () => {
    await execute('lazada_get_shipment_providers', { orders: [{ order_id: 12312312, order_item_ids: [123124321] }] });
    let form = Object.fromEntries(new URLSearchParams(String(sent().data)));
    expect(Object.keys(form)).toEqual(['getShipmentProvidersReq']);
    expect(form.getShipmentProvidersReq).toBe('{"orders":[{"order_id":12312312,"order_item_ids":[123124321]}]}');

    await execute('lazada_pack_order_items', {
      pack_order_list: [{ order_item_list: [560694402292001], order_id: 560694402192001 }],
      shipping_allocate_type: 'NTFS',
      shipment_provider_code: 'FM50',
    });
    form = Object.fromEntries(new URLSearchParams(String(sent().data)));
    expect(Object.keys(form)).toEqual(['packReq']);
    // The request demo of the Pack API page, field for field.
    expect(JSON.parse(form.packReq)).toEqual({
      pack_order_list: [{ order_item_list: [560694402292001], order_id: 560694402192001 }],
      delivery_type: 'dropship',
      shipment_provider_code: 'FM50',
      shipping_allocate_type: 'NTFS',
    });
    expect(sent().params.sign).toBe(lazadaSign('/order/fulfill/pack', { ...sent().params, ...form }));

    // A local shop: no shipment provider code, as the fulfilment guide's demo.
    await execute('lazada_pack_order_items', {
      pack_order_list: [{ order_item_list: [560694402292001], order_id: 560694402192001 }],
      shipping_allocate_type: 'TFS',
    });
    form = Object.fromEntries(new URLSearchParams(String(sent().data)));
    expect(JSON.parse(form.packReq)).toEqual({
      pack_order_list: [{ order_item_list: [560694402292001], order_id: 560694402192001 }],
      delivery_type: 'dropship',
      shipping_allocate_type: 'TFS',
    });

    await execute('lazada_set_ready_to_ship', { packages: [{ package_id: 'FP038524014' }] });
    form = Object.fromEntries(new URLSearchParams(String(sent().data)));
    expect(form).toEqual({ readyToShipReq: '{"packages":[{"package_id":"FP038524014"}]}' });

    await execute('lazada_get_shipping_label', { packages: [{ package_id: 'FP038541022' }] });
    form = Object.fromEntries(new URLSearchParams(String(sent().data)));
    expect(form).toEqual({ getDocumentReq: '{"doc_type":"PDF","packages":[{"package_id":"FP038541022"}]}' });
  });

  it('sends a product document unchanged in the documented form field, and signs it as sent', async () => {
    const xml =
      '<Request><Product><Skus><Sku><ItemId>234234234</ItemId><SkuId>234</SkuId>' +
      '<Price>1099.00</Price><Quantity>20</Quantity></Sku></Skus></Product></Request>';
    await execute('lazada_update_price_quantity', { payload: xml });
    let cfg = sent();
    let form = Object.fromEntries(new URLSearchParams(String(cfg.data)));
    expect(form).toEqual({ payload: xml });
    expect(cfg.params.sign).toBe(lazadaSign('/product/price_quantity/update', { ...cfg.params, payload: xml }));

    const json = '{"Request":{"Product":{"ItemId":"2096962270","Attributes":{"name":"Bag & strap, 50% off"}}}}';
    await execute('lazada_update_product', { payload: json });
    cfg = sent();
    form = Object.fromEntries(new URLSearchParams(String(cfg.data)));
    expect(form).toEqual({ payload: json });
    expect(cfg.params.sign).toBe(lazadaSign('/product/update', { ...cfg.params, payload: json }));

    await execute('lazada_deactivate_product', { request_body: '{"Request":{"Product":{"ItemId":3865707451}}}' });
    form = Object.fromEntries(new URLSearchParams(String(sent().data)));
    expect(form).toEqual({ apiRequestBody: '{"Request":{"Product":{"ItemId":3865707451}}}' });

    await execute('lazada_remove_product', { seller_sku_list: '["test00111","test00222"]' });
    form = Object.fromEntries(new URLSearchParams(String(sent().data)));
    expect(form).toEqual({ seller_sku_list: '["test00111","test00222"]' });
  });

  it('turns the error answers Lazada documents into the right kind of failure', () => {
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
    const gateway = (code: string, message = 'x') => status({ type: 'ISV', code, message, request_id: 'r' });
    // The token ended or is of another app or country: the engine renews it and retries once.
    expect(gateway('IllegalAccessToken', 'The specified access token is invalid or expired')).toBe(401);
    expect(gateway('IncompleteSignature')).toBe(401);
    expect(gateway('InvalidAppKey')).toBe(401);
    expect(gateway('IllegalRefreshToken')).toBe(401);
    expect(gateway('InsufficientPermission')).toBe(403);
    expect(gateway('AppWhiteIpLimit')).toBe(403);
    expect(gateway('Mp3SellerApiLimit')).toBe(403);
    expect(gateway('SellerNotVerified')).toBe(403);
    expect(gateway('ApiCallLimit')).toBe(429);
    expect(gateway('AppApiCallLimit')).toBe(429);
    expect(gateway('SellerCallLimit')).toBe(429);
    expect(gateway('TRAFFIC_CONTROL')).toBe(429);
    expect(gateway('901', 'E901: The request is too frequent')).toBe(429);
    // The order-read limit arrives as code 6 with its own message (announcement of 31 Oct 2025).
    expect(
      status({ code: '6', type: 'ISP', message: 'E1009: Query limit exceeded for seller 1 and order 2', request_id: 'r' }),
    ).toBe(429);
    expect(status({ code: '6', type: 'ISP', message: 'E006: Unexpected internal error' })).toBe(400);
    expect(gateway('MissingParameter')).toBe(400);
    expect(gateway('PARAMS_VALIDATE_ERROR', 'REPLY_ALREADY')).toBe(400);
    expect(gateway('37', 'E037: One or more order id in the list are incorrect')).toBe(400);
    // code 0 is success, as text or as a number, with data or with a result object.
    expect(status({ code: '0', data: {}, request_id: 'r' })).toBe(200);
    expect(status({ code: 0, data: [] })).toBe(200);
    expect(status({ code: '0', result: { success: false, error_code: '700021', error_msg: 'ORDER_NOT_FOUND' } })).toBe(200);
    // The message carries the code and Lazada's text.
    try {
      assertNoResponseBodyError({ code: 'IllegalAccessToken', message: 'The specified access token is invalid or expired' }, rules);
      throw new Error('expected an error');
    } catch (e) {
      expect((e as Error).message).toContain('IllegalAccessToken');
      expect((e as Error).message).toContain('invalid or expired');
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
    expect(a.instructions.startsWith('## Lazada Seller\n')).toBe(true);
    const names = new Set(a.tools.map((t) => t.name));
    for (const name of names) expect(`${name}:${a.instructions.includes(`\`${name}\``)}`).toBe(`${name}:true`);
    // lazada_sku is a field of the transaction lines, not a tool.
    const mentioned = [...JSON.stringify(adapter).matchAll(/\blazada_[a-z_]+/g)]
      .map((m) => m[0])
      .filter((name) => name !== 'lazada_sku');
    expect(mentioned.length).toBeGreaterThan(names.size);
    for (const name of mentioned) expect(names).toContain(name);
    for (const text of [
      '/api/iop-auth/callback',
      'https://cloud.anythingmcp.com/api/iop-auth/callback',
      'App Key',
      'App Secret',
      'Seller In-house App',
      'Authorized Seller Whitelist',
      'Authorize with Provider',
      'refresh token',
      '`LAZADA_HOST`',
    ]) {
      expect(a.instructions).toContain(text);
    }
  });

  it('guides the setup in four steps: create the app, paste the keys, whitelist the shop, authorize', () => {
    const g = a.setupGuide;
    expect(g.effort).toBe('own_app');
    expect(g.minutes).toBeGreaterThanOrEqual(10);
    expect(g.examples.length).toBeGreaterThanOrEqual(3);
    expect(g.examples.length).toBeLessThanOrEqual(4);
    expect(g.needs.length).toBeGreaterThan(0);
    expect(g.why).toBeTruthy();
    expect(g.steps.map((s) => s.id)).toEqual(['create-app', 'keys', 'whitelist', 'authorize']);
    expect(new Set(g.steps.map((s) => s.title)).size).toBe(4);
    const [create, keys, whitelist, authorize] = g.steps;

    // 1. The app at Lazada, with this connector's callback URL filled in by the setup page.
    expect(create.action!.url).toBe('https://isvconsole.lazada.com/apps/console/apps');
    expect(create.values).toContainEqual(expect.objectContaining({ label: 'Callback URL', value: '{{redirectUri}}' }));
    expect(create.values).toContainEqual(expect.objectContaining({ value: 'Seller In-house APP', pick: true }));
    expect(create.confirm).toBeTruthy();
    expect(create.fields).toBeUndefined();

    // 2. Every required variable, the country address too, each asked for once.
    expect([...(keys.fields ?? [])].sort()).toEqual([...a.requiredEnvVars].sort());
    expect(g.steps.flatMap((s) => s.fields ?? [])).toHaveLength(a.requiredEnvVars.length);

    // 3. What must be in place before the sign-in: the seller whitelist of a self-developed app.
    expect(whitelist.body).toContain('Authorized Seller Whitelist');
    expect(whitelist.confirm).toBeTruthy();
    expect(whitelist.fields).toBeUndefined();

    // 4. Authorize: no fields; Continue saves and opens Lazada's sign-in page.
    expect(authorize.fields).toBeUndefined();
    expect(authorize.confirm).toBeUndefined();
    const questions = (authorize.problems ?? []).map((p) => p.q).join(' | ');
    expect(questions).toMatch(/Redirect uri does not match/);
    expect(questions).toMatch(/whitelist/i);

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
  process.env.RUN_LAZADA_LIVE === '1' &&
  process.env.LAZADA_HOST &&
  process.env.LAZADA_APP_KEY &&
  process.env.LAZADA_APP_SECRET &&
  process.env.LAZADA_ACCESS_TOKEN
    ? describe
    : describe.skip;
live('lazada adapter: live (read-only)', () => {
  const call = async (path: string, extra: Record<string, string> = {}) => {
    const params: Record<string, string> = {
      app_key: process.env.LAZADA_APP_KEY!,
      access_token: process.env.LAZADA_ACCESS_TOKEN!,
      sign_method: 'sha256',
      timestamp: String(Date.now()),
      ...extra,
    };
    params.sign = lazadaSign(path, params, process.env.LAZADA_APP_SECRET!);
    const res = await fetch(`${process.env.LAZADA_HOST}/rest${path}?${new URLSearchParams(params)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(`${path}:${body.code}:${body.message ?? ''}`).toBe(`${path}:0:`);
    return body;
  };
  it('reads the seller, one page of products and one page of orders', async () => {
    const seller = await call('/seller/get');
    expect(seller.data).toHaveProperty('seller_id');
    const products = await call('/products/get', { filter: 'all', offset: '0', limit: '5' });
    expect(products.data).toBeDefined();
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const orders = await call('/orders/get', { created_after: since, offset: '0', limit: '5' });
    expect(orders.data).toHaveProperty('orders');
  }, 60_000);
});
