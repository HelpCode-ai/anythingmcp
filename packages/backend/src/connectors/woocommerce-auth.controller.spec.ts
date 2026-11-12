import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  WOOCOMMERCE_CALLBACK_MAX_BYTES,
  WooCommerceAuthController,
  verifyWooCommerceKey,
  wooCommerceCallbackBodyParser,
  wooCommerceOneClick,
  wooCommerceShopUrl,
  type WooCommerceVerifyDeps,
} from './woocommerce-auth.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { SsrfBlockedError } from '../common/ssrf.util';
import { encrypt } from '../common/crypto/encryption.util';

const KEY = 'test-encryption-key-32-chars!!!!';
const CK = `ck_${'a1'.repeat(20)}`;
const CS = `cs_${'b2'.repeat(20)}`;
const SHOP = 'https://shop.example.com';

describe('WooCommerceAuthController', () => {
  const prevKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = prevKey;
  });

  let env: Record<string, string | undefined>;
  let connector: Record<string, any>;
  let connectorsService: { findById: jest.Mock; findByIdInternal: jest.Mock; update: jest.Mock };
  let mcpServer: { reloadConnectorTools: jest.Mock };
  let flows: McpOAuthService;
  let verify: { assertSafe: jest.Mock; request: jest.Mock };
  let controller: WooCommerceAuthController;
  const owner = { user: { sub: 'user-1', organizationId: 'org-1', role: 'MEMBER' } };

  beforeEach(() => {
    env = {
      ENCRYPTION_KEY: KEY,
      SERVER_URL: 'https://cloud.anythingmcp.com',
      FRONTEND_URL: 'https://cloud.anythingmcp.com',
      WOOCOMMERCE_ONE_CLICK: 'true',
    };
    connector = {
      id: 'conn-1',
      organizationId: 'org-1',
      userId: 'user-1',
      type: 'REST',
      authType: 'QUERY_AUTH',
      baseUrl: `${SHOP}/wp-json/wc/v3`,
      headers: null,
      config: { adapterSlug: 'woocommerce' },
      authConfig: encrypt(
        JSON.stringify({ consumer_key: '{{WOOCOMMERCE_CONSUMER_KEY}}', consumer_secret: '{{WOOCOMMERCE_CONSUMER_SECRET}}' }),
        KEY,
      ),
      envVars: { WOOCOMMERCE_URL: SHOP },
    };
    connectorsService = {
      findById: jest.fn(async () => connector),
      findByIdInternal: jest.fn(async () => connector),
      update: jest.fn(async (_id: string, data: Record<string, unknown>) => ({ ...connector, ...data })),
    };
    mcpServer = { reloadConnectorTools: jest.fn(async () => undefined) };
    flows = new McpOAuthService();
    verify = {
      assertSafe: jest.fn(async () => undefined),
      request: jest.fn(async () => ({ status: 200, data: [{ id: 42 }] })),
    };
    const config = { get: jest.fn((k: string) => env[k]) } as unknown as ConfigService;
    controller = new WooCommerceAuthController(
      connectorsService as any,
      flows,
      mcpServer as any,
      config,
      verify as unknown as WooCommerceVerifyDeps,
    );
  });

  const start = async (scope?: 'read' | 'read_write') => {
    const { authorizationUrl } = await controller.authorize(owner, 'conn-1', { scope });
    const url = new URL(authorizationUrl);
    return { url, state: url.searchParams.get('user_id')! };
  };
  const post = (body: unknown) => controller.callback({ body });
  const wcBody = (state: string, over: Record<string, unknown> = {}) => ({
    key_id: 7,
    user_id: state,
    consumer_key: CK,
    consumer_secret: CS,
    key_permissions: 'read',
    ...over,
  });

  describe('flag off', () => {
    beforeEach(() => {
      env.WOOCOMMERCE_ONE_CLICK = undefined;
    });

    it('answers 404 on authorize, callback and status, and reports it unavailable', async () => {
      await expect(controller.authorize(owner, 'conn-1', {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(post(wcBody('0'.repeat(32)))).rejects.toBeInstanceOf(NotFoundException);
      await expect(controller.oneClickStatus(owner, 'conn-1', '0'.repeat(32))).rejects.toBeInstanceOf(NotFoundException);
      expect(controller.oneClick()).toEqual({ available: false });
      expect(connectorsService.findById).not.toHaveBeenCalled();
    });

    it('stays off for any value but "true"', async () => {
      env.WOOCOMMERCE_ONE_CLICK = '1';
      await expect(controller.authorize(owner, 'conn-1', {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(post(wcBody('0'.repeat(32)))).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('is not offered when SERVER_URL is not a public https address', async () => {
    for (const server of ['http://cloud.anythingmcp.com', 'https://localhost:4000', 'https://192.168.1.5', 'http://backend:4000']) {
      env.SERVER_URL = server;
      expect(controller.oneClick()).toEqual({ available: false });
      await expect(controller.authorize(owner, 'conn-1', {})).rejects.toBeInstanceOf(NotFoundException);
    }
    env.SERVER_URL = 'https://amcp.example.org';
    expect(controller.oneClick()).toEqual({ available: true });
  });

  describe('authorize', () => {
    it('requires a dashboard session; the callback does not', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, WooCommerceAuthController.prototype.authorize)).toHaveLength(1);
      expect(Reflect.getMetadata(GUARDS_METADATA, WooCommerceAuthController.prototype.oneClickStatus)).toHaveLength(1);
      expect(Reflect.getMetadata(GUARDS_METADATA, WooCommerceAuthController.prototype.oneClick)).toHaveLength(1);
      expect(Reflect.getMetadata(GUARDS_METADATA, WooCommerceAuthController.prototype.callback)).toBeUndefined();
    });

    it('returns the shop authorize link and stores a single-use attempt for this connector and workspace', async () => {
      const { url, state } = await start();
      expect(url.origin + url.pathname).toBe(`${SHOP}/wc-auth/v1/authorize`);
      expect(url.searchParams.get('app_name')).toBe('AnythingMCP');
      expect(url.searchParams.get('scope')).toBe('read');
      expect(state).toMatch(/^[a-f0-9]{32}$/);
      expect(url.searchParams.get('callback_url')).toBe('https://cloud.anythingmcp.com/api/woocommerce/callback');
      const back = new URL(url.searchParams.get('return_url')!);
      expect(back.pathname).toBe('/connectors/setup/woocommerce');
      expect(back.searchParams.get('connector')).toBe('conn-1');
      expect(back.searchParams.get('wc')).toBe('done');
      expect((await flows.getPendingFlow(state))?.flow).toMatchObject({
        provider: 'woocommerce',
        connectorId: 'conn-1',
        userId: 'user-1',
        woocommerce: { organizationId: 'org-1', shopUrl: SHOP, scope: 'read' },
      });
    });

    it('asks for read and write when chosen, and keeps the assistant to return to', async () => {
      const { authorizationUrl } = await controller.authorize(owner, 'conn-1', { scope: 'read_write', from: 'claude' });
      const url = new URL(authorizationUrl);
      expect(url.searchParams.get('scope')).toBe('read_write');
      expect(new URL(url.searchParams.get('return_url')!).searchParams.get('from')).toBe('claude');
    });

    it('refuses another workspace, a viewer and a member who does not own the connector', async () => {
      await expect(
        controller.authorize({ user: { sub: 'user-1', organizationId: 'org-2', role: 'ADMIN' } }, 'conn-1', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.authorize({ user: { sub: 'user-1', organizationId: 'org-1', role: 'VIEWER' } }, 'conn-1', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.authorize({ user: { sub: 'user-9', organizationId: 'org-1', role: 'MEMBER' } }, 'conn-1', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.authorize({ user: { sub: 'user-9', organizationId: 'org-1', role: 'ADMIN' } }, 'conn-1', {}),
      ).resolves.toHaveProperty('authorizationUrl');
    });

    it('refuses a connector that is not WooCommerce or has no usable shop address', async () => {
      connector.config = { adapterSlug: 'shopify' };
      await expect(controller.authorize(owner, 'conn-1', {})).rejects.toBeInstanceOf(BadRequestException);
      connector.config = { adapterSlug: 'woocommerce' };
      for (const bad of [undefined, 'http://shop.example.com', 'https://shop.example.com/wp-json', 'https://localhost']) {
        connector.envVars = { WOOCOMMERCE_URL: bad };
        await expect(controller.authorize(owner, 'conn-1', {})).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('tells a missing shop address apart from one that is not public', async () => {
      connector.envVars = {};
      await expect(controller.authorize(owner, 'conn-1', {})).rejects.toThrow(/Save the shop's https:\/\/ address first/);
      for (const local of ['https://localhost:8443', 'https://192.168.1.20', 'https://shop.local']) {
        connector.envVars = { WOOCOMMERCE_URL: local };
        await expect(controller.authorize(owner, 'conn-1', {})).rejects.toThrow(/public https:\/\/ address/);
      }
    });
  });

  describe('callback', () => {
    it('checks the key on the stored shop, then writes it through the env-var path for that connector only', async () => {
      const { state } = await start();
      await expect(post(wcBody(state))).resolves.toEqual({ ok: true });
      await controller.whenIdle();

      expect(verify.assertSafe).toHaveBeenCalledWith(`${SHOP}/wp-json/wc/v3/orders`);
      const [config, options] = verify.request.mock.calls[0];
      expect(config).toMatchObject({
        method: 'GET',
        url: `${SHOP}/wp-json/wc/v3/orders`,
        params: { per_page: 1, _fields: 'id', consumer_key: CK, consumer_secret: CS },
        maxRedirects: 0,
      });
      expect(options).toEqual({ maxRedirects: 0 });

      expect(connectorsService.update).toHaveBeenCalledTimes(1);
      const [id, data] = connectorsService.update.mock.calls[0];
      expect(id).toBe('conn-1');
      expect(data.envVars).toEqual({
        WOOCOMMERCE_URL: SHOP,
        WOOCOMMERCE_CONSUMER_KEY: CK,
        WOOCOMMERCE_CONSUMER_SECRET: CS,
      });
      // The catalog credentials are rebuilt from the new variables.
      expect(data.authConfig).toMatchObject({ consumer_key: CK, consumer_secret: CS });
      expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('conn-1');
      await expect(controller.oneClickStatus(owner, 'conn-1', state)).resolves.toEqual({ status: 'ready' });
    });

    it('is single use', async () => {
      const { state } = await start();
      await post(wcBody(state));
      await expect(post(wcBody(state))).rejects.toBeInstanceOf(GoneException);
      await controller.whenIdle();
      expect(connectorsService.update).toHaveBeenCalledTimes(1);
    });

    it('refuses an expired attempt', async () => {
      const { state } = await start();
      const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
      try {
        await expect(post(wcBody(state))).rejects.toBeInstanceOf(GoneException);
      } finally {
        now.mockRestore();
      }
      await controller.whenIdle();
      expect(verify.request).not.toHaveBeenCalled();
      expect(connectorsService.update).not.toHaveBeenCalled();
    });

    it('refuses an unknown state and a body that is not a WooCommerce callback', async () => {
      await expect(post(wcBody('f'.repeat(32)))).rejects.toBeInstanceOf(GoneException);
      await expect(post({ user_id: 'nope', consumer_key: CK, consumer_secret: CS })).rejects.toBeInstanceOf(BadRequestException);
      await expect(post(undefined)).rejects.toBeInstanceOf(BadRequestException);
      expect(connectorsService.update).not.toHaveBeenCalled();
    });

    it('ignores fields it does not know', async () => {
      const { state } = await start();
      await expect(post(wcBody(state, { something_new: true }))).resolves.toEqual({ ok: true });
    });

    it.each([
      ['a key without ck_', { consumer_key: `xx_${'a1'.repeat(20)}` }],
      ['a short secret', { consumer_secret: 'cs_123' }],
      ['key and secret swapped', { consumer_key: CS, consumer_secret: CK }],
      ['upper-case hex', { consumer_key: `ck_${'A1'.repeat(20)}` }],
    ])('refuses %s without trying or writing it', async (_label, over) => {
      const { state } = await start();
      await expect(post(wcBody(state, over))).rejects.toBeInstanceOf(BadRequestException);
      await controller.whenIdle();
      expect(verify.request).not.toHaveBeenCalled();
      expect(connectorsService.update).not.toHaveBeenCalled();
      await expect(controller.oneClickStatus(owner, 'conn-1', state)).resolves.toMatchObject({ status: 'failed' });
    });

    it('writes nothing when the shop does not accept the key, and says why', async () => {
      verify.request.mockResolvedValueOnce({ status: 401, data: { code: 'woocommerce_rest_cannot_view' } });
      const { state } = await start();
      await expect(post(wcBody(state))).resolves.toEqual({ ok: true });
      await controller.whenIdle();
      expect(connectorsService.update).not.toHaveBeenCalled();
      expect(mcpServer.reloadConnectorTools).not.toHaveBeenCalled();
      const status = await controller.oneClickStatus(owner, 'conn-1', state);
      expect(status).toMatchObject({ status: 'failed' });
      expect((status as { message: string }).message).toMatch(/administrator or shop manager/);
    });

    it('writes nothing when the shop address is refused by the SSRF guard', async () => {
      verify.assertSafe.mockRejectedValueOnce(new SsrfBlockedError('blocked'));
      const { state } = await start();
      await post(wcBody(state));
      await controller.whenIdle();
      expect(verify.request).not.toHaveBeenCalled();
      expect(connectorsService.update).not.toHaveBeenCalled();
    });

    it('writes nothing when the connector moved to another workspace or changed shop meanwhile', async () => {
      const first = await start();
      connector.organizationId = 'org-2';
      await post(wcBody(first.state));
      await controller.whenIdle();
      connector.organizationId = 'org-1';
      const second = await start();
      connector.envVars = { WOOCOMMERCE_URL: 'https://other-shop.example.com' };
      await post(wcBody(second.state));
      await controller.whenIdle();
      expect(connectorsService.update).not.toHaveBeenCalled();
    });

    it('writes to the connector of the attempt, whatever else is posted', async () => {
      const { state } = await start();
      await post(wcBody(state, { connectorId: 'conn-other', organizationId: 'org-2' }));
      await controller.whenIdle();
      expect(connectorsService.findByIdInternal).toHaveBeenCalledWith('conn-1');
      expect(connectorsService.update.mock.calls.map((c) => c[0])).toEqual(['conn-1']);
    });

    it('never logs the key or the secret', async () => {
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      );
      try {
        const ok = await start();
        await post(wcBody(ok.state));
        verify.request.mockResolvedValueOnce({ status: 500, data: { message: `boom ${CK} ${CS}` } });
        const failed = await start();
        await post(wcBody(failed.state));
        connectorsService.update.mockRejectedValueOnce(new Error(`db said ${CK} ${CS}`));
        const broken = await start();
        await post(wcBody(broken.state));
        const bad = await start();
        await post(wcBody(bad.state, { consumer_secret: `${CS}x` })).catch(() => undefined);
        await controller.whenIdle();
        const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
        expect(spies.some((s) => s.mock.calls.length > 0)).toBe(true);
        expect(logged).not.toContain(CK);
        expect(logged).not.toContain(CS);
        expect(logged).not.toContain(CK.slice(3, 20));
        expect(logged).not.toContain(CS.slice(3, 20));
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });
  });

  describe('one-click status', () => {
    it('is pending until the shop posts, and unknown for another user or a bad state', async () => {
      const { state } = await start();
      await expect(controller.oneClickStatus(owner, 'conn-1', state)).resolves.toEqual({ status: 'pending' });
      await expect(
        controller.oneClickStatus({ user: { sub: 'user-2', organizationId: 'org-1', role: 'ADMIN' } }, 'conn-1', state),
      ).resolves.toEqual({ status: 'unknown' });
      await expect(controller.oneClickStatus(owner, 'conn-1', 'not-a-state')).resolves.toEqual({ status: 'unknown' });
      await expect(
        controller.oneClickStatus({ user: { sub: 'user-1', organizationId: 'org-2', role: 'ADMIN' } }, 'conn-1', state),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

describe('wooCommerceCallbackBodyParser', () => {
  let server: import('node:http').Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use('/cb', wooCommerceCallbackBodyParser());
    app.post('/cb', (req, res) => {
      res.json({ got: Object.keys(req.body ?? {}).length });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('parses a WooCommerce-sized JSON body, whatever its content type', async () => {
    const res = await fetch(`${base}/cb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ user_id: 'x', consumer_key: CK, consumer_secret: CS }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: 3 });
  });

  it(`refuses a body over ${WOOCOMMERCE_CALLBACK_MAX_BYTES} bytes with 413`, async () => {
    const res = await fetch(`${base}/cb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(WOOCOMMERCE_CALLBACK_MAX_BYTES) }),
    });
    expect(res.status).toBe(413);
  });
});

describe('wooCommerceShopUrl', () => {
  it.each([
    ['https://shop.example.com', 'https://shop.example.com'],
    ['  https://shop.example.com/  ', 'https://shop.example.com'],
    ['https://example.com/shop', 'https://example.com/shop'],
    ['https://Shop.Example.com/store//', 'https://shop.example.com/store'],
  ])('keeps %s as %s', (raw, want) => {
    expect(wooCommerceShopUrl(raw)).toBe(want);
  });

  it.each([
    'http://shop.example.com',
    'https://shop.example.com/wp-json',
    'https://shop.example.com/wp-admin/x',
    'https://shop.example.com/?a=1',
    'https://user:pw@shop.example.com',
    'https://10.0.0.5',
    'https://localhost',
    'shop.example.com',
    '',
    42,
  ])('refuses %p', (raw) => {
    expect(wooCommerceShopUrl(raw)).toBeNull();
  });
});

describe('wooCommerceOneClick', () => {
  const of = (env: Record<string, string>) => wooCommerceOneClick({ get: (k: string) => env[k] });
  it('is off by default', () => {
    expect(of({ SERVER_URL: 'https://cloud.anythingmcp.com' })).toEqual({ enabled: false, available: false });
  });
  it('is available only with the flag and a public https server', () => {
    expect(of({ WOOCOMMERCE_ONE_CLICK: 'true', SERVER_URL: 'https://cloud.anythingmcp.com' })).toEqual({
      enabled: true,
      available: true,
    });
    expect(of({ WOOCOMMERCE_ONE_CLICK: 'TRUE ', SERVER_URL: 'http://localhost:4000' })).toEqual({
      enabled: true,
      available: false,
    });
  });
});

describe('verifyWooCommerceKey', () => {
  const deps = (request: jest.Mock): WooCommerceVerifyDeps => ({
    assertSafe: jest.fn(async () => undefined),
    request: request as unknown as WooCommerceVerifyDeps['request'],
  });

  it('accepts a list of orders', async () => {
    await expect(verifyWooCommerceKey(SHOP, CK, CS, deps(jest.fn(async () => ({ status: 200, data: [] }))))).resolves.toEqual({
      ok: true,
    });
  });

  it.each([
    [{ status: 200, data: '<html>' }, 'unexpected'],
    [{ status: 301, data: '' }, 'unexpected'],
    [{ status: 401, data: { code: 'woocommerce_rest_authentication_error' } }, 'auth_failed'],
    [{ status: 403, data: 'Forbidden' }, 'auth_failed'],
    [{ status: 404, data: { code: 'rest_no_route' } }, 'not_found'],
    [{ status: 502, data: '' }, 'upstream_error'],
  ])('maps %p to %s', async (res, kind) => {
    const out = await verifyWooCommerceKey(SHOP, CK, CS, deps(jest.fn(async () => res)));
    expect(out).toMatchObject({ ok: false, kind });
  });

  it('maps network errors without quoting the key', async () => {
    const err = Object.assign(new Error(`getaddrinfo ENOTFOUND shop.example.com ${CK}`), { code: 'ENOTFOUND' });
    const out = await verifyWooCommerceKey(SHOP, CK, CS, deps(jest.fn(async () => Promise.reject(err))));
    expect(out).toMatchObject({ ok: false, kind: 'unreachable' });
    expect(JSON.stringify(out)).not.toContain(CK);
  });

  it('reports a connect-time SSRF refusal as blocked', async () => {
    const out = await verifyWooCommerceKey(SHOP, CK, CS, deps(jest.fn(async () => Promise.reject(new SsrfBlockedError('x')))));
    expect(out).toMatchObject({ ok: false, kind: 'blocked' });
  });
});

