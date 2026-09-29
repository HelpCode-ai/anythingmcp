import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { RegisteredTool } from './tool-registry';
import {
  SHARED_TOOL_NAMES,
  SHARED_TOOLSET_INSTRUCTIONS,
  SharedToolsetDeps,
  excludedOnSharedEndpoint,
  registerSharedToolset,
  sharedEndpointMode,
} from './shared-toolset';

function tool(p: Partial<RegisteredTool> & { name: string; connectorId: string }): RegisteredTool {
  return {
    id: `${p.connectorId}:${p.name}`,
    organizationId: 'org-A',
    description: `${p.name} description`,
    parameters: {},
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://api.example.com', authType: 'NONE' },
    endpointMapping: { method: 'GET', path: '/x' },
    ...p,
  } as RegisteredTool;
}

const CRM_READ = tool({
  name: 'crm_find_customer',
  connectorId: 'c-crm',
  description: 'Find a customer by email address',
  parameters: {
    type: 'object',
    properties: { email: { type: 'string', description: 'Customer email' } },
    required: ['email'],
  },
});
const CRM_WRITE = tool({
  name: 'crm_create_deal',
  connectorId: 'c-crm',
  description: 'Create a deal for a customer',
  endpointMapping: { method: 'POST', path: '/deals' },
  parameters: {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
  },
});
const WISE_PAY = tool({
  name: 'wise_create_transfer',
  connectorId: 'c-wise',
  endpointMapping: { method: 'POST', path: '/transfers' },
  connectorConfig: {
    baseUrl: 'https://api.wise.com',
    authType: 'BEARER_TOKEN',
    config: { adapterSlug: 'wise' },
  },
});

function makeDeps(overrides: Partial<SharedToolsetDeps> = {}) {
  const deps = {
    execute: jest.fn(async (t: RegisteredTool, args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ran: t.id, args }) }],
    })),
    connectors: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: id === 'c-crm' ? 'Acme CRM' : id, hasGuide: id === 'c-crm' })),
    ),
    guide: jest.fn(async () => '## Acme CRM\nUse emails in lower case.'),
    kgLookup: jest.fn(async () => ({ entities: [] })),
    configuration: jest.fn(async () => ({
      dashboardUrl: 'https://cloud.example.com/connectors',
      servers: [{ name: 'Default', url: 'https://cloud.example.com/mcp/srv-1' }],
    })),
    ...overrides,
  };
  return deps;
}

async function connect(scope: RegisteredTool[], deps = makeDeps()) {
  const server = new McpServer(
    { name: 'AnythingMCP', version: 'test' },
    { instructions: SHARED_TOOLSET_INSTRUCTIONS },
  );
  registerSharedToolset(server, scope, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'spec', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, deps };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { isError: !!result.isError, body };
}

describe('shared /mcp tool set', () => {
  it('lists the same eight tools, schemas and annotations whatever the caller can reach', async () => {
    const a = await connect([CRM_READ, CRM_WRITE]);
    const b = await connect([]);
    const listA = (await a.client.listTools()).tools;
    const listB = (await b.client.listTools()).tools;

    expect(listA.map((t) => t.name).sort()).toEqual([...SHARED_TOOL_NAMES].sort());
    expect(JSON.stringify(listA)).toEqual(JSON.stringify(listB));
    expect(a.client.getInstructions()).toBe(SHARED_TOOLSET_INSTRUCTIONS);
    expect(b.client.getInstructions()).toBe(SHARED_TOOLSET_INSTRUCTIONS);
  });

  it('annotates the read runner read-only and the write runner destructive', async () => {
    const { client } = await connect([]);
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    expect(byName.get('anythingmcp_run_read_tool')?.annotations?.readOnlyHint).toBe(true);
    const write = byName.get('anythingmcp_run_write_tool')?.annotations;
    expect(write?.readOnlyHint).toBe(false);
    expect(write?.destructiveHint).toBe(true);
    for (const name of SHARED_TOOL_NAMES) {
      if (name === 'anythingmcp_run_write_tool') continue;
      expect(byName.get(name)?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('searches only the caller\'s tools and reports read or write access', async () => {
    const { client } = await connect([CRM_READ, CRM_WRITE]);
    const { body } = await call(client, 'anythingmcp_search_tools', { query: 'customer email' });
    expect(body.tools[0]).toMatchObject({
      name: 'crm_find_customer',
      connector: 'Acme CRM',
      access: 'read',
    });

    const writes = await call(client, 'anythingmcp_search_tools', { access: 'write' });
    expect(writes.body.tools.map((t: any) => t.name)).toEqual(['crm_create_deal']);
  });

  it('runs a read tool in exactly its own connector, with validated arguments', async () => {
    const { client, deps } = await connect([CRM_READ, CRM_WRITE]);
    const res = await call(client, 'anythingmcp_run_read_tool', {
      tool: 'crm_find_customer',
      arguments: { email: 'a@b.c', unexpected: 1 },
    });
    expect(res.isError).toBe(false);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    const [ranTool, ranArgs] = (deps.execute as jest.Mock).mock.calls[0];
    expect(ranTool).toBe(CRM_READ);
    expect(ranArgs).toEqual({ email: 'a@b.c' });
  });

  it('refuses a write tool on the read runner and a read tool on the write runner', async () => {
    const { client, deps } = await connect([CRM_READ, CRM_WRITE]);
    const viaRead = await call(client, 'anythingmcp_run_read_tool', {
      tool: 'crm_create_deal',
      arguments: { title: 'x' },
    });
    expect(viaRead.isError).toBe(true);
    expect(viaRead.body.error).toMatch(/anythingmcp_run_write_tool/);

    const viaWrite = await call(client, 'anythingmcp_run_write_tool', {
      tool: 'crm_find_customer',
      arguments: { email: 'a@b.c' },
    });
    expect(viaWrite.isError).toBe(true);
    expect(deps.execute).not.toHaveBeenCalled();

    const ok = await call(client, 'anythingmcp_run_write_tool', {
      tool: 'crm_create_deal',
      arguments: { title: 'x' },
    });
    expect(ok.isError).toBe(false);
    expect((deps.execute as jest.Mock).mock.calls[0][0]).toBe(CRM_WRITE);
  });

  it('returns the schema when the arguments are invalid, without running anything', async () => {
    const { client, deps } = await connect([CRM_READ]);
    const res = await call(client, 'anythingmcp_run_read_tool', {
      tool: 'crm_find_customer',
      arguments: {},
    });
    expect(res.isError).toBe(true);
    expect(res.body.issues[0].path).toBe('email');
    expect(res.body.inputSchema.required).toEqual(['email']);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('never reaches another workspace\'s tool of the same name', async () => {
    // Org B has a tool named exactly like org A's. The caller's scope holds
    // only org B's connector, so org A's tool must be neither found, described
    // nor run, and org B's own copy must be the one that runs.
    const ownCopy = tool({ ...CRM_READ, connectorId: 'b-sales', organizationId: 'org-B' });
    const { client, deps } = await connect([ownCopy]);

    const search = await call(client, 'anythingmcp_search_tools', { query: 'crm_find_customer' });
    expect(search.body.tools.map((t: any) => t.connectorId)).toEqual(['b-sales']);

    const other = await call(client, 'anythingmcp_describe_tool', {
      tool: 'crm_find_customer',
      connector: 'c-crm',
    });
    expect(other.isError).toBe(true);

    await call(client, 'anythingmcp_run_read_tool', {
      tool: 'crm_find_customer',
      arguments: { email: 'a@b.c' },
    });
    expect((deps.execute as jest.Mock).mock.calls[0][0]).toBe(ownCopy);

    const empty = await connect([]);
    const none = await call(empty.client, 'anythingmcp_run_read_tool', {
      tool: 'crm_find_customer',
      arguments: { email: 'a@b.c' },
    });
    expect(none.isError).toBe(true);
    expect(empty.deps.execute).not.toHaveBeenCalled();
  });

  it('asks which connector when two in scope share a tool name', async () => {
    const second = tool({ ...CRM_READ, connectorId: 'c-crm-2' });
    const { client, deps } = await connect([CRM_READ, second]);
    const ambiguous = await call(client, 'anythingmcp_run_read_tool', {
      tool: 'crm_find_customer',
      arguments: { email: 'a@b.c' },
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.body.connectors.map((c: any) => c.id).sort()).toEqual(['c-crm', 'c-crm-2']);

    await call(client, 'anythingmcp_run_read_tool', {
      tool: 'crm_find_customer',
      connector: 'c-crm-2',
      arguments: { email: 'a@b.c' },
    });
    expect((deps.execute as jest.Mock).mock.calls[0][0]).toBe(second);
  });

  it('does not serve payment, banking or trading connectors', async () => {
    expect(excludedOnSharedEndpoint(WISE_PAY)).toBe(true);
    expect(excludedOnSharedEndpoint(CRM_WRITE)).toBe(false);
    expect(
      excludedOnSharedEndpoint(
        tool({ name: 'x', connectorId: 'c', connectorConfig: { baseUrl: '', authType: 'NONE', config: { adapterSlug: 'sorare' } } }),
      ),
    ).toBe(true);

    const { client, deps } = await connect([CRM_READ, WISE_PAY]);
    const search = await call(client, 'anythingmcp_search_tools', {});
    expect(search.body.tools.map((t: any) => t.name)).not.toContain('wise_create_transfer');

    const run = await call(client, 'anythingmcp_run_write_tool', {
      tool: 'wise_create_transfer',
      arguments: {},
    });
    expect(run.isError).toBe(true);
    expect(run.body.error).toMatch(/payment, banking or trading/);
    expect(deps.execute).not.toHaveBeenCalled();

    const list = await call(client, 'anythingmcp_list_connectors');
    expect(list.body.connectors.map((c: any) => c.id)).toEqual(['c-crm']);
    expect(list.body.notServedHere).toEqual(['c-wise']);
  });

  it('keeps kg_how_to_obtain listed and says so when the graph is off', async () => {
    const { client } = await connect(
      [CRM_READ],
      makeDeps({ kgLookup: jest.fn(async () => null) }),
    );
    const res = await call(client, 'kg_how_to_obtain', { query: 'customer_id' });
    expect(res.isError).toBe(false);
    expect(res.body.enabled).toBe(false);
  });

  it('returns the workspace guide as tool output, scoped to one connector on request', async () => {
    const { client, deps } = await connect([CRM_READ, WISE_PAY]);
    const all = await call(client, 'anythingmcp_get_workspace_guide');
    expect(all.body).toContain('Use emails in lower case.');
    // The excluded connector's notes are not requested either.
    expect(deps.guide).toHaveBeenCalledWith(['c-crm'], true);

    await call(client, 'anythingmcp_get_workspace_guide', { connector: 'acme crm' });
    expect(deps.guide).toHaveBeenLastCalledWith(['c-crm'], false);

    // A partial name is enough when no connector matches exactly.
    await call(client, 'anythingmcp_get_workspace_guide', { connector: 'acme' });
    expect(deps.guide).toHaveBeenLastCalledWith(['c-crm'], false);
  });

  it('defaults to the fixed set on the cloud only, with an explicit override', () => {
    const saved = { mode: process.env.DEPLOYMENT_MODE, tools: process.env.MCP_SHARED_ENDPOINT_TOOLS };
    try {
      delete process.env.MCP_SHARED_ENDPOINT_TOOLS;
      process.env.DEPLOYMENT_MODE = 'cloud';
      expect(sharedEndpointMode()).toBe('fixed');
      process.env.DEPLOYMENT_MODE = 'self-hosted';
      expect(sharedEndpointMode()).toBe('direct');
      process.env.MCP_SHARED_ENDPOINT_TOOLS = 'fixed';
      expect(sharedEndpointMode()).toBe('fixed');
    } finally {
      for (const [k, v] of [
        ['DEPLOYMENT_MODE', saved.mode],
        ['MCP_SHARED_ENDPOINT_TOOLS', saved.tools],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
