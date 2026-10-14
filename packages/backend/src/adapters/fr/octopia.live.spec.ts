import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './octopia.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { attachResponseMeta } from '../../connectors/engines/response-headers.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Cdiscount (Octopia) Seller API adapter:
 *
 *   1. Static: always runs. Pins the client-credentials token request
 *      (credentials in the form body, at Octopia's Keycloak realm), the
 *      SellerId header on every call, every tool's method and URL (checked
 *      against Octopia's published Seller API v2 OpenAPI specification of
 *      9 Oct 2026), the bodies of the writes, and which tools write.
 *
 *   2. Live: skipped unless RUN_OCTOPIA_LIVE=1 and the credentials are set.
 *      Reads only: the seller, carriers, orders, offers, offer packages,
 *      products, discussions, returns, payments.
 *
 *        RUN_OCTOPIA_LIVE=1 OCTOPIA_CLIENT_ID=... OCTOPIA_CLIENT_SECRET=... \
 *          OCTOPIA_SELLER_ID=... npx jest src/adapters/fr/octopia.live.spec.ts
 *
 *      Nothing here accepts, ships or cancels an order, or touches an offer:
 *      those act on real customers and live listings.
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
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios; post: jest.Mock };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyTemplate?: string;
    exposeHeaders?: string[];
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  icon: string;
  aliases: string[];
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
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

const TOKEN_URL = 'https://auth.octopia-io.net/auth/realms/maas/protocol/openid-connect/token';
const BASE = 'https://api.octopia-io.net/seller/v2';
// Built at run time so no literal here looks like a real secret.
const SECRET = ['oihSWfu8', 'TgfMFycZ', 'nZa8zhh5'].join('');
const ENV = { OCTOPIA_CLIENT_ID: 'my-shop-api', OCTOPIA_CLIENT_SECRET: SECRET, OCTOPIA_SELLER_ID: '98979' };

// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const executeWithMeta = (name: string, env: Record<string, string>, params: Record<string, unknown>, tokens?: OAuth2TokenService) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  const tokenService = tokens ?? ({ getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService);
  return new RestEngine(tokenService, {} as LoginTokenService).executeWithMeta(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, env),
      headers: config.headers,
    },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  );
};
// What the model receives: the body, plus the exposed headers and pagination.
const execute = async (name: string, env: Record<string, string>, params: Record<string, unknown>, tokens?: OAuth2TokenService): Promise<any> => {
  const { body, headers } = await executeWithMeta(name, env, params, tokens);
  const wanted = tool(name).endpointMapping.exposeHeaders;
  return wanted?.length ? attachResponseMeta(body, { headers }, tool(name).endpointMapping.queryParams) : body;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];
const header = (cfg: { headers: Record<string, string> }, name: string) =>
  Object.entries(cfg.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const WRITES = [
  'octopia_add_offer_requests',
  'octopia_cancel_order',
  'octopia_create_offer_delete_package',
  'octopia_create_offer_package',
  'octopia_reply_discussion',
  'octopia_set_discussion_open',
  'octopia_set_order_approval',
  'octopia_ship_order',
  'octopia_submit_offer_package',
];

describe('octopia adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until it has been run against a real seller account', () => {
    expect(a.unlisted).toBe(true);
    expect(a.name).toBe('Cdiscount (Octopia)');
    expect(a.aliases).toContain('cdiscount');
    expect(a.region).toBe('fr');
    expect(a.icon).toBe('cdiscount');
  });

  it("gets its token with the client-credentials grant at Octopia's Keycloak realm, no browser sign-in", () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{OCTOPIA_CLIENT_ID}}',
      clientSecret: '{{OCTOPIA_CLIENT_SECRET}}',
      tokenUrl: TOKEN_URL,
      tokenAuthMethod: 'client_secret_post',
    });
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    expect(a.connector.baseUrl).toBe(BASE);
  });

  it('sends client_id and client_secret in the form body, as Octopia documents, and no Basic header', async () => {
    const service = new OAuth2TokenService(
      {} as PrismaService,
      { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService,
    );
    const post = jest.spyOn(mockedAxios, 'post').mockResolvedValue({ data: { access_token: 'eyJ.token', expires_in: 7200, token_type: 'Bearer' } });
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).resolves.toBe('eyJ.token');
    const [url, body, options] = post.mock.calls[0] as [string, string, { headers: Record<string, string> }];
    expect(url).toBe(TOKEN_URL);
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'my-shop-api',
      client_secret: SECRET,
    });
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    post.mockRestore();
  });

  it('sends the bearer token and the SellerId header on every call', async () => {
    expect(a.connector.headers.SellerId).toBe('{{OCTOPIA_SELLER_ID}}');
    mockedAxios.mockResolvedValue({ data: {} });
    await call('octopia_get_seller', {});
    expect(sent().url).toBe(`${BASE}/sellers`);
    expect(header(sent(), 'SellerId')).toBe('98979');
    expect(header(sent(), 'Authorization')).toBe('Bearer test-token');
    expect(JSON.stringify(sent())).not.toContain(SECRET);
  });

  it('checks the credentials and seller id and keeps the secret secret', () => {
    expect(a.requiredEnvVars).toEqual(['OCTOPIA_CLIENT_ID', 'OCTOPIA_CLIENT_SECRET', 'OCTOPIA_SELLER_ID']);
    expect(a.optionalEnvVars).toBeUndefined();
    const seller = new RegExp(a.envVarMeta.OCTOPIA_SELLER_ID.pattern!);
    expect(seller.test('98979')).toBe(true);
    expect(seller.test('SELLER 98979')).toBe(false);
    const secret = new RegExp(a.envVarMeta.OCTOPIA_CLIENT_SECRET.pattern!);
    expect(secret.test(SECRET)).toBe(true);
    expect(secret.test(`${SECRET} `)).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'OCTOPIA_CLIENT_SECRET')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'OCTOPIA_SELLER_ID')!.secret).toBe(false);
    expect(described.find((d) => d.name === 'OCTOPIA_SELLER_ID')!.kind).toBe('setting');
  });

  it('probes and health-checks with the seller account', () => {
    expect(a.probe).toEqual({ tool: 'octopia_get_seller' });
    expect(a.connector.healthcheckPath).toBe('/sellers');
    expect(tool('octopia_get_seller').parameters.required).toBeUndefined();
  });

  it('prefixes every tool with octopia_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^octopia_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, asks for confirmation on every write and installs only the delete package switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/get a yes from the user first/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['octopia_create_offer_delete_package']);
  });

  it('encodes path ids, so an id cannot reach another route', async () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('{'))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('octopia_get_order', { orderId: '../sellers' });
    expect(sent().url).toBe(`${BASE}/orders/..%2Fsellers`);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\boctopia_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\boctopia_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, args, method, path] — each checked against the Seller API v2 OpenAPI file.
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['octopia_get_seller', {}, 'GET', '/sellers'],
    ['octopia_get_seller_indicators', {}, 'GET', '/sellers/indicators'],
    ['octopia_list_carriers', {}, 'GET', '/carriers'],
    ['octopia_list_orders', {}, 'GET', '/orders'],
    ['octopia_get_order', { orderId: 'SELLZZ210525142759UT8E' }, 'GET', '/orders/SELLZZ210525142759UT8E'],
    ['octopia_set_order_approval', { orderId: 'SCID1', approval_status: 'Accepted' }, 'POST', '/orders/SCID1/approval-status'],
    ['octopia_ship_order', { orderId: 'SCID1', parcels: [{ parcelNumber: 'P1', carrierName: 'Colissimo' }] }, 'POST', '/orders/SCID1/shipments'],
    ['octopia_list_cancellation_reasons', { orderStatus: 'Accepted' }, 'GET', '/cancellation-reasons'],
    ['octopia_list_cancellation_requests', { orderSellerId: 'SCID1' }, 'GET', '/order-cancellation-requests'],
    ['octopia_cancel_order', { orderSellerId: 'SCID1', reason: 'OutOfStock' }, 'POST', '/order-cancellation-requests'],
    ['octopia_list_offers', {}, 'GET', '/offers'],
    ['octopia_list_offer_packages', {}, 'GET', '/offer-packages'],
    ['octopia_get_offer_package', { packageId: 'AAA0000001' }, 'GET', '/offer-packages/AAA0000001'],
    ['octopia_get_offer_package_results', { packageId: 'AAA0000001' }, 'GET', '/offer-packages/AAA0000001/offer-requests-results'],
    ['octopia_create_offer_package', { packageType: 'Update' }, 'POST', '/offer-packages'],
    ['octopia_add_offer_requests', { packageId: 'AAA0000001', offers: [{ sellerExternalReference: 'SKU1', quantity: 2 }] }, 'POST', '/offer-packages/AAA0000001/offer-requests'],
    ['octopia_submit_offer_package', { packageId: 'AAA0000001' }, 'PATCH', '/offer-packages/AAA0000001'],
    ['octopia_create_offer_delete_package', {}, 'POST', '/offer-packages'],
    ['octopia_list_products', {}, 'GET', '/products'],
    ['octopia_list_discussions', {}, 'GET', '/discussions'],
    ['octopia_get_discussion', { discussionId: '60afb211f41c9700016d92ae' }, 'GET', '/discussions/60afb211f41c9700016d92ae'],
    ['octopia_reply_discussion', { discussionId: 'd1', salesChannel: 'CDISFR', receiverType: 'Customer', body: 'Your parcel leaves tomorrow.' }, 'POST', '/messages'],
    ['octopia_set_discussion_open', { discussionId: 'd1', isOpen: false }, 'PATCH', '/discussions/d1'],
    ['octopia_list_returns', {}, 'GET', '/returns'],
    ['octopia_list_payments', {}, 'GET', '/payments'],
    ['octopia_list_operations', { orderReference: '1601302358PGI56' }, 'GET', '/operations'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s %s', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
  });

  it('pages orders 50 at a time from page 1 and passes the filters through', async () => {
    mockedAxios.mockResolvedValue({ data: { items: [] } });
    await call('octopia_list_orders', { status: 'WaitingAcceptance', createdAtMin: '2026-10-01T00:00:00Z', desc: 'createdAt' });
    expect(sent().params).toEqual({ status: 'WaitingAcceptance', createdAtMin: '2026-10-01T00:00:00Z', desc: 'createdAt', pageIndex: 1, pageSize: 50 });
  });

  it('accepts or refuses an order with the approval_status body', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('octopia_set_order_approval', { orderId: 'SCID1', approval_status: 'Refused' });
    expect(sent().data).toEqual({ approval_status: 'Refused' });
    expect(tool('octopia_set_order_approval').parameters.properties!.approval_status.enum).toEqual(['Accepted', 'Refused']);
  });

  it('ships with the array of parcels as the whole body', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    const parcels = [
      { parcelNumber: '6A123', carrierName: 'Colissimo', trackingUrl: 'https://www.laposte.fr/outils/suivre-vos-envois?code=6A123', orderLineIds: ['AYG1'] },
      { parcelNumber: '6A124', carrierName: 'Colissimo', orderLineIds: ['AYG2'] },
    ];
    await call('octopia_ship_order', { orderId: 'SCID1', parcels });
    expect(sent().data).toEqual(parcels);
  });

  it('cancels with the order id and reason, and leaves the shipping refund to Octopia unless asked', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('octopia_cancel_order', { orderSellerId: 'SCID1', reason: 'OutOfStock' });
    expect(sent().data).toEqual({ orderSellerId: 'SCID1', reason: 'OutOfStock' });
    mockedAxios.mockClear();
    await call('octopia_cancel_order', { orderSellerId: 'SCID1', reason: 'OutOfStock', shippingCostRefund: false });
    expect(sent().data).toEqual({ orderSellerId: 'SCID1', reason: 'OutOfStock', shippingCostRefund: false });
  });

  it('opens offer packages for Cdiscount by default and returns the package id from Content-Location', async () => {
    mockedAxios.mockResolvedValue({ data: '', status: 201, headers: { 'content-location': 'offer-packages/AAA0000001' } });
    const res = await call('octopia_create_offer_package', { packageType: 'Update' });
    expect(sent().data).toEqual({ packageType: 'Update' });
    expect(header(sent(), 'SalesChannelId')).toBe('CDISFR');
    expect(header(sent(), 'Accept-Language')).toBe('en-US');
    expect(JSON.stringify(res)).toContain('offer-packages/AAA0000001');
    expect(tool('octopia_create_offer_package').parameters.properties!.packageType.enum).toEqual(['Update', 'Upsert']);
  });

  it('keeps deletion in its own package tool, switched off', async () => {
    mockedAxios.mockResolvedValue({ data: '', headers: {} });
    await call('octopia_create_offer_delete_package', {});
    expect(sent().data).toEqual({ packageType: 'Delete' });
    expect(header(sent(), 'SalesChannelId')).toBe('CDISFR');
    expect(tool('octopia_create_offer_delete_package').enabled).toBe(false);
  });

  it('uploads offer requests as a bare array and submits the package as Ready', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    const offers = [{ sellerExternalReference: 'SKU1', price: { price: 49.99 }, quantity: 20 }];
    await call('octopia_add_offer_requests', { packageId: 'AAA0000001', offers });
    expect(sent().data).toEqual(offers);
    expect(tool('octopia_add_offer_requests').parameters.properties!.offers.maxItems).toBe(100);
    mockedAxios.mockClear();
    await call('octopia_submit_offer_package', { packageId: 'AAA0000001' });
    expect(sent().data).toEqual({ state: 'Ready' });
  });

  it('lists offers of one sales channel and pages with the Cursor parameter', async () => {
    mockedAxios.mockResolvedValue({ data: { items: [] }, headers: { link: '<offers?SalesChannelId=CDISFR&limit=100&Cursor=cHwx>; rel="next"' } });
    const res = await call('octopia_list_offers', { sellerExternalReferences: 'SKU1,SKU2', cursor: 'Zg==' });
    expect(sent().params).toEqual({ salesChannelId: 'CDISFR', sellerExternalReferences: 'SKU1,SKU2', limit: 100, Cursor: 'Zg==' });
    expect(res._pagination.nextUrl).toContain('Cursor=cHwx');
  });

  it('sends Accept-Language on products only when asked', async () => {
    mockedAxios.mockResolvedValue({ data: { items: [] }, headers: {} });
    await call('octopia_list_products', { gtin: '3564461054763' });
    expect(header(sent(), 'Accept-Language')).toBeUndefined();
    expect(sent().params).toEqual({ gtin: '3564461054763', limit: 25 });
    mockedAxios.mockClear();
    await call('octopia_list_products', { language: 'en-US' });
    expect(header(sent(), 'Accept-Language')).toBe('en-US');
  });

  it('replies to a discussion with one receiver of the chosen type', async () => {
    mockedAxios.mockResolvedValue({ data: { id: 'm1' } });
    await call('octopia_reply_discussion', { discussionId: 'd1', salesChannel: 'CDISFR', receiverType: 'GrcOperator', body: 'Le colis "A" part demain.' });
    expect(sent().data).toEqual({ discussionId: 'd1', salesChannel: 'CDISFR', body: 'Le colis "A" part demain.', receivers: [{ userType: 'GrcOperator' }] });
  });

  it('closes a discussion with the replace operation Octopia documents', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('octopia_set_discussion_open', { discussionId: 'd1', isOpen: false });
    expect(sent().data).toEqual([{ opt: 'replace', path: '/isOpen', value: 'false' }]);
  });

  it('repeats array filters on returns, as the endpoint expects', async () => {
    mockedAxios.mockResolvedValue({ data: { items: [] }, headers: {} });
    await call('octopia_list_returns', { status: ['Created', 'Pending'], types: ['Customer'] });
    expect(sent().params).toEqual({ status: ['Created', 'Pending'], types: ['Customer'], limit: 20 });
    expect(sent().paramsSerializer(sent().params)).toBe('status=Created&status=Pending&types=Customer&limit=20');
  });

  it('documents setup, the order workflow, the three-step offer change and the token endpoint', () => {
    expect(a.instructions).toContain('https://developer.octopia-io.net/user-guides/api-credentials/');
    expect(a.instructions).toContain('Link my SellerAccount and my clientId');
    expect(a.instructions).toContain(TOKEN_URL);
    expect(a.instructions).toContain('WaitingAcceptance');
    expect(a.instructions).toContain('CDISFR');
    expect(a.instructions).toMatch(/content-location/);
    expect(a.verifyHints['403']).toContain('Link the clientId');
  });
});

const LIVE =
  process.env.RUN_OCTOPIA_LIVE === '1' &&
  !!process.env.OCTOPIA_CLIENT_ID &&
  !!process.env.OCTOPIA_CLIENT_SECRET &&
  !!process.env.OCTOPIA_SELLER_ID;

(LIVE ? describe : describe.skip)('octopia adapter: live Seller API (reads only)', () => {
  const env: Record<string, string> = {
    OCTOPIA_CLIENT_ID: process.env.OCTOPIA_CLIENT_ID as string,
    OCTOPIA_CLIENT_SECRET: process.env.OCTOPIA_CLIENT_SECRET as string,
    OCTOPIA_SELLER_ID: process.env.OCTOPIA_SELLER_ID as string,
  };
  // The real token service, so the live run also proves the token request shape.
  const tokens = new OAuth2TokenService(
    {} as PrismaService,
    { get: () => 'live-spec-encryption-key-32-chars!' } as unknown as ConfigService,
  );
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params, tokens);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

  it('reads the seller, its indicators and the carriers', async () => {
    const seller = await run('octopia_get_seller');
    expect(String(seller.seller_id)).toBe(env.OCTOPIA_SELLER_ID);
    await run('octopia_get_seller_indicators');
    await run('octopia_list_carriers');
  }, 120_000);

  it('reads orders of the last 30 days and one order in full', async () => {
    const orders = await run('octopia_list_orders', { createdAtMin: daysAgo(30), pageSize: 5, desc: 'createdAt' });
    expect(Array.isArray(orders.items)).toBe(true);
    if (orders.items[0]) {
      const one = await run('octopia_get_order', { orderId: orders.items[0].orderId });
      expect(one.orderId).toBe(orders.items[0].orderId);
    }
    await run('octopia_list_cancellation_reasons', { orderStatus: 'Accepted', salesChannel: 'CDISFR' });
  }, 120_000);

  it('reads offers, offer packages and products', async () => {
    const offers = await run('octopia_list_offers', { limit: 5 });
    expect(offers).toBeDefined();
    await run('octopia_list_offer_packages', { limit: 5 });
    await run('octopia_list_products', { limit: 5 });
  }, 120_000);

  it('reads discussions, returns and payments', async () => {
    await run('octopia_list_discussions', { updatedAtMin: daysAgo(30), pageSize: 5 });
    await run('octopia_list_returns', { limit: 10 });
    await run('octopia_list_payments', { pageSize: 5 });
  }, 120_000);
});
