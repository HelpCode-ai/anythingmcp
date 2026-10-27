import { KgStaticService } from './kg-static.service';

describe('KgStaticService.syncConnector', () => {
  it('persists in a transaction that outlives Prisma\'s 5 s default', async () => {
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
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          organizationId: 'org1',
          tools: [
            { name: 'shop_list_orders', description: 'List orders', parameters: { type: 'object', properties: {} }, outputSchema: null },
            { name: 'shop_get_order', description: 'Get one order', parameters: { type: 'object', properties: { order_id: { type: 'string' } } }, outputSchema: null },
          ],
        }),
      },
      orgSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      kgConnectorState: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>, _opts?: { timeout: number; maxWait: number }) => run(tx)),
    };
    const svc = new KgStaticService(prisma as never);

    const result = await svc.syncConnector('c1');

    expect(result.skipped).toBe(false);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const opts = prisma.$transaction.mock.calls[0][1]!;
    expect(opts.timeout).toBeGreaterThanOrEqual(60_000);
    expect(prisma.kgConnectorState.upsert).toHaveBeenCalled();
  });
});
