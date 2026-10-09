import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { McpEndpointController } from './mcp-endpoint.controller';
import { CHATGPT_EXTRA_TOOL_NAMES, SHARED_TOOL_NAMES } from './shared-toolset';
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

// One workspace, two servers: srv-A1 serves conn-A1, srv-A2 serves conn-A2.
const TWO_SERVERS = [
  ...ALL.filter((t) => t.organizationId === 'org-A'),
  tool('t-a3', 'erp_list_orders', 'org-A', 'conn-A2'),
];
const SERVER_CONNECTORS = { 'srv-A1': ['conn-A1'], 'srv-A2': ['conn-A2'] };
const keyForServerA = {
  sub: 'u-a',
  organizationId: 'org-A',
  authMethod: 'mcp_api_key',
  apiKeyName: 'agent',
  mcpServerId: 'srv-A1',
};

// Redirect URIs as the two assistants register them in production.
const REDIRECTS: Record<string, string[]> = {
  'client-claude': ['https://claude.ai/api/mcp/auth_callback'],
  'client-chatgpt': ['https://chatgpt.com/connector_platform_oauth_redirect'],
};

function build(
  opts: {
    grant?: unknown;
    allowedByOrg?: Record<string, string[] | null>;
    tools?: RegisteredTool[];
    serverConnectors?: Record<string, string[]>;
  } = {},
) {
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
    getConnectorIds: jest.fn(async (id: string) => opts.serverConnectors?.[id] ?? []),
    getConnectorSummaries: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: `Connector ${id}`, hasGuide: false })),
    ),
    getSharedGuide: jest.fn(async () => undefined),
    getServerNames: jest.fn(async () => []),
    getServerNamesByOrg: jest.fn(async (org: string) => [{ id: `srv-${org}`, name: 'Default' }]),
  };
  const controller = new McpEndpointController(
    servers as any,
    { getAllTools: () => opts.tools ?? ALL, countByName: () => 1 } as any,
    executor as any,
    {
      getAllowedToolIds: jest.fn(async (_sub: string, org: string) =>
        opts.allowedByOrg ? (opts.allowedByOrg[org] ?? null) : null,
      ),
    } as any,
    kg as any,
    {} as any,
    {
      resolve: jest.fn().mockResolvedValue(opts.grant ?? null),
      clientRedirectUris: jest.fn(async (id?: string) => (id ? (REDIRECTS[id] ?? []) : [])),
    } as any,
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

  it('gives a Claude connection exactly the reviewed set, with the Claude instructions', async () => {
    const claude = await build().connect({ ...orgB, azp: 'client-claude' });
    const plain = await build().connect(orgB);
    const listClaude = (await claude.listTools()).tools;
    expect(listClaude.map((t) => t.name).sort()).toEqual([...SHARED_TOOL_NAMES].sort());
    expect(JSON.stringify(listClaude)).toBe(JSON.stringify((await plain.listTools()).tools));
    expect(claude.getInstructions()).toBe(plain.getInstructions());
  });

  it('gives a ChatGPT connection the reviewed set plus the ChatGPT tools', async () => {
    const client = await build().connect({ ...orgB, azp: 'client-chatgpt' });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...SHARED_TOOL_NAMES, ...CHATGPT_EXTRA_TOOL_NAMES].sort());
    expect(client.getInstructions()).toMatch(/anythingmcp_run_read_steps/);
  });

  it('falls back to the reviewed set for an unknown client or an API key', async () => {
    for (const user of [
      { ...orgB, azp: 'client-unregistered' },
      { ...orgB, authMethod: 'api_key', mcpServerId: undefined },
    ]) {
      const client = await build().connect(user);
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...SHARED_TOOL_NAMES].sort());
    }
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

  it('limits a key created for a server to that server\'s tools', async () => {
    const { executor, connect } = build({ tools: TWO_SERVERS, serverConnectors: SERVER_CONNECTORS });
    const client = await connect(keyForServerA);
    const search = await call(client, 'anythingmcp_search_tools', {});
    expect(search.body.tools.map((t: any) => t.name).sort()).toEqual(['crm_find_customer', 'crm_list_deals']);

    const other = await call(client, 'anythingmcp_run_read_tool', { tool: 'erp_list_orders' });
    expect(other.isError).toBe(true);
    expect(executor.executeTool).not.toHaveBeenCalled();

    const own = await call(client, 'anythingmcp_run_read_tool', { tool: 'crm_list_deals' });
    expect(own.isError).toBe(false);
    expect((executor.executeTool.mock.calls[0] as any[])[2]).toMatchObject({ connectorIds: ['conn-A1'] });
  });

  it('gives a key without a server, and an OAuth token, the whole workspace', async () => {
    for (const user of [
      { ...keyForServerA, mcpServerId: null },
      { sub: 'u-a', organizationId: 'org-A', authMethod: 'jwt' },
    ]) {
      const client = await build({ tools: TWO_SERVERS, serverConnectors: SERVER_CONNECTORS }).connect(user);
      const search = await call(client, 'anythingmcp_search_tools', {});
      expect(search.body.tools.map((t: any) => t.name).sort()).toEqual([
        'crm_find_customer',
        'crm_list_deals',
        'erp_list_orders',
      ]);
    }
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

  it('lists only its server\'s tools to a key created for a server, and refuses the others', async () => {
    process.env.MCP_SHARED_ENDPOINT_TOOLS = 'direct';
    const prev = process.env.MCP_STREAMABLE_JSON_RESPONSE;
    process.env.MCP_STREAMABLE_JSON_RESPONSE = 'true';
    try {
      const listFor = async (user: Record<string, unknown>) => {
        const { controller } = build({ tools: TWO_SERVERS, serverConnectors: SERVER_CONNECTORS });
        const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        await controller.handleGlobalPost({ user, body: { method: 'tools/list', id: 1 } } as any, res);
        return res.json.mock.calls[0][0].result.tools.map((t: any) => t.name).sort();
      };
      expect(await listFor({ ...keyForServerA })).toEqual(['crm_find_customer', 'crm_list_deals']);
      expect(await listFor({ ...keyForServerA, mcpServerId: null })).toEqual([
        'crm_find_customer',
        'crm_list_deals',
        'erp_list_orders',
      ]);

      const { controller } = build({ tools: TWO_SERVERS, serverConnectors: SERVER_CONNECTORS });
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await controller.handleGlobalPost(
        {
          user: { ...keyForServerA },
          body: { method: 'tools/call', id: 2, params: { name: 'erp_list_orders', arguments: {} } },
        } as any,
        res,
      );
      expect(res.json.mock.calls[0][0].error.message).toMatch(/not available to you/);
    } finally {
      if (prev === undefined) delete process.env.MCP_STREAMABLE_JSON_RESPONSE;
      else process.env.MCP_STREAMABLE_JSON_RESPONSE = prev;
    }
  });
});
