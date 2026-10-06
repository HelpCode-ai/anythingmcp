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
