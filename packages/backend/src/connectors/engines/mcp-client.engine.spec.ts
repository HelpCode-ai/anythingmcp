import { McpClientEngine } from './mcp-client.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
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
