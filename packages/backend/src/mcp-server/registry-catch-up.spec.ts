import { NotFoundException } from '@nestjs/common';
import { McpServerService } from './mcp-server.service';
import { ToolRegistry } from './tool-registry';
import {
  RegistryCatchUpController,
  isLoopback,
} from './registry-catch-up.controller';

/**
 * catchUpRegistry() is what keeps a freshly started backend from serving a
 * stale tool registry after a zero-downtime release: changes made through
 * the previous backend while this one was starting reach the database, not
 * this process. These tests pin which connectors it selects.
 */
function tool(id: string, connectorId: string) {
  return {
    id,
    connectorId,
    organizationId: 'org',
    name: `t_${id}`,
    description: '',
    parameters: {},
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://x', authType: 'NONE' },
    endpointMapping: { method: 'GET', path: '/' },
  };
}

function makeService(opts: {
  registered: Array<[toolId: string, connectorId: string]>;
  changedConnectors?: string[];
  changedToolConnectors?: string[];
  active: string[];
  enabledCounts: Record<string, number>;
  loadedFrom?: Date;
}) {
  const svc = Object.create(McpServerService.prototype) as McpServerService;
  const registry = new ToolRegistry();
  for (const [id, c] of opts.registered) registry.registerTool(tool(id, c));

  const prisma = {
    connector: {
      findMany: jest.fn(async (args: any) =>
        args.where.isActive
          ? opts.active.map((id) => ({ id }))
          : (opts.changedConnectors ?? []).map((id) => ({ id })),
      ),
    },
    mcpTool: {
      findMany: jest.fn(async () =>
        (opts.changedToolConnectors ?? []).map((connectorId) => ({
          connectorId,
        })),
      ),
      groupBy: jest.fn(async () =>
        Object.entries(opts.enabledCounts).map(([connectorId, n]) => ({
          connectorId,
          _count: { _all: n },
        })),
      ),
    },
  };
  const sessionManager = { notifyToolsChanged: jest.fn(async () => {}) };
  Object.assign(svc as any, {
    prisma,
    toolRegistry: registry,
    sessionManager,
    logger: { log: jest.fn(), warn: jest.fn() },
    toolsLoadedFrom: opts.loadedFrom,
  });
  const reload = jest
    .spyOn(svc, 'reloadConnectorTools')
    .mockResolvedValue(undefined);
  return { svc, prisma, reload, sessionManager };
}

const reloadedIds = (reload: jest.SpyInstance) =>
  reload.mock.calls.map((c) => c[0]).sort();

describe('McpServerService.catchUpRegistry', () => {
  const loadedFrom = new Date('2026-09-25T10:00:00Z');

  it('reloads nothing when the registry matches the database', async () => {
    const { svc, reload, sessionManager } = makeService({
      registered: [['t1', 'c1'], ['t2', 'c1'], ['t3', 'c2']],
      active: ['c1', 'c2'],
      enabledCounts: { c1: 2, c2: 1 },
      loadedFrom,
    });
    const res = await svc.catchUpRegistry();
    expect(res.reloaded).toBe(0);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionManager.notifyToolsChanged).not.toHaveBeenCalled();
  });

  it('reloads connectors written, or whose tools were written, since the load began', async () => {
    const { svc, reload, prisma } = makeService({
      registered: [['t1', 'c1'], ['t3', 'c2']],
      changedConnectors: ['c1'],
      changedToolConnectors: ['c2'],
      active: ['c1', 'c2'],
      enabledCounts: { c1: 1, c2: 1 },
      loadedFrom,
    });
    await svc.catchUpRegistry();
    expect(reloadedIds(reload)).toEqual(['c1', 'c2']);
    // A minute of margin before the load, for clocks in other processes.
    const since = (prisma.connector.findMany.mock.calls as any[]).find(
      (c) => c[0].where.updatedAt,
    )[0].where.updatedAt.gte as Date;
    expect(since.toISOString()).toBe('2026-09-25T09:59:00.000Z');
  });

  it('reloads a connector installed elsewhere (in the database, not registered here)', async () => {
    const { svc, reload } = makeService({
      registered: [['t1', 'c1']],
      active: ['c1', 'cNew'],
      enabledCounts: { c1: 1, cNew: 4 },
      loadedFrom,
    });
    await svc.catchUpRegistry();
    expect(reloadedIds(reload)).toEqual(['cNew']);
  });

  it('reloads a connector deleted or deactivated elsewhere, so its tools go', async () => {
    const { svc, reload } = makeService({
      registered: [['t1', 'c1'], ['t2', 'cGone']],
      active: ['c1'],
      enabledCounts: { c1: 1 },
      loadedFrom,
    });
    await svc.catchUpRegistry();
    expect(reloadedIds(reload)).toEqual(['cGone']);
  });

  it('reloads a connector whose enabled-tool count changed (a delete leaves no timestamp)', async () => {
    const { svc, reload } = makeService({
      registered: [['t1', 'c1'], ['t2', 'c1']],
      active: ['c1'],
      enabledCounts: { c1: 1 },
      loadedFrom,
    });
    await svc.catchUpRegistry();
    expect(reloadedIds(reload)).toEqual(['c1']);
  });

  it('reloads without KG sync or per-connector notifications, then notifies sessions once', async () => {
    const { svc, reload, sessionManager } = makeService({
      registered: [],
      changedConnectors: ['a', 'b', 'c'],
      active: [],
      enabledCounts: {},
      loadedFrom,
    });
    await svc.catchUpRegistry();
    expect(reload).toHaveBeenCalledTimes(3);
    for (const call of reload.mock.calls) {
      expect(call[1]).toEqual({ syncKg: false, notifySessions: false });
    }
    expect(sessionManager.notifyToolsChanged).toHaveBeenCalledTimes(1);
  });

  it('moves its watermark forward, so a second call looks only at newer writes', async () => {
    const { svc, prisma } = makeService({
      registered: [],
      active: [],
      enabledCounts: {},
      loadedFrom,
    });
    const before = Date.now();
    await svc.catchUpRegistry();
    await svc.catchUpRegistry();
    const sinceCalls = (prisma.connector.findMany.mock.calls as any[])
      .filter((c) => c[0].where.updatedAt)
      .map((c) => (c[0].where.updatedAt.gte as Date).getTime());
    expect(sinceCalls[0]).toBe(loadedFrom.getTime() - 60_000);
    expect(sinceCalls[1]).toBeGreaterThanOrEqual(before - 60_000);
  });
});

describe('RegistryCatchUpController', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'accepts loopback %s',
    (a) => expect(isLoopback(a)).toBe(true),
  );

  it.each(['172.18.0.5', '::ffff:172.18.0.5', '10.0.0.1', '', undefined])(
    'refuses %s',
    (a) => expect(isLoopback(a as any)).toBe(false),
  );

  it('answers 404 to a request that arrived over the network, whatever it claims', async () => {
    const svc = { catchUpRegistry: jest.fn() };
    const ctrl = new RegistryCatchUpController(svc as any);
    const req = {
      socket: { remoteAddress: '172.18.0.3' },
      headers: { 'x-forwarded-for': '127.0.0.1' },
      ip: '127.0.0.1',
    };
    await expect(ctrl.catchUp(req as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(svc.catchUpRegistry).not.toHaveBeenCalled();
  });

  it('runs the catch-up for a loopback caller', async () => {
    const svc = {
      catchUpRegistry: jest.fn(async () => ({
        since: null,
        reloaded: 0,
        toolCount: 0,
      })),
    };
    const ctrl = new RegistryCatchUpController(svc as any);
    await expect(
      ctrl.catchUp({ socket: { remoteAddress: '127.0.0.1' } } as any),
    ).resolves.toEqual({ since: null, reloaded: 0, toolCount: 0 });
  });
});
