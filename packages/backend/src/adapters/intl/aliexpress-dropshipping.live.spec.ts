import axios from 'axios';
import { createHmac } from 'node:crypto';
import * as adapter from './aliexpress-dropshipping.json';
import { RestEngine, sortedParamsString } from '../../connectors/engines/rest.engine';
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
 * AliExpress Dropshipping adapter (AliExpress Open Platform, Dropshipping API).
 *
 *   1. Static: always runs. Every tool through the real RestEngine at a fixed
 *      clock, checked against the Open Platform docs (openservice.aliexpress.com,
 *      "HTTP request sample" docId 1385, the AE-Dropshipper API pages and the
 *      order create and tracking guides docId 1617 and 1660, read Oct 2026):
 *      business APIs on https://api-sg.aliexpress.com/sync with `method`,
 *      `app_key`, `access_token`, a millisecond `timestamp`,
 *      `sign_method=sha256` and `sign` over every parameter sorted by name.
 *      Object parameters (queryDeliveryReq, the order) go as JSON text, in a
 *      form body that the signature covers.
 *
 *   2. Live: skipped unless RUN_ALIEXPRESS_DROPSHIPPING_LIVE=1 and
 *      ALIEXPRESS_DS_APP_KEY, ALIEXPRESS_DS_APP_SECRET and
 *      ALIEXPRESS_DS_ACCESS_TOKEN are set. Reads only (member benefits, a
 *      product search). Never places an order. Not run for this adapter's
 *      first version: no dropshipping app was available.
 *
 *        RUN_ALIEXPRESS_DROPSHIPPING_LIVE=1 ALIEXPRESS_DS_APP_KEY=... ALIEXPRESS_DS_APP_SECRET=... \
 *          ALIEXPRESS_DS_ACCESS_TOKEN=... npx jest src/adapters/intl/aliexpress-dropshipping
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
const a = adapter as unknown as {
  slug: string;
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
const SECRET = ['ae', 'test', 'secret', '0000', '1111'].join('');
// Built the same way: not a real token.
const TOKEN = ['5000', '0000', 'demo', 'token', 'abcdef'].join('');
const ENV = { ALIEXPRESS_DS_APP_KEY: '512345', ALIEXPRESS_DS_APP_SECRET: SECRET, ALIEXPRESS_DS_ACCESS_TOKEN: TOKEN };
const NOW = 1_761_800_000_123;

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
/** The IOP signature written out independently of the engine. */
const iopSign = (concatenated: string) =>
  createHmac('sha256', SECRET).update(concatenated, 'utf8').digest('hex').toUpperCase();

// The documented API of each tool (AE-Dropshipper category of the API reference).
const METHODS: Record<string, string> = {
  aliexpress_dropshipping_get_member_benefits: 'aliexpress.ds.member.benefit.get',
  aliexpress_dropshipping_list_categories: 'aliexpress.ds.category.get',
  aliexpress_dropshipping_search_products: 'aliexpress.ds.text.search',
  aliexpress_dropshipping_get_product: 'aliexpress.ds.product.get',
  aliexpress_dropshipping_get_freight: 'aliexpress.ds.freight.query',
  aliexpress_dropshipping_get_order: 'aliexpress.trade.ds.order.get',
  aliexpress_dropshipping_get_tracking: 'aliexpress.ds.order.tracking.get',
  aliexpress_dropshipping_create_order: 'aliexpress.ds.order.create',
};
const WRITES = ['aliexpress_dropshipping_create_order'];
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations } as never);

describe('aliexpress-dropshipping adapter: static spec conformance', () => {
  let now: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { result: {} }, headers: {} });
    now = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => now.mockRestore());

  it('is listed in e-commerce with the AliExpress icon and a token-checking probe without parameters', () => {
    expect(a.slug).toBe('aliexpress-dropshipping');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('aliexpress');
    expect(a.requiredEnvVars).toEqual(['ALIEXPRESS_DS_APP_KEY', 'ALIEXPRESS_DS_APP_SECRET', 'ALIEXPRESS_DS_ACCESS_TOKEN']);
    expect(a.envVarMeta.ALIEXPRESS_DS_APP_SECRET.secret).toBe(true);
    expect(a.envVarMeta.ALIEXPRESS_DS_ACCESS_TOKEN.secret).toBe(true);
    expect(a.probe.tool).toBe('aliexpress_dropshipping_get_member_benefits');
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
  });

  it('signs IOP style and sends the pasted access token as a signed parameter', () => {
    expect(a.connector.baseUrl).toBe('https://api-sg.aliexpress.com');
    expect(a.connector.authType).toBe('HMAC');
    expect(a.connector.authConfig).toEqual({
      signature: {
        algorithm: 'sha256',
        encoding: 'hex-upper',
        secret: '{{ALIEXPRESS_DS_APP_SECRET}}',
        placement: 'query',
        paramName: 'sign',
        timestampParam: 'timestamp',
        timestampFormat: 'ms',
        queryParams: {
          app_key: '{{ALIEXPRESS_DS_APP_KEY}}',
          sign_method: 'sha256',
          access_token: '{{ALIEXPRESS_DS_ACCESS_TOKEN}}',
        },
        template: '${sortedParams}',
      },
    });
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
  });

  it('maps every tool to its documented API on /sync', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(METHODS).sort());
    for (const t of a.tools) {
      expect(t.endpointMapping.path).toBe('/sync');
      expect(`${t.name}:${t.endpointMapping.queryParams?.method}`).toBe(`${t.name}:${METHODS[t.name]}`);
    }
  });

  it('reads a product with the token and the documented signature', async () => {
    await execute('aliexpress_dropshipping_get_product', { product_id: '1005004638293060', ship_to_country: 'US', target_currency: 'USD' });
    const cfg = sent();
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toBe('https://api-sg.aliexpress.com/sync');
    const { sign, ...rest } = cfg.params;
    expect(rest).toEqual({
      method: 'aliexpress.ds.product.get',
      product_id: '1005004638293060',
      ship_to_country: 'US',
      target_currency: 'USD',
      app_key: '512345',
      sign_method: 'sha256',
      access_token: TOKEN,
      timestamp: String(NOW),
    });
    expect(sign).toBe(
      iopSign(
        `access_token${TOKEN}app_key512345methodaliexpress.ds.product.getproduct_id1005004638293060` +
          `ship_to_countryUSsign_methodsha256target_currencyUSDtimestamp${NOW}`,
      ),
    );
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
  });

  it('queries freight with queryDeliveryReq as JSON text in a signed form body', async () => {
    await execute('aliexpress_dropshipping_get_freight', {
      product_id: '1005004638293060',
      sku_id: '12000029786932962',
      quantity: 2,
      ship_to_country: 'FR',
      currency: 'EUR',
    });
    const cfg = sent();
    expect(cfg.method).toBe('POST');
    const body = Object.fromEntries(new URLSearchParams(cfg.data));
    expect(JSON.parse(body.queryDeliveryReq)).toEqual({
      productId: '1005004638293060',
      selectedSkuId: '12000029786932962',
      quantity: 2,
      shipToCountry: 'FR',
      currency: 'EUR',
      locale: 'en_US',
      language: 'en_US',
    });
    expect(cfg.params.method).toBe('aliexpress.ds.freight.query');
    expect(cfg.params.sign).toBe(iopSign(sortedParamsString({ ...cfg.params, ...body }, [], 'sign')));
  });

  it('reads an order with single_order_query as JSON and tracking with ae_order_id', async () => {
    await execute('aliexpress_dropshipping_get_order', { order_id: '8198352049851315' });
    expect(JSON.parse(sent().params.single_order_query)).toEqual({ order_id: 8198352049851315 });
    expect(sent().params.single_order_query).toBe('{"order_id":8198352049851315}');
    await execute('aliexpress_dropshipping_get_tracking', { order_id: '8198352049851315' });
    expect(sent().params).toMatchObject({ method: 'aliexpress.ds.order.tracking.get', ae_order_id: '8198352049851315', language: 'en_US' });
  });

  it('places an order as JSON text in the documented parameter, and installs it switched off', async () => {
    const order = tool('aliexpress_dropshipping_create_order');
    expect(order.enabled).toBe(false);
    expect(annotationsOf(order).readOnlyHint).toBe(false);
    await execute('aliexpress_dropshipping_create_order', {
      out_order_id: 'shop-1001',
      logistics_address: { country: 'US', province: 'New Jersey', city: 'Vineland', address: '1 Main St', zip: '08360', full_name: 'Jane Doe', phone_country: '+1', mobile_no: '5550100' },
      product_items: [{ product_id: 1005004638293060, product_count: 1, sku_attr: '14:365458#Brown', logistics_service_name: 'CAINIAO_STANDARD' }],
    });
    const cfg = sent();
    expect(cfg.method).toBe('POST');
    const body = Object.fromEntries(new URLSearchParams(cfg.data));
    expect(Object.keys(body)).toEqual(['param_place_order_request4_open_api_d_t_o']);
    expect(JSON.parse(body.param_place_order_request4_open_api_d_t_o)).toEqual({
      out_order_id: 'shop-1001',
      logistics_address: { country: 'US', province: 'New Jersey', city: 'Vineland', address: '1 Main St', zip: '08360', full_name: 'Jane Doe', phone_country: '+1', mobile_no: '5550100' },
      product_items: [{ product_id: 1005004638293060, product_count: 1, sku_attr: '14:365458#Brown', logistics_service_name: 'CAINIAO_STANDARD' }],
    });
    // No automatic payment: the documented try_to_pay switch is never sent.
    expect(cfg.data).not.toContain('try_to_pay');
    expect(cfg.params.sign).toBe(iopSign(sortedParamsString({ ...cfg.params, ...body }, [], 'sign')));
  });

  it('every tool is prefixed, every declared parameter reaches the request, all but the order are reads', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('aliexpress_dropshipping_')).toBe(true);
      const mapped = JSON.stringify({ q: t.endpointMapping.queryParams, b: t.endpointMapping.bodyMapping });
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        const reached = mapped.includes(`"$${p}"`) || mapped.includes(`\${${p}}`);
        expect(`${t.name}:${p}:${reached}`).toBe(`${t.name}:${p}:true`);
      }
      if (WRITES.includes(t.name)) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
    }
  });

  it('turns an expired or wrong token into an authentication error', () => {
    const status = (code: string) => {
      try {
        assertNoResponseBodyError({ error_response: { type: 'ISV', code, msg: 'x' } }, a.connector.config.errorWhen);
      } catch (e) {
        return (e as ResponseBodyError).status;
      }
      return 200;
    };
    expect(status('IllegalAccessToken')).toBe(401);
    expect(status('InvalidAppKey')).toBe(401);
    expect(status('InsufficientPermission')).toBe(403);
    expect(status('AppCallLimit')).toBe(429);
  });

  it('documents every tool and the token expiry in the instructions, without em dashes', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/Token expiry/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live =
  process.env.RUN_ALIEXPRESS_DROPSHIPPING_LIVE === '1' &&
  process.env.ALIEXPRESS_DS_APP_KEY &&
  process.env.ALIEXPRESS_DS_APP_SECRET &&
  process.env.ALIEXPRESS_DS_ACCESS_TOKEN
    ? describe
    : describe.skip;
live('aliexpress-dropshipping adapter: live (read-only)', () => {
  const call = async (method: string, extra: Record<string, string> = {}) => {
    const params: Record<string, string> = {
      method,
      app_key: process.env.ALIEXPRESS_DS_APP_KEY!,
      access_token: process.env.ALIEXPRESS_DS_ACCESS_TOKEN!,
      sign_method: 'sha256',
      timestamp: String(Date.now()),
      ...extra,
    };
    params.sign = createHmac('sha256', process.env.ALIEXPRESS_DS_APP_SECRET!)
      .update(sortedParamsString(params), 'utf8')
      .digest('hex')
      .toUpperCase();
    const res = await fetch(`${a.connector.baseUrl}/sync?${new URLSearchParams(params)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error_response).toBeUndefined();
    return body;
  };
  it('reads the member benefits and searches products', async () => {
    expect(await call('aliexpress.ds.member.benefit.get')).toHaveProperty('aliexpress_ds_member_benefit_get_response');
    const found = await call('aliexpress.ds.text.search', { keyWord: 'phone case', countryCode: 'US', currency: 'USD', local: 'en_US', pageSize: '5' });
    expect(found).toHaveProperty('aliexpress_ds_text_search_response');
  }, 60_000);
});
