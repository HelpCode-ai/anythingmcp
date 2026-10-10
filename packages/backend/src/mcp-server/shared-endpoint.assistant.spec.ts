import { McpServer } from '@modelcontextprotocol/server';
import { McpEndpointController } from './mcp-endpoint.controller';

/**
 * Connector setup from a chat hands the user a one-time link; the setup page
 * then sends them back to the assistant they came from. Which assistant that
 * is comes from the OAuth client of the connection, by the redirect URIs it
 * registered, never from anything the request says about itself.
 */

// Redirect URIs as the assistants register them, and some that are not known.
const REDIRECTS: Record<string, string[]> = {
  'client-claude': ['https://claude.ai/api/mcp/auth_callback'],
  'client-chatgpt': ['https://chatgpt.com/connector_platform_oauth_redirect'],
  'client-muse': ['https://www.meta.ai/oauth/callback'],
  'client-cursor': ['cursor://anysphere.cursor-mcp/oauth/callback'],
  'client-other': ['https://agent.example.org/oauth/cb'],
};

function build(setup: unknown) {
  const servers = {
    getConnectorIds: jest.fn(async () => []),
    getConnectorSummaries: jest.fn(async () => []),
    getSharedGuide: jest.fn(async () => undefined),
    getServerNames: jest.fn(async () => []),
    getServerNamesByOrg: jest.fn(async () => []),
  };
  const controller = new McpEndpointController(
    servers as any,
    { getAllTools: () => [], countByName: () => 0 } as any,
    { executeTool: jest.fn() } as any,
    { getAllowedToolIds: jest.fn(async () => null) } as any,
    { isEnabled: jest.fn(async () => false), lookup: jest.fn() } as any,
    {} as any,
    {
      resolve: jest.fn().mockResolvedValue(null),
      clientRedirectUris: jest.fn(async (id?: string) => (id ? (REDIRECTS[id] ?? []) : [])),
    } as any,
    { create: jest.fn() } as any,
    { get: () => setup } as any,
  );
  (controller as any).serveStateless = jest.fn(
    async (_req: unknown, _res: unknown, _body: unknown, factory: () => McpServer) => {
      factory();
    },
  );
  const connect = (user: Record<string, unknown>) =>
    controller.handleGlobalPost(
      { user, body: { method: 'initialize' }, headers: { host: 'x' } } as any,
      {} as any,
    );
  return { controller, connect };
}

function setupProvider(seen: Array<string | null | undefined> = []) {
  return {
    canSetUp: jest.fn(async (ctx: { assistant?: string | null }) => {
      seen.push(ctx.assistant);
      return true;
    }),
    find: jest.fn(),
    install: jest.fn(),
    status: jest.fn(),
  };
}

describe('shared /mcp: the assistant a setup link returns to', () => {
  const saved = process.env.MCP_SHARED_ENDPOINT_TOOLS;
  beforeAll(() => {
    process.env.MCP_SHARED_ENDPOINT_TOOLS = 'fixed';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.MCP_SHARED_ENDPOINT_TOOLS;
    else process.env.MCP_SHARED_ENDPOINT_TOOLS = saved;
  });

  const user = { sub: 'u-b', organizationId: 'org-B', authMethod: 'jwt' };

  it('comes from the OAuth client of the connection', async () => {
    const seen: Array<string | null | undefined> = [];
    const setup = setupProvider(seen);
    for (const azp of ['client-claude', 'client-chatgpt', 'client-muse', 'client-cursor', 'client-unregistered', undefined]) {
      await build(setup).connect({ ...user, ...(azp ? { azp } : {}) });
    }
    expect(seen).toEqual(['claude', 'chatgpt', 'muse', null, null, null]);
  });

  it('logs a client host that names no known assistant, once, without its path', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { controller, connect } = build(setupProvider());
      jest.spyOn((controller as any).logger, 'log').mockImplementation((m: unknown) => {
        lines.push(String(m));
      });
      await connect({ ...user, azp: 'client-other' });
    }
    const about = lines.filter((l) => l.includes('agent.example.org'));
    expect(about).toHaveLength(1);
    expect(about[0]).not.toContain('/oauth/cb');
  });
});
