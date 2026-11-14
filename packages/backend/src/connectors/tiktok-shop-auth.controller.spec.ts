import { BadRequestException, ForbiddenException, GoneException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TikTokShopAuthController } from './tiktok-shop-auth.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { encrypt } from '../common/crypto/encryption.util';
import { getAdapter } from '../adapters/catalog';

const KEY = 'test-encryption-key-32-chars!!!!';

describe('TikTokShopAuthController', () => {
  const prevKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = prevKey;
  });

  // The catalog adapter's own authConfig, placeholders and all, as installed.
  const authConfig = getAdapter('tiktok-shop')!.connector.authConfig as Record<string, unknown>;
  let connector: Record<string, any>;
  let connectorsService: { findById: jest.Mock; findByIdInternal: jest.Mock };
  let tokens: { exchangeCode: jest.Mock };
  let mcpServer: { reloadConnectorTools: jest.Mock };
  let flows: McpOAuthService;
  let controller: TikTokShopAuthController;
  const admin = { user: { sub: 'user-1', organizationId: 'org-1', role: 'ADMIN' } };

  beforeEach(() => {
    connector = {
      id: 'conn-1',
      organizationId: 'org-1',
      userId: 'user-1',
      authType: 'HMAC',
      baseUrl: 'https://open-api.tiktokglobalshop.com',
      authConfig: encrypt(JSON.stringify(authConfig), KEY),
      envVars: { TIKTOK_SHOP_APP_KEY: '38abcd', TIKTOK_SHOP_APP_SECRET: 'testappsecret1234567890', TIKTOK_SHOP_SERVICE_ID: '7256213' },
    };
    connectorsService = {
      findById: jest.fn(async () => connector),
      findByIdInternal: jest.fn(async () => connector),
    };
    tokens = { exchangeCode: jest.fn(async () => ({ shopName: 'Maomao', shopCount: 1 })) };
    mcpServer = { reloadConnectorTools: jest.fn(async () => undefined) };
    flows = new McpOAuthService();
    const config = {
      get: jest.fn((k: string) =>
        ({ ENCRYPTION_KEY: KEY, SERVER_URL: 'https://cloud.anythingmcp.com', FRONTEND_URL: 'https://app.test' })[k],
      ),
    } as unknown as ConfigService;
    controller = new TikTokShopAuthController(connectorsService as any, flows, tokens as any, mcpServer as any, config);
  });

  const redirectOf = async (query: Record<string, unknown>) => {
    const res = { redirect: jest.fn() };
    await controller.callback(query.state, query.code, query.error, res as any, query.app_key, query.shop_region);
    return new URL(res.redirect.mock.calls[0][0]);
  };

  it('returns the service_id link with a stored single-use state, and the Redirect URL to set', async () => {
    const out = await controller.authorize(admin, 'conn-1');
    const url = new URL(out.authorizationUrl!);
    expect(url.origin + url.pathname).toBe('https://services.tiktokshop.com/open/authorize');
    expect(url.searchParams.get('service_id')).toBe('7256213');
    const state = url.searchParams.get('state')!;
    expect((await flows.getPendingFlow(state))?.flow).toMatchObject({ provider: 'tiktok-shop', connectorId: 'conn-1', userId: 'user-1' });
    expect(out.redirectUrl).toBe('https://cloud.anythingmcp.com/api/tiktok-shop/callback');
    expect(out.authorizationUrl).not.toContain('testappsecret');
  });

  it('sends a US shop to the US authorization domain', async () => {
    connector.envVars.TIKTOK_SHOP_MARKET = 'US';
    const out = await controller.authorize(admin, 'conn-1');
    expect(new URL(out.authorizationUrl!).origin).toBe('https://services.us.tiktokshop.com');
  });

  it('asks for the Service ID before starting', async () => {
    delete connector.envVars.TIKTOK_SHOP_SERVICE_ID;
    expect(await controller.authorize(admin, 'conn-1')).toEqual({ error: expect.stringMatching(/TIKTOK_SHOP_SERVICE_ID/) });
  });

  it('refuses a viewer and another organization', async () => {
    await expect(controller.authorize({ user: { ...admin.user, role: 'VIEWER' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.authorize({ user: { ...admin.user, organizationId: 'org-2' } }, 'conn-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('forwards the code to the dashboard and reports a declined authorization', async () => {
    const out = await controller.authorize(admin, 'conn-1');
    const state = new URL(out.authorizationUrl!).searchParams.get('state')!;
    const ok = await redirectOf({ state, code: 'TTP_code' });
    expect(ok.origin + ok.pathname).toBe('https://app.test/connectors/oauth/complete');
    expect(Object.fromEntries(ok.searchParams)).toEqual({ provider: 'tiktok-shop', state, code: 'TTP_code' });

    const declined = await redirectOf({ state, code: 'null', error: 'auth_denied' });
    expect(declined.searchParams.get('error')).toMatch(/declined/);
    expect(declined.searchParams.get('connectorId')).toBe('conn-1');

    const unknown = await redirectOf({ state: 'nope', code: 'x' });
    expect(unknown.searchParams.get('error')).toMatch(/expired or was already used/);
  });

  it('completes only for the user who started, once, with the preferred shop', async () => {
    connector.envVars.TIKTOK_SHOP_SHOP_ID = 'GBX';
    const out = await controller.authorize(admin, 'conn-1');
    const state = new URL(out.authorizationUrl!).searchParams.get('state')!;
    await expect(
      controller.complete({ user: { sub: 'user-2', organizationId: 'org-1', role: 'ADMIN' } }, { state, code: 'c' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(await controller.complete(admin, { state, code: 'TTP_code' })).toEqual({ connectorId: 'conn-1', toolsImported: 0 });
    expect(tokens.exchangeCode).toHaveBeenCalledWith({
      connectorId: 'conn-1',
      app: { appKey: '38abcd', appSecret: 'testappsecret1234567890', serviceId: '7256213', apiHost: 'https://open-api.tiktokglobalshop.com' },
      code: 'TTP_code',
      preferredShop: 'GBX',
    });
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('conn-1');
    await expect(controller.complete(admin, { state, code: 'TTP_code' })).rejects.toBeInstanceOf(GoneException);
  });

  it("says what to check when TikTok refuses the code", async () => {
    tokens.exchangeCode.mockRejectedValueOnce({ response: { status: 200, data: { code: 36004004, message: 'Invalid auth code.' } } });
    const out = await controller.authorize(admin, 'conn-1');
    const state = new URL(out.authorizationUrl!).searchParams.get('state')!;
    const err = await controller.complete(admin, { state, code: 'used' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ connectorId: 'conn-1', message: expect.stringMatching(/code 36004004.*30 minutes/) });
  });

  describe('with a server app', () => {
    const PLATFORM_VARS = {
      TIKTOK_SHOP_PLATFORM_APP_KEY: '6abcplatform',
      TIKTOK_SHOP_PLATFORM_APP_SECRET: 'platformsecret0987654321',
      TIKTOK_SHOP_PLATFORM_SERVICE_ID: '7000001',
    };
    const saved: Record<string, string | undefined> = {};
    const setServerApp = (on: boolean) => {
      for (const [k, v] of Object.entries(PLATFORM_VARS)) {
        if (on) process.env[k] = v;
        else delete process.env[k];
      }
    };
    beforeEach(() => {
      for (const k of Object.keys(PLATFORM_VARS)) saved[k] = process.env[k];
      setServerApp(true);
    });
    afterEach(() => {
      for (const k of Object.keys(PLATFORM_VARS)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
    const blank = { TIKTOK_SHOP_APP_KEY: '', TIKTOK_SHOP_APP_SECRET: '', TIKTOK_SHOP_SERVICE_ID: '' };

    it('says whether the server has its own app', () => {
      expect(controller.platform()).toEqual({ available: true, redirectUrl: 'https://cloud.anythingmcp.com/api/tiktok-shop/callback' });
      setServerApp(false);
      expect(controller.platform().available).toBe(false);
    });

    it('authorizes a connector without an App key with the server app, and completes with it', async () => {
      connector.envVars = { ...blank };
      const out = await controller.authorize(admin, 'conn-1');
      const url = new URL(out.authorizationUrl!);
      expect(url.searchParams.get('service_id')).toBe('7000001');
      const state = url.searchParams.get('state')!;
      expect((await flows.getPendingFlow(state))?.flow.clientId).toBe('6abcplatform');
      expect(JSON.stringify(out)).not.toContain('platformsecret');

      await controller.complete(admin, { state, code: 'TTP_code' });
      expect(tokens.exchangeCode).toHaveBeenCalledWith(
        expect.objectContaining({
          connectorId: 'conn-1',
          app: { appKey: '6abcplatform', appSecret: 'platformsecret0987654321', serviceId: '7000001', apiHost: 'https://open-api.tiktokglobalshop.com' },
        }),
      );
    });

    it('keeps a connector with its own App key on its own app', async () => {
      const out = await controller.authorize(admin, 'conn-1');
      expect(new URL(out.authorizationUrl!).searchParams.get('service_id')).toBe('7256213');
    });

    it('still asks for the app keys of a connector without them on a server without its own app', async () => {
      setServerApp(false);
      connector.envVars = { ...blank };
      expect(await controller.authorize(admin, 'conn-1')).toEqual({ error: expect.stringMatching(/Set TIKTOK_SHOP_APP_KEY/) });
    });

    it('keeps a store install without a state as a single-use record, with the code kept server-side', async () => {
      const ok = await redirectOf({ code: 'TTP_store', app_key: '6abcplatform', shop_region: 'gb' });
      expect(ok.origin + ok.pathname).toBe('https://app.test/connectors/oauth/complete');
      expect(ok.searchParams.get('provider')).toBe('tiktok-shop-install');
      expect(ok.searchParams.get('code')).toBeNull();
      expect(ok.toString()).not.toContain('TTP_store');
      const pending = await flows.getPendingFlow(ok.searchParams.get('state')!);
      expect(pending?.flow).toMatchObject({
        provider: 'tiktok-shop-install',
        code: 'TTP_store',
        shopRegion: 'GB',
        connectorId: '',
        userId: '',
        clientId: '6abcplatform',
      });
      // Not a connector authorization: complete refuses it.
      await expect(controller.complete(admin, { state: ok.searchParams.get('state')!, code: 'x' })).rejects.toBeInstanceOf(
        GoneException,
      );
    });

    it("refuses a store install that names another app's key, or reaches a server without its own app", async () => {
      const store = jest.spyOn(flows, 'storePendingFlow');
      const wrong = await redirectOf({ code: 'TTP_store', app_key: 'someoneelse' });
      expect(wrong.searchParams.get('error')).toMatch(/expired or was already used/);
      setServerApp(false);
      const none = await redirectOf({ code: 'TTP_store', app_key: '6abcplatform' });
      expect(none.searchParams.get('error')).toMatch(/expired or was already used/);
      expect(store).not.toHaveBeenCalled();
    });
  });
});
