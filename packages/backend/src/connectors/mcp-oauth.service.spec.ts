import { McpOAuthService, TokenExchangeError, chooseTokenAuthMethod, isLocalOnlyHost } from './mcp-oauth.service';
import axios from 'axios';
import { generateKeyPairSync, verify } from 'crypto';

jest.mock('axios');
// assertSafeOutboundUrl performs DNS/SSRF checks — stub it out for unit tests.
jest.mock('../common/ssrf.util', () => ({
  ...jest.requireActual('../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('McpOAuthService.exchangeCodeForTokens client authentication', () => {
  let service: McpOAuthService;

  beforeEach(() => {
    service = new McpOAuthService();
    mockedAxios.post.mockReset();
    mockedAxios.post.mockResolvedValue({
      data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
    } as any);
  });

  const baseParams = {
    tokenUrl: 'https://sandbox-api.datev.de/token',
    code: 'authcode',
    redirectUri: 'https://cloud.anythingmcp.com/api/mcp-oauth/callback',
    clientId: 'cid',
    clientSecret: 'secret',
    codeVerifier: 'verifier',
  };

  it('defaults to client_secret_post (credentials in body, no Basic header)', async () => {
    await service.exchangeCodeForTokens({ ...baseParams });

    const [, body, config] = mockedAxios.post.mock.calls[0];
    expect(String(body)).toContain('client_secret=secret');
    expect((config as any).headers.Authorization).toBeUndefined();
  });

  it('uses client_secret_basic when tokenAuthMethod=basic (header, not body)', async () => {
    await service.exchangeCodeForTokens({
      ...baseParams,
      tokenAuthMethod: 'basic',
    });

    const [, body, config] = mockedAxios.post.mock.calls[0];
    // Secret must NOT be in the body...
    expect(String(body)).not.toContain('client_secret=');
    // ...but in the Authorization header as base64(client_id:client_secret).
    const expected =
      'Basic ' + Buffer.from('cid:secret').toString('base64');
    expect((config as any).headers.Authorization).toBe(expected);
    // client_id still present in the body per RFC 6749.
    expect(String(body)).toContain('client_id=cid');
  });

  it("sends the connector's User-Agent to the token endpoint (Reddit throttles generic agents)", async () => {
    await service.exchangeCodeForTokens({
      ...baseParams,
      tokenUrl: 'https://www.reddit.com/api/v1/access_token',
      userAgent: 'web:anythingmcp:v1 (by /u/anythingmcp)',
    });
    const [, , config] = mockedAxios.post.mock.calls[0];
    expect((config as any).headers['User-Agent']).toBe('web:anythingmcp:v1 (by /u/anythingmcp)');
  });

  it('sets no User-Agent of its own when the connector has none', async () => {
    await service.exchangeCodeForTokens({ ...baseParams });
    const [, , config] = mockedAxios.post.mock.calls[0];
    expect((config as any).headers['User-Agent']).toBeUndefined();
  });

  it("treats 'client_secret_basic' as an alias for basic", async () => {
    await service.exchangeCodeForTokens({
      ...baseParams,
      tokenAuthMethod: 'client_secret_basic',
    });
    const [, , config] = mockedAxios.post.mock.calls[0];
    expect((config as any).headers.Authorization).toMatch(/^Basic /);
  });

  // Revolut Business: "Exchange authorization code for access token"
  // (developer.revolut.com) — grant_type, code, client_assertion_type and a
  // client_assertion signed with the key whose certificate was uploaded.
  it('signs a client assertion for private_key_jwt and sends no secret or client_id', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await service.exchangeCodeForTokens({
      ...baseParams,
      tokenUrl: 'https://sandbox-b2b.revolut.com/api/1.0/auth/token',
      clientSecret: undefined,
      tokenAuthMethod: 'private_key_jwt',
      clientAssertion: {
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        clientId: 'cid',
        tokenUrl: 'https://sandbox-b2b.revolut.com/api/1.0/auth/token',
        claims: { iss: 'cloud.anythingmcp.com', aud: 'https://revolut.com' },
      },
    });

    const [, body, config] = mockedAxios.post.mock.calls[0];
    const form = new URLSearchParams(String(body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('authcode');
    expect(form.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    expect(form.has('client_id')).toBe(false);
    expect(form.has('client_secret')).toBe(false);
    expect((config as any).headers.Authorization).toBeUndefined();

    const [h, p, sig] = String(form.get('client_assertion')).split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toMatchObject({
      iss: 'cloud.anythingmcp.com',
      sub: 'cid',
      aud: 'https://revolut.com',
    });
    expect(
      verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')),
    ).toBe(true);
  });

  it('refuses private_key_jwt without assertion settings instead of sending nothing', async () => {
    await expect(
      service.exchangeCodeForTokens({ ...baseParams, tokenAuthMethod: 'private_key_jwt' }),
    ).rejects.toThrow(/no client assertion settings/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("reports the provider's own error when the exchange is refused", async () => {
    mockedAxios.post.mockRejectedValue({
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: { error: 'invalid_request', error_description: 'The Token has expired.' },
      },
    });
    await expect(service.exchangeCodeForTokens({ ...baseParams })).rejects.toThrow(
      'Token exchange failed: HTTP 400: invalid_request: The Token has expired.',
    );
  });

  it('marks a refused exchange as such, with the status and the OAuth error code', async () => {
    // Mercado Libre's answer to a mistyped client secret.
    mockedAxios.post.mockRejectedValue({
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: { error: 'invalid_client', message: 'invalid client_id or client_secret' },
      },
    });
    const err = await service.exchangeCodeForTokens({ ...baseParams }).catch((e) => e);
    expect(err).toBeInstanceOf(TokenExchangeError);
    expect(err).toMatchObject({ status: 400, providerError: 'invalid_client' });
    expect(err.message).toBe(
      'Token exchange failed: HTTP 400: invalid_client: invalid client_id or client_secret',
    );
  });

  it('leaves a network failure as it is: nothing for the user to fix there', async () => {
    mockedAxios.post.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const err = await service.exchangeCodeForTokens({ ...baseParams }).catch((e) => e);
    expect(err).not.toBeInstanceOf(TokenExchangeError);
  });
});

describe('McpOAuthService.discoverMetadata', () => {
  let service: McpOAuthService;

  const AS_METADATA = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
  };

  /** Serve only the listed URLs; anything else 404s like a real server. */
  const serve = (documents: Record<string, unknown>) => {
    mockedAxios.get.mockImplementation(((url: string) =>
      url in documents
        ? Promise.resolve({ data: documents[url] } as any)
        : Promise.reject(new Error('Request failed with status code 404'))) as any);
  };

  beforeEach(() => {
    service = new McpOAuthService();
    mockedAxios.get.mockReset();
  });

  it('follows the RFC 9728 protected-resource document of a path-hosted server', async () => {
    serve({
      'https://cloud.anythingmcp.com/.well-known/oauth-protected-resource/mcp/srv_1':
        {
          resource: 'https://cloud.anythingmcp.com/mcp/srv_1',
          authorization_servers: ['https://auth.example.com'],
        },
      'https://auth.example.com/.well-known/oauth-authorization-server':
        AS_METADATA,
    });

    const metadata = await service.discoverMetadata(
      'https://cloud.anythingmcp.com/mcp/srv_1',
    );

    // An authorization server named by the resource is external on purpose,
    // so it must NOT be rebased onto the MCP server's origin.
    expect(metadata.authorization_endpoint).toBe(
      'https://auth.example.com/authorize',
    );
    expect(metadata.token_endpoint).toBe('https://auth.example.com/token');
  });

  it('falls back to the path-inserted authorization-server metadata (RFC 8414 §3.1)', async () => {
    serve({
      'https://acct.snowflakecomputing.com/.well-known/oauth-authorization-server/api/v2/databases/db/schemas/public/mcp-servers/srv':
        {
          issuer: 'https://acct.snowflakecomputing.com',
          authorization_endpoint:
            'https://acct.snowflakecomputing.com/oauth/authorize',
          token_endpoint: 'https://acct.snowflakecomputing.com/oauth/token-request',
        },
    });

    const metadata = await service.discoverMetadata(
      'https://acct.snowflakecomputing.com/api/v2/databases/db/schemas/public/mcp-servers/srv',
    );

    expect(metadata.token_endpoint).toBe(
      'https://acct.snowflakecomputing.com/oauth/token-request',
    );
  });

  it('still finds the origin-level document, and keeps rebasing it (legacy behaviour)', async () => {
    serve({
      'https://mcp.example.com/.well-known/oauth-authorization-server': {
        issuer: 'http://localhost:4000',
        authorization_endpoint: 'http://localhost:4000/oauth/authorize',
        token_endpoint: 'http://localhost:4000/oauth/token',
      },
    });

    const metadata = await service.discoverMetadata('https://mcp.example.com/mcp');

    // A self-hosted server with a misconfigured OAUTH_SERVER_URL gets its
    // endpoints pulled back onto the origin we actually reached.
    expect(metadata.authorization_endpoint).toBe(
      'https://mcp.example.com/oauth/authorize',
    );
    expect(metadata.token_endpoint).toBe('https://mcp.example.com/oauth/token');
  });

  it('probes the root protected-resource document, then the origin-level one, for a bare-origin base URL', async () => {
    serve({
      'https://mcp.example.com/.well-known/oauth-authorization-server': {
        issuer: 'https://mcp.example.com',
        authorization_endpoint: 'https://mcp.example.com/authorize',
        token_endpoint: 'https://mcp.example.com/token',
      },
    });

    await service.discoverMetadata('https://mcp.example.com');

    expect(mockedAxios.get.mock.calls.map((c) => c[0])).toEqual([
      'https://mcp.example.com/.well-known/oauth-protected-resource',
      'https://mcp.example.com/.well-known/oauth-authorization-server',
    ]);
  });

  // Live shape of mcp.stripe.com and access.stripe.com (6 Oct 2026).
  const STRIPE_AS = {
    issuer: 'https://access.stripe.com/mcp',
    authorization_endpoint: 'https://access.stripe.com/mcp/oauth2/authorize',
    token_endpoint: 'https://access.stripe.com/mcp/oauth2/token',
    registration_endpoint: 'https://access.stripe.com/mcp/oauth2/register',
    scopes_supported: ['mcp'],
    token_endpoint_auth_methods_supported: ['none'],
  };

  it('follows a server-root protected-resource document (Stripe) and keeps its resource', async () => {
    serve({
      'https://mcp.stripe.com/.well-known/oauth-protected-resource': {
        resource: 'https://mcp.stripe.com',
        authorization_servers: ['https://access.stripe.com/mcp'],
      },
      'https://access.stripe.com/.well-known/oauth-authorization-server/mcp': STRIPE_AS,
    });

    const metadata = await service.discoverMetadata('https://mcp.stripe.com');

    expect(metadata.authorization_endpoint).toBe('https://access.stripe.com/mcp/oauth2/authorize');
    expect(metadata.protectedResource).toEqual({ resource: 'https://mcp.stripe.com', scopesSupported: undefined });
  });

  it('no longer rewrites a legitimate external authorization server published at the origin level (G1)', async () => {
    // Before: users were sent to https://mcp.stripe.com/mcp/oauth2/authorize, which does not exist.
    serve({ 'https://mcp.stripe.com/.well-known/oauth-authorization-server': STRIPE_AS });

    const metadata = await service.discoverMetadata('https://mcp.stripe.com/mcp');

    expect(metadata.authorization_endpoint).toBe('https://access.stripe.com/mcp/oauth2/authorize');
    expect(metadata.token_endpoint).toBe('https://access.stripe.com/mcp/oauth2/token');
    expect(metadata.registration_endpoint).toBe('https://access.stripe.com/mcp/oauth2/register');
  });

  it('leaves a local test setup alone: MCP server and authorization server on two local ports', async () => {
    serve({
      'http://localhost:3000/.well-known/oauth-authorization-server': {
        issuer: 'http://localhost:4000',
        authorization_endpoint: 'http://localhost:4000/oauth/authorize',
        token_endpoint: 'http://localhost:4000/oauth/token',
      },
    });
    const metadata = await service.discoverMetadata('http://localhost:3000/mcp');
    expect(metadata.token_endpoint).toBe('http://localhost:4000/oauth/token');
  });

  it('rebases an endpoint on a Docker service name or private address', async () => {
    serve({
      'https://amcp.example.com/.well-known/oauth-authorization-server': {
        issuer: 'http://backend:4000',
        authorization_endpoint: 'http://backend:4000/oauth/authorize',
        token_endpoint: 'http://10.0.0.5:4000/oauth/token',
      },
    });
    const metadata = await service.discoverMetadata('https://amcp.example.com/mcp/srv_1');
    expect(metadata.authorization_endpoint).toBe('https://amcp.example.com/oauth/authorize');
    expect(metadata.token_endpoint).toBe('https://amcp.example.com/oauth/token');
  });

  it('reports every URL it tried when nothing is discoverable', async () => {
    serve({});

    await expect(
      service.discoverMetadata('https://mcp.example.com/deep/mcp'),
    ).rejects.toThrow(/oauth-protected-resource\/deep\/mcp/);
  });
});

describe('McpOAuthService.buildAuthorizationUrl', () => {
  it('keeps query parameters the adapter put on the authorization URL', () => {
    // Google only issues a refresh token for access_type=offline, and only
    // re-issues one on a repeat grant with prompt=consent. The Search Console
    // adapter carries both on its authorizationUrl; dropping them would leave
    // a connector that stops working an hour after it was authorised.
    const url = new URL(
      new McpOAuthService().buildAuthorizationUrl({
        authorizationEndpoint:
          'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
        clientId: 'client-1',
        redirectUri: 'https://cloud.example.com/api/mcp-oauth/callback',
        codeChallenge: 'challenge',
        state: 'state-1',
        scope: 'https://www.googleapis.com/auth/webmasters',
      }),
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/webmasters');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

/**
 * Every browser authorization runs PKCE (RFC 7636, S256): Etsy refuses an
 * authorization request without it, and providers that do not use it ignore
 * the extra parameters. The verifier never leaves the server until the token
 * exchange; it is stored with the state.
 */
describe('McpOAuthService PKCE', () => {
  const service = new McpOAuthService();

  it('derives the S256 challenge exactly as RFC 7636 appendix B does', () => {
    expect(
      service.generateCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generates verifiers within the RFC 7636 alphabet and length (43-128)', () => {
    const verifier = service.generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(service.generateCodeVerifier()).not.toBe(verifier);
  });

  it('puts the challenge, never the verifier, on the authorization URL (Etsy shape)', () => {
    const verifier = service.generateCodeVerifier();
    const url = new URL(
      service.buildAuthorizationUrl({
        authorizationEndpoint: 'https://www.etsy.com/oauth/connect',
        clientId: 'keystring',
        redirectUri: 'https://cloud.anythingmcp.com/api/mcp-oauth/callback',
        codeChallenge: service.generateCodeChallenge(verifier),
        state: 'state-1',
        scope: 'email_r shops_r listings_r transactions_r',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://www.etsy.com/oauth/connect');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe(
      service.generateCodeChallenge(verifier),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // Etsy wants the scopes space-separated.
    expect(url.searchParams.get('scope')).toBe('email_r shops_r listings_r transactions_r');
    expect(url.toString()).not.toContain(verifier);
  });

  it('sends the stored verifier with the code at the token endpoint', async () => {
    mockedAxios.post.mockReset();
    mockedAxios.post.mockResolvedValue({
      data: { access_token: '123.at', refresh_token: '123.rt', expires_in: 3600 },
    } as any);

    await service.exchangeCodeForTokens({
      tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
      code: 'the-code',
      redirectUri: 'https://cloud.anythingmcp.com/api/mcp-oauth/callback',
      clientId: 'keystring',
      clientSecret: 'secret',
      codeVerifier: 'the-verifier',
    });

    const params = new URLSearchParams(String(mockedAxios.post.mock.calls[0][1]));
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code_verifier')).toBe('the-verifier');
    expect(params.get('client_id')).toBe('keystring');
  });

  it('keeps the verifier with its state, until it expires or is taken', async () => {
    const s = new McpOAuthService();
    const flow = {
      codeVerifier: 'v',
      connectorId: 'c',
      userId: 'u',
      redirectUri: 'r',
      clientId: 'id',
      tokenUrl: 't',
      createdAt: Date.now(),
    };
    await s.storePendingFlow('state-a', flow, { returnTo: '/connectors/c' });
    expect((await s.getPendingFlow('state-a'))?.flow.codeVerifier).toBe('v');
    expect((await s.getPendingFlow('state-a'))?.returnTo).toBe('/connectors/c');
    expect(await s.getPendingFlow('state-b')).toBeUndefined();
    // Taking it consumes it.
    expect((await s.takePendingFlow('state-a'))?.flow.codeVerifier).toBe('v');
    expect(await s.takePendingFlow('state-a')).toBeUndefined();
  });

});

describe('McpOAuthService pending flows in the database', () => {
  const flow = {
    codeVerifier: 'the-verifier',
    connectorId: 'conn-1',
    userId: 'user-1',
    redirectUri: 'https://cloud.example.com/api/mcp-oauth/callback',
    clientId: 'cid',
    clientSecret: 'very-secret',
    tokenUrl: 'https://example.com/token',
    createdAt: Date.now(),
  };
  const saved = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'k'.repeat(32);
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = saved;
  });

  function fakePrisma() {
    const rows = new Map<string, any>();
    return {
      rows,
      connectorOAuthAttempt: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(async ({ data }: any) => {
          rows.set(data.stateHash, data);
          return data;
        }),
        findUnique: jest.fn(async ({ where }: any) => rows.get(where.stateHash) ?? null),
        delete: jest.fn(async ({ where }: any) => {
          const row = rows.get(where.stateHash);
          if (!row) throw new Error('P2025');
          rows.delete(where.stateHash);
          return row;
        }),
      },
    };
  }

  it('stores the state hashed and the secrets encrypted', async () => {
    const prisma = fakePrisma();
    const s = new McpOAuthService(prisma as any);
    await s.storePendingFlow('the-state', flow);
    const [row] = [...prisma.rows.values()];
    expect(row.stateHash).not.toContain('the-state');
    expect(row.payload).not.toContain('very-secret');
    expect(row.payload).not.toContain('the-verifier');
    expect(row.userId).toBe('user-1');
    expect((await s.getPendingFlow('the-state'))?.flow.clientSecret).toBe('very-secret');
  });

  it('can be taken only once', async () => {
    const s = new McpOAuthService(fakePrisma() as any);
    await s.storePendingFlow('the-state', flow);
    expect((await s.takePendingFlow('the-state'))?.flow.userId).toBe('user-1');
    expect(await s.takePendingFlow('the-state')).toBeUndefined();
  });

  it('ignores an expired attempt', async () => {
    const prisma = fakePrisma();
    const s = new McpOAuthService(prisma as any);
    await s.storePendingFlow('the-state', flow);
    for (const row of prisma.rows.values()) row.expiresAt = new Date(Date.now() - 1000);
    expect(await s.getPendingFlow('the-state')).toBeUndefined();
    expect(await s.takePendingFlow('the-state')).toBeUndefined();
  });

  it('drops a returnTo that would leave the dashboard', async () => {
    const s = new McpOAuthService(fakePrisma() as any);
    for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'connectors/1']) {
      await s.storePendingFlow(`st-${bad}`, flow, { returnTo: bad });
      expect((await s.getPendingFlow(`st-${bad}`))?.returnTo).toBeUndefined();
    }
  });
});

/**
 * Hardening of the MCP OAuth client for vendors' official MCP servers:
 * RFC 8707 resource indicators, public clients, and what may be put in front
 * of the user's browser.
 */
describe('McpOAuthService for remote MCP servers', () => {
  let service: McpOAuthService;

  beforeEach(() => {
    service = new McpOAuthService();
    mockedAxios.post.mockReset();
  });

  it('registers a public client where the server only takes those, and keeps no secret (G3)', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { client_id: 'pub-1', client_secret: 'ignored', token_endpoint_auth_method: 'none' },
    } as any);

    const reg = await service.registerClient(
      'https://access.stripe.com/mcp/oauth2/register',
      'https://cloud.anythingmcp.com/api/mcp-oauth/callback',
      { tokenAuthMethod: 'none' },
    );

    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({ token_endpoint_auth_method: 'none' });
    expect(reg).toEqual({ clientId: 'pub-1', clientSecret: undefined, tokenAuthMethod: 'none' });
  });

  it('still registers a confidential client by default, and takes what the server granted', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { client_id: 'c-1', client_secret: 's-1', token_endpoint_auth_method: 'client_secret_basic', client_secret_expires_at: 0 },
    } as any);

    const reg = await service.registerClient('https://as.example.com/register', 'https://x/cb');

    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({ token_endpoint_auth_method: 'client_secret_post' });
    expect(reg).toEqual({ clientId: 'c-1', clientSecret: 's-1', tokenAuthMethod: 'client_secret_basic' });
  });

  it('chooses the token endpoint auth method from what the server advertises', () => {
    expect(chooseTokenAuthMethod(['none'])).toBe('none');
    expect(chooseTokenAuthMethod(['client_secret_basic', 'none'])).toBe('client_secret_basic');
    expect(chooseTokenAuthMethod(['client_secret_basic', 'client_secret_post', 'none'])).toBe('client_secret_post');
    expect(chooseTokenAuthMethod(undefined)).toBe('client_secret_post');
    expect(chooseTokenAuthMethod(['private_key_jwt'])).toBe('client_secret_post');
  });

  it('puts the resource indicator on the authorization URL (G2)', () => {
    const url = new URL(
      service.buildAuthorizationUrl({
        authorizationEndpoint: 'https://mcp.notion.com/authorize',
        clientId: 'cid',
        redirectUri: 'https://cloud.anythingmcp.com/api/mcp-oauth/callback',
        codeChallenge: 'challenge',
        state: 'st',
        scope: 'default',
        resource: 'https://mcp.notion.com/mcp',
      }),
    );
    expect(url.searchParams.get('resource')).toBe('https://mcp.notion.com/mcp');
  });

  it('refuses to send the browser to anything but a web page', () => {
    expect(() =>
      service.buildAuthorizationUrl({
        authorizationEndpoint: 'javascript:alert(1)',
        clientId: 'cid',
        redirectUri: 'https://x/cb',
        codeChallenge: 'c',
        state: 's',
      }),
    ).toThrow(/not a web address/);
  });

  it('sends the resource with the code, and no secret for a public client', async () => {
    mockedAxios.post.mockResolvedValue({ data: { access_token: 'at' } } as any);

    await service.exchangeCodeForTokens({
      tokenUrl: 'https://access.stripe.com/mcp/oauth2/token',
      code: 'code',
      redirectUri: 'https://x/cb',
      clientId: 'pub-1',
      clientSecret: 'leftover',
      codeVerifier: 'v',
      tokenAuthMethod: 'none',
      resource: 'https://mcp.stripe.com',
    });

    const form = new URLSearchParams(String(mockedAxios.post.mock.calls[0][1]));
    expect(form.get('resource')).toBe('https://mcp.stripe.com');
    expect(form.get('client_id')).toBe('pub-1');
    expect(form.get('client_secret')).toBeNull();
  });
});

describe('isLocalOnlyHost', () => {
  it.each([
    'localhost', 'api.localhost', '127.0.0.1', '10.1.2.3', '172.20.0.4', '192.168.1.10',
    '169.254.169.254', 'backend', 'printer.local', 'svc.internal', '::1', '[::1]', 'fd00::1',
  ])('%s is only reachable locally', (host) => {
    expect(isLocalOnlyHost(host)).toBe(true);
  });

  it.each(['access.stripe.com', 'console.apify.com', '8.8.8.8', '172.32.0.1', 'slack.com'])(
    '%s is public',
    (host) => {
      expect(isLocalOnlyHost(host)).toBe(false);
    },
  );
});
