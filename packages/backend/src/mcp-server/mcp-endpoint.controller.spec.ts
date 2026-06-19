import { McpEndpointController } from './mcp-endpoint.controller';

/**
 * Regression tests for cross-tenant isolation on the per-server MCP endpoint.
 * A leak was confirmed where an OAuth token from org B could list/use org A's
 * tools because the org check was skipped when organizationId was absent.
 */
describe('McpEndpointController — tenant isolation', () => {
  let controller: McpEndpointController;
  let mcpServersService: any;
  let toolRegistry: any;
  let toolExecutor: any;
  let rolesService: any;

  const SERVER = {
    id: 'srv-A',
    name: 'deutsch bahn',
    version: '1.0.0',
    isActive: true,
    organizationId: 'org-A',
  };

  const makeRes = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.headersSent = false;
    return res;
  };

  beforeEach(() => {
    mcpServersService = {
      findById: jest.fn().mockResolvedValue(SERVER),
      getConnectorIds: jest.fn().mockResolvedValue([]),
      getComposedInstructions: jest.fn().mockResolvedValue(''),
      isUserInOrganization: jest.fn().mockResolvedValue(false),
    };
    toolRegistry = { getAllTools: jest.fn().mockReturnValue([]) };
    toolExecutor = { executeTool: jest.fn() };
    rolesService = { getAllowedToolIds: jest.fn().mockResolvedValue(null) };
    controller = new McpEndpointController(
      mcpServersService,
      toolRegistry,
      toolExecutor,
      rolesService,
    );
  });

  it('denies a non-member whose org differs and has no membership (cross-tenant)', async () => {
    // org-B user, NOT a member of org-A → isUserInOrganization returns false.
    const req: any = {
      user: { sub: 'u-b', organizationId: 'org-B', authMethod: 'jwt' },
    };
    const res = makeRes();

    await controller.handlePost('srv-A', req, res, {});

    expect(mcpServersService.isUserInOrganization).toHaveBeenCalledWith(
      'u-b',
      'org-A',
    );
    expect(res.status).toHaveBeenCalledWith(403);
    // Must short-circuit before touching the server's connectors/tools.
    expect(mcpServersService.getConnectorIds).not.toHaveBeenCalled();
  });

  it('allows a multi-org user who is a MEMBER of the server org via membership', async () => {
    // Primary org is org-B, but the user is also a member of org-A (the
    // server's org) — must be allowed.
    mcpServersService.isUserInOrganization.mockResolvedValue(true);
    const req: any = {
      user: { sub: 'u-multi', organizationId: 'org-B', authMethod: 'jwt' },
      headers: {},
    };
    const res = makeRes();

    await controller.handlePost('srv-A', req, res, {});

    expect(mcpServersService.isUserInOrganization).toHaveBeenCalledWith(
      'u-multi',
      'org-A',
    );
    expect(mcpServersService.getConnectorIds).toHaveBeenCalledWith('srv-A');
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('denies when the caller organization cannot be determined (fail closed)', async () => {
    const req: any = { user: { authMethod: 'jwt' } }; // no organizationId
    const res = makeRes();

    await controller.handlePost('srv-A', req, res, {});

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mcpServersService.getConnectorIds).not.toHaveBeenCalled();
  });

  it('does not crash when two connectors expose the same tool name (dedup, no 500)', async () => {
    // Regression: a server with two connectors that both expose
    // "etsy_get_authenticated_user" made the MCP SDK throw
    // "Tool ... is already registered", which 500'd every request.
    const dupTool = (connectorId: string) => ({
      id: `${connectorId}:etsy_get_authenticated_user`,
      connectorId,
      name: 'etsy_get_authenticated_user',
      description: 'whoami',
      parameters: { type: 'object', properties: {} },
      connectorConfig: { envVars: {} },
    });
    mcpServersService.getConnectorIds.mockResolvedValue(['c1', 'c2']);
    toolRegistry.getAllTools.mockReturnValue([dupTool('c1'), dupTool('c2')]);
    const warnSpy = jest
      .spyOn((controller as any).logger, 'warn')
      .mockImplementation(() => undefined);

    const req: any = {
      user: { sub: 'u-a', organizationId: 'org-A', authMethod: 'jwt' },
      headers: {},
    };
    const res = makeRes();

    // Must resolve — the duplicate registration used to throw out of the
    // handler (it runs before the transport try/catch).
    await expect(
      controller.handlePost('srv-A', req, res, {}),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate tool name "etsy_get_authenticated_user"'),
    );
  });

  it('demo endpoint serves static tools without touching tenant data', async () => {
    // /mcp/demo must NEVER resolve a server or read connectors — it has no
    // tenant data to leak. Verify the per-server services are never called.
    const req: any = { headers: {}, user: { authMethod: 'none' } };
    const res = makeRes();

    await expect(
      controller.handleDemoPost(req, res, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }),
    ).resolves.toBeUndefined();

    expect(mcpServersService.findById).not.toHaveBeenCalled();
    expect(mcpServersService.getConnectorIds).not.toHaveBeenCalled();
    expect(mcpServersService.isUserInOrganization).not.toHaveBeenCalled();
  });

  it('allows a user whose primary org matches the server (zero-query fast path)', async () => {
    const req: any = {
      user: { sub: 'u-a', organizationId: 'org-A', authMethod: 'jwt' },
      headers: {},
    };
    const res = makeRes();

    await controller.handlePost('srv-A', req, res, {});

    // Primary org matches → no membership query needed.
    expect(mcpServersService.isUserInOrganization).not.toHaveBeenCalled();
    expect(mcpServersService.getConnectorIds).toHaveBeenCalledWith('srv-A');
    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});
