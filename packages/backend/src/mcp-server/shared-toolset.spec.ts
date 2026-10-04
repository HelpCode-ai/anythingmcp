import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { RegisteredTool } from './tool-registry';
import {
  CHATGPT_EXTRA_TOOL_NAMES,
  SHARED_TOOL_NAMES,
  SHARED_TOOLSET_INSTRUCTIONS,
  SharedToolsetDeps,
  SharedToolsetProfile,
  excludedOnSharedEndpoint,
  profileForRedirectUris,
  registerSharedToolset,
  sharedEndpointMode,
  sharedToolsetInstructions,
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
    connectorUrl: (id: string) => `https://cloud.example.com/connectors/${id}`,
    configuration: jest.fn(async () => ({
      dashboardUrl: 'https://cloud.example.com/connectors',
      servers: [{ name: 'Default', url: 'https://cloud.example.com/mcp/srv-1' }],
    })),
    ...overrides,
  };
  return deps;
}

async function connect(
  scope: RegisteredTool[],
  deps = makeDeps(),
  profile: SharedToolsetProfile = 'default',
) {
  const server = new McpServer(
    { name: 'AnythingMCP', version: 'test' },
    { instructions: sharedToolsetInstructions(profile) },
  );
  registerSharedToolset(server, scope, deps, profile);
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

describe('connectors that are not set up yet', () => {
  const ETSY_PENDING = tool({
    name: 'etsy_get_shop',
    connectorId: 'c-etsy',
    setupStatus: 'needs_authorization',
  });

  it('are not offered to the model, but named with where to finish them', async () => {
    const { client } = await connect([CRM_READ, ETSY_PENDING]);
    const list = await call(client, 'anythingmcp_list_connectors');
    expect(list.body.connectors.map((c: any) => c.id)).toEqual(['c-crm']);
    expect(list.body.needsSetup).toEqual([
      {
        name: 'c-etsy',
        status: 'needs_authorization',
        whatIsMissing: 'it has to be authorized with the provider',
        finishSetupUrl: 'https://cloud.example.com/connectors/c-etsy',
      },
    ]);
    const search = await call(client, 'anythingmcp_search_tools', { query: 'etsy shop' });
    expect(JSON.stringify(search.body)).not.toContain('etsy_get_shop');
  });

  it('answer a call by name with the link instead of running it', async () => {
    const { client, deps } = await connect([CRM_READ, ETSY_PENDING]);
    const out = await call(client, 'anythingmcp_run_read_tool', { tool: 'etsy_get_shop', arguments: {} });
    expect(out.isError).toBe(true);
    expect(out.body.error).toContain('not set up yet');
    expect(out.body.error).toContain('https://cloud.example.com/connectors/c-etsy');
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('drop the empty-workspace hint when the only connector is waiting for setup', async () => {
    const { client } = await connect([ETSY_PENDING]);
    const list = await call(client, 'anythingmcp_list_connectors');
    expect(list.body.connectors).toEqual([]);
    expect(list.body.hint).toBeUndefined();
    expect(list.body.needsSetup).toHaveLength(1);
  });
});

describe('connector setup from the chat (AnythingMCP Setup)', () => {
  function withSetup(run: jest.Mock = jest.fn(async () => ({ body: { results: [] } }))) {
    return makeDeps({ setup: { organizationId: 'org-A', run } } as any);
  }

  it('is offered on an empty workspace, and the hint points the model at it', async () => {
    const { client } = await connect([], withSetup());
    const list = await call(client, 'anythingmcp_list_connectors');
    expect(list.body.connectors).toEqual([
      expect.objectContaining({ id: 'anythingmcp-setup', name: 'AnythingMCP Setup', readTools: 2, writeTools: 1 }),
    ]);
    expect(list.body.hint).toContain('setup_find_connectors');
  });

  it('is found by search and run through the generic run tools', async () => {
    const run = jest.fn(async () => ({ body: { results: [{ adapter: 'etsy' }] } }));
    const { client } = await connect([CRM_READ], withSetup(run));
    const search = await call(client, 'anythingmcp_search_tools', { query: 'connect etsy app' });
    expect(JSON.stringify(search.body)).toContain('setup_find_connectors');
    const out = await call(client, 'anythingmcp_run_read_tool', { tool: 'setup_find_connectors', arguments: { query: 'etsy' } });
    expect(out.isError).toBe(false);
    expect(run).toHaveBeenCalledWith('setup_find_connectors', { query: 'etsy' });
  });

  it('installs only through the write tool, so the client asks the user first', async () => {
    const run = jest.fn(async () => ({ body: { installed: 'Etsy' } }));
    const { client } = await connect([], withSetup(run));
    const viaRead = await call(client, 'anythingmcp_run_read_tool', { tool: 'setup_install_connector', arguments: { adapter: 'etsy' } });
    expect(viaRead.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
    const viaWrite = await call(client, 'anythingmcp_run_write_tool', { tool: 'setup_install_connector', arguments: { adapter: 'etsy' } });
    expect(viaWrite.body).toEqual({ installed: 'Etsy' });
  });

  it('passes an error from the setup service through as an error result', async () => {
    const run = jest.fn(async () => ({ isError: true, body: { error: 'secret' } }));
    const { client } = await connect([], withSetup(run));
    const out = await call(client, 'anythingmcp_run_write_tool', { tool: 'setup_install_connector', arguments: { adapter: 'x' } });
    expect(out).toEqual({ isError: true, body: { error: 'secret' } });
  });

  it('documents itself in the workspace guide', async () => {
    const { client } = await connect([], withSetup());
    const guide = await call(client, 'anythingmcp_get_workspace_guide', { connector: 'AnythingMCP Setup' });
    expect(String(guide.body)).toContain('Never ask the user for passwords, API keys or tokens');
  });

  it('is absent for a caller who may not install connectors', async () => {
    const { client } = await connect([], makeDeps());
    const list = await call(client, 'anythingmcp_list_connectors');
    expect(list.body.connectors).toEqual([]);
    expect(list.body.hint).toContain('anythingmcp_get_configuration_url');
  });

  it('keeps the eight tools the directory reviewed', async () => {
    const { client } = await connect([], withSetup());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...SHARED_TOOL_NAMES].sort());
  });
});

describe('which tool set a client gets', () => {
  it('recognises ChatGPT by the redirect URIs it registered, and nothing else', () => {
    expect(profileForRedirectUris(['https://chatgpt.com/connector_platform_oauth_redirect'])).toBe('chatgpt');
    expect(profileForRedirectUris(['https://chatgpt.com/connector/oauth/CvGqWES8FsNv'])).toBe('chatgpt');
    expect(profileForRedirectUris(['https://platform.openai.com/apps-manage/oauth'])).toBe('chatgpt');
    expect(profileForRedirectUris(['https://claude.ai/api/mcp/auth_callback'])).toBe('default');
    expect(profileForRedirectUris(['cursor://anysphere.cursor-mcp/oauth/callback'])).toBe('default');
    expect(profileForRedirectUris([])).toBe('default');
    expect(profileForRedirectUris(undefined)).toBe('default');
    // Look-alikes and cleartext do not count.
    expect(profileForRedirectUris(['https://chatgpt.com.evil.io/cb'])).toBe('default');
    expect(profileForRedirectUris(['https://notchatgpt.com/cb'])).toBe('default');
    expect(profileForRedirectUris(['http://chatgpt.com/cb'])).toBe('default');
    expect(profileForRedirectUris(['not a url'])).toBe('default');
  });

  it('leaves the default set exactly as the Claude directory reviewed it', async () => {
    const { client } = await connect([CRM_READ, CRM_WRITE]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...SHARED_TOOL_NAMES].sort());
    expect(client.getInstructions()).toBe(SHARED_TOOLSET_INSTRUCTIONS);
    const read = tools.find((t) => t.name === 'anythingmcp_run_read_tool')!.annotations;
    expect(read).toEqual({ title: 'Run read-only tool', readOnlyHint: true, openWorldHint: true });
  });
});

describe('ChatGPT tool set', () => {
  const connectGpt = (scope: RegisteredTool[], deps = makeDeps()) => connect(scope, deps, 'chatgpt');

  it('is the reviewed set plus four tools, the same for every caller', async () => {
    const a = await connectGpt([CRM_READ, CRM_WRITE]);
    const b = await connectGpt([]);
    const listA = (await a.client.listTools()).tools;
    expect(listA.map((t) => t.name).sort()).toEqual(
      [...SHARED_TOOL_NAMES, ...CHATGPT_EXTRA_TOOL_NAMES].sort(),
    );
    expect(JSON.stringify(listA)).toBe(JSON.stringify((await b.client.listTools()).tools));
  });

  it('sets readOnlyHint, destructiveHint and openWorldHint on every tool', async () => {
    const { client } = await connectGpt([]);
    for (const t of (await client.listTools()).tools) {
      expect(typeof t.annotations?.title).toBe('string');
      for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const) {
        expect({ tool: t.name, hint, type: typeof t.annotations?.[hint] }).toEqual({
          tool: t.name,
          hint,
          type: 'boolean',
        });
      }
    }
  });

  it('runs several reads in one call and reports each step', async () => {
    const OTHER_READ = tool({ name: 'erp_open_invoices', connectorId: 'c-erp' });
    const { client, deps } = await connectGpt([CRM_READ, OTHER_READ]);
    const out = await call(client, 'anythingmcp_run_read_steps', {
      steps: [
        { tool: 'crm_find_customer', arguments: { email: 'a@b.io' } },
        { tool: 'erp_open_invoices' },
        { tool: 'crm_find_customer', arguments: {} },
      ],
    });
    expect(out.isError).toBe(false);
    expect(out.body.succeeded).toBe(2);
    expect(out.body.failed).toBe(1);
    expect(out.body.steps[0]).toMatchObject({ step: 1, ok: true, result: { ran: 'c-crm:crm_find_customer' } });
    expect(out.body.steps[2]).toMatchObject({ step: 3, ok: false });
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  it('refuses a write tool inside the steps runner without running it', async () => {
    const { client, deps } = await connectGpt([CRM_READ, CRM_WRITE]);
    const out = await call(client, 'anythingmcp_run_read_steps', {
      steps: [{ tool: 'crm_create_deal', arguments: { title: 'x' } }],
    });
    expect(out.body.steps[0].ok).toBe(false);
    expect(JSON.stringify(out.body)).toContain('anythingmcp_run_write_tool');
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('does not reach payment connectors through the steps runner', async () => {
    const { client, deps } = await connectGpt([WISE_PAY]);
    const out = await call(client, 'anythingmcp_run_read_steps', {
      steps: [{ tool: 'wise_create_transfer' }],
    });
    expect(out.body.steps[0].ok).toBe(false);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('adds connectors through the setup service, pointing at the tools it lists', async () => {
    const run = jest.fn(async (name: string) =>
      name === 'setup_find_connectors'
        ? { body: { results: [{ adapter: 'etsy' }], next: 'then call setup_install_connector' } }
        : { body: { installed: 'Etsy', next: 'call setup_get_status when done' } },
    );
    const { client } = await connectGpt([], makeDeps({ setup: { organizationId: 'org-A', run } } as any));
    const found = await call(client, 'anythingmcp_find_connectors', { query: 'etsy' });
    expect(found.body.next).toBe('then call anythingmcp_add_connector');
    const added = await call(client, 'anythingmcp_add_connector', { adapter: 'etsy' });
    expect(added.body).toEqual({ installed: 'Etsy', next: 'call anythingmcp_connection_status when done' });
    expect(run).toHaveBeenCalledWith('setup_install_connector', { adapter: 'etsy' });
  });

  it('explains a connector limit without plan quotas or upgrade links', async () => {
    const run = jest.fn(async (name: string) =>
      name === 'setup_find_connectors'
        ? { body: { results: [], connectorsLeftOnThisPlan: 0 } }
        : {
            isError: true,
            body: {
              error: 'Trial limit reached (10 connectors).',
              whatTheUserCanDo: 'Add a card to continue the trial on the full plan, or remove a connector.',
              upgradeUrl: 'https://cloud.example.com/start-trial',
            },
          },
    );
    const { client } = await connectGpt([], makeDeps({ setup: { organizationId: 'org-A', run } } as any));
    const found = await call(client, 'anythingmcp_find_connectors', { query: 'etsy' });
    expect(found.body).toEqual({ results: [] });
    const added = await call(client, 'anythingmcp_add_connector', { adapter: 'etsy' });
    expect(added.isError).toBe(true);
    expect(JSON.stringify(added.body)).not.toMatch(/start-trial|card|upgradeUrl/);
    expect(added.body.error).toBe('Trial limit reached (10 connectors).');
  });

  it('marks adding a connector as a write, and refuses it to callers who may not', async () => {
    const { client } = await connectGpt([]);
    const add = (await client.listTools()).tools.find((t) => t.name === 'anythingmcp_add_connector');
    expect(add?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    const out = await call(client, 'anythingmcp_add_connector', { adapter: 'etsy' });
    expect(out.isError).toBe(true);
    expect(out.body.dashboardUrl).toBe('https://cloud.example.com/connectors');
  });
});
