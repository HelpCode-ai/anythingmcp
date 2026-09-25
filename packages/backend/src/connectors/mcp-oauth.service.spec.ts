import { McpOAuthService } from './mcp-oauth.service';
import axios from 'axios';

jest.mock('axios');
// assertSafeOutboundUrl performs DNS/SSRF checks — stub it out for unit tests.
jest.mock('../common/ssrf.util', () => ({
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

  it("treats 'client_secret_basic' as an alias for basic", async () => {
    await service.exchangeCodeForTokens({
      ...baseParams,
      tokenAuthMethod: 'client_secret_basic',
    });
    const [, , config] = mockedAxios.post.mock.calls[0];
    expect((config as any).headers.Authorization).toMatch(/^Basic /);
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

  it('only probes the origin-level document for a bare-origin base URL', async () => {
    serve({
      'https://mcp.example.com/.well-known/oauth-authorization-server': {
        issuer: 'https://mcp.example.com',
        authorization_endpoint: 'https://mcp.example.com/authorize',
        token_endpoint: 'https://mcp.example.com/token',
      },
    });

    await service.discoverMetadata('https://mcp.example.com');

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
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

  it('keeps the verifier with its state, for ten minutes', () => {
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
    s.storePendingFlow('state-a', flow);
    expect(s.getPendingFlow('state-a')?.codeVerifier).toBe('v');
    expect(s.getPendingFlow('state-b')).toBeUndefined();
    s.storePendingFlow('state-old', { ...flow, createdAt: Date.now() - 11 * 60 * 1000 });
    expect(s.getPendingFlow('state-old')).toBeUndefined();
  });
});
