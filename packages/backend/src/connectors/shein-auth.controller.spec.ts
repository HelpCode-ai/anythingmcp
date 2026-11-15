import { BadGatewayException, BadRequestException, ForbiddenException, GoneException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SheinAuthController } from './shein-auth.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { encrypt } from '../common/crypto/encryption.util';

const KEY = 'test-encryption-key-32-chars!!!!';

describe('SheinAuthController', () => {
  const prevKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = prevKey;
  });

  // As the SHEIN adapter writes it: variables resolved from the connector.
  const authConfig = {
    tokenProvider: 'shein',
    shein: {
      appId: '{{SHEIN_APP_ID}}',
      appSecret: '{{SHEIN_APP_SECRET}}',
      authorizeUrl: 'https://openapi-sem.sheincorp.com/#/empower',
      tokenBaseUrl: '{{SHEIN_API_HOST}}',
      tokenPath: '/open-api/auth/get-by-token',
    },
    signature: {
      algorithm: 'sha256',
      encoding: 'hex-base64',
      secret: '${secretKey}${nonce}',
      nonceLength: 5,
      template: '${openKeyId}&${timestamp}&${pathname}',
      timestampFormat: 'ms',
      headerName: 'x-lt-signature',
      headerTemplate: '${nonce}${signature}',
      timestampHeader: 'x-lt-timestamp',
      extraHeaders: { 'x-lt-openKeyId': '${openKeyId}' },
    },
  };
  const APP_ID = 'F9D87342D803BA78E1EE49997162';
  const APP_SECRET = '0D8BD3F0AC9F12B0B6B6876527D0175F';
  let connector: Record<string, any>;
  let connectorsService: { findById: jest.Mock; findByIdInternal: jest.Mock };
  let tokens: { exchangeTempToken: jest.Mock };
  let mcpServer: { reloadConnectorTools: jest.Mock };
  let flows: McpOAuthService;
  let controller: SheinAuthController;
  const admin = { user: { sub: 'user-1', organizationId: 'org-1', role: 'ADMIN' } };
  const CALLBACK = 'https://cloud.anythingmcp.com/api/shein-auth/callback';

  beforeEach(() => {
    connector = {
      id: 'conn-1',
      organizationId: 'org-1',
      userId: 'user-1',
      authType: 'HMAC',
      baseUrl: 'https://openapi.sheincorp.com',
      authConfig: encrypt(JSON.stringify(authConfig), KEY),
      envVars: { SHEIN_API_HOST: 'https://openapi.sheincorp.com', SHEIN_APP_ID: APP_ID, SHEIN_APP_SECRET: APP_SECRET },
    };
    connectorsService = {
      findById: jest.fn(async () => connector),
      findByIdInternal: jest.fn(async () => connector),
    };
    tokens = { exchangeTempToken: jest.fn(async () => ({ supplierId: '1' })) };
    mcpServer = { reloadConnectorTools: jest.fn(async () => undefined) };
    flows = new McpOAuthService();
    const config = {
      get: jest.fn((k: string) =>
        ({ ENCRYPTION_KEY: KEY, SERVER_URL: 'https://cloud.anythingmcp.com/', FRONTEND_URL: 'https://app.test' })[k],
      ),
    } as unknown as ConfigService;
    controller = new SheinAuthController(connectorsService as any, flows, tokens as any, mcpServer as any, config);
  });

  const queryOf = (authorizationUrl: string) => new URLSearchParams(authorizationUrl.split('#/empower?')[1]);
  const stateOf = (authorizationUrl: string) => queryOf(authorizationUrl).get('state')!;
  const redirectOf = async (query: Record<string, unknown>) => {
    const res = { redirect: jest.fn() };
    await controller.callback(query.state, query.tempToken, query.appid, res as any);
    return new URL(res.redirect.mock.calls[0][0]);
  };

  it('names the redirect URL', () => {
    expect(controller.redirectUri()).toEqual({ redirectUri: CALLBACK });
  });

  it("returns SHEIN's authorize link with this server's redirect in Base64 and a stored state bound to the connector", async () => {
    const out = await controller.authorize(admin, 'conn-1');
    expect(out.redirectUrl).toBe(CALLBACK);
    expect(out.authorizationUrl!.startsWith('https://openapi-sem.sheincorp.com/#/empower?appid=')).toBe(true);
    const query = queryOf(out.authorizationUrl!);
    const state = query.get('state')!;
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(query.get('appid')).toBe(APP_ID);
    expect(Buffer.from(query.get('redirectUrl')!, 'base64').toString('utf8')).toBe(CALLBACK);
    expect([...query.keys()]).toEqual(['appid', 'redirectUrl', 'state']);
    expect(out.authorizationUrl).not.toContain(APP_SECRET);
    expect((await flows.getPendingFlow(state))?.flow).toMatchObject({
      provider: 'shein',
      connectorId: 'conn-1',
      userId: 'user-1',
      redirectUri: CALLBACK,
      clientId: APP_ID,
      tokenUrl: 'https://openapi.sheincorp.com/open-api/auth/get-by-token',
    });
  });

  it('only lets the owner or an admin of the workspace start it, and asks for the app keys first', async () => {
    await expect(controller.authorize({ user: { ...admin.user, organizationId: 'org-2' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.authorize({ user: { ...admin.user, role: 'VIEWER' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.authorize({ user: { sub: 'user-2', organizationId: 'org-1', role: 'EDITOR' } }, 'conn-1')).rejects.toBeInstanceOf(ForbiddenException);
    connector.envVars = { SHEIN_API_HOST: 'https://openapi.sheincorp.com', SHEIN_APP_ID: APP_ID };
    expect(await controller.authorize(admin, 'conn-1')).toEqual({ error: expect.stringContaining('App Secret') });
    connector.authConfig = encrypt(JSON.stringify({ ...authConfig, tokenProvider: 'iop' }), KEY);
    expect(await controller.authorize(admin, 'conn-1')).toEqual({ error: expect.stringContaining('does not authorize a SHEIN shop') });
  });

  it("forwards SHEIN's redirect to the dashboard, and refuses unknown states, another app and a missing tempToken", async () => {
    const state = stateOf((await controller.authorize(admin, 'conn-1')).authorizationUrl!);

    const ok = await redirectOf({ state, tempToken: 'd1a506e0-d064-47ea-8b01-e56acdca2df2', appid: APP_ID });
    expect(ok.origin + ok.pathname).toBe('https://app.test/connectors/oauth/complete');
    expect(Object.fromEntries(ok.searchParams)).toEqual({ provider: 'shein', state, code: 'd1a506e0-d064-47ea-8b01-e56acdca2df2' });
    // Peeked, not taken: the dashboard completes it.
    expect(await flows.getPendingFlow(state)).toBeDefined();

    const unknown = await redirectOf({ state: 'nope', tempToken: 't' });
    expect(unknown.searchParams.get('error')).toMatch(/expired or was already used/);
    expect(unknown.searchParams.get('code')).toBeNull();
    expect((await redirectOf({ tempToken: 't' })).searchParams.get('error')).toMatch(/expired or was already used/);

    const other = await redirectOf({ state, tempToken: 't', appid: 'ANOTHERAPP' });
    expect(other.searchParams.get('error')).toMatch(/another app/);
    expect(other.searchParams.get('code')).toBeNull();
    expect(await flows.getPendingFlow(state)).toBeUndefined();

    const state2 = stateOf((await controller.authorize(admin, 'conn-1')).authorizationUrl!);
    const cancelled = await redirectOf({ state: state2 });
    expect(cancelled.searchParams.get('error')).toMatch(/without a tempToken/);
    expect(cancelled.searchParams.get('connectorId')).toBe('conn-1');
    expect(await flows.getPendingFlow(state2)).toBeUndefined();
  });

  it("a state of another provider's flow is not accepted here", async () => {
    for (const [state, provider] of [
      ['generic', undefined],
      ['iop-state', 'iop'],
    ] as const) {
      await flows.storePendingFlow(state, {
        ...(provider ? { provider } : {}),
        connectorId: 'conn-1',
        userId: 'user-1',
        redirectUri: 'x',
        clientId: 'c',
        tokenUrl: 'https://t',
        createdAt: Date.now(),
      });
      await expect(controller.complete(admin, { state, tempToken: 't' })).rejects.toBeInstanceOf(GoneException);
      expect((await redirectOf({ state, tempToken: 't' })).searchParams.get('error')).toBeTruthy();
    }
    expect(tokens.exchangeTempToken).not.toHaveBeenCalled();
  });

  it('completes only for the user who started it, in the connector workspace, then stores the keys and reloads the tools', async () => {
    const start = async () => stateOf((await controller.authorize(admin, 'conn-1', { returnTo: '/connectors/conn-1' })).authorizationUrl!);
    const s1 = await start();
    await expect(controller.complete({ user: { sub: 'user-2', organizationId: 'org-1' } }, { state: s1, tempToken: 't' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tokens.exchangeTempToken).not.toHaveBeenCalled();
    // Another user's refusal does not burn the owner's authorization.
    expect(await flows.getPendingFlow(s1)).toBeDefined();
    await controller.complete(admin, { state: s1, tempToken: 't-1' });
    // Single use: the same state cannot complete twice.
    await expect(controller.complete(admin, { state: s1, tempToken: 't-1' })).rejects.toBeInstanceOf(GoneException);
    tokens.exchangeTempToken.mockClear();
    mcpServer.reloadConnectorTools.mockClear();

    const s2 = await start();
    expect(await controller.complete(admin, { state: s2, tempToken: ' t-2 ' })).toEqual({
      connectorId: 'conn-1',
      toolsImported: 0,
      returnTo: '/connectors/conn-1',
    });
    expect(tokens.exchangeTempToken).toHaveBeenCalledWith({
      connectorId: 'conn-1',
      app: {
        appId: APP_ID,
        appSecret: APP_SECRET,
        authorizeUrl: 'https://openapi-sem.sheincorp.com/#/empower',
        tokenBaseUrl: 'https://openapi.sheincorp.com',
        tokenPath: '/open-api/auth/get-by-token',
      },
      tempToken: 't-2',
    });
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('conn-1');

    // The connector moved to another workspace meanwhile: refused, nothing exchanged.
    const s3 = await start();
    connector.organizationId = 'org-2';
    tokens.exchangeTempToken.mockClear();
    await expect(controller.complete(admin, { state: s3, tempToken: 't-3' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(tokens.exchangeTempToken).not.toHaveBeenCalled();
  });

  it('refuses an expired state and says what SHEIN refused when the exchange fails', async () => {
    await expect(controller.complete(admin, { state: 'never-issued', tempToken: 't' })).rejects.toBeInstanceOf(GoneException);

    let state = stateOf((await controller.authorize(admin, 'conn-1')).authorizationUrl!);
    tokens.exchangeTempToken.mockRejectedValueOnce({
      response: { status: 200, data: { code: '33051002', msg: 'Request timed out: Please request to generate a temporary token again' } },
    });
    let err = await controller.complete(admin, { state, tempToken: 't' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      connectorId: 'conn-1',
      message: expect.stringMatching(/33051002.*IP whitelist/),
    });

    state = stateOf((await controller.authorize(admin, 'conn-1')).authorizationUrl!);
    tokens.exchangeTempToken.mockRejectedValueOnce({ response: { status: 503, data: 'Service Unavailable' } });
    err = await controller.complete(admin, { state, tempToken: 't' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
  });
});
