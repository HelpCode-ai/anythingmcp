import { McpServer } from '@modelcontextprotocol/server';
import { McpEndpointController } from './mcp-endpoint.controller';
import { McpClientSeenRegistry, type McpClientSeen } from './mcp-client-seen';
import * as toolset from './shared-toolset';
import { withRegistryIndexes } from './registry-test-double';

/**
 * The shared endpoint reports each call of its tools to the
 * shared_tool_called recorder, with the connection's workspace, profile and
 * OAuth client (see shared-tool-calls.ts).
 */
describe('shared /mcp: shared_tool_called', () => {
  const saved = process.env.MCP_SHARED_ENDPOINT_TOOLS;
  beforeAll(() => {
    process.env.MCP_SHARED_ENDPOINT_TOOLS = 'fixed';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.MCP_SHARED_ENDPOINT_TOOLS;
    else process.env.MCP_SHARED_ENDPOINT_TOOLS = saved;
    jest.restoreAllMocks();
  });

  function build(withEvents: boolean, clientSeen?: McpClientSeenRegistry) {
    const productEvents = { log: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      productEvent: { findMany: jest.fn().mockResolvedValue([]) },
      oAuthClient: { findUnique: jest.fn().mockResolvedValue({ clientName: 'Claude' }) },
    };
    const controller = new McpEndpointController(
      {
        getConnectorIds: jest.fn(async () => []),
        getConnectorSummaries: jest.fn(async () => []),
      } as any,
      withRegistryIndexes({ getAllTools: () => [], countByName: () => 0 }) as any,
      { executeTool: jest.fn() } as any,
      { getAllowedToolIds: jest.fn(async () => null) } as any,
      { isEnabled: jest.fn(async () => false), lookup: jest.fn() } as any,
      {} as any,
      {
        resolve: jest.fn().mockResolvedValue(null),
        clientRedirectUris: jest.fn(async () => ['https://claude.ai/api/mcp/auth_callback']),
      } as any,
      { create: jest.fn(), hasVisible: jest.fn().mockResolvedValue(false) } as any,
      { get: () => null } as any,
      undefined,
      undefined,
      withEvents ? (productEvents as any) : undefined,
      withEvents ? (prisma as any) : undefined,
      undefined,
      undefined,
      clientSeen,
    );
    (controller as any).serveStateless = jest.fn(
      async (_req: unknown, _res: unknown, _body: unknown, factory: () => McpServer) => {
        factory();
      },
    );
    return { controller, productEvents };
  }

  it('records a call with the workspace, profile and client name', async () => {
    const register = jest.spyOn(toolset, 'registerSharedToolset').mockImplementation(() => undefined);
    const { controller, productEvents } = build(true);
    await controller.handleGlobalPost(
      { user: { sub: 'u1', organizationId: 'org-1', authMethod: 'oauth', azp: 'client-claude' }, body: { method: 'initialize' }, headers: { host: 'x' } } as any,
      {} as any,
    );
    const deps = register.mock.calls[0][2];
    deps.called!({ tool: 'anythingmcp_list_connectors' });
    await new Promise((r) => setImmediate(r));
    expect(productEvents.log).toHaveBeenCalledWith({
      event: 'shared_tool_called',
      organizationId: 'org-1',
      userId: 'u1',
      metadata: { tool: 'anythingmcp_list_connectors', profile: 'default', client: 'Claude' },
    });
    register.mockRestore();
  });

  it('hands the server-set origin of a setup call through to the setup service', async () => {
    const register = jest.spyOn(toolset, 'registerSharedToolset').mockImplementation(() => undefined);
    const provider = {
      canSetUp: jest.fn().mockResolvedValue(true),
      find: jest.fn().mockResolvedValue({ body: {} }),
      install: jest.fn().mockResolvedValue({ body: {} }),
      status: jest.fn(),
    };
    const { controller } = build(true);
    (controller as any).sharedSetup = { get: () => provider };
    await controller.handleGlobalPost(
      { user: { sub: 'u1', organizationId: 'org-1', authMethod: 'oauth', azp: 'client-claude' }, body: { method: 'initialize' }, headers: { host: 'x' } } as any,
      {} as any,
    );
    const setup = register.mock.calls[0][2].setup!;
    await setup.run('setup_find_connectors', { query: 'telegram' }, { via: 'mcp_search_fallback' });
    await setup.run('setup_install_connector', { adapter: 'telegram-bot' });
    expect(provider.find).toHaveBeenCalledWith(expect.anything(), { query: 'telegram' }, { via: 'mcp_search_fallback' });
    expect(provider.install).toHaveBeenCalledWith(expect.anything(), { adapter: 'telegram-bot' }, undefined);
    register.mockRestore();
  });

  describe('a tools/list tells whoever listens that the workspace\'s client is connected', () => {
    const listing = (user: Record<string, unknown>) =>
      ({ user, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { host: 'x' } }) as any;
    const USER = { sub: 'u1', organizationId: 'org-1', authMethod: 'oauth', azp: 'client-claude' };

    it('with the connection\'s workspace and user, on every listing and for no other request', async () => {
      const register = jest.spyOn(toolset, 'registerSharedToolset').mockImplementation(() => undefined);
      const clientSeen = new McpClientSeenRegistry();
      const heard: McpClientSeen[] = [];
      clientSeen.register((seen) => heard.push(seen));
      const { controller, productEvents } = build(true, clientSeen);

      await controller.handleGlobalPost({ ...listing(USER), body: { method: 'initialize' } }, {} as any);
      await controller.handleGlobalPost({ ...listing(USER), body: { method: 'tools/call', params: { name: 'x' } } }, {} as any);
      expect(heard).toEqual([]);

      await controller.handleGlobalPost(listing(USER), {} as any);
      await controller.handleGlobalPost(listing(USER), {} as any);
      await new Promise((r) => setImmediate(r));
      // Twice: the once-a-day rule is the event's, not the listeners'.
      expect(heard).toEqual([
        { organizationId: 'org-1', userId: 'u1' },
        { organizationId: 'org-1', userId: 'u1' },
      ]);
      expect(productEvents.log.mock.calls.filter((c) => c[0].event === 'mcp_tools_listed')).toHaveLength(1);
      register.mockRestore();
    });

    it('also without the events service, and a request without a workspace tells nothing', async () => {
      const register = jest.spyOn(toolset, 'registerSharedToolset').mockImplementation(() => undefined);
      const clientSeen = new McpClientSeenRegistry();
      const heard: McpClientSeen[] = [];
      clientSeen.register((seen) => heard.push(seen));
      const { controller } = build(false, clientSeen);
      await controller.handleGlobalPost(listing({ sub: 'u1', authMethod: 'oauth' }), {} as any);
      expect(heard).toEqual([]);
      await controller.handleGlobalPost(listing(USER), {} as any);
      expect(heard).toEqual([{ organizationId: 'org-1', userId: 'u1' }]);
      register.mockRestore();
    });

    it('is never failed or held up by a listener: one that throws is skipped, and nothing is awaited', async () => {
      const register = jest.spyOn(toolset, 'registerSharedToolset').mockImplementation(() => undefined);
      const clientSeen = new McpClientSeenRegistry();
      const later = jest.fn();
      clientSeen.register(() => {
        throw new Error('listener broke');
      });
      // What a listener returns is not looked at: a promise that never settles holds nothing up.
      clientSeen.register((() => new Promise(() => undefined)) as any);
      clientSeen.register(later);
      const { controller } = build(true, clientSeen);
      const serve = (controller as any).serveStateless as jest.Mock;

      await expect(controller.handleGlobalPost(listing(USER), {} as any)).resolves.toBeUndefined();
      expect(later).toHaveBeenCalledWith({ organizationId: 'org-1', userId: 'u1' });
      // The listing itself was answered as always.
      expect(serve).toHaveBeenCalledTimes(1);
      register.mockRestore();
    });
  });

  it('reports nothing when the events service is not there', async () => {
    const register = jest.spyOn(toolset, 'registerSharedToolset').mockImplementation(() => undefined);
    const { controller } = build(false);
    await controller.handleGlobalPost(
      { user: { sub: 'u1', organizationId: 'org-1', authMethod: 'oauth' }, body: { method: 'initialize' }, headers: { host: 'x' } } as any,
      {} as any,
    );
    expect(register.mock.calls[0][2].called).toBeUndefined();
    register.mockRestore();
  });
});
