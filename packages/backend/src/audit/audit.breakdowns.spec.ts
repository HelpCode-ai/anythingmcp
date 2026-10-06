import { AuditService } from './audit.service';

/** Unit test for the usage/cost breakdowns aggregation (Prisma mocked). */
describe('AuditService.getBreakdowns', () => {
  const makePrisma = () => {
    const groupBy = jest
      .fn()
      // byConnector
      .mockResolvedValueOnce([
        { connectorId: 'c1', _count: { _all: 8 } },
        { connectorId: null, _count: { _all: 2 } },
      ])
      // byConnectorErr
      .mockResolvedValueOnce([{ connectorId: 'c1', _count: { _all: 3 } }])
      // byServer
      .mockResolvedValueOnce([{ mcpServerId: 's1', _count: { _all: 10 } }])
      // byServerErr
      .mockResolvedValueOnce([])
      // byUser
      .mockResolvedValueOnce([{ userId: 'u1', _count: { _all: 10 } }])
      // byUserErr
      .mockResolvedValueOnce([]);
    // Calls are summed over repeat_count, so totals come from aggregate().
    const aggregate = jest
      .fn()
      .mockResolvedValueOnce({ _sum: { repeatCount: 10 } }) // total
      .mockResolvedValueOnce({ _sum: { repeatCount: 3 } }) // errors
      .mockResolvedValueOnce({ _sum: { repeatCount: 4 } }); // proxyCalls
    return {
      toolInvocation: { groupBy, aggregate },
      connector: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Koch ERP' }]) },
      mcpServerConfig: { findMany: jest.fn().mockResolvedValue([{ id: 's1', name: 'KOCH Superpowers' }]) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', email: 'a@b.c', name: 'Alice' }]) },
    } as any;
  };

  afterEach(() => {
    delete process.env.COST_PER_CALL_MICROS;
    delete process.env.COST_PER_PROXY_CALL_MICROS;
  });

  it('aggregates per connector/server/user with error counts + proxy metering', async () => {
    const svc = new AuditService(makePrisma());
    const r = await svc.getBreakdowns('org-1', 30);

    expect(r.total).toBe(10);
    expect(r.errors).toBe(3);
    expect(r.proxyCalls).toBe(4);
    // connector names resolved; null id → "No connector"; sorted desc by count
    expect(r.byConnector).toEqual([
      { id: 'c1', label: 'Koch ERP', count: 8, errors: 3 },
      { id: null, label: 'No connector', count: 2, errors: 0 },
    ]);
    expect(r.byServer[0]).toMatchObject({ label: 'KOCH Superpowers', count: 10 });
    expect(r.byUser[0]).toMatchObject({ label: 'Alice', count: 10 });
  });

  it('computes a volume-based cost estimate from env rates', async () => {
    process.env.COST_PER_CALL_MICROS = '100';
    process.env.COST_PER_PROXY_CALL_MICROS = '500';
    const svc = new AuditService(makePrisma());
    const r = await svc.getBreakdowns('org-1', 30);
    // 10 calls * 100 + 4 proxy * 500 = 1000 + 2000
    expect(r.estCostMicros).toBe(3000);
    expect(r.rates).toEqual({ callMicros: 100, proxyCallMicros: 500 });
  });

  it('defaults cost to 0 when no rates configured', async () => {
    const svc = new AuditService(makePrisma());
    const r = await svc.getBreakdowns('org-1', 30);
    expect(r.estCostMicros).toBe(0);
  });
});
