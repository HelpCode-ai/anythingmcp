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
