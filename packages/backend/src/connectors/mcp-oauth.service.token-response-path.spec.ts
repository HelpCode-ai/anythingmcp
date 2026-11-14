import axios from 'axios';
import { encrypt } from '../common/crypto/encryption.util';
import { startConnectorAuthorization } from './connector-authorization';
import { McpOAuthService, TokenExchangeError } from './mcp-oauth.service';

jest.mock('axios');
// assertSafeOutboundUrl performs DNS/SSRF checks — stub it out for unit tests.
jest.mock('../common/ssrf.util', () => ({
  ...jest.requireActual('../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * `authConfig.tokenResponsePath` on the authorization-code exchange: a token
 * endpoint that wraps the token fields, as Joom does
 * ({ code, message, data: { access_token, refresh_token, expires_in } }).
 * Opt-in: without the field the answer is read at the top level, as always.
 */
describe('McpOAuthService.exchangeCodeForTokens with tokenResponsePath', () => {
  let service: McpOAuthService;

  // Built at runtime so no literal looks like a real credential.
  const accessToken = ['at', 'a'.repeat(20)].join('-');
  const refreshToken = ['rt', 'r'.repeat(20)].join('-');

  const baseParams = {
    tokenUrl: 'https://api-merchant.joom.com/api/v2/oauth/access_token',
    code: 'authcode',
    redirectUri: 'https://cloud.anythingmcp.com/api/mcp-oauth/callback',
    clientId: 'cid',
    clientSecret: 'client-secret',
  };

  beforeEach(() => {
    service = new McpOAuthService();
    mockedAxios.post.mockReset();
  });

  it('reads the access token, the refresh token and the lifetime from the wrapper', async () => {
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: {
        code: 0,
        message: '',
        data: { access_token: accessToken, refresh_token: refreshToken, expires_in: 2592000, expiry_time: 1900000000 },
      },
    } as any);

    await expect(
      service.exchangeCodeForTokens({ ...baseParams, tokenResponsePath: 'data' }),
    ).resolves.toEqual({ accessToken, refreshToken, expiresIn: 2592000 });

    // The request itself is the usual one.
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toBe(baseParams.tokenUrl);
    expect(Object.fromEntries(new URLSearchParams(String(body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'authcode',
      redirect_uri: baseParams.redirectUri,
      client_id: 'cid',
      client_secret: 'client-secret',
    });
  });

  it('follows a deeper path', async () => {
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { result: { token: { access_token: accessToken } } },
    } as any);
    await expect(
      service.exchangeCodeForTokens({ ...baseParams, tokenResponsePath: 'result.token' }),
    ).resolves.toEqual({ accessToken, refreshToken: undefined, expiresIn: undefined });
  });

  it("fails with the provider's code and message when the wrapper is missing", async () => {
    // A refusal inside a 200, with a stray token-like field the message must not repeat.
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { code: 1001, message: 'Authorization code is invalid or expired', echo: { client_secret: 'client-secret' } },
    } as any);

    const err = await service
      .exchangeCodeForTokens({ ...baseParams, tokenResponsePath: 'data' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TokenExchangeError);
    expect(err.status).toBe(200);
    expect(err.message).toBe(
      'Token exchange failed: the token answer has no object at "data" (authConfig.tokenResponsePath); ' +
        'the provider answered: code 1001: Authorization code is invalid or expired',
    );
    expect(err.message).not.toMatch(/client-secret|authcode/);
  });

  it('fails without quoting anything when the token fields sit at the top level instead', async () => {
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 },
    } as any);

    const err = await service
      .exchangeCodeForTokens({ ...baseParams, tokenResponsePath: 'data' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TokenExchangeError);
    expect(err.message).toBe(
      'Token exchange failed: the token answer has no object at "data" (authConfig.tokenResponsePath)',
    );
    expect(err.message).not.toContain(accessToken);
    expect(err.message).not.toContain(refreshToken);
  });

  it('fails when the wrapper is there but holds no access token', async () => {
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { code: 0, data: { refresh_token: refreshToken, expires_in: 3600 } },
    } as any);

    const err = await service
      .exchangeCodeForTokens({ ...baseParams, tokenResponsePath: 'data' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TokenExchangeError);
    expect(err.message).toBe(
      'Token exchange failed: the object at "data" of the token answer carries no access_token',
    );
    expect(err.message).not.toContain(refreshToken);
  });

  it('still reports an RFC 6749 error at the top level first', async () => {
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { error: 'invalid_grant', error_description: 'code expired' },
    } as any);
    await expect(
      service.exchangeCodeForTokens({ ...baseParams, tokenResponsePath: 'data' }),
    ).rejects.toThrow('Token exchange failed: invalid_grant — code expired');
  });

  describe('without the field (every other OAuth2 connector)', () => {
    it('still reads the token fields at the top level', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
      } as any);
      await expect(service.exchangeCodeForTokens({ ...baseParams })).resolves.toEqual({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresIn: 3600,
      });
    });

    it('does not look inside a data object nobody named', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { code: 0, data: { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 } },
      } as any);
      await expect(service.exchangeCodeForTokens({ ...baseParams })).resolves.toEqual({
        accessToken: undefined,
        refreshToken: undefined,
        expiresIn: undefined,
      });
    });

    it.each([[''], ['   '], [undefined]])('treats tokenResponsePath %p as unset', async (value) => {
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
      } as any);
      await expect(
        service.exchangeCodeForTokens({ ...baseParams, tokenResponsePath: value }),
      ).resolves.toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    });
  });
});

/**
 * The browser authorization carries the connector's tokenResponsePath to the
 * code exchange the callback runs.
 */
describe('startConnectorAuthorization with tokenResponsePath', () => {
  const KEY = 'a'.repeat(48);
  const CALLBACK = 'https://cloud.anythingmcp.com/api/mcp-oauth/callback';
  let service: McpOAuthService;

  beforeEach(() => {
    service = new McpOAuthService();
    mockedAxios.post.mockReset();
  });

  const deps = () => ({
    connectorsService: { updateAuthConfigMerge: jest.fn() },
    mcpOAuthService: service,
    logger: { log: jest.fn() },
    encryptionKey: KEY,
    callbackUrl: CALLBACK,
  });

  const row = (authConfig: Record<string, unknown>) => ({
    id: 'c1',
    type: 'REST' as const,
    baseUrl: 'https://api-merchant.joom.com/api/v3',
    authConfig: encrypt(JSON.stringify(authConfig), KEY),
    envVars: {},
    config: {},
    headers: null,
  });

  const authConfig = {
    clientId: 'cid',
    clientSecret: 'sec',
    authorizationUrl: 'https://api-merchant.joom.com/api/v2/oauth/authorize',
    tokenUrl: 'https://api-merchant.joom.com/api/v2/oauth/access_token',
    pkce: false,
  };

  const pendingFlow = async (config: Record<string, unknown>) => {
    const started = await startConnectorAuthorization(deps(), row(config) as any, { userId: 'u1' });
    if ('error' in started) throw new Error(started.error);
    return (await service.getPendingFlow(started.state))!.flow;
  };

  it('stores the path on the pending flow, and the exchange reads the wrapper', async () => {
    const flow = await pendingFlow({ ...authConfig, tokenResponsePath: 'data' });
    expect(flow.tokenResponsePath).toBe('data');

    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { code: 0, data: { access_token: 'wrapped-at', refresh_token: 'wrapped-rt', expires_in: 60 } },
    } as any);
    await expect(
      service.exchangeCodeForTokens({
        tokenUrl: flow.tokenUrl,
        code: 'the-code',
        redirectUri: flow.redirectUri,
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        codeVerifier: flow.codeVerifier,
        tokenAuthMethod: flow.tokenAuthMethod,
        tokenResponsePath: flow.tokenResponsePath,
      }),
    ).resolves.toEqual({ accessToken: 'wrapped-at', refreshToken: 'wrapped-rt', expiresIn: 60 });
  });

  it('leaves the pending flow of every other connector without the field', async () => {
    const flow = await pendingFlow(authConfig);
    expect(flow).not.toHaveProperty('tokenResponsePath');
    expect(await pendingFlow({ ...authConfig, tokenResponsePath: '' })).not.toHaveProperty('tokenResponsePath');
  });
});
