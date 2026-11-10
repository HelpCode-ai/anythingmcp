import { BadGatewayException, BadRequestException, ForbiddenException, GoneException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaAuthController } from './meta-auth.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { MetaLoginError } from './engines/meta-login.service';
import { decrypt, encrypt } from '../common/crypto/encryption.util';

const KEY = 'test-encryption-key-32-chars!!!!';
const ACCOUNT_A = { id: '17841400000000001', username: 'shop_a', pageName: 'Shop A' };
const ACCOUNT_B = { id: '17841400000000002', username: 'shop_b', pageName: 'Shop B' };

describe('MetaAuthController', () => {
  const prev = {
    key: process.env.ENCRYPTION_KEY,
    fbId: process.env.META_PLATFORM_APP_ID,
    fbSecret: process.env.META_PLATFORM_APP_SECRET,
    fbConfig: process.env.META_PLATFORM_CONFIG_ID,
    igId: process.env.INSTAGRAM_PLATFORM_APP_ID,
    igSecret: process.env.INSTAGRAM_PLATFORM_APP_SECRET,
  };
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('ENCRYPTION_KEY', prev.key);
    restore('META_PLATFORM_APP_ID', prev.fbId);
    restore('META_PLATFORM_APP_SECRET', prev.fbSecret);
    restore('META_PLATFORM_CONFIG_ID', prev.fbConfig);
    restore('INSTAGRAM_PLATFORM_APP_ID', prev.igId);
    restore('INSTAGRAM_PLATFORM_APP_SECRET', prev.igSecret);
  });

  let connector: Record<string, any>;
  let connectorsService: { findById: jest.Mock; findByIdInternal: jest.Mock; update: jest.Mock };
  let metaLogin: { exchangeCode: jest.Mock; facebookAccounts: jest.Mock; unifiedAccounts: jest.Mock };
  let bearerTokens: { seed: jest.Mock };
  let mcpServer: { reloadConnectorTools: jest.Mock };
  let flows: McpOAuthService;
  let controller: MetaAuthController;
  const admin = { user: { sub: 'user-1', organizationId: 'org-1', role: 'ADMIN' } };

  const authConfig = {
    token: '{{INSTAGRAM_ACCESS_TOKEN}}',
    tokenRenewal: { provider: 'meta', appIdVar: 'META_APP_ID', appSecretVar: 'META_APP_SECRET', graphVersion: 'v25.0' },
  };

  beforeEach(() => {
    delete process.env.META_PLATFORM_APP_ID;
    delete process.env.META_PLATFORM_APP_SECRET;
    delete process.env.META_PLATFORM_CONFIG_ID;
    delete process.env.INSTAGRAM_PLATFORM_APP_ID;
    delete process.env.INSTAGRAM_PLATFORM_APP_SECRET;
    connector = {
      id: 'conn-1',
      organizationId: 'org-1',
      userId: 'user-1',
      authType: 'BEARER_TOKEN',
      baseUrl: 'https://graph.facebook.com/v25.0',
      // As installed without a token: the placeholder stays.
      authConfig: encrypt(JSON.stringify(authConfig), KEY),
      headers: null,
      config: { adapterSlug: 'instagram' },
      envVars: { META_APP_ID: '1234567890', META_APP_SECRET: 'abcdef0123456789abcdef0123456789' },
    };
    connectorsService = {
      findById: jest.fn(async () => connector),
      findByIdInternal: jest.fn(async () => connector),
      update: jest.fn(async (_id: string, data: any) => {
        connector = {
          ...connector,
          ...(data.envVars ? { envVars: data.envVars } : {}),
          ...(data.authConfig ? { authConfig: encrypt(JSON.stringify(data.authConfig), KEY) } : {}),
        };
        return connector;
      }),
    };
    metaLogin = {
      exchangeCode: jest.fn(async () => ({ token: 'EAAlong', expiresAt: 1_900_000_000_000, accounts: [ACCOUNT_A] })),
      facebookAccounts: jest.fn(async () => [ACCOUNT_A, ACCOUNT_B]),
      unifiedAccounts: jest.fn(async () => [ACCOUNT_A, ACCOUNT_B]),
    };
    bearerTokens = { seed: jest.fn(async () => undefined) };
    mcpServer = { reloadConnectorTools: jest.fn(async () => undefined) };
    flows = new McpOAuthService();
    const config = {
      get: jest.fn(
        (k: string) => ({ ENCRYPTION_KEY: KEY, SERVER_URL: 'https://cloud.anythingmcp.com', FRONTEND_URL: 'https://app.test' })[k],
      ),
    } as unknown as ConfigService;
    controller = new MetaAuthController(
      connectorsService as any,
      flows,
      metaLogin as any,
      bearerTokens as any,
      mcpServer as any,
      config,
    );
  });

  const stateOf = (authorizationUrl: string) => new URL(authorizationUrl).searchParams.get('state')!;
  const start = async (returnTo?: string) => {
    const out = await controller.authorize(admin, 'conn-1', returnTo ? { returnTo } : undefined);
    return { out, state: stateOf(out.authorizationUrl!) };
  };
  const redirectOf = async (query: Record<string, unknown>) => {
    const res = { redirect: jest.fn() };
    await controller.callback(query.state, query.code, query.error, res as any, query.error_reason);
    return new URL(res.redirect.mock.calls[0][0]);
  };

  it('returns the Facebook dialog with the connector app, and stores a pending attempt', async () => {
    const { out, state } = await start();
    const url = new URL(out.authorizationUrl!);
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v25.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('1234567890');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cloud.anythingmcp.com/api/meta/callback');
    expect(out.redirectUrl).toBe('https://cloud.anythingmcp.com/api/meta/callback');
    expect(out.authorizationUrl).not.toContain('abcdef0123456789');
    expect((await flows.getPendingFlow(state))?.flow).toMatchObject({ provider: 'meta', connectorId: 'conn-1', userId: 'user-1' });
  });

  it("uses the server's app when the connector has none, never for instagram-login", async () => {
    connector.envVars = {};
    expect(await controller.authorize(admin, 'conn-1')).toEqual({
      error: expect.stringContaining('META_APP_ID and META_APP_SECRET'),
      redirectUrl: 'https://cloud.anythingmcp.com/api/meta/callback',
    });
    process.env.META_PLATFORM_APP_ID = '900';
    process.env.META_PLATFORM_APP_SECRET = 'server-secret';
    expect(new URL((await controller.authorize(admin, 'conn-1')).authorizationUrl!).searchParams.get('client_id')).toBe('900');

    connector.config = { adapterSlug: 'instagram-login' };
    // Instagram Login has no server app (new Meta apps cannot get it), not even from these variables.
    process.env.INSTAGRAM_PLATFORM_APP_ID = '777';
    process.env.INSTAGRAM_PLATFORM_APP_SECRET = 'ig-secret';
    expect((await controller.authorize(admin, 'conn-1')).error).toMatch(/INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET/);
    connector.envVars = { INSTAGRAM_APP_ID: '778', INSTAGRAM_APP_SECRET: 'own-ig-secret' };
    const ig = new URL((await controller.authorize(admin, 'conn-1')).authorizationUrl!);
    expect(ig.origin + ig.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(ig.searchParams.get('client_id')).toBe('778');
    expect(controller.platform()).toEqual({
      facebook: true,
      unified: false,
      instagram: false,
      redirectUrl: 'https://cloud.anythingmcp.com/api/meta/callback',
    });
  });

  it("signs in with Unified Login through the server's configuration, stores a token that never renews", async () => {
    connector.envVars = {};
    process.env.META_PLATFORM_APP_ID = '1785424892691435';
    process.env.META_PLATFORM_APP_SECRET = 'server-secret';
    process.env.META_PLATFORM_CONFIG_ID = '2539939149839675';
    expect(controller.platform()).toMatchObject({ facebook: true, unified: true });
    const { out, state } = await start();
    const url = new URL(out.authorizationUrl!);
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/dialog/oauth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: '1785424892691435',
      config_id: '2539939149839675',
      response_type: 'code',
      override_default_response_type: 'true',
      prompt: 'login',
    });
    expect(url.searchParams.get('scope')).toBeNull();

    metaLogin.exchangeCode.mockResolvedValueOnce({ token: 'BISU', expiresAt: null, accounts: [ACCOUNT_A, ACCOUNT_B], systemUser: true });
    const done = await controller.complete(admin, { state, code: 'CODE' });
    expect(metaLogin.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ app: { appId: '1785424892691435', appSecret: 'server-secret', configId: '2539939149839675' } }),
    );
    expect(done.accounts).toEqual([ACCOUNT_A, ACCOUNT_B]);
    expect(bearerTokens.seed).toHaveBeenCalledWith('conn-1', 'BISU', { expiresAt: null, viaPlatformApp: false, systemUser: true });
    // Choosing reads the accounts the client shared, not Facebook Pages.
    await controller.chooseAccount(admin, 'conn-1', { accountId: ACCOUNT_A.id });
    expect(metaLogin.unifiedAccounts).toHaveBeenCalledWith('BISU');
    expect(metaLogin.facebookAccounts).not.toHaveBeenCalled();
    expect(connector.envVars.INSTAGRAM_ACCOUNT_ID).toBe(ACCOUNT_A.id);
    expect(JSON.stringify(connector.envVars)).not.toContain('server-secret');
  });

  it("uses a connector's own Unified Login configuration, and explains an empty share", async () => {
    connector.envVars = { ...connector.envVars, META_CONFIG_ID: '1112223334445' };
    const { out, state } = await start();
    expect(new URL(out.authorizationUrl!).searchParams.get('config_id')).toBe('1112223334445');
    metaLogin.exchangeCode.mockResolvedValueOnce({ token: 'BISU', expiresAt: null, accounts: [], systemUser: true });
    const none = await controller.complete(admin, { state, code: 'CODE' }).catch((e) => e);
    expect(none).toBeInstanceOf(BadRequestException);
    expect(none.getResponse().message).toMatch(/no Instagram account was shared/);
  });

  it('only lets the owner or an admin start it, and only on an Instagram connector', async () => {
    await expect(controller.authorize({ user: { ...admin.user, organizationId: 'org-2' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.authorize({ user: { ...admin.user, role: 'VIEWER' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.authorize({ user: { sub: 'user-2', organizationId: 'org-1', role: 'EDITOR' } }, 'conn-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    connector.config = { adapterSlug: 'facebook-pages' };
    expect(await controller.authorize(admin, 'conn-1')).toEqual({ error: expect.stringMatching(/does not sign in/) });
  });

  it("forwards Meta's redirect to the dashboard, and handles a refusal or an unknown state", async () => {
    const { state } = await start();
    const ok = await redirectOf({ state, code: 'CODE#_' });
    expect(ok.origin + ok.pathname).toBe('https://app.test/connectors/oauth/complete');
    expect(Object.fromEntries(ok.searchParams)).toEqual({ provider: 'meta', state, code: 'CODE#_' });
    expect(await flows.getPendingFlow(state)).toBeDefined();

    expect((await redirectOf({ state: 'nope', code: 'c' })).searchParams.get('error')).toMatch(/expired/);

    const denied = await redirectOf({ state, error: 'access_denied', error_reason: 'user_denied' });
    expect(denied.searchParams.get('error')).toMatch(/cancelled or the permissions were declined/);
    expect(denied.searchParams.get('connectorId')).toBe('conn-1');
    expect(await flows.getPendingFlow(state)).toBeUndefined();
  });

  it('completes for the starter only, stores token and account, rebuilds the auth and seeds the renewal', async () => {
    const { state } = await start('/connectors/conn-1');
    await expect(
      controller.complete({ user: { sub: 'user-2', organizationId: 'org-1', role: 'ADMIN' } }, { state, code: 'CODE' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const out = await controller.complete(admin, { state, code: 'CODE' });
    expect(out).toEqual({ connectorId: 'conn-1', toolsImported: 0, returnTo: '/connectors/conn-1', account: ACCOUNT_A });
    expect(metaLogin.exchangeCode).toHaveBeenCalledWith({
      flavour: 'facebook',
      app: { appId: '1234567890', appSecret: 'abcdef0123456789abcdef0123456789' },
      code: 'CODE',
      redirectUri: 'https://cloud.anythingmcp.com/api/meta/callback',
    });
    expect(connector.envVars).toMatchObject({ INSTAGRAM_ACCESS_TOKEN: 'EAAlong', INSTAGRAM_ACCOUNT_ID: ACCOUNT_A.id, META_APP_ID: '1234567890' });
    // The bearer token in authConfig is resolved, as the variable editor does.
    expect(JSON.parse(decrypt(connector.authConfig, KEY))).toMatchObject({ token: 'EAAlong', tokenRenewal: { provider: 'meta' } });
    expect(bearerTokens.seed).toHaveBeenCalledWith('conn-1', 'EAAlong', {
      expiresAt: 1_900_000_000_000,
      viaPlatformApp: false,
      systemUser: undefined,
    });
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('conn-1');

    // Single use.
    await expect(controller.complete(admin, { state, code: 'CODE' })).rejects.toBeInstanceOf(GoneException);
  });

  it("marks a token from the server's Facebook app for renewal with that app", async () => {
    connector.envVars = {};
    process.env.META_PLATFORM_APP_ID = '900';
    process.env.META_PLATFORM_APP_SECRET = 'server-secret';
    const { state } = await start();
    await controller.complete(admin, { state, code: 'CODE' });
    expect(bearerTokens.seed).toHaveBeenCalledWith('conn-1', 'EAAlong', expect.objectContaining({ viaPlatformApp: true }));
    // The server's secret never lands on the connector.
    expect(JSON.stringify(connector.envVars)).not.toContain('server-secret');
  });

  it('with several accounts and none set, stores the token and lets the user choose', async () => {
    metaLogin.exchangeCode.mockResolvedValueOnce({ token: 'EAAlong', expiresAt: null, accounts: [ACCOUNT_A, ACCOUNT_B] });
    const { state } = await start();
    const out = await controller.complete(admin, { state, code: 'CODE' });
    expect(out.accounts).toEqual([ACCOUNT_A, ACCOUNT_B]);
    expect(out.account).toBeUndefined();
    expect(connector.envVars.INSTAGRAM_ACCESS_TOKEN).toBe('EAAlong');
    expect(connector.envVars.INSTAGRAM_ACCOUNT_ID).toBeUndefined();

    const chosen = await controller.chooseAccount(admin, 'conn-1', { accountId: ACCOUNT_B.id });
    expect(chosen).toEqual({ connectorId: 'conn-1', account: ACCOUNT_B });
    expect(metaLogin.facebookAccounts).toHaveBeenCalledWith('EAAlong');
    expect(connector.envVars.INSTAGRAM_ACCOUNT_ID).toBe(ACCOUNT_B.id);

    await expect(controller.chooseAccount(admin, 'conn-1', { accountId: '17841499999999999' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.chooseAccount(admin, 'conn-1', { accountId: 'shop_a' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.chooseAccount({ user: { ...admin.user, role: 'VIEWER' } }, 'conn-1', { accountId: ACCOUNT_A.id }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps an account id already set when the login still reaches it', async () => {
    connector.envVars = { ...connector.envVars, INSTAGRAM_ACCOUNT_ID: ACCOUNT_B.id };
    metaLogin.exchangeCode.mockResolvedValueOnce({ token: 'EAAlong', expiresAt: null, accounts: [ACCOUNT_A, ACCOUNT_B] });
    const { state } = await start();
    expect((await controller.complete(admin, { state, code: 'CODE' })).account).toEqual(ACCOUNT_B);
  });

  it('explains a login without any linked Instagram account, and a refused code', async () => {
    metaLogin.exchangeCode.mockResolvedValueOnce({ token: 'EAAlong', expiresAt: null, accounts: [] });
    let { state } = await start();
    const none = await controller.complete(admin, { state, code: 'CODE' }).catch((e) => e);
    expect(none).toBeInstanceOf(BadRequestException);
    expect(none.getResponse().message).toMatch(/none of the Facebook Pages you manage has an Instagram/);
    expect(connectorsService.update).not.toHaveBeenCalled();

    metaLogin.exchangeCode.mockRejectedValueOnce(new MetaLoginError('HTTP 400 (code 100): Invalid verification code format.', 400));
    ({ state } = await start());
    const refused = await controller.complete(admin, { state, code: 'CODE' }).catch((e) => e);
    expect(refused).toBeInstanceOf(BadRequestException);
    expect(refused.getResponse().message).toMatch(/META_APP_ID and META_APP_SECRET belong to the same app/);
    expect(refused.getResponse().message).toContain('https://cloud.anythingmcp.com/api/meta/callback');

    metaLogin.exchangeCode.mockRejectedValueOnce(new MetaLoginError('HTTP 503', 503));
    ({ state } = await start());
    await expect(controller.complete(admin, { state, code: 'CODE' })).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('completes an Instagram Login without asking to choose', async () => {
    connector.config = { adapterSlug: 'instagram-login' };
    connector.baseUrl = 'https://graph.instagram.com/v25.0';
    connector.envVars = { INSTAGRAM_APP_ID: '777', INSTAGRAM_APP_SECRET: 'ig-secret' };
    metaLogin.exchangeCode.mockResolvedValueOnce({
      token: 'IGlong',
      expiresAt: 1_900_000_000_000,
      accounts: [{ id: '17841400000000099', username: 'creator' }],
    });
    const { state } = await start();
    const out = await controller.complete(admin, { state, code: 'AQB#_' });
    expect(metaLogin.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ flavour: 'instagram', app: { appId: '777', appSecret: 'ig-secret' } }));
    expect(out.account).toEqual({ id: '17841400000000099', username: 'creator' });
    expect(connector.envVars).toMatchObject({ INSTAGRAM_ACCESS_TOKEN: 'IGlong', INSTAGRAM_ACCOUNT_ID: '17841400000000099' });
    expect(bearerTokens.seed).toHaveBeenCalledWith('conn-1', 'IGlong', {
      expiresAt: 1_900_000_000_000,
      viaPlatformApp: false,
      systemUser: undefined,
    });
    await expect(controller.chooseAccount(admin, 'conn-1', { accountId: '17841400000000099' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
