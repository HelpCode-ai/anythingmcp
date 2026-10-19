import { BadRequestException, ForbiddenException, GoneException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShopeeAuthController } from './shopee-auth.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { encrypt } from '../common/crypto/encryption.util';
import { shopeeBaseString, shopeeSign } from './engines/shopee-token.service';

const KEY = 'test-encryption-key-32-chars!!!!';

describe('ShopeeAuthController', () => {
  const prevKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = prevKey;
  });

  const authConfig = {
    tokenProvider: 'shopee',
    partnerId: '{{SHOPEE_PARTNER_ID}}',
    signature: { secret: '{{SHOPEE_PARTNER_KEY}}', queryParams: { partner_id: '{{SHOPEE_PARTNER_ID}}' } },
  };
  let connector: Record<string, any>;
  let connectorsService: { findById: jest.Mock; findByIdInternal: jest.Mock };
  let tokens: { exchangeCode: jest.Mock };
  let mcpServer: { reloadConnectorTools: jest.Mock };
  let flows: McpOAuthService;
  let controller: ShopeeAuthController;
  const admin = { user: { sub: 'user-1', organizationId: 'org-1', role: 'ADMIN' } };

  beforeEach(() => {
    connector = {
      id: 'conn-1',
      organizationId: 'org-1',
      userId: 'user-1',
      authType: 'HMAC',
      baseUrl: '{{SHOPEE_HOST}}',
      authConfig: encrypt(JSON.stringify(authConfig), KEY),
      envVars: { SHOPEE_HOST: 'https://partner.shopeemobile.com', SHOPEE_PARTNER_ID: '2001887', SHOPEE_PARTNER_KEY: 'pk-test-0001' },
    };
    connectorsService = {
      findById: jest.fn(async () => connector),
      findByIdInternal: jest.fn(async () => connector),
    };
    tokens = { exchangeCode: jest.fn(async () => undefined) };
    mcpServer = { reloadConnectorTools: jest.fn(async () => undefined) };
    flows = new McpOAuthService();
    const config = {
      get: jest.fn((k: string) =>
        ({ ENCRYPTION_KEY: KEY, SERVER_URL: 'https://cloud.anythingmcp.com', FRONTEND_URL: 'https://app.test' })[k],
      ),
    } as unknown as ConfigService;
    controller = new ShopeeAuthController(connectorsService as any, flows, tokens as any, mcpServer as any, config);
  });

  const redirectOf = async (state: string, query: Record<string, unknown>) => {
    const res = { redirect: jest.fn() };
    await controller.callback(state, query.code, query.shop_id, query.main_account_id, res as any);
    return new URL(res.redirect.mock.calls[0][0]);
  };

  it('returns the signed auth_partner link, with the attempt state in the redirect path', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1655714431000);
    let out: { authorizationUrl?: string };
    let stored: unknown;
    try {
      out = await controller.authorize(admin, 'conn-1');
      const state = new URL(new URL(out.authorizationUrl!).searchParams.get('redirect')!).pathname.split('/').pop()!;
      stored = (await flows.getPendingFlow(state))?.flow;
    } finally {
      now.mockRestore();
    }
    expect(stored).toMatchObject({ provider: 'shopee', connectorId: 'conn-1', userId: 'user-1' });
    const url = new URL(out!.authorizationUrl!);
    expect(url.origin + url.pathname).toBe('https://partner.shopeemobile.com/api/v2/shop/auth_partner');
    expect(url.searchParams.get('partner_id')).toBe('2001887');
    expect(url.searchParams.get('timestamp')).toBe('1655714431');
    expect(url.searchParams.get('sign')).toBe(
      shopeeSign('pk-test-0001', shopeeBaseString({ partnerId: '2001887', path: '/api/v2/shop/auth_partner', timestamp: 1655714431 })),
    );
    const redirect = url.searchParams.get('redirect')!;
    expect(redirect).toMatch(/^https:\/\/cloud\.anythingmcp\.com\/api\/shopee\/callback\/[0-9a-f]{32}$/);
    expect(out!.authorizationUrl).not.toContain('pk-test-0001');
  });

  it('only lets the owner or an admin of the workspace start it, and asks for the keys first', async () => {
    await expect(controller.authorize({ user: { ...admin.user, organizationId: 'org-2' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.authorize({ user: { ...admin.user, role: 'VIEWER' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.authorize({ user: { sub: 'user-2', organizationId: 'org-1', role: 'EDITOR' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    connector.envVars = { SHOPEE_HOST: 'https://partner.shopeemobile.com' };
    expect(await controller.authorize(admin, 'conn-1')).toEqual({ error: expect.stringContaining('SHOPEE_PARTNER_KEY') });
    connector.authType = 'API_KEY';
    expect(await controller.authorize(admin, 'conn-1')).toEqual({ error: 'This connector does not authorize a Shopee shop.' });
  });

  it("forwards Shopee's redirect to the dashboard, and refuses unknown states and main accounts", async () => {
    const out = await controller.authorize(admin, 'conn-1');
    const state = new URL(new URL(out.authorizationUrl!).searchParams.get('redirect')!).pathname.split('/').pop()!;

    const ok = await redirectOf(state, { code: 'c-1', shop_id: '14701711' });
    expect(ok.origin + ok.pathname).toBe('https://app.test/connectors/oauth/complete');
    expect(Object.fromEntries(ok.searchParams)).toEqual({ provider: 'shopee', state, code: 'c-1', shop_id: '14701711' });
    // Peeked, not taken: the dashboard completes it.
    expect(await flows.getPendingFlow(state)).toBeDefined();

    const unknown = await redirectOf('nope', { code: 'c', shop_id: '1' });
    expect(unknown.searchParams.get('error')).toMatch(/expired or was already used/);

    const main = await redirectOf(state, { code: 'c', main_account_id: '9' });
    expect(main.searchParams.get('error')).toMatch(/main \(merchant\) account/);
    expect(await flows.getPendingFlow(state)).toBeUndefined();
  });

  it('completes only for the user who started it, then stores the tokens and reloads the tools', async () => {
    const start = async () => {
      const out = await controller.authorize(admin, 'conn-1', { returnTo: '/connectors/conn-1' });
      return new URL(new URL(out.authorizationUrl!).searchParams.get('redirect')!).pathname.split('/').pop()!;
    };
    const s1 = await start();
    await expect(
      controller.complete({ user: { sub: 'user-2' } }, { state: s1, code: 'c', shopId: '14701711' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tokens.exchangeCode).not.toHaveBeenCalled();
    // Another user's refusal does not burn the owner's authorization.
    expect(await flows.getPendingFlow(s1)).toBeDefined();
    await controller.complete(admin, { state: s1, code: 'c-1', shopId: '14701711' });
    // Single use: the same state cannot complete twice.
    await expect(controller.complete(admin, { state: s1, code: 'c-1', shopId: '14701711' })).rejects.toBeInstanceOf(GoneException);
    (tokens.exchangeCode as jest.Mock).mockClear();
    (mcpServer.reloadConnectorTools as jest.Mock).mockClear();

    const s2 = await start();
    expect(await controller.complete(admin, { state: s2, code: 'c-2', shopId: '14701711' })).toEqual({
      connectorId: 'conn-1',
      toolsImported: 0,
      returnTo: '/connectors/conn-1',
    });
    expect(tokens.exchangeCode).toHaveBeenCalledWith({
      connectorId: 'conn-1',
      app: { host: 'https://partner.shopeemobile.com', partnerId: '2001887', partnerKey: 'pk-test-0001' },
      code: 'c-2',
      shopId: '14701711',
    });
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('conn-1');
  });

  it("a generic OAuth flow's state is not accepted here", async () => {
    await flows.storePendingFlow('generic', {
      connectorId: 'conn-1',
      userId: 'user-1',
      redirectUri: 'x',
      clientId: 'c',
      tokenUrl: 'https://t',
      createdAt: Date.now(),
    });
    await expect(controller.complete(admin, { state: 'generic', code: 'c', shopId: '1' })).rejects.toBeInstanceOf(GoneException);
    expect((await redirectOf('generic', { code: 'c', shop_id: '1' })).searchParams.get('error')).toBeTruthy();
  });

  it("says what Shopee refused when the code exchange fails", async () => {
    const out = await controller.authorize(admin, 'conn-1');
    const state = new URL(new URL(out.authorizationUrl!).searchParams.get('redirect')!).pathname.split('/').pop()!;
    tokens.exchangeCode.mockRejectedValueOnce({ response: { status: 200, data: { error: 'invalid_code', message: 'Invalid code.' } } });
    const err = await controller.complete(admin, { state, code: 'c', shopId: '1' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ connectorId: 'conn-1', message: expect.stringContaining('invalid_code') });
  });
});
