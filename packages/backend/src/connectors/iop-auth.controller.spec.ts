import { BadGatewayException, BadRequestException, ForbiddenException, GoneException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IopAuthController } from './iop-auth.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { encrypt } from '../common/crypto/encryption.util';

const KEY = 'test-encryption-key-32-chars!!!!';

describe('IopAuthController', () => {
  const prevKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = prevKey;
  });

  // As the Miravia adapter writes it: variables resolved from the connector.
  const authConfig = {
    tokenProvider: 'iop',
    iop: {
      appKey: '{{MIRAVIA_APP_KEY}}',
      authorizeUrl: 'https://auth.miravia.com/apps/oauth/authorize',
      tokenBaseUrl: 'https://api.miravia.es/rest',
      tokenPath: '/auth/token/create',
      refreshPath: '/auth/token/refresh',
      authorizeParams: { force_auth: 'true' },
    },
    signature: {
      algorithm: 'sha256',
      encoding: 'hex-upper',
      secret: '{{MIRAVIA_APP_SECRET}}',
      placement: 'query',
      paramName: 'sign',
      timestampParam: 'timestamp',
      timestampFormat: 'ms',
      queryParams: { app_key: '{{MIRAVIA_APP_KEY}}', sign_method: 'sha256' },
      template: '${apiPath}${sortedParams}',
    },
  };
  let connector: Record<string, any>;
  let connectorsService: { findById: jest.Mock; findByIdInternal: jest.Mock };
  let tokens: { exchangeCode: jest.Mock };
  let mcpServer: { reloadConnectorTools: jest.Mock };
  let flows: McpOAuthService;
  let controller: IopAuthController;
  const admin = { user: { sub: 'user-1', organizationId: 'org-1', role: 'ADMIN' } };
  const CALLBACK = 'https://cloud.anythingmcp.com/api/iop-auth/callback';

  beforeEach(() => {
    connector = {
      id: 'conn-1',
      organizationId: 'org-1',
      userId: 'user-1',
      authType: 'HMAC',
      baseUrl: 'https://api.miravia.es/rest',
      authConfig: encrypt(JSON.stringify(authConfig), KEY),
      envVars: { MIRAVIA_APP_KEY: '500123', MIRAVIA_APP_SECRET: 'sec-test-0001' },
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
        ({ ENCRYPTION_KEY: KEY, SERVER_URL: 'https://cloud.anythingmcp.com/', FRONTEND_URL: 'https://app.test' })[k],
      ),
    } as unknown as ConfigService;
    controller = new IopAuthController(connectorsService as any, flows, tokens as any, mcpServer as any, config);
  });

  const stateOf = (authorizationUrl: string) => new URL(authorizationUrl).searchParams.get('state')!;
  const redirectOf = async (query: Record<string, unknown>) => {
    const res = { redirect: jest.fn() };
    await controller.callback(query.state, query.code, res as any);
    return new URL(res.redirect.mock.calls[0][0]);
  };

  it('names the callback URL to register on the app', () => {
    expect(controller.redirectUri()).toEqual({ redirectUri: CALLBACK });
  });

  it("returns the gateway's authorize link with this server's callback and a stored state bound to the connector", async () => {
    const out = await controller.authorize(admin, 'conn-1');
    expect(out.redirectUrl).toBe(CALLBACK);
    const url = new URL(out.authorizationUrl!);
    expect(url.origin + url.pathname).toBe('https://auth.miravia.com/apps/oauth/authorize');
    const state = stateOf(out.authorizationUrl!);
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      force_auth: 'true',
      response_type: 'code',
      client_id: '500123',
      redirect_uri: CALLBACK,
      state,
    });
    expect(out.authorizationUrl).not.toContain('sec-test-0001');
    expect((await flows.getPendingFlow(state))?.flow).toMatchObject({
      provider: 'iop',
      connectorId: 'conn-1',
      userId: 'user-1',
      redirectUri: CALLBACK,
      clientId: '500123',
      tokenUrl: 'https://api.miravia.es/rest/auth/token/create',
    });
  });

  it('only lets the owner or an admin of the workspace start it, and asks for the keys first', async () => {
    await expect(controller.authorize({ user: { ...admin.user, organizationId: 'org-2' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.authorize({ user: { ...admin.user, role: 'VIEWER' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.authorize({ user: { sub: 'user-2', organizationId: 'org-1', role: 'EDITOR' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    connector.envVars = { MIRAVIA_APP_KEY: '500123' };
    expect(await controller.authorize(admin, 'conn-1')).toEqual({ error: expect.stringContaining('app secret') });
    connector.authConfig = encrypt(JSON.stringify({ ...authConfig, tokenProvider: 'shopee' }), KEY);
    expect(await controller.authorize(admin, 'conn-1')).toEqual({ error: expect.stringContaining('does not authorize a seller') });
  });

  it("forwards the gateway's redirect to the dashboard, and refuses unknown states and a missing code", async () => {
    const state = stateOf((await controller.authorize(admin, 'conn-1')).authorizationUrl!);

    const ok = await redirectOf({ state, code: '0_500123_abc' });
    expect(ok.origin + ok.pathname).toBe('https://app.test/connectors/oauth/complete');
    expect(Object.fromEntries(ok.searchParams)).toEqual({ provider: 'iop', state, code: '0_500123_abc' });
    // Peeked, not taken: the dashboard completes it.
    expect(await flows.getPendingFlow(state)).toBeDefined();

    const unknown = await redirectOf({ state: 'nope', code: 'c' });
    expect(unknown.searchParams.get('error')).toMatch(/expired or was already used/);
    expect(unknown.searchParams.get('code')).toBeNull();
    const none = await redirectOf({ code: 'c' });
    expect(none.searchParams.get('error')).toMatch(/expired or was already used/);

    const cancelled = await redirectOf({ state });
    expect(cancelled.searchParams.get('error')).toMatch(/without an authorization code/);
    expect(cancelled.searchParams.get('connectorId')).toBe('conn-1');
    expect(await flows.getPendingFlow(state)).toBeUndefined();
  });

  it("a state of another provider's flow is not accepted here", async () => {
    await flows.storePendingFlow('generic', {
      connectorId: 'conn-1',
      userId: 'user-1',
      redirectUri: 'x',
      clientId: 'c',
      tokenUrl: 'https://t',
      createdAt: Date.now(),
    });
    await flows.storePendingFlow('shopee-state', {
      provider: 'shopee',
      connectorId: 'conn-1',
      userId: 'user-1',
      redirectUri: 'x',
      clientId: 'c',
      tokenUrl: 'https://t',
      createdAt: Date.now(),
    });
    for (const state of ['generic', 'shopee-state']) {
      await expect(controller.complete(admin, { state, code: 'c' })).rejects.toBeInstanceOf(GoneException);
      expect((await redirectOf({ state, code: 'c' })).searchParams.get('error')).toBeTruthy();
    }
    expect(tokens.exchangeCode).not.toHaveBeenCalled();
  });

  it('completes only for the user who started it, in the connector workspace, then stores the tokens and reloads the tools', async () => {
    const start = async () => stateOf((await controller.authorize(admin, 'conn-1', { returnTo: '/connectors/conn-1' })).authorizationUrl!);
    const s1 = await start();
    await expect(controller.complete({ user: { sub: 'user-2', organizationId: 'org-1' } }, { state: s1, code: 'c' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tokens.exchangeCode).not.toHaveBeenCalled();
    // Another user's refusal does not burn the owner's authorization.
    expect(await flows.getPendingFlow(s1)).toBeDefined();
    await controller.complete(admin, { state: s1, code: 'c-1' });
    // Single use: the same state cannot complete twice.
    await expect(controller.complete(admin, { state: s1, code: 'c-1' })).rejects.toBeInstanceOf(GoneException);
    tokens.exchangeCode.mockClear();
    mcpServer.reloadConnectorTools.mockClear();

    const s2 = await start();
    expect(await controller.complete(admin, { state: s2, code: ' c-2 ' })).toEqual({
      connectorId: 'conn-1',
      toolsImported: 0,
      returnTo: '/connectors/conn-1',
    });
    expect(tokens.exchangeCode).toHaveBeenCalledWith({
      connectorId: 'conn-1',
      app: expect.objectContaining({
        appKey: '500123',
        appSecret: 'sec-test-0001',
        tokenBaseUrl: 'https://api.miravia.es/rest',
        tokenPath: '/auth/token/create',
      }),
      code: 'c-2',
    });
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('conn-1');

    // The connector moved to another workspace meanwhile: refused, nothing exchanged.
    const s3 = await start();
    connector.organizationId = 'org-2';
    tokens.exchangeCode.mockClear();
    await expect(controller.complete(admin, { state: s3, code: 'c-3' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(tokens.exchangeCode).not.toHaveBeenCalled();
  });

  it('says what the gateway refused when the code exchange fails', async () => {
    let state = stateOf((await controller.authorize(admin, 'conn-1')).authorizationUrl!);
    tokens.exchangeCode.mockRejectedValueOnce({
      response: { status: 200, data: { code: 'InvalidCode', type: 'ISV', message: 'Invalid authorization code' } },
    });
    let err = await controller.complete(admin, { state, code: 'c' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      connectorId: 'conn-1',
      message: expect.stringMatching(/InvalidCode.*api\/iop-auth\/callback/),
    });

    state = stateOf((await controller.authorize(admin, 'conn-1')).authorizationUrl!);
    tokens.exchangeCode.mockRejectedValueOnce({ response: { status: 503, data: 'Service Unavailable' } });
    err = await controller.complete(admin, { state, code: 'c' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
  });
});
