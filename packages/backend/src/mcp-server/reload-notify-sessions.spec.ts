import { McpServerService } from './mcp-server.service';
import { ToolRegistry } from './tool-registry';

/**
 * A connector save reloads its tools and tells the live MCP sessions. Each
 * session rebuild runs several queries, so only sessions on servers that
 * carry the connector are told (ANYTHINGMCP-CLOUD-BACKEND-E, an N+1 on
 * PUT /api/connectors/:id/env-vars).
 */
function makeService(opts: { connector: any; serverIds: string[]; hasSessions?: boolean }) {
  const svc = Object.create(McpServerService.prototype) as McpServerService;
  const prisma = {
    connector: { findUnique: jest.fn(async () => opts.connector) },
    mcpServerConnector: {
      findMany: jest.fn(async () => opts.serverIds.map((mcpServerId) => ({ mcpServerId }))),
    },
  };
  const sessionManager = {
    hasSessions: jest.fn(() => opts.hasSessions ?? true),
    notifyToolsChanged: jest.fn(async () => {}),
  };
  Object.assign(svc as any, {
    prisma,
    toolRegistry: new ToolRegistry(),
    mcpRegistry: { removeTool: jest.fn() },
    sessionManager,
    kgStatic: { syncConnector: jest.fn(async () => {}) },
    logger: { log: jest.fn(), warn: jest.fn() },
  });
  jest.spyOn(svc as any, 'registerConnectorTools').mockImplementation(() => undefined);
  return { svc, prisma, sessionManager };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('McpServerService.reloadConnectorTools: session notify', () => {
  it('tells only the sessions on servers that carry the connector', async () => {
    const { svc, prisma, sessionManager } = makeService({
      connector: { id: 'c1', organizationId: 'org', isActive: true, tools: [] },
      serverIds: ['srv-1', 'srv-2'],
    });
    await svc.reloadConnectorTools('c1', { syncKg: false });
    await flush();
    expect(prisma.mcpServerConnector.findMany).toHaveBeenCalledWith({
      where: { connectorId: 'c1' },
      select: { mcpServerId: true },
    });
    expect(sessionManager.notifyToolsChanged).toHaveBeenCalledWith(['srv-1', 'srv-2']);
  });

  it('tells every session when the connector was deleted', async () => {
    const { svc, prisma, sessionManager } = makeService({ connector: null, serverIds: [] });
    await svc.reloadConnectorTools('gone', { syncKg: false });
    await flush();
    expect(prisma.mcpServerConnector.findMany).not.toHaveBeenCalled();
    expect(sessionManager.notifyToolsChanged).toHaveBeenCalledWith();
  });

  it('runs no query when no session is open', async () => {
    const { svc, prisma, sessionManager } = makeService({
      connector: { id: 'c1', organizationId: 'org', isActive: true, tools: [] },
      serverIds: ['srv-1'],
      hasSessions: false,
    });
    await svc.reloadConnectorTools('c1', { syncKg: false });
    await flush();
    expect(prisma.mcpServerConnector.findMany).not.toHaveBeenCalled();
    expect(sessionManager.notifyToolsChanged).not.toHaveBeenCalled();
  });

  it('tells nobody when asked not to', async () => {
    const { svc, sessionManager } = makeService({
      connector: { id: 'c1', organizationId: 'org', isActive: true, tools: [] },
      serverIds: ['srv-1'],
    });
    await svc.reloadConnectorTools('c1', { syncKg: false, notifySessions: false });
    await flush();
    expect(sessionManager.hasSessions).not.toHaveBeenCalled();
    expect(sessionManager.notifyToolsChanged).not.toHaveBeenCalled();
  });
});
