import {
  MAX_TOOL_LIST_PAGES,
  McpClientEngine,
  assertNotThisServer,
  explainToolListPageCap,
  explainMcpConnectError,
  isUnauthorized,
} from './mcp-client.engine';
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
  let transport: { terminateSession: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    client = {
      connect: jest.fn().mockResolvedValue(undefined),
      callTool: jest.fn().mockResolvedValue({ content: [] }),
      listTools: jest.fn().mockResolvedValue({ tools: [] }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    transport = { terminateSession: jest.fn().mockResolvedValue(undefined) };
    MockedClient.mockImplementation(() => client);
    MockedTransport.mockImplementation(() => transport);
    engine = new McpClientEngine({} as unknown as OAuth2TokenService);
  });

  const config = (baseUrl: string) => ({
    baseUrl,
    authType: 'NONE',
    headers: {} as Record<string, string>,
  });

  describe('session cleanup', () => {
    it('terminates the session before locally closing the client', async () => {
      await engine.execute(config('https://mcp.example.com'), { method: 'echo', path: '/mcp' }, {});
      await new Promise((resolve) => setImmediate(resolve));
      expect(transport.terminateSession).toHaveBeenCalledTimes(1);
      expect(transport.terminateSession.mock.invocationCallOrder[0]).toBeLessThan(client.close.mock.invocationCallOrder[0]);
    });

    it('preserves the original tool error when session termination also fails', async () => {
      const original = new Error('tool failed');
      client.callTool.mockRejectedValueOnce(original);
      transport.terminateSession.mockRejectedValueOnce(new Error('cleanup failed'));
      await expect(engine.execute(config('https://mcp.example.com'), { method: 'echo', path: '/mcp' }, {})).rejects.toBe(original);
      expect(transport.terminateSession).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('closes locally even when connecting fails and remote termination fails', async () => {
      const original = new Error('connect failed');
      client.connect.mockRejectedValueOnce(original);
      transport.terminateSession.mockRejectedValueOnce(new Error('transport already aborted'));
      await expect(engine.execute(config('https://mcp.example.com'), { method: 'echo', path: '/mcp' }, {})).rejects.toBe(original);
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it.each(['execute', 'listTools'] as const)('returns from %s before a hanging cleanup reaches its deadline', async (operation) => {
      jest.useFakeTimers();
      try {
        transport.terminateSession.mockReturnValue(new Promise<void>(() => undefined));
        const call = operation === 'execute'
          ? engine.execute(config('https://mcp.example.com'), { method: 'echo', path: '/mcp' }, {})
          : engine.listTools(config('https://mcp.example.com'));
        const settled = jest.fn();
        const outcome = call.then(settled);
        await jest.advanceTimersByTimeAsync(0);
        expect(settled).toHaveBeenCalledWith(operation === 'execute' ? { content: [] } : []);
        await outcome;
        expect(client.close).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(5_000);
        expect(client.close).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it.each(['execute', 'listTools'] as const)('rejects %s without waiting for hanging cleanup', async (operation) => {
      jest.useFakeTimers();
      try {
        const original = new Error('upstream request failed');
        if (operation === 'execute') client.callTool.mockRejectedValueOnce(original);
        else client.listTools.mockRejectedValueOnce(original);
        transport.terminateSession.mockReturnValue(new Promise<void>(() => undefined));
        const call = operation === 'execute'
          ? engine.execute(config('https://mcp.example.com'), { method: 'echo', path: '/mcp' }, {})
          : engine.listTools(config('https://mcp.example.com'));
        const rejected = jest.fn();
        const outcome = call.catch(rejected);
        await jest.advanceTimersByTimeAsync(0);
        expect(rejected).toHaveBeenCalledWith(original);
        await outcome;
        expect(client.close).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(5_000);
        expect(client.close).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('clears the cleanup timer on success even when local close fails', async () => {
      jest.useFakeTimers();
      try {
        client.close.mockRejectedValueOnce(new Error('local close failed'));
        await expect(engine.execute(config('https://mcp.example.com'), { method: 'echo', path: '/mcp' }, {})).resolves.toEqual({ content: [] });
        expect(transport.terminateSession).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
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

  describe('fixed arguments (config.mcpFixedArguments)', () => {
    const fixed = { meta: { 'ucp-agent': { profile: 'https://agent.example.test/ucp-agent.json' } } };

    it("sends the caller's own arguments object when the connector fixes nothing", async () => {
      const params = { catalog: { query: 'tent' } };
      await engine.execute(config('https://shop.example.test/api/ucp/mcp'), { method: 'search_catalog', path: '/mcp' }, params);

      expect(client.callTool).toHaveBeenCalledTimes(1);
      expect(client.callTool.mock.calls[0][0].arguments).toBe(params);
    });

    it('merges them into the arguments of the call, without touching what the caller passed', async () => {
      const params = { catalog: { query: 'tent' } };
      await engine.execute(
        { ...config('https://shop.example.test/api/ucp/mcp'), fixedArguments: fixed },
        { method: 'search_catalog', path: '/mcp' },
        params,
      );

      expect(client.callTool).toHaveBeenCalledWith({
        name: 'search_catalog',
        arguments: { catalog: { query: 'tent' }, meta: { 'ucp-agent': { profile: 'https://agent.example.test/ucp-agent.json' } } },
      });
      expect(params).toEqual({ catalog: { query: 'tent' } });
    });

    it('lets the fixed value win over what the caller sent, and keeps the rest of the object', async () => {
      await engine.execute(
        { ...config('https://shop.example.test/api/ucp/mcp'), fixedArguments: fixed },
        { method: 'complete_checkout', path: '/mcp' },
        { id: 'chk_1', meta: { 'idempotency-key': 'k-1', 'ucp-agent': { profile: 'https://other.example.test/p.json' } } },
      );

      expect(client.callTool.mock.calls[0][0].arguments).toEqual({
        id: 'chk_1',
        meta: { 'idempotency-key': 'k-1', 'ucp-agent': { profile: 'https://agent.example.test/ucp-agent.json' } },
      });
    });

    it('sends no Authorization header to a server that needs no credentials (NONE)', async () => {
      await engine.execute(
        { ...config('https://shop.example.test/api/ucp/mcp'), fixedArguments: fixed },
        { method: 'search_catalog', path: '/mcp' },
        {},
      );
      await engine.listTools(config('https://shop.example.test/api/ucp/mcp'));

      for (const call of MockedTransport.mock.calls) {
        expect(Object.keys(call[1].requestInit.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
      }
      expect(transportUrl(1)).toBe('https://shop.example.test/api/ucp/mcp');
    });

    it('sends them again on the retry after a renewed OAuth2 token', async () => {
      const tokens = {
        getAccessToken: jest.fn().mockResolvedValue('expired'),
        renewAfterRejection: jest.fn().mockResolvedValue('renewed'),
      };
      engine = new McpClientEngine(tokens as unknown as OAuth2TokenService);
      client.callTool.mockRejectedValueOnce(
        Object.assign(new Error('Error POSTing to endpoint: {"error":"invalid_token"}'), { data: { status: 401 } }),
      );

      await engine.execute(
        {
          baseUrl: 'https://shop.example.test/mcp',
          authType: 'OAUTH2',
          authConfig: { tokenUrl: 'https://shop.example.test/token', refreshToken: 'rt' },
          connectorId: 'c1',
          fixedArguments: { channel: 'amcp' },
        },
        { method: 'search', path: '/mcp' },
        { q: 'tent', channel: 'model' },
      );

      expect(client.callTool).toHaveBeenCalledTimes(2);
      for (const call of client.callTool.mock.calls) {
        expect(call[0]).toEqual({ name: 'search', arguments: { q: 'tent', channel: 'amcp' } });
      }
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

  describe('tools/list pagination', () => {
    it('lets the SDK walk every page with our page cap (issue #1791)', async () => {
      client.listTools.mockResolvedValueOnce({
        tools: [
          { name: 'a', inputSchema: {} },
          { name: 'b', inputSchema: {} },
        ],
      });

      const tools = await engine.listTools(config('https://mcp.atlassian.com/v2/mcp'));

      expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
      // No cursor: the SDK aggregates all pages itself (client >= 2.4).
      expect(client.listTools.mock.calls).toEqual([[]]);
      expect(MockedClient.mock.calls[0][1]).toEqual({ listMaxPages: MAX_TOOL_LIST_PAGES });
      expect(MAX_TOOL_LIST_PAGES).toBe(50);
    });

    it('explains a server that lists more pages than the cap', async () => {
      client.listTools.mockRejectedValueOnce(
        Object.assign(new Error('tools/list: exceeded listMaxPages (50); server pagination did not terminate'), {
          code: 'LIST_PAGINATION_EXCEEDED',
        }),
      );

      await expect(engine.listTools(config('https://mcp.example.com/mcp'))).rejects.toThrow(
        /more than 50 pages, so discovery stopped/,
      );
      expect(client.close).toHaveBeenCalled();
    });

    it('passes other discovery errors through unchanged', async () => {
      const boom = new Error('upstream 502');
      client.listTools.mockRejectedValueOnce(boom);
      await expect(engine.listTools(config('https://mcp.example.com/mcp'))).rejects.toBe(boom);
      expect(explainToolListPageCap(boom)).toBe(boom);
      expect(explainToolListPageCap(undefined)).toBeUndefined();
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

  describe('OAuth2: a token the server refused', () => {
    // What @modelcontextprotocol/client throws for Cloudinary's 401: the
    // message is the body only, the status sits in `data`.
    const cloudinary401 = () =>
      Object.assign(
        new Error(
          'Error POSTing to endpoint: {"error":"invalid_token","error_description":"OAuth token is invalid or expired. Please re-authenticate."}',
        ),
        { code: 'CLIENT_HTTP_NOT_IMPLEMENTED', data: { status: 401, statusText: 'Unauthorized' } },
      );

    it('renews the token once and retries the call with it, with the connector id', async () => {
      const tokens = {
        getAccessToken: jest.fn().mockResolvedValue('expired'),
        renewAfterRejection: jest.fn().mockResolvedValue('renewed'),
      };
      engine = new McpClientEngine(tokens as unknown as OAuth2TokenService);
      client.connect.mockRejectedValueOnce(cloudinary401());

      const result = await engine.execute(
        {
          baseUrl: 'https://asset-management.mcp.cloudinary.com/mcp',
          authType: 'OAUTH2',
          authConfig: { tokenUrl: 'https://asset-management.mcp.cloudinary.com/token', refreshToken: 'rt' },
          connectorId: 'cmv-cloudinary',
        },
        { method: 'list-images', path: '/mcp' },
        {},
      );

      expect(result).toEqual({ content: [] });
      expect(tokens.getAccessToken).toHaveBeenCalledWith(expect.any(Object), 'cmv-cloudinary');
      expect(tokens.renewAfterRejection).toHaveBeenCalledWith(
        expect.any(Object),
        'cmv-cloudinary',
        expect.any(Number),
      );
      const retryHeaders = MockedTransport.mock.calls[1][1].requestInit.headers;
      expect(retryHeaders.Authorization).toBe('Bearer renewed');
    });
  });
});

describe('isUnauthorized', () => {
  it('reads the status the SDK puts in data, whatever the message says', () => {
    expect(
      isUnauthorized(Object.assign(new Error('Error POSTing to endpoint: nope'), { data: { status: 401 } })),
    ).toBe(true);
  });

  it('recognises the older message with the status, and an invalid_token body', () => {
    expect(isUnauthorized(new Error('Error POSTing to endpoint (HTTP 401): Unauthorized'))).toBe(true);
    expect(isUnauthorized(new Error('Error POSTing to endpoint: {"error":"invalid_token"}'))).toBe(true);
  });

  it('looks into the cause', () => {
    const outer = new Error('MCP error') as Error & { cause?: unknown };
    outer.cause = Object.assign(new Error('x'), { status: 401 });
    expect(isUnauthorized(outer)).toBe(true);
  });

  it('leaves other failures alone', () => {
    expect(isUnauthorized(Object.assign(new Error('Error POSTing to endpoint: x'), { data: { status: 403 } }))).toBe(false);
    expect(isUnauthorized(new Error('Tool returned 4010 rows'))).toBe(false);
    expect(isUnauthorized(undefined)).toBe(false);
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
