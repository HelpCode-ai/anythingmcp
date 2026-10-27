import { KgStaticService } from './kg-static.service';

function setup(opts: { tools?: number; digest?: string; storedHash?: string | null } = {}) {
  const tx = {
    kgNode: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    kgEdge: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'e1' }),
      update: jest.fn(),
      upsert: jest.fn().mockResolvedValue({ id: 'e1' }),
      deleteMany: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const prisma = {
    connector: {
      findUnique: jest.fn().mockResolvedValue({ id: 'c1', organizationId: 'org1' }),
    },
    mcpTool: {
      findMany: jest.fn().mockResolvedValue([
        { name: 'shop_list_orders', description: 'List orders', parameters: { type: 'object', properties: {} }, outputSchema: null },
        { name: 'shop_get_order', description: 'Get one order', parameters: { type: 'object', properties: { order_id: { type: 'string' } } }, outputSchema: null },
      ]),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ tools: opts.tools ?? 2, digest: opts.digest ?? 'abc' }]),
    orgSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    kgNode: { count: jest.fn().mockResolvedValue(3) },
    kgEdge: { count: jest.fn().mockResolvedValue(1) },
    kgConnectorState: {
      findUnique: jest.fn().mockResolvedValue(opts.storedHash === undefined ? null : { staticHash: opts.storedHash }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(
      async (run: (t: typeof tx) => Promise<unknown>, _opts?: { timeout: number; maxWait: number }) => run(tx),
    ),
  };
  return { prisma, svc: new KgStaticService(prisma as never) };
}

describe('KgStaticService.syncConnector', () => {
  it("persists in a transaction that outlives Prisma's 5 s default and stores the tool fingerprint", async () => {
    const { prisma, svc } = setup();

    const result = await svc.syncConnector('c1');

    expect(result.skipped).toBe(false);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]!.timeout).toBeGreaterThanOrEqual(60_000);
    expect(prisma.kgConnectorState.upsert.mock.calls[0][0].update.staticHash).toBe('surface-v1:abc');
  });

  it('skips an unchanged connector without loading its tools', async () => {
    const { prisma, svc } = setup({ storedHash: 'surface-v1:abc' });

    const result = await svc.syncConnector('c1');

    expect(result).toEqual({ nodes: 3, edges: 1, skipped: true });
    expect(prisma.mcpTool.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rebuilds when forced or when the fingerprint changed', async () => {
    const changed = setup({ storedHash: 'surface-v1:old' });
    expect((await changed.svc.syncConnector('c1')).skipped).toBe(false);

    const forced = setup({ storedHash: 'surface-v1:abc' });
    expect((await forced.svc.syncConnector('c1', { force: true })).skipped).toBe(false);
    expect(forced.prisma.mcpTool.findMany).toHaveBeenCalled();
  });

  it('leaves out a connector above the tool limit', async () => {
    const { prisma, svc } = setup({ tools: 60_000 });

    const result = await svc.syncConnector('c1');

    expect(result.skipped).toBe(true);
    expect(prisma.mcpTool.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
