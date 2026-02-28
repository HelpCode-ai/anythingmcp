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
      },
    };
    service = new AuditService(mockPrisma);
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

      expect(mockPrisma.toolInvocation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          toolId: 'tool-1',
          userId: 'user-1',
          status: 'SUCCESS',
          durationMs: 150,
        }),
      });
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
      mockPrisma.toolInvocation.count
        .mockResolvedValueOnce(10)  // 24h invocations
        .mockResolvedValueOnce(2)   // 24h errors
        .mockResolvedValueOnce(50)  // 7d invocations
        .mockResolvedValueOnce(100); // total

      const stats = await service.getStats();

      expect(stats).toEqual({
        invocations24h: 10,
        errors24h: 2,
        invocations7d: 50,
        totalInvocations: 100,
      });
      expect(mockPrisma.toolInvocation.count).toHaveBeenCalledTimes(4);
    });
  });
});
