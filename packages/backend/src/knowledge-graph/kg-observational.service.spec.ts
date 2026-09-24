import { KgObservationalService } from './kg-observational.service';

/**
 * The observational ingest runs after every tool call. On 24 Sep 2026 it took
 * the cloud backend past its 4 GB heap: one workspace's connectors had no
 * watermark, so every run re-read all of its invocations (some 3 MB each, 100
 * at a time), runs overlapped, none finished, and the watermark never moved.
 * These tests pin the properties that stop that from happening again.
 */
describe('KgObservationalService.ingestOrganization', () => {
  const ORG = 'org-1';
  const T0 = new Date('2026-09-20T00:00:00Z');
  const MB = 1024 * 1024;

  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
  const row = (id: string, connectorId: string, minutes: number, tool: string) => ({
    id,
    connectorId,
    createdAt: at(minutes),
    intent: null,
    tool: { name: tool },
  });

  interface Setup {
    pages: Array<ReturnType<typeof row>[] | Error>;
    sizes?: Record<string, { input: number; output: number }>;
    payloads?: Record<string, { input?: unknown; output?: unknown }>;
    valueSeen?: Array<Record<string, string>>;
    states?: Array<{ connectorId: string; lastObservedAt: Date | null }>;
    isEnabled?: () => Promise<boolean>;
  }

  function make(setup: Setup) {
    const pages = [...setup.pages];
    const pageCalls: any[] = [];
    const payloadCalls: any[] = [];
    const toolInvocationFindMany = jest.fn(async (args: any) => {
      if (args.where?.id?.in) {
        payloadCalls.push(args);
        return args.where.id.in.map((id: string) => ({
          id,
          input: setup.payloads?.[id]?.input ?? {},
          ...(args.select.output ? { output: setup.payloads?.[id]?.output ?? {} } : {}),
        }));
      }
      pageCalls.push(args);
      const next = pages.shift() ?? [];
      if (next instanceof Error) throw next;
      return next;
    });
    const queryRaw = jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) =>
      (values[values.length - 1] as string[]).map((id) => ({
        id,
        input_bytes: setup.sizes?.[id]?.input ?? 100,
        output_bytes: setup.sizes?.[id]?.output ?? 1000,
      })),
    );
    const prisma = {
      connector: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'c1', tools: [{ name: 'crm_list_customers' }, { name: 'crm_get_customer' }] },
          { id: 'c2', tools: [{ name: 'erp_list_orders' }, { name: 'erp_get_order' }] },
        ]),
      },
      kgConnectorState: {
        findMany: jest
          .fn()
          .mockResolvedValue(setup.states ?? [{ connectorId: 'c1', lastObservedAt: T0 }]),
        upsert: jest.fn().mockResolvedValue({}),
      },
      kgNode: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(async (args: any) => ({
          id: `node-${args.create.connectorId}-${args.create.entity}`,
        })),
      },
      toolInvocation: { findMany: toolInvocationFindMany },
      $queryRaw: queryRaw,
      kgValueSeen: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue(setup.valueSeen ?? []),
      },
      kgEdge: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const kgStatic = { isEnabled: jest.fn(setup.isEnabled ?? (async () => true)) };
    const svc = new KgObservationalService(prisma as any, kgStatic as any);
    return { svc, prisma, pageCalls, payloadCalls, kgStatic };
  }

  it('scans each connector from its own watermark, not from a shared floor', async () => {
    const { svc, pageCalls } = make({ pages: [[]] });
    await svc.ingestOrganization(ORG);

    expect(pageCalls[0].where).toEqual({
      organizationId: ORG,
      OR: [{ connectorId: 'c1', createdAt: { gt: T0 } }, { connectorId: 'c2' }],
    });
  });

  it('pages with a keyset cursor instead of skip', async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(`r${i}`, 'c2', i, 'erp_get_order'));
    const { svc, pageCalls } = make({ pages: [full, []] });
    await svc.ingestOrganization(ORG);

    expect(pageCalls).toHaveLength(2);
    expect(pageCalls[0].skip).toBeUndefined();
    expect(pageCalls[1].where.AND).toEqual([
      {
        OR: [
          { createdAt: { gt: at(99) } },
          { createdAt: at(99), id: { gt: 'r99' } },
        ],
      },
    ]);
  });

  it('skips a run while another one for the same organization is in flight', async () => {
    let release!: (v: boolean) => void;
    const gate = new Promise<boolean>((resolve) => (release = resolve));
    const { svc, kgStatic } = make({ pages: [[]], isEnabled: () => gate });

    const first = svc.ingestOrganization(ORG);
    await expect(svc.ingestOrganization(ORG)).resolves.toEqual({
      invocations: 0,
      edges: 0,
      skipped: true,
    });
    release(true);
    await first;

    expect(kgStatic.isEnabled).toHaveBeenCalledTimes(1);
    // The guard is released once the run ends.
    await expect(svc.ingestOrganization(ORG)).resolves.not.toHaveProperty('skipped');
  });

  it('commits the watermark after each page, so a failure later keeps the progress', async () => {
    // Tools that map to no entity still move the watermark: leaving it behind
    // for them is how a connector ended up re-read on every run.
    const full = Array.from({ length: 100 }, (_, i) => row(`r${i}`, 'c2', i, 'erp_whoami'));
    const { svc, prisma } = make({ pages: [full, new Error('db went away')] });

    await expect(svc.ingestOrganization(ORG)).rejects.toThrow('db went away');
    expect(prisma.kgConnectorState.upsert).toHaveBeenCalledWith({
      where: { connectorId: 'c2' },
      create: { organizationId: ORG, connectorId: 'c2', lastObservedAt: at(99) },
      update: { lastObservedAt: at(99) },
    });
  });

  it('never loads an oversized output, and still reads that call’s input', async () => {
    const { svc, payloadCalls } = make({
      pages: [[row('big', 'c2', 1, 'erp_list_orders'), row('small', 'c2', 2, 'erp_get_order')]],
      sizes: { big: { input: 200, output: 10 * MB } },
    });
    await svc.ingestOrganization(ORG);

    const withOutput = payloadCalls.filter((c) => c.select.output);
    const inputOnly = payloadCalls.filter((c) => !c.select.output);
    expect(withOutput.map((c) => c.where.id.in)).toEqual([['small']]);
    expect(inputOnly.map((c) => c.where.id.in)).toEqual([['big']]);
  });

  it('loads payloads in batches bounded by JSON size, not by row count', async () => {
    const { svc, payloadCalls } = make({
      pages: [
        [
          row('a', 'c2', 1, 'erp_get_order'),
          row('b', 'c2', 2, 'erp_get_order'),
          row('c', 'c2', 3, 'erp_get_order'),
        ],
      ],
      sizes: {
        a: { input: 0, output: 3 * MB },
        b: { input: 0, output: 3 * MB },
        c: { input: 0, output: 3 * MB },
      },
    });
    await svc.ingestOrganization(ORG);

    expect(payloadCalls.map((c) => c.where.id.in)).toEqual([['a', 'b'], ['c']]);
  });

  it('stores each occurrence once and pairs each linked entity once', async () => {
    const payload = { order: { customer_id: 'CUST-12345' } };
    const copies = (n: number, r: Record<string, string>) => Array.from({ length: n }, () => r);
    const { svc, prisma } = make({
      pages: [[row('r1', 'c2', 1, 'erp_get_order')]],
      payloads: { r1: { input: {}, output: payload } },
      // What the table looked like before the unique key: the same occurrence
      // stored once per run.
      valueSeen: [
        ...copies(50, {
          valueHash: 'h1',
          connectorId: 'c2',
          entity: 'order',
          field: 'customer_id',
          direction: 'output',
        }),
        ...copies(50, {
          valueHash: 'h1',
          connectorId: 'c1',
          entity: 'customer',
          field: 'id',
          direction: 'input',
        }),
      ],
    });
    await svc.ingestOrganization(ORG);

    expect(prisma.kgValueSeen.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.kgValueSeen.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20_000 }),
    );
    const kinds = prisma.kgEdge.create.mock.calls.map((c: any[]) => c[0].data.kind).sort();
    expect(kinds).toEqual(['produces_consumes', 'same_identity']);
  });
});
