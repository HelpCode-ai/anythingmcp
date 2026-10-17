import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { CodeboundService } from '../codebound/codebound.service';
import { SavedScriptsService } from '../codebound/saved-scripts.service';
import { CodeboundMcpService } from '../codebound/codebound-mcp.service';
import { McpEndpointController } from './mcp-endpoint.controller';
import { ToolRegistry, RegisteredTool } from './tool-registry';
import { CODEBOUND_TOOLS, CodeboundRegistry } from './codebound-tools';

const user = {
  sub: 'u1',
  email: 'a@example.com',
  organizationId: 'org-a',
  authMethod: 'jwt',
  azp: 'client-a',
};
const serverA = {
  id: 's1',
  name: 'Demo',
  organizationId: 'org-a',
  version: '1',
  isActive: true,
};
const base = {
  name: 'setup_demo_get_post',
  description: 'Read demo post',
  parameters: { type: 'object', properties: {} },
  connectorType: 'REST',
  connectorConfig: {
    baseUrl: 'https://example.com',
    authType: 'NONE',
    envVars: { API_KEY: 'stored-secret-not-for-the-agent' },
  },
  endpointMapping: { method: 'GET', path: '/posts/1' },
};

function build(role = 'EDITOR') {
  const registry = new ToolRegistry();
  registry.registerTool({
    ...base,
    id: 'foreign',
    connectorId: 'conn-b',
    organizationId: 'org-b',
  } as RegisteredTool);
  registry.registerTool({
    ...base,
    id: 'own',
    connectorId: 'conn-a',
    organizationId: 'org-a',
  } as RegisteredTool);
  const rows = new Map<string, any>();
  const project = (row: any, select: any) =>
    row &&
    Object.fromEntries(
      Object.keys(select)
        .filter((key) => select[key])
        .map((key) => [key, row[key]]),
    );
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const prisma = {
    organizationMember: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ organizationId: 'org-a', role }]),
    },
    mcpServerConfig: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 's1' && where.organizationId === 'org-a'
          ? { ...serverA, connectors: [{ connectorId: 'conn-a' }] }
          : null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        where.organizationId.in.includes('org-a') &&
        where.AND.every((filter: any) =>
          typeof filter.id === 'string'
            ? filter.id === 's1'
            : filter.id.in.includes('s1'),
        )
          ? [serverA]
          : [],
      ),
    },
    codeboundScript: {
      create: jest.fn(async ({ data, select }: any) => {
        const row = {
          ...data,
          id: 'script-1',
          revision: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.set(row.id, row);
        return project(row, select);
      }),
      findFirst: jest.fn(async ({ where, select }: any) =>
        project(
          [...rows.values()].find((row) => matches(row, where)),
          select,
        ),
      ),
      findMany: jest.fn(async ({ where, select, skip, take }: any) =>
        [...rows.values()]
          .filter((row) => matches(row, where))
          .slice(skip, skip + take)
          .map((row) => project(row, select)),
      ),
    },
  };
  const roles = { getAllowedToolIds: jest.fn().mockResolvedValue(null) };
  const executor = {
    executeTool: jest
      .fn()
      .mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
        structured: {
          id: 1,
          title: 'Demo post',
          body: 'Large intermediate response',
        },
      }),
  };
  const license = {
    checkLicenseActive: jest.fn().mockResolvedValue(undefined),
  };
  const security = { log: jest.fn().mockResolvedValue(undefined) };
  const runner = new CodeboundService(
    prisma as any,
    roles as any,
    registry,
    executor as any,
    license as any,
    security as any,
  );
  const scripts = new SavedScriptsService(
    prisma as any,
    runner,
    license as any,
    security as any,
  );
  const bridge = new CodeboundRegistry();
  const grants = {
    resolve: jest.fn().mockResolvedValue(null),
    clientRedirectUris: jest.fn().mockResolvedValue([]),
  };
  new CodeboundMcpService(
    prisma as any,
    grants as any,
    runner,
    scripts,
    bridge,
  ).onModuleInit();
  const servers = {
    findById: jest.fn().mockResolvedValue(serverA),
    getConnectorIds: jest.fn().mockResolvedValue(['conn-a']),
    getVisibleContent: jest
      .fn()
      .mockResolvedValue({ connectors: [], resources: [] }),
    isUserInOrganization: jest.fn().mockResolvedValue(true),
    getConnectorSummaries: jest
      .fn()
      .mockResolvedValue([{ id: 'conn-a', name: 'Demo', hasGuide: false }]),
    getSharedGuide: jest.fn().mockResolvedValue(undefined),
    getServerNamesByOrg: jest.fn().mockResolvedValue([serverA]),
  };
  const sessionManager = { get: jest.fn(), touch: jest.fn() };
  const controller = new McpEndpointController(
    servers as any,
    registry,
    executor as any,
    roles as any,
    {
      captureIntentEnabled: async () => false,
      isEnabled: async () => false,
    } as any,
    sessionManager as any,
    grants as any,
    {} as any,
    undefined,
    bridge,
  );
  let built: McpServer;
  (controller as any).serveStateless = jest.fn(
    async (
      _req: unknown,
      _res: unknown,
      _body: unknown,
      factory: () => McpServer,
    ) => {
      built = factory();
    },
  );
  const connect = async (shared = false, identity = user) => {
    const req: any = {
      user: { ...identity },
      body: {
        method:
          shared && process.env.MCP_SHARED_ENDPOINT_TOOLS === 'direct'
            ? 'tools/call'
            : 'initialize',
        params: { name: 'codebound_list_tools' },
      },
      headers: { host: 'localhost' },
    };
    if (shared) await controller.handleGlobalPost(req, {} as any);
    else await controller.handlePost('s1', req, {} as any, req.body);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await built!.connect(serverSide);
    const client = new Client({ name: 'codebound-test', version: '1' });
    await client.connect(clientSide);
    return { client, server: built! };
  };
  return {
    connect,
    controller,
    executor,
    security,
    roles,
    grants,
    sessionManager,
    bridge,
  };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result: any = await client.callTool({ name, arguments: args });
  return { error: !!result.isError, data: JSON.parse(result.content[0].text) };
}
const code = `const post = await tools.call('setup_demo_get_post', {}); return { id: post.id, title: input.uppercase ? post.title.toUpperCase() : post.title };`;

describe('AI-authored Codebound through MCP', () => {
  const environment = {
    shared: process.env.MCP_SHARED_ENDPOINT_TOOLS,
    stateful: process.env.MCP_STATEFUL_SESSIONS,
    json: process.env.MCP_STREAMABLE_JSON_RESPONSE,
  };
  beforeEach(() => {
    process.env.MCP_SHARED_ENDPOINT_TOOLS = 'fixed';
    process.env.MCP_STATEFUL_SESSIONS = 'false';
    process.env.MCP_STREAMABLE_JSON_RESPONSE = 'true';
  });
  afterAll(() => {
    for (const [name, value] of [
      ['MCP_SHARED_ENDPOINT_TOOLS', environment.shared],
      ['MCP_STATEFUL_SESSIONS', environment.stateful],
      ['MCP_STREAMABLE_JSON_RESPONSE', environment.json],
    ]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
  });

  it.each([false, true])(
    'discovers schemas and runs real QuickJS through %s shared endpoint',
    async (shared) => {
      const { connect, executor } = build();
      const { client, server } = await connect(shared);
      try {
        expect(
          (await client.listTools()).tools.map((tool) => tool.name),
        ).toEqual(
          expect.arrayContaining(CODEBOUND_TOOLS.map((tool) => tool.name)),
        );
        const discovered = await call(
          client,
          'codebound_list_tools',
          shared ? { serverId: 's1' } : {},
        );
        expect(discovered.data.tools.map((tool: any) => tool.name)).toEqual([
          'setup_demo_get_post',
        ]);
        expect(JSON.stringify(discovered)).not.toContain('stored-secret');
        const output = await call(client, 'codebound_run', {
          ...(shared ? { serverId: 's1' } : {}),
          code,
          input: { uppercase: true },
          allowedTools: ['setup_demo_get_post'],
        });
        expect(output.error).toBe(false);
        expect(output.data.result).toEqual({ id: 1, title: 'DEMO POST' });
        expect(executor.executeTool).toHaveBeenCalledWith(
          'setup_demo_get_post',
          {},
          expect.objectContaining({
            organizationId: 'org-a',
            connectorIds: ['conn-a'],
            authMethod: 'jwt',
          }),
        );
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it('saves an AI-written workflow and reuses stored defaults and source by revision', async () => {
    const { connect, security } = build();
    const { client, server } = await connect();
    try {
      const saved = await call(client, 'codebound_save_script', {
        name: 'AI summary',
        code,
        input: { uppercase: true },
        allowedTools: ['setup_demo_get_post'],
      });
      expect(saved.error).toBe(false);
      expect((await call(client, 'codebound_list_scripts')).data.items).toEqual(
        [expect.objectContaining({ id: 'script-1', revision: 1 })],
      );
      const opened = await call(client, 'codebound_get_script', {
        scriptId: saved.data.id,
      });
      expect(opened.data.code).toBe(code);
      const output = await call(client, 'codebound_run_saved', {
        scriptId: saved.data.id,
        revision: 1,
      });
      expect(output.data.result).toEqual({ id: 1, title: 'DEMO POST' });
      expect(security.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'CODEBOUND_RUN',
          metadata: expect.objectContaining({
            savedScriptId: 'script-1',
            revision: 1,
          }),
        }),
      );
      expect(
        (
          await call(client, 'codebound_run_saved', {
            scriptId: saved.data.id,
            revision: 2,
          })
        ).error,
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lets viewers run scripts but refuses saving them', async () => {
    const { connect } = build('VIEWER');
    const { client, server } = await connect();
    try {
      expect(
        (
          await call(client, 'codebound_run', {
            code: 'return 42;',
            allowedTools: [],
          })
        ).data.result,
      ).toBe(42);
      expect(
        (
          await call(client, 'codebound_save_script', {
            name: 'Denied',
            code: 'return 42;',
            allowedTools: [],
          })
        ).error,
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(['role', 'grant'])(
    'stops nested reads when the %s is revoked after the first read',
    async (reason) => {
      const { connect, roles, grants, executor } = build();
      const { client, server } = await connect();
      executor.executeTool.mockImplementationOnce(async () => {
        if (reason === 'role') roles.getAllowedToolIds.mockResolvedValue([]);
        else grants.resolve.mockResolvedValue({ mode: 'none' });
        return {
          content: [{ type: 'text', text: '{}' }],
          structured: { id: 1, title: 'Demo', body: '' },
        };
      });
      try {
        const result = await call(client, 'codebound_run', {
          code: 'await tools.call("setup_demo_get_post", {}); return await tools.call("setup_demo_get_post", {});',
          allowedTools: ['setup_demo_get_post'],
        });
        expect(result.error).toBe(true);
        expect(executor.executeTool).toHaveBeenCalledTimes(1);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it('publishes and dispatches the same tools on the shared direct endpoint', async () => {
    process.env.MCP_SHARED_ENDPOINT_TOOLS = 'direct';
    const { controller, connect } = build();
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.handleGlobalPost(
      {
        user: { ...user },
        body: { id: 1, method: 'tools/list' },
        headers: {},
      } as any,
      res,
    );
    expect(
      res.json.mock.calls[0][0].result.tools.map((tool: any) => tool.name),
    ).toEqual(expect.arrayContaining(CODEBOUND_TOOLS.map((tool) => tool.name)));
    const { client, server } = await connect(true);
    try {
      expect(
        (
          await call(client, 'codebound_run', {
            serverId: 's1',
            code: 'return { ok: true };',
            allowedTools: [],
          })
        ).data.result,
      ).toEqual({ ok: true });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('does not expose script execution on anonymous/static public surfaces', async () => {
    const { connect } = build();
    const { client, server } = await connect(false, {
      authMethod: 'none',
    } as any);
    try {
      expect(
        (await client.listTools()).tools.some((tool) =>
          tool.name.startsWith('codebound_'),
        ),
      ).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses each stateful request's client grant when invoking a reused handler", async () => {
    process.env.MCP_STATEFUL_SESSIONS = 'true';
    const { controller, sessionManager, bridge } = build();
    const call = jest.fn().mockResolvedValue({ ok: true });
    bridge.register({ call });
    const reused = bridge.get()!;
    sessionManager.get.mockReturnValue({
      serverId: 's1',
      organizationId: 'org-a',
      principalKey: 'sub:u1',
      transport: {
        handleRequest: async () => {
          await reused.call(
            {
              userId: 'u1',
              organizationId: 'org-a',
              email: '',
              authMethod: 'jwt',
              oauthClientId: 'old-client',
            },
            'codebound_list_tools',
            {},
          );
        },
      },
    });
    await controller.handlePost(
      's1',
      {
        user: { ...user, azp: 'current-client' },
        headers: { 'mcp-session-id': 'session' },
      } as any,
      {} as any,
      {},
    );
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        oauthClientId: 'current-client',
        endpointServerId: 's1',
      }),
      'codebound_list_tools',
      {},
    );
  });
});
