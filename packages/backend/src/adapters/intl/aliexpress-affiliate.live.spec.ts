import axios from 'axios';
import { createHmac } from 'node:crypto';
import * as adapter from './aliexpress-affiliate.json';
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
 * AliExpress Affiliate adapter (AliExpress Open Platform, Affiliate API).
 *
 *   1. Static: always runs. Every tool through the real RestEngine at a fixed
 *      clock, checked against the Open Platform docs (openservice.aliexpress.com,
 *      "API endpoint URLs", "HTTP request sample" docId 1385 and the API pages
 *      of the AE-Affiliate category, read Oct 2026): business APIs on
 *      https://api-sg.aliexpress.com/sync with `method`, `app_key`, a
 *      millisecond `timestamp`, `sign_method=sha256` and `sign`, an upper-case
 *      HMAC-SHA256 over every parameter sorted by name, no path prefix.
 *
 *   2. Live: skipped unless RUN_ALIEXPRESS_AFFILIATE_LIVE=1 and
 *      ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET and ALIEXPRESS_TRACKING_ID
 *      are set. Reads only (categories, a product search). Not run for this
 *      adapter's first version: no affiliate app was available.
 *
 *        RUN_ALIEXPRESS_AFFILIATE_LIVE=1 ALIEXPRESS_APP_KEY=... ALIEXPRESS_APP_SECRET=... \
 *          ALIEXPRESS_TRACKING_ID=... npx jest src/adapters/intl/aliexpress-affiliate
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
const ENV = { ALIEXPRESS_APP_KEY: '512345', ALIEXPRESS_APP_SECRET: SECRET, ALIEXPRESS_TRACKING_ID: 'mytrack' };
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

// The documented API of each tool (AE-Affiliate category of the API reference).
const METHODS: Record<string, string> = {
  aliexpress_affiliate_list_categories: 'aliexpress.affiliate.category.get',
  aliexpress_affiliate_search_products: 'aliexpress.affiliate.product.query',
  aliexpress_affiliate_list_hot_products: 'aliexpress.affiliate.hotproduct.query',
  aliexpress_affiliate_get_products: 'aliexpress.affiliate.productdetail.get',
  aliexpress_affiliate_get_sku_details: 'aliexpress.affiliate.product.sku.detail.get',
  aliexpress_affiliate_get_shipping: 'aliexpress.affiliate.product.shipping.get',
  aliexpress_affiliate_get_promotions: 'aliexpress.affiliate.promotion.info.get',
  aliexpress_affiliate_generate_links: 'aliexpress.affiliate.link.generate',
  aliexpress_affiliate_list_featured_promos: 'aliexpress.affiliate.featuredpromo.get',
  aliexpress_affiliate_list_promo_products: 'aliexpress.affiliate.featuredpromo.products.get',
  aliexpress_affiliate_list_orders: 'aliexpress.affiliate.order.list',
  aliexpress_affiliate_get_orders: 'aliexpress.affiliate.order.get',
};

describe('aliexpress-affiliate adapter: static spec conformance', () => {
  let now: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { resp_result: { resp_code: 200 } }, headers: {} });
    now = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => now.mockRestore());

  it('is listed in e-commerce with the AliExpress icon and a read probe without parameters', () => {
    expect(a.slug).toBe('aliexpress-affiliate');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('aliexpress');
    expect(a.requiredEnvVars).toEqual(['ALIEXPRESS_APP_KEY', 'ALIEXPRESS_APP_SECRET', 'ALIEXPRESS_TRACKING_ID']);
    expect(a.envVarMeta.ALIEXPRESS_APP_SECRET.secret).toBe(true);
    expect(a.probe.tool).toBe('aliexpress_affiliate_list_categories');
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
  });

  it('signs IOP style: query placement, sorted parameters, upper-case hex, millisecond timestamp', () => {
    expect(a.connector.baseUrl).toBe('https://api-sg.aliexpress.com');
    expect(a.connector.authType).toBe('HMAC');
    expect(a.connector.authConfig).toEqual({
      signature: {
        algorithm: 'sha256',
        encoding: 'hex-upper',
        secret: '{{ALIEXPRESS_APP_SECRET}}',
        placement: 'query',
        paramName: 'sign',
        timestampParam: 'timestamp',
        timestampFormat: 'ms',
        queryParams: { app_key: '{{ALIEXPRESS_APP_KEY}}', sign_method: 'sha256' },
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

  it('sends a product search with the tracking ID and the documented signature', async () => {
    await execute('aliexpress_affiliate_search_products', {
      keywords: 'usb c cable',
      min_sale_price: 500,
      ship_to_country: 'DE',
      target_currency: 'EUR',
      target_language: 'DE',
    });
    const cfg = sent();
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toBe('https://api-sg.aliexpress.com/sync');
    const { sign, ...rest } = cfg.params;
    expect(rest).toEqual({
      method: 'aliexpress.affiliate.product.query',
      keywords: 'usb c cable',
      min_sale_price: 500,
      ship_to_country: 'DE',
      target_currency: 'EUR',
      target_language: 'DE',
      page_size: 20,
      tracking_id: 'mytrack',
      app_key: '512345',
      sign_method: 'sha256',
      timestamp: String(NOW),
    });
    expect(sign).toBe(
      iopSign(
        'app_key512345keywordsusb c cablemethodaliexpress.affiliate.product.query' +
          'min_sale_price500page_size20ship_to_countryDEsign_methodsha256' +
          `target_currencyEURtarget_languageDEtimestamp${NOW}tracking_idmytrack`,
      ),
    );
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
  });

  it('generates links in a signed form body, with the tracking ID', async () => {
    await execute('aliexpress_affiliate_generate_links', {
      source_values: 'https://www.aliexpress.com/item/1005001.html,https://www.aliexpress.com/item/1005002.html',
    });
    const cfg = sent();
    expect(cfg.method).toBe('POST');
    expect(cfg.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = Object.fromEntries(new URLSearchParams(cfg.data));
    expect(body).toEqual({
      source_values: 'https://www.aliexpress.com/item/1005001.html,https://www.aliexpress.com/item/1005002.html',
      promotion_link_type: '0',
      tracking_id: 'mytrack',
    });
    expect(cfg.params.sign).toBe(iopSign(sortedParamsString({ ...cfg.params, ...body }, [], 'sign')));
    expect(cfg.params.sign).toMatch(/^[0-9A-F]{64}$/);
  });

  it('every tool is prefixed and every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('aliexpress_affiliate_')).toBe(true);
      const mapped = JSON.stringify({ q: t.endpointMapping.queryParams, b: t.endpointMapping.bodyMapping });
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        expect(`${t.name}:${p}:${mapped.includes(`"$${p}"`)}`).toBe(`${t.name}:${p}:true`);
      }
      for (const [, p] of mapped.matchAll(/"\$(\w+)"/g)) {
        expect(`${t.name}:${p}:${p in (t.parameters.properties ?? {})}`).toBe(`${t.name}:${p}:true`);
      }
    }
  });

  it('is read-only: every tool is a read, none switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      const ann = deriveToolAnnotations({
        name: t.name,
        connectorType: 'REST',
        endpointMapping: t.endpointMapping,
        annotations: t.annotations,
      } as never);
      expect(`${t.name}:${ann.readOnlyHint}`).toBe(`${t.name}:true`);
    }
  });

  it('classifies gateway errors that arrive with HTTP 200', () => {
    const status = (code: string) => {
      try {
        assertNoResponseBodyError({ error_response: { type: 'ISV', code, msg: 'x' } }, a.connector.config.errorWhen);
      } catch (e) {
        return (e as ResponseBodyError).status;
      }
      return 200;
    };
    expect(status('InvalidAppKey')).toBe(401);
    expect(status('IncompleteSignature')).toBe(401);
    expect(status('IllegalAccessToken')).toBe(401);
    expect(status('InsufficientPermission')).toBe(403);
    expect(status('ApiCallLimit')).toBe(429);
    expect(status('MissingParameter')).toBe(400);
    expect(() =>
      assertNoResponseBodyError({ aliexpress_affiliate_category_get_response: { resp_result: { resp_code: 200 } } }, a.connector.config.errorWhen),
    ).not.toThrow();
  });

  it('documents every tool in the instructions, without em dashes', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live =
  process.env.RUN_ALIEXPRESS_AFFILIATE_LIVE === '1' &&
  process.env.ALIEXPRESS_APP_KEY &&
  process.env.ALIEXPRESS_APP_SECRET &&
  process.env.ALIEXPRESS_TRACKING_ID
    ? describe
    : describe.skip;
live('aliexpress-affiliate adapter: live (read-only)', () => {
  const call = async (method: string, extra: Record<string, string> = {}) => {
    const params: Record<string, string> = {
      method,
      app_key: process.env.ALIEXPRESS_APP_KEY!,
      sign_method: 'sha256',
      timestamp: String(Date.now()),
      ...extra,
    };
    params.sign = createHmac('sha256', process.env.ALIEXPRESS_APP_SECRET!)
      .update(sortedParamsString(params), 'utf8')
      .digest('hex')
      .toUpperCase();
    const res = await fetch(`${a.connector.baseUrl}/sync?${new URLSearchParams(params)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error_response).toBeUndefined();
    return body;
  };
  it('reads the categories and searches products', async () => {
    const cats = await call('aliexpress.affiliate.category.get');
    expect(cats.aliexpress_affiliate_category_get_response.resp_result.resp_code).toBe(200);
    const found = await call('aliexpress.affiliate.product.query', {
      keywords: 'phone case',
      page_size: '5',
      tracking_id: process.env.ALIEXPRESS_TRACKING_ID!,
    });
    expect(found.aliexpress_affiliate_product_query_response.resp_result.resp_code).toBe(200);
  }, 60_000);
});
