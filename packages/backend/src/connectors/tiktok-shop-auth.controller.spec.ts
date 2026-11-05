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
    await controller.callback(query.state, query.code, query.error, res as any);
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
});
