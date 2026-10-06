import { McpClientEngine, assertNotThisServer, explainMcpConnectError } from './mcp-client.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';

// Both classes now live in one package, so a single mock covers them.
jest.mock('@modelcontextprotocol/client', () => ({
  Client: jest.fn(),
  StreamableHTTPClientTransport: jest.fn(),
}));
jest.mock('../../common/ssrf.util', () => ({
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));

const MockedClient = Client as unknown as jest.Mock;
const MockedTransport = StreamableHTTPClientTransport as unknown as jest.Mock;
const mockedAssertSafeOutboundUrl = assertSafeOutboundUrl as jest.Mock;

/** The URL the SDK transport was constructed with, as a string. */
const transportUrl = (call = 0): string =>
  String(MockedTransport.mock.calls[call][0]);

describe('McpClientEngine endpoint resolution', () => {
  let engine: McpClientEngine;
  let client: {
    connect: jest.Mock;
    callTool: jest.Mock;
    listTools: jest.Mock;
    close: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    client = {
      connect: jest.fn().mockResolvedValue(undefined),
      callTool: jest.fn().mockResolvedValue({ content: [] }),
      listTools: jest.fn().mockResolvedValue({ tools: [] }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    MockedClient.mockImplementation(() => client);
    engine = new McpClientEngine({} as unknown as OAuth2TokenService);
  });

  const config = (baseUrl: string) => ({
    baseUrl,
    authType: 'NONE',
    headers: {} as Record<string, string>,
  });

  describe('execute', () => {
    it('POSTs to <origin>/mcp for a bare-origin base URL (unchanged behaviour)', async () => {
      await engine.execute(
        config('https://mcp.example.com'),
        { method: 'ping', path: '/mcp' },
        {},
      );

      expect(transportUrl()).toBe('https://mcp.example.com/mcp');
      expect(client.callTool).toHaveBeenCalledWith({
        name: 'ping',
        arguments: {},
      });
    });

    it('keeps the base URL path for a Snowflake managed MCP server (#501)', async () => {
      const baseUrl =
        'https://acct.snowflakecomputing.com/api/v2/databases/mydb/schemas/public/mcp-servers/my-server';

      await engine.execute(
        config(baseUrl),
        { method: 'query', path: '/mcp' },
        {},
      );

      expect(transportUrl()).toBe(baseUrl);
    });

    it('keeps the base URL path when bridging to an AnythingMCP Cloud tenant server', async () => {
      const baseUrl = 'https://cloud.anythingmcp.com/mcp/srv_123';

      await engine.execute(
        config(baseUrl),
        { method: 'ping', path: '/mcp' },
        {},
      );

      expect(transportUrl()).toBe(baseUrl);
    });

    it('SSRF-checks the resolved URL, not the base origin', async () => {
      const baseUrl = 'https://gw.example.com/tenant/a/mcp';

      await engine.execute(
        config(baseUrl),
        { method: 'ping', path: '/mcp' },
        {},
      );

      expect(mockedAssertSafeOutboundUrl).toHaveBeenCalledWith(baseUrl);
    });
  });

  describe('headers', () => {
    it('forwards connector headers alongside the injected auth header', async () => {
      // Snowflake needs both: the PAT in Authorization AND a token-type header.
      await engine.execute(
        {
          baseUrl:
            'https://acct.snowflakecomputing.com/api/v2/databases/db/schemas/public/mcp-servers/srv',
          authType: 'BEARER_TOKEN',
          authConfig: { token: 'snowflake-pat' },
          headers: {
            'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
          },
        },
        { method: 'query', path: '/mcp' },
        {},
      );

      const { requestInit } = MockedTransport.mock.calls[0][1];
      expect(requestInit.headers).toEqual({
        'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
        Authorization: 'Bearer snowflake-pat',
      });
    });

    it('sends the API key header on a path-hosted server', async () => {
      await engine.listTools({
        baseUrl: 'https://gw.example.com/tenant/a/mcp',
        authType: 'API_KEY',
        authConfig: { headerName: 'X-API-Key', apiKey: 'k-123' },
        headers: {},
      });

      const { requestInit } = MockedTransport.mock.calls[0][1];
      expect(requestInit.headers['X-API-Key']).toBe('k-123');
    });

    it('sends Basic base64(email:token) for BASIC_AUTH (Atlassian personal API token)', async () => {
      await engine.listTools({
        baseUrl: 'https://mcp.atlassian.com/v2/mcp',
        authType: 'BASIC_AUTH',
        authConfig: { username: 'jane@example.com', password: 'ATATT-token' },
        headers: {},
      });

      const { requestInit } = MockedTransport.mock.calls[0][1];
      expect(requestInit.headers.Authorization).toBe(
        'Basic ' + Buffer.from('jane@example.com:ATATT-token').toString('base64'),
      );
      expect(transportUrl()).toBe('https://mcp.atlassian.com/v2/mcp');
    });

    it('treats a missing Basic password as empty, never as "undefined"', async () => {
      await engine.listTools({
        baseUrl: 'https://mcp.example.com/mcp',
        authType: 'BASIC_AUTH',
        authConfig: { username: 'key' },
        headers: {},
      });
      const { requestInit } = MockedTransport.mock.calls[0][1];
      expect(requestInit.headers.Authorization).toBe(
        'Basic ' + Buffer.from('key:').toString('base64'),
      );
    });
  });

  describe('a server at the root of its host (Stripe, Apify)', () => {
    it('reaches the root when the tool path is "/", for calls and for discovery', async () => {
      await engine.execute(
        { ...config('https://mcp.stripe.com'), authType: 'BEARER_TOKEN', authConfig: { token: 'rk_test_x' } },
        { method: 'stripe_api_read', path: '/' },
        {},
      );
      expect(transportUrl(0)).toBe('https://mcp.stripe.com/');

      await engine.listTools({ ...config('https://mcp.apify.com'), mcpPath: '/' });
      expect(transportUrl(1)).toBe('https://mcp.apify.com/');
    });
  });

  describe('listTools', () => {
    it('discovers against the base URL path instead of <origin>/mcp', async () => {
      const baseUrl = 'https://app.linkmcp.io/api/mcp';

      await engine.listTools(config(baseUrl));

      expect(transportUrl()).toBe(baseUrl);
    });

    it('still defaults to <origin>/mcp for a bare origin', async () => {
      await engine.listTools(config('https://mcp.example.com'));

      expect(transportUrl()).toBe('https://mcp.example.com/mcp');
    });

    it('honours an explicit mcpPath override', async () => {
      await engine.listTools({
        ...config('https://mcp.example.com'),
        mcpPath: '/sse',
      });

      expect(transportUrl()).toBe('https://mcp.example.com/sse');
    });

    it('applies the SSRF guard on the discovery path too', async () => {
      await engine.listTools(config('https://mcp.example.com/deep/path/mcp'));

      expect(mockedAssertSafeOutboundUrl).toHaveBeenCalledWith(
        'https://mcp.example.com/deep/path/mcp',
      );
    });
  });
});

describe('assertNotThisServer', () => {
  const env = { SERVER_URL: 'https://cloud.anythingmcp.com', FRONTEND_URL: 'https://cloud.anythingmcp.com' } as NodeJS.ProcessEnv;

  it.each(['https://cloud.anythingmcp.com/mcp', 'https://CLOUD.anythingmcp.com/mcp/abc123'])(
    'refuses an MCP connector that points at this server: %s',
    (url) => {
      expect(() => assertNotThisServer(new URL(url), env)).toThrow(/points at this AnythingMCP server itself/);
    },
  );

  it('allows another server, including another AnythingMCP instance', () => {
    expect(() => assertNotThisServer(new URL('https://mcp.example.com/mcp'), env)).not.toThrow();
    expect(() => assertNotThisServer(new URL('https://amcp.customer.de/mcp'), env)).not.toThrow();
  });

  it('on a self-hosted instance, another MCP server on the same machine is allowed', () => {
    const local = { SERVER_URL: 'http://localhost:4000' } as NodeJS.ProcessEnv;
    expect(() => assertNotThisServer(new URL('http://localhost:8080/mcp'), local)).not.toThrow();
    expect(() => assertNotThisServer(new URL('http://localhost:4000/mcp'), local)).toThrow(/itself/);
  });

  it('does nothing when the instance does not know its own URL', () => {
    expect(() => assertNotThisServer(new URL('https://cloud.anythingmcp.com/mcp'), {} as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('explainMcpConnectError', () => {
  const url = new URL('https://soap-shipping.trycloudflare.com/mcp');

  it.each([
    'Error POSTing to endpoint: host not allowed',
    'Error POSTing to endpoint: Forbidden: invalid Host header',
  ])('says which setting to change when the server refuses our Host: %s', (raw) => {
    const out = explainMcpConnectError(new Error(raw), url);
    expect(out.message).toContain(raw);
    expect(out.message).toContain("Add 'soap-shipping.trycloudflare.com' to the server's allowed hosts");
  });

  it('leaves other errors as they are', () => {
    const err = new Error('Error POSTing to endpoint: 401 Unauthorized');
    expect(explainMcpConnectError(err, url)).toBe(err);
  });

  const sdkHttpError = (status: number, body: string, code = 'CLIENT_HTTP_NOT_IMPLEMENTED') =>
    Object.assign(new Error(`Error POSTing to endpoint: ${body}`), { code, data: { status } });
  const tradingView = new URL('https://mcp.tradingview.com/mcp');

  it('says to sign in with OAuth when a server wants it and the connector sends nothing', () => {
    const err = sdkHttpError(401, '{"detail":"This server requires OAuth authentication"}');
    const out = explainMcpConnectError(err, tradingView, 'NONE');
    expect(out.message).toContain('requires sign-in (HTTP 401)');
    expect(out.message).toContain('set the connector\'s authentication to OAuth2 and click Authorize with Provider');
    expect((out as Error & { cause?: unknown }).cause).toBe(err);
  });

  it('says to authorize again when an OAuth connector is refused', () => {
    const out = explainMcpConnectError(sdkHttpError(401, '{}'), tradingView, 'OAUTH2');
    expect(out.message).toContain('click Authorize with Provider again');
  });

  it('says an address that returns a web page is not an MCP server', () => {
    const page = Object.assign(new Error('Unexpected content type: text/html; charset=utf-8'), {
      code: 'CLIENT_HTTP_UNEXPECTED_CONTENT',
    });
    const out = explainMcpConnectError(page, new URL('https://www.pinterest.com/'), 'NONE');
    expect(out.message).toContain('does not answer as an MCP server (it returned a web page)');
    expect(out.message).toContain('create a REST connector');
  });

  it('says a 404 is not an MCP endpoint', () => {
    const out = explainMcpConnectError(sdkHttpError(404, 'Not Found'), new URL('https://erp.example.com/mcp'));
    expect(out.message).toContain('does not answer as an MCP server (HTTP 404)');
  });
});
