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

  it('denies a user whose organization differs from the server (cross-tenant)', async () => {
    const req: any = { user: { organizationId: 'org-B', authMethod: 'jwt' } };
    const res = makeRes();

    await controller.handlePost('srv-A', req, res, {});

    expect(res.status).toHaveBeenCalledWith(403);
    // Must short-circuit before touching the server's connectors/tools.
    expect(mcpServersService.getConnectorIds).not.toHaveBeenCalled();
  });

  it('denies when the caller organization cannot be determined (fail closed)', async () => {
    const req: any = { user: { authMethod: 'jwt' } }; // no organizationId
    const res = makeRes();

    await controller.handlePost('srv-A', req, res, {});

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mcpServersService.getConnectorIds).not.toHaveBeenCalled();
  });

  it('allows a user from the same organization as the server', async () => {
    const req: any = {
      user: { organizationId: 'org-A', authMethod: 'jwt' },
      headers: {},
    };
    const res = makeRes();

    await controller.handlePost('srv-A', req, res, {});

    // Passed isolation → proceeded to assemble the server's tools.
    expect(mcpServersService.getConnectorIds).toHaveBeenCalledWith('srv-A');
    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});
