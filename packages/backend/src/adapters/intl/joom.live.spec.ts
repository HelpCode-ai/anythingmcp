import axios from 'axios';
import * as adapter from './joom.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';
import { McpOAuthService } from '../../connectors/mcp-oauth.service';
import { startConnectorAuthorization } from '../../connectors/connector-authorization';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';

/**
 * Joom for Merchants API v3 adapter.
 *
 * Static checks always run: the authorization-code sign-in with the merchant's
 * own app (authorize and token endpoints still on API v2, a separate refresh
 * endpoint, no PKCE, the token fields inside Joom's `data` envelope, read
 * through the real token services), every tool's method and path against Joom's published
 * OpenAPI file, the request bodies of the write tools, the guided setup, and
 * which tools install switched off (cancellation, which refunds the customer,
 * Joom online shipping, and the two delete tools).
 * https://merchant.joom.com/docs/api/v3
 *
 * Live checks run only with RUN_JOOM_LIVE=1. Without a token they confirm the
 * API refuses an unauthenticated call; with JOOM_ACCESS_TOKEN (an access token
 * of an authorized app) they count the products. Reads only.
 *
 *   RUN_JOOM_LIVE=1 JOOM_ACCESS_TOKEN=... npx jest src/adapters/intl/joom.live.spec.ts
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
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
    download?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
type GuideStep = { id: string; fields?: string[]; values?: Array<{ label: string; value: string }>; confirm?: string };
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; advanced?: boolean; example?: string; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  setupGuide?: { effort: string; minutes: number; steps: GuideStep[] };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: { errorWhen?: Array<Record<string, unknown>> };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  walk(m.download ?? {});
  return out;
};
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

const BASE = 'https://api-merchant.joom.com/api/v3';
// Built at runtime so no literal looks like a real credential.
const ENV: Record<string, string> = {
  JOOM_CLIENT_ID: 'a1b2c3d4e5f6a7b8',
  JOOM_CLIENT_SECRET: ['joom', 's'.repeat(28)].join('-'),
  JOOM_REFRESH_TOKEN: ['rt', 'r'.repeat(24)].join('-'),
};
const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200, data: unknown = {}) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// Every tool with its method, its path below the base URL and its required arguments,
// as the vendor documents them.
const EXPECTED: Array<[string, string, string, string[]]> = [
  ['joom_list_unfulfilled_orders', 'GET', '/orders/unfulfilled', []],
  ['joom_list_orders', 'GET', '/orders/multi', []],
  ['joom_get_order', 'GET', '/orders', ['order_id']],
  ['joom_fulfill_order', 'POST', '/orders/fulfill', ['order_id', 'tracking_number']],
  ['joom_modify_tracking', 'POST', '/orders/modifyTracking', ['order_id', 'tracking_number']],
  ['joom_cancel_order', 'POST', '/orders/cancel', ['order_id', 'reason']],
  ['joom_fulfill_orders_online', 'POST', '/orders/fulfillOnline', ['order_ids']],
  ['joom_list_shippers', 'GET', '/shippers', []],
  ['joom_list_products', 'GET', '/products/multi', []],
  ['joom_count_products', 'GET', '/products/multi/count', []],
  ['joom_get_product', 'GET', '/products', []],
  ['joom_create_product', 'POST', '/products/create', ['sku', 'name', 'main_image', 'variants']],
  ['joom_update_product', 'POST', '/products/update', []],
  ['joom_remove_product', 'POST', '/products/remove', []],
  ['joom_remove_product_variants', 'POST', '/products/removeVariants', ['variants']],
  ['joom_get_product_stock', 'GET', '/products/warehouses', []],
  ['joom_update_product_stock', 'POST', '/products/warehouses/update', ['items']],
  ['joom_list_categories', 'GET', '/productCategories', []],
  ['joom_get_category_requirements', 'GET', '/productCategories/requirements', ['category_id']],
  ['joom_list_warehouses', 'GET', '/warehouses/multi', []],
  ['joom_list_pickup_addresses', 'GET', '/pickupAddresses/all', []],
  ['joom_list_fbj_replenishments', 'GET', '/fbj/replenishments/multi', []],
];

describe('joom adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with an authorization code through the app the merchant created', () => {
    expect(a.slug).toBe('joom');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('joom');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'refresh_token',
      authorizationUrl: 'https://api-merchant.joom.com/api/v2/oauth/authorize',
      tokenUrl: 'https://api-merchant.joom.com/api/v2/oauth/access_token',
      refreshUrl: 'https://api-merchant.joom.com/api/v2/oauth/refresh_token',
      tokenResponsePath: 'data',
      pkce: false,
      clientId: '{{JOOM_CLIENT_ID}}',
      clientSecret: '{{JOOM_CLIENT_SECRET}}',
      refreshToken: '{{JOOM_REFRESH_TOKEN}}',
    });
    expect(a.requiredEnvVars).toEqual(['JOOM_CLIENT_ID', 'JOOM_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['JOOM_REFRESH_TOKEN']);
    expect(a.envVarMeta.JOOM_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.JOOM_REFRESH_TOKEN).toMatchObject({ advanced: true });
    expect(new RegExp(a.envVarMeta.JOOM_CLIENT_ID.pattern!).test(ENV.JOOM_CLIENT_ID)).toBe(true);
    expect(new RegExp(a.envVarMeta.JOOM_CLIENT_SECRET.pattern!).test(ENV.JOOM_CLIENT_SECRET)).toBe(true);
    for (const bad of ['', 'has space here 123456']) expect(new RegExp(a.envVarMeta.JOOM_CLIENT_SECRET.pattern!).test(bad)).toBe(false);
  });

  // Joom answers its token calls as { code, message, data: { access_token, refresh_token, expires_in, expiry_time } }
  // (the Authorization chapter of its OpenAPI file). The adapter names the envelope in
  // authConfig.tokenResponsePath; the two tests below run the real token services against that answer.
  describe('token answers inside the data envelope', () => {
    const KEY = 'k'.repeat(48);
    const CALLBACK = 'https://cloud.anythingmcp.com/api/mcp-oauth/callback';
    // Built at runtime so no literal looks like a real credential.
    const issued = {
      access_token: ['at', 'a'.repeat(30)].join('-'),
      refresh_token: ['rt', 'n'.repeat(30)].join('-'),
      expires_in: 2592000,
      expiry_time: 1900000000,
    };
    const envelope = (data: unknown) => ({ status: 200, data: { code: 0, message: '', data }, headers: {} });
    // The connector row as an install stores it: the adapter's authConfig, placeholders kept.
    const row = (extra: Record<string, unknown> = {}) => ({
      id: 'conn-joom',
      type: 'REST' as const,
      baseUrl: a.connector.baseUrl,
      authConfig: encrypt(JSON.stringify({ ...a.connector.authConfig, ...extra }), KEY),
      envVars: { JOOM_CLIENT_ID: ENV.JOOM_CLIENT_ID, JOOM_CLIENT_SECRET: ENV.JOOM_CLIENT_SECRET },
      config: {},
      headers: a.connector.headers ?? null,
    });
    let post: jest.SpyInstance;

    beforeEach(() => {
      post = jest.spyOn(axios, 'post');
    });
    afterEach(() => post.mockRestore());

    it('exchanges the authorization code and reads the tokens from the envelope', async () => {
      const oauth = new McpOAuthService();
      const started = await startConnectorAuthorization(
        {
          connectorsService: { updateAuthConfigMerge: jest.fn() },
          mcpOAuthService: oauth,
          logger: { log: jest.fn() },
          encryptionKey: KEY,
          callbackUrl: CALLBACK,
        },
        row() as never,
        { userId: 'u1' },
      );
      if ('error' in started) throw new Error(started.error);

      // Joom's authorize page: the client id, this server's callback, no PKCE.
      const authorize = new URL(started.authorizationUrl);
      expect(`${authorize.origin}${authorize.pathname}`).toBe('https://api-merchant.joom.com/api/v2/oauth/authorize');
      expect(authorize.searchParams.get('client_id')).toBe(ENV.JOOM_CLIENT_ID);
      expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK);
      expect(authorize.searchParams.get('code_challenge')).toBeNull();

      const flow = (await oauth.getPendingFlow(started.state))!.flow;
      expect(flow.tokenResponsePath).toBe('data');

      // What the callback then does with the code.
      post.mockResolvedValueOnce(envelope(issued));
      const tokens = await oauth.exchangeCodeForTokens({
        tokenUrl: flow.tokenUrl,
        code: 'the-code',
        redirectUri: flow.redirectUri,
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        codeVerifier: flow.codeVerifier,
        tokenAuthMethod: flow.tokenAuthMethod,
        tokenResponsePath: flow.tokenResponsePath,
      });

      expect(tokens).toEqual({
        accessToken: issued.access_token,
        refreshToken: issued.refresh_token,
        expiresIn: 2592000,
      });
      const [url, body, config] = post.mock.calls[0];
      expect(url).toBe('https://api-merchant.joom.com/api/v2/oauth/access_token');
      // The five form fields Joom documents for the code exchange, and no PKCE verifier.
      expect(Object.fromEntries(new URLSearchParams(String(body)))).toEqual({
        client_id: ENV.JOOM_CLIENT_ID,
        client_secret: ENV.JOOM_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: 'the-code',
        redirect_uri: CALLBACK,
      });
      expect(config.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(config.headers.Authorization).toBeUndefined();
    });

    it("fails the code exchange with Joom's own code and message when the envelope has no data", async () => {
      post.mockResolvedValueOnce({ status: 200, data: { code: 1000, message: 'Invalid authorization code' }, headers: {} });
      const cfg = interpolateDeep(a.connector.authConfig, ENV) as Record<string, string>;
      await expect(
        new McpOAuthService().exchangeCodeForTokens({
          tokenUrl: cfg.tokenUrl,
          code: 'the-code',
          redirectUri: CALLBACK,
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
          tokenResponsePath: cfg.tokenResponsePath,
        }),
      ).rejects.toThrow(
        'Token exchange failed: the token answer has no object at "data" (authConfig.tokenResponsePath); ' +
          'the provider answered: code 1000: Invalid authorization code',
      );
    });

    it('renews at the refresh endpoint, reads the envelope, stores the new pair and calls the API with it', async () => {
      // The row after a sign-in: an access token that has run out and the refresh token Joom issued.
      const stored = { accessToken: 'expired-token', refreshToken: 'rt-first', expiresAt: Date.now() - 1000 };
      let saved = row(stored).authConfig;
      const prisma = {
        connector: {
          findUnique: jest.fn(async () => ({ authConfig: saved, envVars: row().envVars, headers: null })),
          update: jest.fn(async ({ data }: { data: { authConfig: string } }) => {
            saved = data.authConfig;
            return {};
          }),
        },
      };
      const service = new OAuth2TokenService(prisma as never, { get: jest.fn().mockReturnValue(KEY) } as never);
      post.mockResolvedValueOnce(envelope(issued));
      ok(200, { data: { count: 7 } });

      const { config: cfg, endpointMapping } = interpolateConnectorConfig(
        { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
        tool('joom_count_products').endpointMapping,
        ENV,
      );
      const result = await new RestEngine(service, {} as LoginTokenService).execute(
        {
          baseUrl: cfg.baseUrl,
          authType: a.connector.authType,
          authConfig: { ...interpolateDeep(a.connector.authConfig, ENV), ...stored },
          headers: cfg.headers,
          connectorId: 'conn-joom',
        } as never,
        endpointMapping,
        {},
      );

      // The refresh call: Joom's own refresh endpoint with the four form fields it documents.
      expect(post).toHaveBeenCalledTimes(1);
      const [url, body, config] = post.mock.calls[0];
      expect(url).toBe('https://api-merchant.joom.com/api/v2/oauth/refresh_token');
      expect(Object.fromEntries(new URLSearchParams(String(body)))).toEqual({
        client_id: ENV.JOOM_CLIENT_ID,
        client_secret: ENV.JOOM_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: 'rt-first',
      });
      expect(config.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(config.headers.Authorization).toBeUndefined();

      // The API call carries the token from the envelope.
      expect(sent().url).toBe(`${BASE}/products/multi/count`);
      expect(header(sent(), 'Authorization')).toBe(`Bearer ${issued.access_token}`);
      expect(result).toEqual({ data: { count: 7 } });

      // Stored for the next renewal: the rotated refresh token and the lifetime Joom named.
      const kept = JSON.parse(decrypt(saved, KEY));
      expect(kept).toMatchObject({
        accessToken: issued.access_token,
        refreshToken: issued.refresh_token,
        expiresIn: 2592000,
        tokenResponsePath: 'data',
        refreshUrl: 'https://api-merchant.joom.com/api/v2/oauth/refresh_token',
        clientSecret: '{{JOOM_CLIENT_SECRET}}',
      });
    });
  });

  it('guides the setup in three steps: create the app with the callback URL, paste the keys, authorize', () => {
    const guide = a.setupGuide!;
    expect(guide.effort).toBe('own_app');
    expect(guide.steps.map((step) => step.id)).toEqual(['create-app', 'keys', 'authorize']);
    expect(guide.steps[0].values!.map((v) => v.value)).toContain('{{redirectUri}}');
    expect(guide.steps[1].fields).toEqual(['JOOM_CLIENT_ID', 'JOOM_CLIENT_SECRET']);
    expect(guide.steps[2].fields).toBeUndefined();
  });

  it('probes the product count and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'joom_count_products', params: {} });
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('exposes every tool on the documented method and path, with its required arguments', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(EXPECTED.map(([name]) => name));
    for (const [name, method, path, required] of EXPECTED) {
      const entry = tool(name);
      expect([name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([name, method, path]);
      expect(entry.parameters.required ?? []).toEqual(required);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^joom_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, schema] of Object.entries(entry.parameters.properties ?? {})) expect([param, Boolean(schema.description)]).toEqual([param, true]);
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('marks reads read-only and installs cancellation, online shipping and the delete tools switched off', () => {
    const READS: string[] = ['joom_count_products', 'joom_get_category_requirements', 'joom_get_order', 'joom_get_product', 'joom_get_product_stock', 'joom_list_categories', 'joom_list_fbj_replenishments', 'joom_list_orders', 'joom_list_pickup_addresses', 'joom_list_products', 'joom_list_shippers', 'joom_list_unfulfilled_orders', 'joom_list_warehouses'];
    for (const entry of a.tools) {
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, READS.includes(entry.name)]);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['joom_cancel_order', 'joom_fulfill_orders_online', 'joom_remove_product', 'joom_remove_product_variants']);
    for (const name of off) expect(tool(name).description).toContain('Installed switched off');
  });

  it('names every tool in the instructions and keeps the texts safe for the website', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const texts = [a.description, a.instructions, ...a.tools.flatMap((entry) => [entry.description, ...Object.values(entry.parameters.properties ?? {}).map((p) => p.description ?? '')])];
    for (const text of texts) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/—/);
    }
  });

  it('lists unfulfilled orders with the bearer token and the default page size', async () => {
    ok();
    await call('joom_list_unfulfilled_orders', {});
    const req = sent();
    expect(req.url).toBe(`${BASE}/orders/unfulfilled`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
    expect(req.params).toEqual({ limit: 100 });

    ok();
    await call('joom_list_orders', { updated_from: '2026-11-01T00:00:00Z', after: 'tok1', limit: 500 });
    expect(sent().url).toBe(`${BASE}/orders/multi`);
    expect(sent().params).toEqual({ limit: 500, updatedFrom: '2026-11-01T00:00:00Z', after: 'tok1' });
  });

  it('addresses orders and products through query parameters, by id or by SKU', async () => {
    ok();
    await call('joom_get_order', { order_id: 'ORDER1' });
    expect(sent().url).toBe(`${BASE}/orders`);
    expect(sent().params).toEqual({ id: 'ORDER1' });

    ok();
    await call('joom_get_product', { sku: 'TSHIRT-RED' });
    expect(sent().url).toBe(`${BASE}/products`);
    expect(sent().params).toEqual({ sku: 'TSHIRT-RED' });

    ok();
    await call('joom_count_products', {});
    expect(sent().url).toBe(`${BASE}/products/multi/count`);
  });

  it('builds the fulfil, tracking, cancel, product and stock bodies as Joom documents them', async () => {
    ok();
    await call('joom_fulfill_order', { order_id: 'ORDER1', tracking_number: 'RR123456789CN', provider_id: 'shipper-9' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/orders/fulfill`);
    expect(sent().params).toEqual({ id: 'ORDER1' });
    expect(sent().data).toEqual({ providerId: 'shipper-9', trackingNumber: 'RR123456789CN' });

    ok();
    await call('joom_modify_tracking', { order_id: 'ORDER1', tracking_number: 'RR000', provider: 'China Post' });
    expect(sent().url).toBe(`${BASE}/orders/modifyTracking`);
    expect(sent().data).toEqual({ provider: 'China Post', trackingNumber: 'RR000' });

    ok();
    await call('joom_cancel_order', { order_id: 'ORDER1', reason: 'outOfStock' });
    expect(sent().url).toBe(`${BASE}/orders/cancel`);
    expect(sent().params).toEqual({ id: 'ORDER1' });
    expect(sent().data).toEqual({ reason: 'outOfStock' });

    ok();
    await call('joom_update_product', { sku: 'TSHIRT-RED', variants: [{ sku: 'TSHIRT-RED-M', price: '12.50', inventory: 40 }] });
    expect(sent().url).toBe(`${BASE}/products/update`);
    expect(sent().params).toEqual({ sku: 'TSHIRT-RED' });
    expect(sent().data).toEqual({ variants: [{ sku: 'TSHIRT-RED-M', price: '12.50', inventory: 40 }] });

    ok();
    await call('joom_update_product_stock', { product_id: 'P1', items: [{ variantSku: 'TSHIRT-RED-M', inventory: 3 }] });
    expect(sent().url).toBe(`${BASE}/products/warehouses/update`);
    expect(sent().params).toEqual({ id: 'P1' });
    expect(sent().data).toEqual({ items: [{ variantSku: 'TSHIRT-RED-M', inventory: 3 }] });

    ok();
    await call('joom_fulfill_orders_online', { order_ids: ['ORDER1', 'ORDER2'], pickup: false });
    expect(sent().url).toBe(`${BASE}/orders/fulfillOnline`);
    expect(sent().data).toEqual({ ids: ['ORDER1', 'ORDER2'], pickup: false });
  });
});

// Opt-in: RUN_JOOM_LIVE=1. The refusal check needs no account; the read needs
// JOOM_ACCESS_TOKEN. Nothing is written.
const live = process.env.RUN_JOOM_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('joom: live', () => {
  it('refuses a call without a token', async () => {
    const response = await liveFetch.get(`${BASE}/orders/unfulfilled`, { validateStatus: () => true });
    expect(response.status).toBe(401);
  });

  it('counts the products with an access token', async () => {
    const token = process.env.JOOM_ACCESS_TOKEN;
    if (!token) throw new Error('Set JOOM_ACCESS_TOKEN for the live check');
    const response = await liveFetch.get(`${BASE}/products/multi/count`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(typeof response.data.data.count).toBe('number');
  });
});
