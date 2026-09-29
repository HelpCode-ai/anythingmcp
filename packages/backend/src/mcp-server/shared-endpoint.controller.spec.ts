import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { McpEndpointController } from './mcp-endpoint.controller';
import { SHARED_TOOL_NAMES } from './shared-toolset';
import type { RegisteredTool } from './tool-registry';

/**
 * The shared `/mcp` in `fixed` mode, end to end through the controller: the
 * scope comes from `attachVisibleTools` (grant, then role) and every run goes
 * to the executor pinned to the one connector that owns the tool.
 */
function tool(
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
    description: `${name} (${organizationId})`,
    parameters: {},
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://example.com', authType: 'NONE' },
    endpointMapping: { method: 'GET', path: '/' },
  };
}

// The same tool name in two workspaces: the collision that once ran another
// tenant's connector with their credentials.
const ALL = [
  tool('t-a1', 'crm_find_customer', 'org-A', 'conn-A1'),
  tool('t-a2', 'crm_list_deals', 'org-A', 'conn-A1'),
  tool('t-b1', 'crm_find_customer', 'org-B', 'conn-B1'),
];

function build(opts: { grant?: unknown; allowedByOrg?: Record<string, string[] | null> } = {}) {
  const executor = {
    executeTool: jest.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"ok":true}' }],
      structured: { ok: true },
    })),
  };
  const kg = {
    isEnabled: jest.fn(async () => true),
    lookup: jest.fn(async (org: string) => ({ org })),
  };
  const servers = {
    getConnectorIds: jest.fn(async () => []),
    getConnectorSummaries: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: `Connector ${id}`, hasGuide: false })),
    ),
    getSharedGuide: jest.fn(async () => undefined),
    getServerNames: jest.fn(async () => []),
    getServerNamesByOrg: jest.fn(async (org: string) => [{ id: `srv-${org}`, name: 'Default' }]),
  };
  const controller = new McpEndpointController(
    servers as any,
    { getAllTools: () => ALL, countByName: () => 1 } as any,
    executor as any,
    {
      getAllowedToolIds: jest.fn(async (_sub: string, org: string) =>
        opts.allowedByOrg ? (opts.allowedByOrg[org] ?? null) : null,
      ),
    } as any,
    kg as any,
    {} as any,
    { resolve: jest.fn().mockResolvedValue(opts.grant ?? null) } as any,
    { create: jest.fn() } as any,
  );

  // Capture the per-request server instead of serving HTTP, then talk to it
  // with a real MCP client.
  let built: McpServer | undefined;
  (controller as any).serveStateless = jest.fn(
    async (_req: unknown, _res: unknown, _body: unknown, factory: () => McpServer) => {
      built = factory();
    },
  );
  const connect = async (user: Record<string, unknown>) => {
    const req: any = { user, body: { method: 'initialize' }, headers: { host: 'x' } };
    await controller.handleGlobalPost(req, {} as any);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await built!.connect(serverSide);
    const client = new Client({ name: 'spec', version: '1.0.0' });
    await client.connect(clientSide);
    return client;
  };
  return { controller, executor, kg, servers, connect };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args });
  return { isError: !!result.isError, body: JSON.parse(result.content[0].text) };
}

describe('shared /mcp in fixed mode', () => {
  const saved = process.env.MCP_SHARED_ENDPOINT_TOOLS;
  beforeAll(() => {
    process.env.MCP_SHARED_ENDPOINT_TOOLS = 'fixed';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.MCP_SHARED_ENDPOINT_TOOLS;
    else process.env.MCP_SHARED_ENDPOINT_TOOLS = saved;
  });

  const orgB = { sub: 'u-b', organizationId: 'org-B', authMethod: 'jwt', email: 'b@x.io' };

  it('lists only the fixed tool set', async () => {
    const client = await build().connect(orgB);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...SHARED_TOOL_NAMES].sort());
  });

  it('runs the caller\'s own copy of a colliding tool name, pinned to its connector', async () => {
    const { executor, connect } = build();
    const client = await connect(orgB);

    const search = await call(client, 'anythingmcp_search_tools', { query: 'crm' });
    expect(search.body.tools.map((t: any) => t.connectorId)).toEqual(['conn-B1']);

    const res = await call(client, 'anythingmcp_run_read_tool', { tool: 'crm_find_customer' });
    expect(res.isError).toBe(false);
    expect(executor.executeTool).toHaveBeenCalledTimes(1);
    const [name, , ctx] = executor.executeTool.mock.calls[0] as any[];
    expect(name).toBe('crm_find_customer');
    expect(ctx).toMatchObject({
      organizationId: 'org-B',
      connectorIds: ['conn-B1'],
      userId: 'u-b',
      userEmail: 'b@x.io',
    });
    // The executor's `structured` field never leaves the server.
    expect(JSON.stringify(res.body)).toBe('{"ok":true}');
  });

  it('cannot reach a tool of another workspace, even by naming its connector', async () => {
    const { executor, connect } = build();
    const client = await connect(orgB);
    const res = await call(client, 'anythingmcp_run_read_tool', {
      tool: 'crm_list_deals',
    });
    expect(res.isError).toBe(true);
    const pinned = await call(client, 'anythingmcp_run_read_tool', {
      tool: 'crm_find_customer',
      connector: 'conn-A1',
    });
    expect(pinned.isError).toBe(true);
    expect(executor.executeTool).not.toHaveBeenCalled();
  });

  it('applies the MCP role before anything is searchable', async () => {
    const { executor, connect } = build({ allowedByOrg: { 'org-A': ['t-a2'] } });
    const client = await connect({ sub: 'u-a', organizationId: 'org-A', authMethod: 'jwt' });
    const search = await call(client, 'anythingmcp_search_tools', {});
    expect(search.body.tools.map((t: any) => t.name)).toEqual(['crm_list_deals']);
    const denied = await call(client, 'anythingmcp_run_read_tool', { tool: 'crm_find_customer' });
    expect(denied.isError).toBe(true);
    expect(executor.executeTool).not.toHaveBeenCalled();
  });

  it('follows a connection grant into another workspace, with that workspace\'s context', async () => {
    const { executor, kg, connect } = build({
      grant: { mode: 'organization', organizationId: 'org-A' },
    });
    const client = await connect({ ...orgB, azp: 'client-1' });
    await call(client, 'anythingmcp_run_read_tool', { tool: 'crm_find_customer' });
    const ctx = (executor.executeTool.mock.calls[0] as any[])[2];
    expect(ctx).toMatchObject({ organizationId: 'org-A', connectorIds: ['conn-A1'] });

    const graph = await call(client, 'kg_how_to_obtain', { query: 'customer_id' });
    expect(graph.body).toEqual({ org: 'org-A' });
    expect(kg.lookup).toHaveBeenCalledWith('org-A', 'customer_id', { connectorIds: ['conn-A1'] });

    const cfg = await call(client, 'anythingmcp_get_configuration_url');
    expect(cfg.body.servers[0].url).toMatch(/\/mcp\/srv-org-A$/);
  });

  it('answers GET and DELETE with 405 for an identified caller', async () => {
    const { controller } = build();
    for (const method of ['handleGlobalGet', 'handleGlobalDelete'] as const) {
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await (controller as any)[method]({ user: orgB }, res);
      expect(res.status).toHaveBeenCalledWith(405);
    }
  });
});

describe('shared /mcp in direct mode', () => {
  const saved = process.env.MCP_SHARED_ENDPOINT_TOOLS;
  afterAll(() => {
    if (saved === undefined) delete process.env.MCP_SHARED_ENDPOINT_TOOLS;
    else process.env.MCP_SHARED_ENDPOINT_TOOLS = saved;
  });

  it('keeps listing the workspace\'s own tools', async () => {
    process.env.MCP_SHARED_ENDPOINT_TOOLS = 'direct';
    const { controller } = build();
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const prev = process.env.MCP_STREAMABLE_JSON_RESPONSE;
    process.env.MCP_STREAMABLE_JSON_RESPONSE = 'true';
    try {
      await controller.handleGlobalPost(
        { user: { sub: 'u-b', organizationId: 'org-B' }, body: { method: 'tools/list', id: 1 } } as any,
        res,
      );
    } finally {
      if (prev === undefined) delete process.env.MCP_STREAMABLE_JSON_RESPONSE;
      else process.env.MCP_STREAMABLE_JSON_RESPONSE = prev;
    }
    const listed = res.json.mock.calls[0][0].result.tools.map((t: any) => t.name);
    expect(listed).toEqual(['crm_find_customer']);
    expect((controller as any).serveStateless).not.toHaveBeenCalled();
  });
});
