import axios from 'axios';
import { createHmac } from 'node:crypto';
import * as adapter from './falabella-seller-center.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import {
  assertNoResponseBodyError,
  describeErrorWhenProblems,
  ResponseBodyError,
} from '../../connectors/engines/response-error.util';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * Falabella Seller Center adapter (Rocket SellerCenter API on
 * sellercenter-api.falabella.com).
 *
 *   1. Static: always runs. Every tool through the real RestEngine at a fixed
 *      clock, checked against developers.falabella.com (read Nov 2026): every
 *      call on `/` with `Action`, `UserID`, `Version=1.0`, `Format`, an ISO
 *      8601 `Timestamp` and `Signature`; reads are GET with their filters in
 *      the query, feed writes are POST with an XML `<Request>` body; refusals
 *      come with HTTP 200 as `ErrorResponse.Head`. The value of the signature
 *      itself is covered by the engine's own spec
 *      (rest.engine.sortedquery-signing.spec.ts); here only its shape.
 *
 *   2. Live: skipped unless RUN_FALABELLA_SELLER_CENTER_LIVE=1 and
 *      FALABELLA_USER_ID, FALABELLA_API_KEY, FALABELLA_SELLER_ID and
 *      FALABELLA_BUSINESS_UNIT are set. Reads only (feed count, one product,
 *      one order). Falabella has no sandbox, so nothing is ever written.
 *
 *        RUN_FALABELLA_SELLER_CENTER_LIVE=1 FALABELLA_USER_ID=... FALABELLA_API_KEY=... \
 *          FALABELLA_SELLER_ID=... FALABELLA_BUSINESS_UNIT=FACL npx jest src/adapters/intl/falabella-seller-center
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
    bodyTemplate?: string;
    bodyEncoding?: string;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: {
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

// Built at run time so no literal here looks like a real secret.
const API_KEY = ['fal', 'test', 'key', '0000', '1111', '2222'].join('');
const ENV = {
  FALABELLA_USER_ID: 'api@store.example',
  FALABELLA_API_KEY: API_KEY,
  FALABELLA_SELLER_ID: 'SC1A2B3',
  FALABELLA_BUSINESS_UNIT: 'FACL',
};
const NOW = Date.parse('2026-11-06T07:00:00.123Z');

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the address, the mapping and authConfig.
const execute = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: config.headers,
      errorWhen: a.connector.config.errorWhen,
    } as never,
    endpointMapping as never,
    applySchemaDefaults(tool(name).parameters, params),
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];
const header = (cfg: { headers?: Record<string, unknown> }, name: string) =>
  Object.entries(cfg.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const P = 'falabella_seller_center_';
// The documented Action of each tool, its HTTP method and whether it installs switched on.
const ACTIONS: Record<string, [string, 'GET' | 'POST', boolean]> = {
  get_products: ['GetProducts', 'GET', true],
  get_stock: ['GetStock', 'GET', true],
  get_brands: ['GetBrands', 'GET', true],
  get_category_tree: ['GetCategoryTree', 'GET', true],
  get_category_attributes: ['GetCategoryAttributes', 'GET', true],
  get_category_suggestion: ['GetCategorySuggestion', 'GET', true],
  get_warehouses: ['GetWarehouse', 'GET', true],
  feed_list: ['FeedList', 'GET', true],
  feed_offset_list: ['FeedOffsetList', 'GET', true],
  feed_count: ['FeedCount', 'GET', true],
  feed_status: ['FeedStatus', 'GET', true],
  get_orders: ['GetOrders', 'GET', true],
  get_order: ['GetOrder', 'GET', true],
  get_order_items: ['GetOrderItems', 'GET', true],
  get_multiple_order_items: ['GetMultipleOrderItems', 'GET', true],
  get_document: ['GetDocument', 'GET', true],
  create_products: ['ProductCreate', 'POST', true],
  update_products: ['ProductUpdate', 'POST', true],
  update_price: ['ProductUpdate', 'POST', true],
  update_stock: ['UpdateStock', 'POST', true],
  update_stock_xml: ['UpdateStock', 'POST', true],
  set_images: ['Image', 'POST', true],
  remove_products: ['ProductRemove', 'POST', false],
  set_status_ready_to_ship: ['SetStatusToReadyToShip', 'POST', false],
  set_status_canceled: ['SetStatusToCanceled', 'POST', false],
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations } as never);

describe('falabella-seller-center adapter: static spec conformance', () => {
  let now: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { SuccessResponse: { Head: {}, Body: {} } }, headers: {} });
    now = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => now.mockRestore());

  it('is listed in e-commerce with the Falabella icon, four variables and a light probe without parameters', () => {
    expect(a.slug).toBe('falabella-seller-center');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('falabella');
    expect(a.docsUrl).toBe('https://developers.falabella.com/docs/getting-started');
    expect(a.requiredEnvVars).toEqual(['FALABELLA_USER_ID', 'FALABELLA_API_KEY', 'FALABELLA_SELLER_ID', 'FALABELLA_BUSINESS_UNIT']);
    expect(a.envVarMeta.FALABELLA_API_KEY.secret).toBe(true);
    const bu = new RegExp(a.envVarMeta.FALABELLA_BUSINESS_UNIT.pattern!);
    expect(['FACL', 'FACO', 'FAPE'].every((v) => bu.test(v))).toBe(true);
    expect(['facl', 'FAAR', 'CL'].some((v) => bu.test(v))).toBe(false);
    expect(new RegExp(a.envVarMeta.FALABELLA_USER_ID.pattern!).test(ENV.FALABELLA_USER_ID)).toBe(true);
    expect(a.probe.tool).toBe(`${P}feed_count`);
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
  });

  it('signs the sorted query with the API key and sends the required User-Agent', () => {
    expect(a.connector.baseUrl).toBe('https://sellercenter-api.falabella.com');
    expect(a.connector.authType).toBe('HMAC');
    expect(a.connector.authConfig).toEqual({
      signature: {
        algorithm: 'sha256',
        encoding: 'hex',
        secret: '{{FALABELLA_API_KEY}}',
        placement: 'query',
        paramName: 'Signature',
        timestampParam: 'Timestamp',
        timestampFormat: 'iso',
        queryParams: { UserID: '{{FALABELLA_USER_ID}}', Version: '1.0', Format: 'JSON' },
        template: '${sortedQuery}',
      },
    });
    // SELLER_ID/TECHNOLOGY/VERSION/INTEGRATION_TYPE/BUSINESS_UNIT
    expect(a.connector.headers['User-Agent']).toBe('{{FALABELLA_SELLER_ID}}/AnythingMCP/1.0/ANYTHINGMCP/{{FALABELLA_BUSINESS_UNIT}}');
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
  });

  it('maps every tool to its documented Action on /, reads as GET and writes as POST', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(ACTIONS).map((n) => P + n).sort());
    for (const t of a.tools) {
      const [action, method, enabled] = ACTIONS[t.name.slice(P.length)];
      expect(`${t.name}:${t.endpointMapping.path}:${t.endpointMapping.method}`).toBe(`${t.name}:/:${method}`);
      expect(`${t.name}:${t.endpointMapping.queryParams?.Action}`).toBe(`${t.name}:${action}`);
      expect(`${t.name}:${t.enabled ?? true}`).toBe(`${t.name}:${enabled}`);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${method === 'GET'}`);
    }
  });

  it('every tool is prefixed and every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(P)).toBe(true);
      const mapped = JSON.stringify({ q: t.endpointMapping.queryParams, b: t.endpointMapping.bodyMapping, t: t.endpointMapping.bodyTemplate });
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        const reached = mapped.includes(`"$${p}"`) || mapped.includes(`\${${p}}`);
        expect(`${t.name}:${p}:${reached}`).toBe(`${t.name}:${p}:true`);
      }
    }
  });

  it('lists products with the documented filters, the credentials and an ISO timestamp in a signed query', async () => {
    await execute(`${P}get_products`, { search: 'zapatilla', sku_seller_list: '["SKU-1","SKU-2"]', offset: 50 });
    const cfg = sent();
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toBe('https://sellercenter-api.falabella.com/');
    const { Signature, ...rest } = cfg.params;
    expect(rest).toEqual({
      Action: 'GetProducts',
      Filter: 'all',
      Search: 'zapatilla',
      SkuSellerList: '["SKU-1","SKU-2"]',
      Limit: 50,
      Offset: 50,
      UserID: 'api@store.example',
      Version: '1.0',
      Format: 'JSON',
      Timestamp: '2026-11-06T07:00:00+00:00',
    });
    expect(Signature).toMatch(/^[0-9a-f]{64}$/);
    expect(header(cfg, 'User-Agent')).toBe('SC1A2B3/AnythingMCP/1.0/ANYTHINGMCP/FACL');
    expect(JSON.stringify(cfg)).not.toContain(API_KEY);
  });

  it('asks for shipping labels with the fixed document type and bracketed item ids', async () => {
    await execute(`${P}get_document`, { order_item_ids: '[987654,987655]' });
    expect(sent().params).toMatchObject({ Action: 'GetDocument', DocumentType: 'shippingParcel', OrderItemIds: '[987654,987655]' });
    await execute(`${P}get_multiple_order_items`, { order_id_list: '[1,2]' });
    expect(sent().params).toMatchObject({ Action: 'GetMultipleOrderItems', OrderIdList: '[1,2]' });
    await execute(`${P}feed_status`, { feed_id: '883bdfe3-950f-4390-9a80-41437b69808c' });
    expect(sent().params).toMatchObject({ Action: 'FeedStatus', FeedID: '883bdfe3-950f-4390-9a80-41437b69808c' });
  });

  it('sends a caller-written XML document unchanged as an XML body', async () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8" ?><Request><Product><SellerSku>A&amp;B</SellerSku>' +
      '<Description><![CDATA[<b>x</b>]]></Description></Product></Request>';
    for (const name of ['create_products', 'update_products', 'update_stock_xml', 'set_images', 'remove_products']) {
      await execute(P + name, { xml });
      const cfg = sent();
      expect(`${name}:${cfg.method}`).toBe(`${name}:POST`);
      expect(`${name}:${cfg.data}`).toBe(`${name}:${xml}`);
      expect(String(header(cfg, 'Content-Type'))).toMatch(/^application\/xml/);
      expect(cfg.params.Action).toBe(ACTIONS[name][0]);
    }
  });

  it('changes one price with escaped values, leaving unset sale fields empty (Falabella ignores them)', async () => {
    await execute(`${P}update_price`, { seller_sku: 'R&D <1>', operator_code: 'facl', price: '19990' });
    expect(sent().data).toBe(
      '<?xml version="1.0" encoding="UTF-8" ?><Request><Product><SellerSku>R&amp;D &lt;1&gt;</SellerSku>' +
        '<BusinessUnits><BusinessUnit><OperatorCode>facl</OperatorCode><Price>19990</Price><SpecialPrice></SpecialPrice>' +
        '<SpecialFromDate></SpecialFromDate><SpecialToDate></SpecialToDate></BusinessUnit></BusinessUnits></Product></Request>',
    );
    await execute(`${P}update_price`, {
      seller_sku: 'SKU-1',
      operator_code: 'fape',
      price: '120.00',
      special_price: '99.90',
      special_from_date: '2026-11-20 00:00:00',
      special_to_date: '2026-11-30 23:59:59',
    });
    expect(sent().data).toContain(
      '<OperatorCode>fape</OperatorCode><Price>120.00</Price><SpecialPrice>99.90</SpecialPrice>' +
        '<SpecialFromDate>2026-11-20 00:00:00</SpecialFromDate><SpecialToDate>2026-11-30 23:59:59</SpecialToDate>',
    );
    expect(sent().params.Action).toBe('ProductUpdate');
    expect(tool(`${P}update_price`).parameters.properties!.operator_code.enum).toEqual(['facl', 'faco', 'fape']);
  });

  it('sets the stock of one SKU in the default warehouse', async () => {
    await execute(`${P}update_stock`, { seller_sku: 'SKU-1', quantity: 0 });
    const cfg = sent();
    expect(cfg.params.Action).toBe('UpdateStock');
    expect(cfg.data).toBe(
      '<?xml version="1.0" encoding="UTF-8" ?><Request><Warehouse><Stock><SellerSku>SKU-1</SellerSku>' +
        '<Quantity>0</Quantity></Stock></Warehouse></Request>',
    );
  });

  it('sends order status changes as signed query parameters', async () => {
    await execute(`${P}set_status_ready_to_ship`, { order_item_ids: '[1,2]', package_id: 'PKG1' });
    expect(sent().method).toBe('POST');
    expect(sent().params).toMatchObject({ Action: 'SetStatusToReadyToShip', OrderItemIds: '[1,2]', PackageId: 'PKG1' });
    await execute(`${P}set_status_canceled`, { order_item_id: 5, reason: 'SHORTAGE' });
    expect(sent().params).toMatchObject({ Action: 'SetStatusToCanceled', OrderItemId: 5, Reason: 'SHORTAGE' });
    expect(sent().params).not.toHaveProperty('ReasonDetail');
  });

  it('turns an ErrorResponse inside HTTP 200 into the right failure', () => {
    const status = (code: string, message: string) => {
      try {
        assertNoResponseBodyError(
          { ErrorResponse: { Head: { RequestAction: 'GetOrder', ErrorType: 'Sender', ErrorCode: code, ErrorMessage: message }, Body: '' } },
          a.connector.config.errorWhen,
        );
      } catch (e) {
        return (e as ResponseBodyError).status;
      }
      return 200;
    };
    expect(status('7', 'E007: Login failed. Signature mismatching')).toBe(401);
    expect(status('E007', 'Login failed. Signature mismatching')).toBe(401);
    expect(status('3', 'E003: Timestamp has expired')).toBe(401);
    expect(status('4', 'E004: Invalid Timestamp format')).toBe(401);
    expect(status('9', 'E009: Access Denied')).toBe(403);
    expect(status('429', 'E429: Too many requests')).toBe(429);
    expect(status('1', 'E001: Parameter OrderId is mandatory')).toBe(400);
    expect(status('1000', 'Format Error Detected')).toBe(400);
    expect(() =>
      assertNoResponseBodyError({ SuccessResponse: { Head: { RequestId: 'x' }, Body: '' } }, a.connector.config.errorWhen),
    ).not.toThrow();
  });

  it('documents every tool, the roles, feeds, the missing sandbox and the OperatorCode, without em dashes', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/Seller API Access/);
    expect(a.instructions).toMatch(/Seller API Product Access/);
    expect(a.instructions).toMatch(/Seller API Order Access/);
    expect(a.instructions).toMatch(/no sandbox/i);
    expect(a.instructions).toMatch(/feed_status/);
    expect(a.instructions).toMatch(/`facl`, `faco`, `fape`/);
    for (const name of ['create_products', 'update_products', 'update_price', 'set_images', 'remove_products']) {
      expect(`${name}:${tool(P + name).description.includes('feed_status')}`).toBe(`${name}:true`);
    }
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });

  it('offers only the GetOrders sort columns and statuses Falabella accepts', () => {
    // developers.falabella.com GetOrders: SortBy created_at | updated_at; Status
    // pending, canceled, ready_to_ship, delivered, returned, shipped, failed.
    // `createdat` and `readytoship` were refused with E075 / E036.
    const props = tool(`${P}get_orders`).parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.sort_by.enum).toEqual(['created_at', 'updated_at']);
    expect(props.status.enum!.slice().sort()).toEqual(
      ['canceled', 'delivered', 'failed', 'pending', 'ready_to_ship', 'returned', 'shipped'],
    );
  });
});

const live =
  process.env.RUN_FALABELLA_SELLER_CENTER_LIVE === '1' &&
  process.env.FALABELLA_USER_ID &&
  process.env.FALABELLA_API_KEY &&
  process.env.FALABELLA_SELLER_ID &&
  process.env.FALABELLA_BUSINESS_UNIT
    ? describe
    : describe.skip;
live('falabella-seller-center adapter: live (read-only)', () => {
  // The signing guide's algorithm, written out independently of the engine.
  const rfc3986 = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const call = async (action: string, extra: Record<string, string> = {}) => {
    const params: Record<string, string> = {
      Action: action,
      Format: 'JSON',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
      UserID: process.env.FALABELLA_USER_ID!,
      Version: '1.0',
      ...extra,
    };
    const query = Object.keys(params)
      .sort()
      .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`)
      .join('&');
    const signature = createHmac('sha256', process.env.FALABELLA_API_KEY!).update(query, 'utf8').digest('hex');
    const res = await fetch(`${a.connector.baseUrl}/?${query}&Signature=${signature}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `${process.env.FALABELLA_SELLER_ID}/AnythingMCP/1.0/ANYTHINGMCP/${process.env.FALABELLA_BUSINESS_UNIT}`,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.ErrorResponse).toBeUndefined();
    return body.SuccessResponse;
  };
  it('reads the feed count, one product and one order', async () => {
    expect((await call('FeedCount')).Body).toHaveProperty('FeedCount');
    expect(await call('GetProducts', { Filter: 'all', Limit: '1' })).toHaveProperty('Body');
    expect(await call('GetOrders', { Limit: '1' })).toHaveProperty('Head');
  }, 60_000);
});
