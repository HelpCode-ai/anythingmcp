import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { McpEndpointController } from './mcp-endpoint.controller';
import { CHATGPT_APP_INSTRUCTIONS, CHATGPT_APP_TOOL_NAMES } from './chatgpt-app-toolset';
import type { RegisteredTool } from './tool-registry';

/**
 * `/mcp/chatgpt-app` end to end through the controller: the same scope as the
 * shared `/mcp` (grant, then role), the fixed plugin tool set whatever the
 * deployment mode or OAuth client, and every query run by the executor pinned
 * to the one connector that owns it.
 */
function dbTool(
  id: string,
  name: string,
  organizationId: string,
  connectorId: string,
): RegisteredTool {
  return {
    id,
    connectorId,
    organizationId,
    name,
    description: name,
    parameters: {},
    connectorType: 'DATABASE',
    connectorConfig: { baseUrl: 'postgresql://u:p@db/x', authType: 'NONE', config: {} },
    endpointMapping:
      name.endsWith('execute_query')
        ? { method: 'query', path: '${query}' }
        : { method: 'query', path: 'SELECT 1' },
  };
}

// The same generated tool names in two workspaces.
const ALL = [
  dbTool('t-a1', 'execute_query', 'org-A', 'db-A'),
  dbTool('t-a2', 'get_database_schema', 'org-A', 'db-A'),
  dbTool('t-b1', 'execute_query', 'org-B', 'db-B'),
  dbTool('t-b2', 'get_database_schema', 'org-B', 'db-B'),
];

function build(opts: { allowedByOrg?: Record<string, string[] | null> } = {}) {
  const executor = {
    executeTool: jest.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"rows":[]}' }],
      structured: { rows: [] },
    })),
  };
  const servers = {
    getConnectorIds: jest.fn(async () => []),
    getConnectorSummaries: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: `Database ${id}`, hasGuide: false })),
    ),
    getSharedGuide: jest.fn(async () => undefined),
    getServerNames: jest.fn(async () => []),
    getServerNamesByOrg: jest.fn(async () => []),
    activityByConnector: jest.fn(async () => []),
  };
  const setup = { get: jest.fn(() => ({ canSetUp: jest.fn(async () => true) })) };
  const controller = new McpEndpointController(
    servers as any,
    { getAllTools: () => ALL, countByName: () => 2 } as any,
    executor as any,
    {
      getAllowedToolIds: jest.fn(async (_sub: string, org: string) =>
        opts.allowedByOrg ? (opts.allowedByOrg[org] ?? null) : null,
      ),
    } as any,
    { isEnabled: jest.fn(async () => false) } as any,
    {} as any,
    {
      resolve: jest.fn().mockResolvedValue(null),
      clientRedirectUris: jest.fn(async () => ['https://claude.ai/api/mcp/auth_callback']),
    } as any,
    { create: jest.fn(), hasVisible: jest.fn().mockResolvedValue(false) } as any,
    setup as any,
  );

  const holder: { built?: McpServer } = {};
  (controller as any).serveStateless = jest.fn(
    async (_req: unknown, _res: unknown, _body: unknown, factory: () => McpServer) => {
      holder.built = factory();
    },
  );
  const connect = async (user: Record<string, unknown>) => {
    holder.built = undefined;
    const req: any = { user, body: { method: 'initialize' }, headers: { host: 'x' } };
    const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
    await controller.handleChatgptAppPost(req, res);
    const built = holder.built as McpServer | undefined;
    if (!built) return { client: undefined, res };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await built.connect(serverSide);
    const client = new Client({ name: 'spec', version: '1.0.0' });
    await client.connect(clientSide);
    return { client, res };
  };
  return { executor, servers, setup, connect };
}

const orgA = { sub: 'u-a', organizationId: 'org-A', authMethod: 'jwt', email: 'a@x.io' };

describe('/mcp/chatgpt-app', () => {
  const saved = process.env.MCP_SHARED_ENDPOINT_TOOLS;
  afterEach(() => {
    if (saved === undefined) delete process.env.MCP_SHARED_ENDPOINT_TOOLS;
    else process.env.MCP_SHARED_ENDPOINT_TOOLS = saved;
  });

  it.each(['fixed', 'direct'])(
    'serves the plugin tool set in %s mode, for any OAuth client',
    async (mode) => {
      process.env.MCP_SHARED_ENDPOINT_TOOLS = mode;
      const { connect } = build();
      const { client } = await connect(orgA);
      const names = (await client!.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...CHATGPT_APP_TOOL_NAMES].sort());
      expect(client!.getInstructions()).toBe(CHATGPT_APP_INSTRUCTIONS);
    },
  );

  it('queries only the caller\'s own database, in its own connector', async () => {
    const { connect, executor } = build();
    const { client } = await connect(orgA);
    const list: any = await client!.callTool({ name: 'anythingmcp_list_databases', arguments: {} });
    expect(JSON.parse(list.content[0].text).databases).toEqual([
      { id: 'db-A', name: 'Database db-A', engine: 'PostgreSQL' },
    ]);

    await client!.callTool({
      name: 'anythingmcp_query_database',
      arguments: { database: 'db-A', query: 'SELECT 1' },
    });
    expect(executor.executeTool).toHaveBeenCalledWith(
      'execute_query',
      { query: 'SELECT 1' },
      expect.objectContaining({ organizationId: 'org-A', connectorIds: ['db-A'] }),
    );

    const other: any = await client!.callTool({
      name: 'anythingmcp_query_database',
      arguments: { database: 'db-B', query: 'SELECT 1' },
    });
    expect(other.isError).toBe(true);
    expect(executor.executeTool).toHaveBeenCalledTimes(1);
  });

  it('applies the caller\'s MCP role', async () => {
    const { connect, executor } = build({ allowedByOrg: { 'org-A': ['t-a2'] } });
    const { client } = await connect(orgA);
    const q: any = await client!.callTool({
      name: 'anythingmcp_query_database',
      arguments: { database: 'db-A', query: 'SELECT 1' },
    });
    expect(q.isError).toBe(true);
    expect(executor.executeTool).not.toHaveBeenCalled();
  });

  it('does not resolve the setup permission, which it has no tools for', async () => {
    const { connect, setup } = build();
    await connect(orgA);
    const provider = setup.get.mock.results[0]?.value;
    expect(provider?.canSetUp).not.toHaveBeenCalled();
  });

  it('refuses operator credentials that name no user', async () => {
    const { connect } = build();
    const { client, res } = await connect({ authMethod: 'static_api_key' });
    expect(client).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
