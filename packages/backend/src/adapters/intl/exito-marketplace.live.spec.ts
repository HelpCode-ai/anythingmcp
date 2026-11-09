import axios, { AxiosError } from 'axios';
import * as adapter from './exito-marketplace.json';
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
 * Grupo Éxito marketplace seller API (developers.exito.com, read Nov 2026).
 *
 *   1. Static: always runs. Every tool goes through the real RestEngine and
 *      LoginTokenService with axios mocked: the token request (x-api-key
 *      header, Email and Password in the body, as Éxito's instructions name them), the token sent bare as
 *      `Authorization` (the docs write COGNITO_TOKEN) with `x-api-key` on every
 *      call, a new login after a 401, each documented API Gateway address and
 *      query, and the request bodies. Éxito does not publish the token
 *      request, so its address is the connector variable EXITO_LOGIN_URL and
 *      the token is looked up at several usual paths.
 *
 *   2. Live: skipped unless RUN_EXITO_LIVE=1 (or RUN_EXITO_MARKETPLACE_LIVE=1)
 *      and EXITO_LOGIN_URL, EXITO_USERNAME, EXITO_PASSWORD, EXITO_API_KEY and
 *      EXITO_SELLER_ID are set. Reads only (one product, the batch status, the
 *      moderation queue). There is no documented sandbox, so nothing is
 *      ever written.
 *
 *        RUN_EXITO_LIVE=1 EXITO_LOGIN_URL=... EXITO_USERNAME=... EXITO_PASSWORD=... \
 *          EXITO_API_KEY=... EXITO_SELLER_ID=... npx jest src/adapters/intl/exito-marketplace
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
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
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

const R = 'https://rbrefxe0d8.execute-api.us-east-1.amazonaws.com/External-pdn';
const A = 'https://akaxxado2l.execute-api.us-east-1.amazonaws.com/products-massive-pdn';
const O = 'https://af2jnwlpmg.execute-api.us-east-1.amazonaws.com/OfferExternal-pdn';
const C = 'https://cl9k3h7xr4.execute-api.us-east-1.amazonaws.com/orders-pdn/api/orders';
const F = 'https://rtox6c92tc.execute-api.us-east-1.amazonaws.com/financial-pdn/api/';
const N = 'https://n8pu9xx2ba.execute-api.us-east-1.amazonaws.com/products-massive-pdn/categories';
const S = 'https://9ddwtrb7mc.execute-api.us-east-1.amazonaws.com/specs-external-pdn/getbycategoryid';

const P = 'exito_marketplace_';
// The documented address of each tool, its HTTP method and whether it installs switched on.
const ROUTES: Record<string, [string, string, boolean]> = {
  get_products: ['GET', `${R}/products/`, true],
  get_products_waiting: ['GET', `${R}/productswaiting/productswaiting`, true],
  get_products_rejected: ['GET', `${R}/productswaiting/productsrejected`, true],
  get_products_pending_seller_approval: ['GET', `${R}/products/productspendingtoapprovebyseller`, true],
  get_bulk_upload_status: ['GET', `${A}/status`, true],
  list_categories: ['GET', N, true],
  get_category: ['GET', `${N}/{category_id}`, true],
  get_category_features: ['GET', `${S}/{category_id}`, true],
  get_orders: ['GET', C, true],
  get_bills: ['GET', F, true],
  create_products: ['POST', `${A}/`, true],
  load_products_and_offers: ['POST', `${R}/productsandoffers`, true],
  upsert_offers: ['PATCH', O, true],
  update_offer_price_stock: ['PATCH', O, true],
  set_order_tracking: ['PATCH', `${C}/{order_id}/tracking`, false],
  upload_order_invoice: ['PATCH', `${C}/bill`, false],
};

// Built at run time so no literal here looks like a real secret.
const API_KEY = ['exi', 'test', 'key', '0000', '1111'].join('');
const PASSWORD = ['pass', 'word', '-', 'test'].join('');
const LOGIN_URL = 'https://abcdefghij.execute-api.us-east-1.amazonaws.com/auth-test/token';
const ENV = {
  EXITO_LOGIN_URL: LOGIN_URL,
  EXITO_USERNAME: 'integraciones@tienda.example',
  EXITO_PASSWORD: PASSWORD,
  EXITO_API_KEY: API_KEY,
  EXITO_SELLER_ID: '11795',
};

let tokens: string[];
let apiCalls: Array<Record<string, any>>;
let loginCalls: Array<Record<string, any>>;
let rejectNextApiCall: boolean;
let apiAnswer: unknown;

const fakeAxios = async (cfg: Record<string, any>) => {
  if (cfg.url === LOGIN_URL) {
    loginCalls.push(cfg);
    return { status: 200, data: { AuthenticationResult: { IdToken: tokens.shift(), ExpiresIn: 3600 } }, headers: {} };
  }
  apiCalls.push({ ...cfg, headers: { ...cfg.headers } });
  if (rejectNextApiCall) {
    rejectNextApiCall = false;
    const response = { status: 401, statusText: 'Unauthorized', data: { message: 'Unauthorized' }, headers: {}, config: cfg };
    throw new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', cfg as never, null, response as never);
  }
  return { status: 200, data: apiAnswer, headers: {} };
};

const newEngine = () => {
  const prisma = { connectorAuthCache: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() } };
  const config = { get: jest.fn().mockReturnValue('test-encryption-key-32-chars-ok!') };
  return new RestEngine({} as OAuth2TokenService, new LoginTokenService(prisma as never, config as never));
};
let engine: RestEngine;

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the address, the mapping and authConfig.
const execute = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return engine.execute(
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
const sent = () => apiCalls[apiCalls.length - 1];
const header = (cfg: { headers?: Record<string, unknown> }, name: string) =>
  Object.entries(cfg.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations } as never);

describe('exito-marketplace adapter: static spec conformance', () => {
  beforeEach(() => {
    tokens = ['id-token-1', 'id-token-2', 'id-token-3'];
    apiCalls = [];
    loginCalls = [];
    rejectNextApiCall = false;
    apiAnswer = { errors: [], data: { list: [], total: 0 }, message: 'Operación realizada con éxito.' };
    mockedAxios.mockReset();
    mockedAxios.mockImplementation(fakeAxios);
    engine = newEngine();
  });

  it('is listed in e-commerce with the Éxito icon, five variables and a light read probe', () => {
    expect(a.slug).toBe('exito-marketplace');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('exito');
    expect(a.docsUrl).toBe('https://developers.exito.com/');
    expect(a.requiredEnvVars).toEqual(['EXITO_USERNAME', 'EXITO_PASSWORD', 'EXITO_API_KEY', 'EXITO_LOGIN_URL', 'EXITO_SELLER_ID']);
    expect(a.envVarMeta.EXITO_PASSWORD.secret).toBe(true);
    expect(a.envVarMeta.EXITO_API_KEY.secret).toBe(true);
    const seller = new RegExp(a.envVarMeta.EXITO_SELLER_ID.pattern!);
    expect(seller.test('11795')).toBe(true);
    expect(['SC-1', '', '11 795'].some((v) => seller.test(v))).toBe(false);
    const url = new RegExp(a.envVarMeta.EXITO_LOGIN_URL.pattern!);
    expect(url.test(LOGIN_URL)).toBe(true);
    expect(['http://x.example/token', 'https://', 'abcdefghij.execute-api.us-east-1.amazonaws.com'].some((v) => url.test(v))).toBe(false);
    expect(a.probe).toEqual({ tool: `${P}get_products`, params: { limit: 1, page: 1 } });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
  });

  it('logs in with x-api-key and the credentials, and sends the bare token with x-api-key on every call', async () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: '{{EXITO_LOGIN_URL}}',
      loginMethod: 'POST',
      loginHeaders: { 'x-api-key': '{{EXITO_API_KEY}}' },
      loginBody: { Email: '${username}', Password: '${password}' },
      username: '{{EXITO_USERNAME}}',
      password: '{{EXITO_PASSWORD}}',
      refreshOn401: true,
      headerName: 'Authorization',
      headerTemplate: '${token}',
      extraHeaders: { 'x-api-key': '{{EXITO_API_KEY}}' },
    });
    // API Gateway's Cognito authorizer validates the ID token by default.
    expect(a.connector.authConfig.tokenJsonPath[0]).toBe('AuthenticationResult.IdToken');
    expect(a.connector.authConfig.tokenTTLSeconds).toBe(3600);

    await execute(`${P}get_products`, { limit: 1, page: 1 });
    expect(loginCalls).toHaveLength(1);
    const login = loginCalls[0];
    expect(login.method).toBe('POST');
    expect(header(login, 'x-api-key')).toBe(API_KEY);
    expect(login.data).toEqual({ Email: 'integraciones@tienda.example', Password: PASSWORD });

    const call = sent();
    expect(header(call, 'Authorization')).toBe('id-token-1');
    expect(header(call, 'x-api-key')).toBe(API_KEY);
    expect(JSON.stringify(call)).not.toContain(PASSWORD);

    // The token is reused, not fetched per call.
    await execute(`${P}get_bulk_upload_status`, {});
    expect(loginCalls).toHaveLength(1);
    expect(header(sent(), 'Authorization')).toBe('id-token-1');
  });

  it('logs in again and retries once when Éxito answers 401', async () => {
    await execute(`${P}get_products`, { limit: 1, page: 1 });
    rejectNextApiCall = true;
    await execute(`${P}get_orders`, {});
    expect(loginCalls).toHaveLength(2);
    expect(apiCalls.map((c) => header(c, 'Authorization'))).toEqual(['id-token-1', 'id-token-1', 'id-token-2']);
  });

  it('maps every tool to its documented address and method, reads as GET', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(ROUTES).map((n) => P + n).sort());
    for (const t of a.tools) {
      const [method, path, enabled] = ROUTES[t.name.slice(P.length)];
      expect(`${t.name}:${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${t.name}:${method} ${path}`);
      expect(`${t.name}:${t.enabled ?? true}`).toBe(`${t.name}:${enabled}`);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${method === 'GET'}`);
      // Categories are documented without culture; every other call carries es-CO.
      const culture = t.endpointMapping.queryParams?.culture;
      expect(`${t.name}:${culture}`).toBe(`${t.name}:${path.startsWith(N) ? undefined : 'es-CO'}`);
    }
  });

  it('every tool is prefixed and every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(P)).toBe(true);
      const m = t.endpointMapping;
      const mapped = JSON.stringify({ p: m.path, q: m.queryParams, b: m.bodyMapping });
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        const reached = mapped.includes(`"$${p}"`) || mapped.includes(`{${p}}`);
        expect(`${t.name}:${p}:${reached}`).toBe(`${t.name}:${p}:true`);
      }
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) {
        expect(`${t.name}:${p}:${(t.parameters.required ?? []).includes(p)}`).toBe(`${t.name}:${p}:true`);
      }
    }
  });

  it('lists products with the documented query and only the seller\'s own by default', async () => {
    await execute(`${P}get_products`, { limit: 10, page: 2, ean: '9205147694107', seller_sku: '1992', initial_date: '2026-01-01' });
    const call = sent();
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`${R}/products/`);
    expect(call.params).toEqual({
      culture: 'es-CO',
      limit: 10,
      page: 2,
      myProducts: true,
      ean: '9205147694107',
      sellerSku: '1992',
      initialDate: '2026-01-01',
    });
  });

  it('pages the moderation queues with {} first and the seller id from the connector', async () => {
    await execute(`${P}get_products_waiting`, {});
    expect(sent().url).toBe(`${R}/productswaiting/productswaiting`);
    expect(sent().params).toEqual({ culture: 'es-CO', limit: 20, paginationToken: '{}', idSeller: '11795' });
    await execute(`${P}get_products_rejected`, { ean: 'IZ20000082449', pagination_token: '{"Id":{"N":"1"}}' });
    expect(sent().params).toMatchObject({ idSeller: '11795', ean: 'IZ20000082449', paginationToken: '{"Id":{"N":"1"}}' });
    await execute(`${P}get_products_pending_seller_approval`, { plu: '100286013' });
    expect(sent().params).toEqual({ culture: 'es-CO', limit: 20, paginationToken: '{}', plu: '100286013' });
    await execute(`${P}get_bills`, { payment_date_initial: '2026/10/01' });
    expect(sent().url).toBe(F);
    expect(sent().params).toEqual({ culture: 'es-CO', idSeller: '11795', limit: 50, paginationToken: '{}', paymentDateInitial: '2026/10/01' });
  });

  it('reads orders, categories and category features at their own addresses', async () => {
    await execute(`${P}get_orders`, { id_status_order: 35, date_order_initial: '2026/11/01' });
    expect(sent().url).toBe(C);
    expect(sent().params).toEqual({ culture: 'es-CO', limit: 50, idStatusOrder: 35, dateOrderInitial: '2026/11/01' });
    await execute(`${P}get_category`, { category_id: 50249 });
    expect(sent().url).toBe(`${N}/50249`);
    await execute(`${P}list_categories`, {});
    expect(sent().url).toBe(N);
    await execute(`${P}get_category_features`, { category_id: 28086 });
    expect(sent().url).toBe(`${S}/28086`);
    expect(sent().params).toEqual({ culture: 'es-CO' });
  });

  it('creates products with the caller\'s array as the whole JSON body', async () => {
    const products = [
      {
        Ean: '0',
        Name: 'Camara deportiva ADIDAS X1 4K',
        Category: '27193',
        Brand: 'ADIDAS',
        Description: '<p>La mejor camara</p>',
        ImageUrl1: 'https://cdn.example/camara.jpg',
        features: [{ key: 'Tipo de cámara', value: 'Deportiva' }],
      },
    ];
    await execute(`${P}create_products`, { products });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${A}/`);
    expect(sent().params).toEqual({ culture: 'es-CO' });
    expect(sent().data).toEqual(products);
    expect(tool(`${P}create_products`).parameters.properties!.products.maxItems).toBe(400);
  });

  it('sends offers as {PriceApproval, ListOffers} and products with offers as {PriceApproval, ProductsAndOffers}', async () => {
    const offers = [{ EAN: '7701410118349', Stock: '3', Price: '16000', IsUpdatedStock: 1 }];
    await execute(`${P}upsert_offers`, { offers });
    expect(sent().method).toBe('PATCH');
    expect(sent().url).toBe(O);
    expect(sent().data).toEqual({ PriceApproval: 0, ListOffers: offers });

    const items = [{ Product: { Ean: '0', Name: 'Auriculares' }, Offer: { EAN: '0', Stock: '100', Price: '65001' } }];
    await execute(`${P}load_products_and_offers`, { items });
    expect(sent().url).toBe(`${R}/productsandoffers`);
    expect(sent().data).toEqual({ PriceApproval: false, ProductsAndOffers: items });
  });

  it('changes one offer\'s price and stock, and only the price when update_stock is 0', async () => {
    await execute(`${P}update_offer_price_stock`, { ean: '7701410118349', price: '45000', stock: 12 });
    expect(sent().data).toEqual({
      PriceApproval: 0,
      ListOffers: [{ EAN: '7701410118349', Stock: 12, Price: '45000', IsUpdatedStock: 1 }],
    });
    await execute(`${P}update_offer_price_stock`, {
      ean: '7701410118349',
      price: '39900',
      discount_price: '35900',
      stock: 12,
      update_stock: 0,
      price_approval: 1,
      seller_sku: '1992',
    });
    expect(sent().data).toEqual({
      PriceApproval: 1,
      ListOffers: [{ EAN: '7701410118349', Stock: 12, Price: '39900', DiscountPrice: '35900', IsUpdatedStock: 0, SellerSku: '1992' }],
    });
  });

  it('ships and invoices orders with the documented bodies (both switched off)', async () => {
    await execute(`${P}set_order_tracking`, { order_id: '637040012650663267', tracking: '787878', carrier: 'SERVIENTREGA', products: ['6370700714712646841'] });
    expect(sent().method).toBe('PATCH');
    expect(sent().url).toBe(`${C}/637040012650663267/tracking`);
    expect(sent().data).toEqual({ tracking: '787878', carrier: 'SERVIENTREGA', products: ['6370700714712646841'] });
    await execute(`${P}upload_order_invoice`, { order_id: '637040012650663267', base64_file: 'JVBERi0x', file_type: 1 });
    expect(sent().url).toBe(`${C}/bill`);
    expect(sent().data).toEqual({ IdOrder: '637040012650663267', Base64File: 'JVBERi0x', FileType: 1 });
  });

  it('turns a non-empty errors list inside HTTP 200 into a failed call, and leaves batch results alone', () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    const outcome = (body: unknown) => {
      try {
        assertNoResponseBodyError(body, a.connector.config.errorWhen as never);
      } catch (e) {
        return `${(e as ResponseBodyError).status}:${(e as Error).message}`;
      }
      return 'ok';
    };
    expect(outcome({ errors: [{ code: '500', message: 'La orden no tiene Centro de Acopio asignado' }], data: null })).toMatch(/^400:.*Centro de Acopio/);
    expect(outcome({ Errors: [{ Message: 'Token inválido' }], Data: [] })).toMatch(/^400:.*Token inválido/);
    // Documented successes: empty error lists, a batch with per-EAN messages, the tracking summary.
    expect(outcome({ errors: [], data: { idSeller: 100121, status: 3 }, Message: 'Operación realizada éxitosamente.' })).toBe('ok');
    expect(outcome({ Errors: [], Data: [{ totalProcess: 1, error: 1, successful: 0, productNotifyViewModel: [{ Ean: '1', Message: 'x' }] }] })).toBe('ok');
    expect(outcome({ status: 'Created', products: [], errors: 0, updates: 1, total: 1 })).toBe('ok');
    expect(outcome({ viewModel: [], count: 0, paginationToken: '{}', paginationTokens: [] })).toBe('ok');
  });

  it('documents every tool, the moderation flow, the price rules and the token request, without em dashes', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/moderated by Éxito's content team/);
    expect(a.instructions).toMatch(/PEX/);
    expect(a.instructions).toMatch(/IsUpdatedStock/);
    expect(a.instructions).toMatch(/EXITO_LOGIN_URL/);
    expect(a.instructions).toMatch(/No sandbox is documented/);
    for (const name of ['create_products', 'load_products_and_offers']) {
      expect(`${name}:${/get_products_waiting/.test(tool(P + name).description)}`).toBe(`${name}:true`);
    }
    for (const name of ['upsert_offers', 'update_offer_price_stock']) {
      expect(`${name}:${/PEX/.test(tool(P + name).description)}`).toBe(`${name}:true`);
    }
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live =
  (process.env.RUN_EXITO_LIVE === '1' || process.env.RUN_EXITO_MARKETPLACE_LIVE === '1') &&
  process.env.EXITO_LOGIN_URL &&
  process.env.EXITO_USERNAME &&
  process.env.EXITO_PASSWORD &&
  process.env.EXITO_API_KEY &&
  process.env.EXITO_SELLER_ID
    ? describe
    : describe.skip;
live('exito-marketplace adapter: live (read-only)', () => {
  const env = process.env as Record<string, string>;
  let token = '';
  const paths: string[] = a.connector.authConfig.tokenJsonPath;
  const at = (body: unknown, path: string): unknown =>
    path === '.' ? body : path.split('.').reduce<any>((v, k) => (v == null ? undefined : v[k]), body);

  beforeAll(async () => {
    const res = await fetch(env.EXITO_LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': env.EXITO_API_KEY },
      body: JSON.stringify({ Email: env.EXITO_USERNAME, Password: env.EXITO_PASSWORD }),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* a bare token */
    }
    expect(res.status).toBe(200);
    token = String(paths.map((p) => at(body, p)).find((v) => typeof v === 'string' && v.trim() !== '') ?? '');
    // Only the shape of the answer, never its values.
    expect(`token at one of the paths; answer keys: ${body && typeof body === 'object' ? Object.keys(body).join(',') : typeof body}:${token !== ''}`).toMatch(/:true$/);
  }, 60_000);

  const get = async (url: string) => {
    const res = await fetch(url, { headers: { Authorization: token, 'x-api-key': env.EXITO_API_KEY, Accept: 'application/json' } });
    expect(`${url.split('?')[0]} ${res.status}`).toBe(`${url.split('?')[0]} 200`);
    return (await res.json()) as Record<string, any>;
  };

  it('reads one product, the batch status and the moderation queue', async () => {
    expect((await get(`${R}/products/?culture=es-CO&limit=1&page=1&myProducts=true`)).data).toHaveProperty('total');
    expect(await get(`${A}/status?culture=es-CO`)).toHaveProperty('data');
    expect(await get(`${R}/productswaiting/productswaiting?culture=es-CO&limit=1&paginationToken=%7B%7D&idSeller=${env.EXITO_SELLER_ID}`)).toHaveProperty('viewModel');
  }, 60_000);
});
