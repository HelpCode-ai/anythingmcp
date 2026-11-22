import { AuditService } from './audit.service';

describe('AuditService', () => {
  let service: AuditService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      toolInvocation: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { repeatCount: 0 } }),
        update: jest.fn().mockResolvedValue({}),
      },
      // resolveUserId consults users to satisfy the FK before insert.
      // Default: the test user exists. Individual tests override
      // findUnique to simulate missing-row or email-fallback paths.
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }),
      },
    };
    service = new AuditService(mockPrisma);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('logInvocation', () => {
    it('should persist an invocation record', async () => {
      await service.logInvocation({
        toolId: 'tool-1',
        userId: 'user-1',
        input: { query: 'test' },
        output: { result: 'ok' },
        status: 'SUCCESS',
        durationMs: 150,
      });

      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            toolId: 'tool-1',
            userId: 'user-1',
            status: 'SUCCESS',
            durationMs: 150,
          }),
        }),
      );
    });

    it('writes nothing for the workspace on a support-key call: no row, alert or first success', async () => {
      const alerts = { recordFailure: jest.fn().mockResolvedValue(undefined) };
      const firstSuccess = { onFirstSuccess: jest.fn() };
      const withHooks = new AuditService(mockPrisma, undefined, alerts as any, firstSuccess as any);
      const log = jest.spyOn((withHooks as any).logger, 'log').mockImplementation(() => undefined);
      try {
        for (const status of ['SUCCESS', 'ERROR'] as const) {
          await withHooks.logInvocation({
            toolId: 'tool-1',
            userId: 'user-1',
            organizationId: 'org-1',
            connectorId: 'conn-1',
            input: { secret: 'customer data' },
            output: { result: 'customer data' },
            status,
            error: status === 'ERROR' ? 'boom' : undefined,
            durationMs: 12,
            supportKeyId: 'sk-1',
          });
        }
        expect(mockPrisma.toolInvocation.create).not.toHaveBeenCalled();
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
        expect(alerts.recordFailure).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledTimes(2);
        const line = String(log.mock.calls[0][0]);
        expect(line).toBe('Support call: key sk-1, org org-1, user user-1, tool tool-1, SUCCESS, 12ms');
        expect(line).not.toContain('customer data');
      } finally {
        await withHooks.onModuleDestroy();
      }
    });

    it('should not throw if persistence fails', async () => {
      mockPrisma.toolInvocation.create.mockRejectedValue(new Error('DB down'));

      await expect(
        service.logInvocation({
          toolId: 'tool-1',
          input: {},
          status: 'ERROR',
          error: 'something broke',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('getRecentInvocations', () => {
    it('should query with default pagination', async () => {
      await service.getRecentInvocations();

      expect(mockPrisma.toolInvocation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
          skip: 0,
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('should apply filters', async () => {
      await service.getRecentInvocations(50, 10, {
        toolId: 'tool-1',
        status: 'ERROR',
      });

      expect(mockPrisma.toolInvocation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { toolId: 'tool-1', status: 'ERROR' },
          take: 50,
          skip: 10,
        }),
      );
    });

    it('should filter on the date range', async () => {
      await service.getRecentInvocations(50, 0, {
        organizationId: 'org-1',
        from: new Date('2026-10-01T00:00:00Z'),
        to: new Date('2026-10-08T00:00:00Z'),
      });

      expect(mockPrisma.toolInvocation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tool: { connector: { organizationId: 'org-1' } },
            createdAt: {
              gte: new Date('2026-10-01T00:00:00Z'),
              lt: new Date('2026-10-08T00:00:00Z'),
            },
          },
        }),
      );
    });
  });

  describe('exportInvocations', () => {
    const at = (i: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - i * 1000);
    const rows = (start: number, n: number) =>
      Array.from({ length: n }, (_, k) => ({ id: `inv-${start + k}`, createdAt: at(start + k) }));
    const collect = () => {
      const batches: any[][] = [];
      return { batches, onBatch: async (b: any[]) => void batches.push(b) };
    };

    it('refuses to run without an organization', async () => {
      const { onBatch } = collect();
      await expect(service.exportInvocations({}, { payloads: false }, onBatch)).rejects.toThrow(
        'organization',
      );
      expect(mockPrisma.toolInvocation.findMany).not.toHaveBeenCalled();
    });

    it('pages with a keyset cursor on (createdAt desc, id desc)', async () => {
      mockPrisma.toolInvocation.findMany
        .mockResolvedValueOnce(rows(0, 2))
        .mockResolvedValueOnce(rows(2, 2))
        .mockResolvedValueOnce(rows(4, 1));
      const { batches, onBatch } = collect();

      const result = await service.exportInvocations(
        { organizationId: 'org-1', status: 'ERROR' },
        { payloads: false, batchSize: 2, maxRows: 100 },
        onBatch,
      );

      expect(result).toEqual({ rowCount: 5, truncated: false, aborted: false });
      expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
      const calls = mockPrisma.toolInvocation.findMany.mock.calls.map((c: any[]) => c[0]);
      const scope = { tool: { connector: { organizationId: 'org-1' } }, status: 'ERROR' };
      expect(calls[0].where).toEqual(scope);
      expect(calls[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(calls[0].take).toBe(2);
      expect(calls[0]).not.toHaveProperty('skip');
      expect(calls[1].where).toEqual({
        AND: [
          scope,
          { OR: [{ createdAt: { lt: at(1) } }, { createdAt: at(1), id: { lt: 'inv-1' } }] },
        ],
      });
      expect(calls[2].where.AND[1].OR[1]).toEqual({ createdAt: at(3), id: { lt: 'inv-3' } });
    });

    it("names only a restricted member's own servers, as the list does", async () => {
      mockPrisma.toolInvocation.findMany.mockResolvedValueOnce([
        { ...rows(0, 1)[0], mcpServer: { name: 'Mine', userId: 'me' } },
        { ...rows(1, 1)[0], mcpServer: { name: 'Theirs', userId: 'other' } },
        { ...rows(2, 1)[0], mcpServer: null },
      ]);
      const { batches, onBatch } = collect();

      await service.exportInvocations(
        { organizationId: 'org-1', onlyUserId: 'me' },
        { payloads: false, batchSize: 10 },
        onBatch,
      );

      const call = mockPrisma.toolInvocation.findMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ userId: 'me' });
      expect(call.select.mcpServer).toEqual({ select: { name: true, userId: true } });
      expect(batches[0].map((r: any) => [r.mcpServer, r.serverHidden])).toEqual([
        [{ name: 'Mine' }, undefined],
        [null, true],
        [null, true],
      ]);
    });

    it('selects input and output only when payloads are asked for', async () => {
      const { onBatch } = collect();
      await service.exportInvocations({ organizationId: 'org-1' }, { payloads: false }, onBatch);
      const without = mockPrisma.toolInvocation.findMany.mock.calls[0][0].select;
      expect(without).not.toHaveProperty('input');
      expect(without).not.toHaveProperty('output');
      expect(without).toMatchObject({ createdAt: true, repeatCount: true, clientInfo: true });

      await service.exportInvocations({ organizationId: 'org-1' }, { payloads: true }, onBatch);
      expect(mockPrisma.toolInvocation.findMany.mock.calls[1][0].select).toMatchObject({
        input: true,
        output: true,
      });
    });

    it('stops at the row cap and says so only when rows were left out', async () => {
      // 3 batches of 2 against a cap of 5: the last query asks for one extra row.
      mockPrisma.toolInvocation.findMany
        .mockResolvedValueOnce(rows(0, 2))
        .mockResolvedValueOnce(rows(2, 2))
        .mockResolvedValueOnce(rows(4, 2));
      const capped = collect();
      const result = await service.exportInvocations(
        { organizationId: 'org-1' },
        { payloads: false, batchSize: 2, maxRows: 5 },
        capped.onBatch,
      );
      expect(result).toEqual({ rowCount: 5, truncated: true, aborted: false });
      expect(capped.batches.flat()).toHaveLength(5);
      expect(mockPrisma.toolInvocation.findMany.mock.calls[2][0].take).toBe(2);

      // Exactly the cap: nothing was left out.
      mockPrisma.toolInvocation.findMany.mockReset();
      mockPrisma.toolInvocation.findMany
        .mockResolvedValueOnce(rows(0, 2))
        .mockResolvedValueOnce(rows(2, 2))
        .mockResolvedValueOnce([]);
      const exact = collect();
      expect(
        await service.exportInvocations(
          { organizationId: 'org-1' },
          { payloads: false, batchSize: 2, maxRows: 4 },
          exact.onBatch,
        ),
      ).toEqual({ rowCount: 4, truncated: false, aborted: false });
      expect(mockPrisma.toolInvocation.findMany.mock.calls[2][0].take).toBe(1);
    });

    it('stops reading when the consumer gives up', async () => {
      mockPrisma.toolInvocation.findMany.mockResolvedValue(rows(0, 2));
      const result = await service.exportInvocations(
        { organizationId: 'org-1' },
        { payloads: false, batchSize: 2, maxRows: 100 },
        async () => false,
      );
      expect(result).toEqual({ rowCount: 2, truncated: false, aborted: true });
      expect(mockPrisma.toolInvocation.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('invocationWhere', () => {
    it("matches nothing for a restricted member filtering by another member's server", () => {
      expect(
        service.invocationWhere({ organizationId: 'org-1', onlyUserId: 'me', mcpServerId: 'srv-1' }),
      ).toEqual({
        tool: { connector: { organizationId: 'org-1' } },
        userId: 'me',
        mcpServerId: 'srv-1',
        mcpServer: { userId: 'me' },
      });
    });

    it('keeps the organization scope when search and connector also filter the tool', () => {
      expect(
        service.invocationWhere({
          organizationId: 'org-1',
          search: 'get_',
          connectorId: 'conn-1',
          mcpServerId: 'srv-1',
          status: 'TIMEOUT',
        }),
      ).toEqual({
        tool: {
          connector: { organizationId: 'org-1' },
          name: { contains: 'get_', mode: 'insensitive' },
          connectorId: 'conn-1',
        },
        mcpServerId: 'srv-1',
        status: 'TIMEOUT',
      });
    });

    it('sets only the date bound that is given', () => {
      const from = new Date('2026-10-01T00:00:00Z');
      const to = new Date('2026-10-08T00:00:00Z');
      expect(service.invocationWhere({ organizationId: 'org-1', from }).createdAt).toEqual({ gte: from });
      expect(service.invocationWhere({ organizationId: 'org-1', to }).createdAt).toEqual({ lt: to });
      expect(service.invocationWhere({ organizationId: 'org-1' })).not.toHaveProperty('createdAt');
    });
  });

  describe('getStats', () => {
    it('should return aggregated stats', async () => {
      mockPrisma.toolInvocation.aggregate
        .mockResolvedValueOnce({ _sum: { repeatCount: 10 } }) // 24h invocations
        .mockResolvedValueOnce({ _sum: { repeatCount: 2 } }) // 24h errors
        .mockResolvedValueOnce({ _sum: { repeatCount: 50 } }) // 7d invocations
        .mockResolvedValueOnce({ _sum: { repeatCount: 100 } }); // total

      const stats = await service.getStats();

      expect(stats).toEqual({
        invocations24h: 10,
        errors24h: 2,
        invocations7d: 50,
        totalInvocations: 100,
      });
      expect(mockPrisma.toolInvocation.aggregate).toHaveBeenCalledTimes(4);
    });
  });

  describe('repeated failures', () => {
    const fail = (error = '429 Too Many Requests: body={"code":429,"msg":"Request rate limit reached"}') =>
      service.logInvocation({
        toolId: 'tool-1',
        connectorId: 'conn-1',
        organizationId: 'org-1',
        input: { view: 'api.pgb_v1' },
        status: 'ERROR',
        error,
      });

    beforeEach(() => {
      let n = 0;
      mockPrisma.toolInvocation.create.mockImplementation(async () => ({ id: `row-${++n}` }));
    });

    it('stores the first failure and counts identical ones on it', async () => {
      await fail();
      await fail();
      await fail();
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledTimes(1);

      await service.flushRepeats(true);
      expect(mockPrisma.toolInvocation.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { repeatCount: { increment: 2 } },
      });
    });

    it('treats errors that differ only in numbers as the same', async () => {
      await fail('upstream timeout after 3012 ms (request 8812)');
      await fail('upstream timeout after 2977 ms (request 9001)');
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledTimes(1);
    });

    it('stores a different error, or a success, as its own row', async () => {
      await fail();
      await fail('403 Forbidden: Access denied');
      await service.logInvocation({ toolId: 'tool-1', connectorId: 'conn-1', input: {}, status: 'SUCCESS' });
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledTimes(3);
    });

    it('stores the failure again once the window has passed, carrying over the count', async () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000_000);
      await fail();
      await fail();
      now.mockReturnValue(1_000_000 + 61_000);
      await fail();
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledTimes(2);
      expect(mockPrisma.toolInvocation.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { repeatCount: { increment: 1 } },
      });
      now.mockRestore();
    });
  });

  describe('connector-failure alerts', () => {
    it('notifies on every failing call, even ones the repeat-dedup check collapses into an existing row', async () => {
      const alerts = { recordFailure: jest.fn().mockResolvedValue(undefined) };
      const svc = new AuditService(mockPrisma, undefined, alerts as any);
      // Dedup only engages once create() returns a row id to count repeats
      // against — same setup as the 'repeated failures' block above.
      let n = 0;
      mockPrisma.toolInvocation.create.mockImplementation(async () => ({ id: `row-${++n}` }));

      const fail = () =>
        svc.logInvocation({
          toolId: 'tool-1',
          connectorId: 'conn-1',
          organizationId: 'org-1',
          input: {},
          status: 'ERROR',
          error: '429 Too Many Requests',
        });

      await fail();
      await fail();
      await fail();
      // Only one row was written (see 'repeated failures' above), but all
      // three attempts are real failures and must all reach the alert hook.
      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledTimes(1);
      expect(alerts.recordFailure).toHaveBeenCalledTimes(3);
      expect(alerts.recordFailure).toHaveBeenCalledWith({
        organizationId: 'org-1',
        connectorId: 'conn-1',
        toolId: 'tool-1',
        error: '429 Too Many Requests',
      });

      await svc.onModuleDestroy();
    });

    it('does not notify on success, or when organizationId/connectorId is missing', async () => {
      const alerts = { recordFailure: jest.fn().mockResolvedValue(undefined) };
      const svc = new AuditService(mockPrisma, undefined, alerts as any);

      await svc.logInvocation({ toolId: 't', organizationId: 'org-1', connectorId: 'conn-1', input: {}, status: 'SUCCESS' });
      await svc.logInvocation({ toolId: 't', connectorId: 'conn-1', input: {}, status: 'ERROR', error: 'e' }); // no org
      await svc.logInvocation({ toolId: 't', organizationId: 'org-1', input: {}, status: 'ERROR', error: 'e' }); // no connector

      expect(alerts.recordFailure).not.toHaveBeenCalled();
      await svc.onModuleDestroy();
    });

    it('never lets a failing alert dispatch affect logInvocation', async () => {
      const alerts = { recordFailure: jest.fn().mockRejectedValue(new Error('webhook down')) };
      const svc = new AuditService(mockPrisma, undefined, alerts as any);

      await expect(
        svc.logInvocation({
          toolId: 't',
          organizationId: 'org-1',
          connectorId: 'conn-1',
          input: {},
          status: 'ERROR',
          error: 'e',
        }),
      ).resolves.toBeUndefined();

      await svc.onModuleDestroy();
    });
  });

  describe('payload budget', () => {
    it('keeps only a short excerpt once an organisation has logged its hourly budget', async () => {
      const big = { rows: 'x'.repeat(20_000) };
      for (let i = 0; i < 1001; i++) {
        await service.logInvocation({ toolId: 't', organizationId: 'busy-org', input: {}, output: big, status: 'SUCCESS' });
      }
      const calls = mockPrisma.toolInvocation.create.mock.calls;
      const size = (call: any) => JSON.stringify(call[0].data.output).length;
      // Within the budget the normal excerpt rules apply; past it, 512 bytes.
      expect(size(calls[999])).toBeGreaterThan(1_500);
      expect(size(calls[1000])).toBeLessThanOrEqual(512);
      expect(calls[1000][0].data.status).toBe('SUCCESS');
    });
  });
});
