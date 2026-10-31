import { WebhookEventsService } from './webhook-events.service';

interface Row {
  id: string;
  connectorId: string;
  organizationId: string;
  provider: string;
  eventType: string | null;
  externalId: string | null;
  payload: unknown;
  receivedAt: Date;
}

function fakePrisma() {
  let rows: Row[] = [];
  let seq = 0;
  return {
    webhookEvent: {
      create: jest.fn(async ({ data }: any) => {
        if (
          data.externalId &&
          rows.some((r) => r.connectorId === data.connectorId && r.externalId === data.externalId)
        ) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const row: Row = {
          id: `evt_${seq++}`,
          connectorId: data.connectorId,
          organizationId: data.organizationId,
          provider: data.provider,
          eventType: data.eventType ?? null,
          externalId: data.externalId ?? null,
          payload: data.payload,
          receivedAt: new Date(),
        };
        rows.push(row);
        return row;
      }),
      count: jest.fn(async ({ where }: any) =>
        rows.filter((r) => r.connectorId === where.connectorId).length,
      ),
      findMany: jest.fn(async ({ where, orderBy, take, select }: any) => {
        let result = rows.filter((r) => {
          if (where.connectorId && r.connectorId !== where.connectorId) return false;
          if (where.organizationId && r.organizationId !== where.organizationId) return false;
          if (where.receivedAt?.gte && r.receivedAt < where.receivedAt.gte) return false;
          if (where.receivedAt?.lt && !(r.receivedAt < where.receivedAt.lt)) return false;
          return true;
        });
        const dir = orderBy?.receivedAt === 'asc' ? 1 : -1;
        result = result.slice().sort((a, b) => dir * (a.receivedAt.getTime() - b.receivedAt.getTime()));
        if (take) result = result.slice(0, take);
        if (select) {
          return result.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, (r as any)[k]])));
        }
        return result;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = rows.length;
        if (where.id?.in) {
          const ids = new Set(where.id.in as string[]);
          rows = rows.filter((r) => !ids.has(r.id));
        } else if (where.receivedAt?.lt) {
          rows = rows.filter((r) => !(r.receivedAt < where.receivedAt.lt));
        }
        return { count: before - rows.length };
      }),
    },
    _rows: () => rows,
  };
}

describe('WebhookEventsService', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let service: WebhookEventsService;

  beforeEach(() => {
    prisma = fakePrisma();
    service = new WebhookEventsService(prisma as any);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('records a verified event and returns true', async () => {
    const ok = await service.recordEvent({
      connectorId: 'c1',
      organizationId: 'org1',
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      externalId: 'evt_abc',
      payload: { id: 'evt_abc' },
    });
    expect(ok).toBe(true);
    expect(prisma._rows()).toHaveLength(1);
  });

  it('returns false instead of throwing on a duplicate externalId for the same connector (redelivery)', async () => {
    await service.recordEvent({
      connectorId: 'c1',
      organizationId: 'org1',
      provider: 'stripe',
      externalId: 'evt_abc',
      payload: {},
    });
    const second = await service.recordEvent({
      connectorId: 'c1',
      organizationId: 'org1',
      provider: 'stripe',
      externalId: 'evt_abc',
      payload: {},
    });
    expect(second).toBe(false);
    expect(prisma._rows()).toHaveLength(1);
  });

  it('allows the same externalId across different connectors', async () => {
    await service.recordEvent({ connectorId: 'c1', organizationId: 'org1', provider: 'stripe', externalId: 'evt_x', payload: {} });
    const ok = await service.recordEvent({ connectorId: 'c2', organizationId: 'org1', provider: 'stripe', externalId: 'evt_x', payload: {} });
    expect(ok).toBe(true);
    expect(prisma._rows()).toHaveLength(2);
  });

  it('allows multiple events with no externalId at all for the same connector', async () => {
    await service.recordEvent({ connectorId: 'c1', organizationId: 'org1', provider: 'stripe', payload: {} });
    const ok = await service.recordEvent({ connectorId: 'c1', organizationId: 'org1', provider: 'stripe', payload: {} });
    expect(ok).toBe(true);
    expect(prisma._rows()).toHaveLength(2);
  });

  it('enforces the per-connector cap on insert, deleting the oldest rows first', async () => {
    process.env.WEBHOOK_EVENT_MAX_PER_CONNECTOR = '3';
    service = new WebhookEventsService(prisma as any);
    for (let i = 0; i < 5; i++) {
      await service.recordEvent({ connectorId: 'c1', organizationId: 'org1', provider: 'stripe', externalId: `evt_${i}`, payload: { i } });
    }
    const rows = prisma._rows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.externalId)).toEqual(['evt_2', 'evt_3', 'evt_4']);
    delete process.env.WEBHOOK_EVENT_MAX_PER_CONNECTOR;
  });

  it('never trims other connectors when enforcing one connector\'s cap', async () => {
    process.env.WEBHOOK_EVENT_MAX_PER_CONNECTOR = '2';
    service = new WebhookEventsService(prisma as any);
    for (let i = 0; i < 4; i++) {
      await service.recordEvent({ connectorId: 'c1', organizationId: 'org1', provider: 'stripe', externalId: `a_${i}`, payload: {} });
    }
    await service.recordEvent({ connectorId: 'c2', organizationId: 'org1', provider: 'stripe', externalId: 'b_0', payload: {} });
    expect(prisma._rows().filter((r) => r.connectorId === 'c1')).toHaveLength(2);
    expect(prisma._rows().filter((r) => r.connectorId === 'c2')).toHaveLength(1);
    delete process.env.WEBHOOK_EVENT_MAX_PER_CONNECTOR;
  });

  it('returns recent events newest first, scoped to connector and organization', async () => {
    await service.recordEvent({ connectorId: 'c1', organizationId: 'org1', provider: 'stripe', externalId: 'e1', payload: { n: 1 } });
    await service.recordEvent({ connectorId: 'c1', organizationId: 'org1', provider: 'stripe', externalId: 'e2', payload: { n: 2 } });
    await service.recordEvent({ connectorId: 'c1', organizationId: 'org2', provider: 'stripe', externalId: 'e3', payload: { n: 3 } });
    // Force a deterministic order: two inserts in the same test can land in
    // the same millisecond, which would make the sort below a coin flip.
    const rows = prisma._rows();
    rows.find((r) => r.externalId === 'e1')!.receivedAt = new Date(1000);
    rows.find((r) => r.externalId === 'e2')!.receivedAt = new Date(2000);

    const events = await service.recentEvents('c1', 'org1', {});
    expect(events.map((e) => e.externalId)).toEqual(['e2', 'e1']);
  });

  it('clamps an out-of-range limit into [1, 200]', async () => {
    await service.recordEvent({ connectorId: 'c1', organizationId: 'org1', provider: 'stripe', payload: {} });
    const events = await service.recentEvents('c1', 'org1', { limit: 0 });
    expect(events).toHaveLength(1); // clamped to at least 1, still returns the one row
  });

  it('deletes rows past the retention window on sweep, and keeps recent ones', async () => {
    await service.recordEvent({ connectorId: 'c1', organizationId: 'org1', provider: 'stripe', externalId: 'old', payload: {} });
    const rows = prisma._rows();
    rows[0].receivedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days old
    await service.recordEvent({ connectorId: 'c1', organizationId: 'org1', provider: 'stripe', externalId: 'new', payload: {} });

    const deleted = await service.sweepExpired(new Date());
    expect(deleted).toBe(1);
    expect(prisma._rows().map((r) => r.externalId)).toEqual(['new']);
  });
});
