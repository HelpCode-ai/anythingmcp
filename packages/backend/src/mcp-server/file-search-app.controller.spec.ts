import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { McpEndpointController } from './mcp-endpoint.controller';
import { FILE_SEARCH_APP_INSTRUCTIONS, FILE_SEARCH_APP_TOOL_NAMES } from './file-search-app-toolset';
import { CHATGPT_APP_TOOL_NAMES } from './chatgpt-app-toolset';
import type { RegisteredTool } from './tool-registry';
import { withRegistryIndexes } from './registry-test-double';

/**
 * `/mcp/file-search` end to end through the controller: the same scope as the
 * shared `/mcp` (grant, then role), the fixed File Search plugin tool set
 * whatever the deployment mode or OAuth client, and every call run by the
 * executor pinned to the one connector that owns it.
 */
function fileTool(id: string, name: string, method: string, organizationId: string, connectorId: string): RegisteredTool {
  return {
    id,
    connectorId,
    organizationId,
    name,
    description: name,
    parameters: {},
    connectorType: 'FILE_SEARCH',
    connectorConfig: { baseUrl: 'sftp://files:22/', authType: 'BASIC_AUTH', config: { fileSearch: { protocol: 'sftp' } } },
    endpointMapping: { method, path: '' },
  };
}

// The same generated tool names in two workspaces, and a database next to them.
const ALL: RegisteredTool[] = [
  fileTool('t-a1', 'files_search', 'file_search', 'org-A', 'fs-A'),
  fileTool('t-a2', 'files_read', 'file_read', 'org-A', 'fs-A'),
  fileTool('t-b1', 'files_search', 'file_search', 'org-B', 'fs-B'),
  fileTool('t-b2', 'files_read', 'file_read', 'org-B', 'fs-B'),
  {
    ...fileTool('t-a3', 'execute_query', 'query', 'org-A', 'db-A'),
    connectorType: 'DATABASE',
    endpointMapping: { method: 'query', path: '${query}' },
  },
];

function build(opts: { allowedByOrg?: Record<string, string[] | null> } = {}) {
  const executor = {
    executeTool: jest.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"files":[]}' }],
      structured: { files: [] },
    })),
  };
  const servers = {
    getConnectorIds: jest.fn(async () => []),
    getConnectorSummaries: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: `Folder ${id}`, hasGuide: false })),
    ),
    getSharedGuide: jest.fn(async () => undefined),
    getServerNames: jest.fn(async () => []),
    getServerNamesByOrg: jest.fn(async () => []),
    activityByConnector: jest.fn(async () => []),
  };
  const setup = { get: jest.fn(() => ({ canSetUp: jest.fn(async () => true) })) };
  const controller = new McpEndpointController(
    servers as any,
    withRegistryIndexes({ getAllTools: () => ALL, countByName: () => 2 }) as any,
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
      clientRedirectUris: jest.fn(async () => ['https://chatgpt.com/connector_platform_oauth_redirect']),
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
  const connect = async (user: Record<string, unknown>, route: 'file-search' | 'chatgpt-app' = 'file-search') => {
    holder.built = undefined;
    const req: any = { user, body: { method: 'initialize' }, headers: { host: 'x' } };
    const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
    if (route === 'file-search') await controller.handleFileSearchAppPost(req, res);
    else await controller.handleChatgptAppPost(req, res);
    const built = holder.built as McpServer | undefined;
    if (!built) return { client: undefined, res };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await built.connect(serverSide);
    const client = new Client({ name: 'spec', version: '1.0.0' });
    await client.connect(clientSide);
    return { client, res };
  };
  return { executor, setup, connect };
}

const orgA = { sub: 'u-a', organizationId: 'org-A', authMethod: 'jwt', email: 'a@x.io' };

describe('/mcp/file-search', () => {
  const saved = process.env.MCP_SHARED_ENDPOINT_TOOLS;
  afterEach(() => {
    if (saved === undefined) delete process.env.MCP_SHARED_ENDPOINT_TOOLS;
    else process.env.MCP_SHARED_ENDPOINT_TOOLS = saved;
  });

  it.each(['fixed', 'direct'])('serves the File Search tool set in %s mode, for any OAuth client', async (mode) => {
    process.env.MCP_SHARED_ENDPOINT_TOOLS = mode;
    const { connect } = build();
    const { client } = await connect(orgA);
    const names = (await client!.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...FILE_SEARCH_APP_TOOL_NAMES].sort());
    expect(client!.getInstructions()).toBe(FILE_SEARCH_APP_INSTRUCTIONS);
  });

  it('leaves /mcp/chatgpt-app serving its own tool set', async () => {
    const { connect } = build();
    const { client } = await connect(orgA, 'chatgpt-app');
    const names = (await client!.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...CHATGPT_APP_TOOL_NAMES].sort());
  });

  it("searches only the caller's own folder, in its own connector", async () => {
    const { connect, executor } = build();
    const { client } = await connect(orgA);
    await client!.callTool({ name: 'search_documents', arguments: { query: 'Nordtor' } });
    expect(executor.executeTool).toHaveBeenCalledTimes(1);
    expect(executor.executeTool).toHaveBeenCalledWith(
      'files_search',
      { query: 'Nordtor' },
      expect.objectContaining({ organizationId: 'org-A', connectorIds: ['fs-A'] }),
    );
    const other: any = await client!.callTool({ name: 'read_document', arguments: { source: 'fs-B', path: 'a.pdf' } });
    expect(other.isError).toBe(true);
    expect(executor.executeTool).toHaveBeenCalledTimes(1);
  });

  it("applies the caller's MCP role", async () => {
    const { connect, executor } = build({ allowedByOrg: { 'org-A': ['t-a1'] } });
    const { client } = await connect(orgA);
    const read: any = await client!.callTool({ name: 'read_document', arguments: { path: 'a.pdf' } });
    expect(read.isError).toBe(true);
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
