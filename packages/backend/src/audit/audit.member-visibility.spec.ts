import { AuditService, analyticsQuery } from './audit.service';
import { toolPerformanceQuery } from './tool-performance.query';

/**
 * The `onlyUserId` option of the audit reads (restricted member visibility):
 * applied in the Prisma `where` / bound in the SQL, on top of the organisation
 * scope, and absent from the open path.
 */
describe('AuditService own-calls filter', () => {
  const ORG = 'org-1';
  const ME = 'user-me';
  const since = new Date('2026-11-01T00:00:00.000Z');
  const until = new Date('2026-11-02T00:00:00.000Z');

  let service: AuditService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      toolInvocation: {
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { repeatCount: 0 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      connector: { findMany: jest.fn().mockResolvedValue([]) },
      mcpServerConfig: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    service = new AuditService(prisma);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('getRecentInvocations', () => {
    it('adds userId next to the organisation scope and every filter', async () => {
      await service.getRecentInvocations(10, 0, {
        organizationId: ORG,
        toolId: 'tool-1',
        status: 'ERROR',
        search: 'crm',
        connectorId: 'conn-1',
        mcpServerId: 'srv-1',
        onlyUserId: ME,
      });
      expect(prisma.toolInvocation.findMany.mock.calls[0][0].where).toEqual({
        userId: ME,
        toolId: 'tool-1',
        status: 'ERROR',
        mcpServerId: 'srv-1',
        tool: {
          connector: { organizationId: ORG },
          name: { contains: 'crm', mode: 'insensitive' },
          connectorId: 'conn-1',
        },
      });
    });

    it('applies an empty user id instead of dropping the filter', async () => {
      await service.getRecentInvocations(10, 0, { organizationId: ORG, onlyUserId: '' });
      expect(prisma.toolInvocation.findMany.mock.calls[0][0].where).toEqual({
        userId: '',
        tool: { connector: { organizationId: ORG } },
      });
    });

    it('has no user filter on the open path', async () => {
      await service.getRecentInvocations(10, 0, { organizationId: ORG });
      expect(prisma.toolInvocation.findMany.mock.calls[0][0].where).toEqual({
        tool: { connector: { organizationId: ORG } },
      });
    });
  });

  describe('getStats', () => {
    it('narrows every counter to the user', async () => {
      await service.getStats(ORG, ME);
      expect(prisma.toolInvocation.aggregate).toHaveBeenCalledTimes(4);
      for (const [args] of prisma.toolInvocation.aggregate.mock.calls) {
        expect(args.where).toMatchObject({ userId: ME, tool: { connector: { organizationId: ORG } } });
      }
    });

    it('has no user filter on the open path', async () => {
      await service.getStats(ORG);
      for (const [args] of prisma.toolInvocation.aggregate.mock.calls) {
        expect(args.where).not.toHaveProperty('userId');
      }
    });
  });

  describe('getBreakdowns', () => {
    it('narrows every list and total to the user', async () => {
      await service.getBreakdowns(ORG, 30, ME);
      expect(prisma.toolInvocation.groupBy).toHaveBeenCalledTimes(6);
      expect(prisma.toolInvocation.aggregate).toHaveBeenCalledTimes(3);
      for (const [args] of [...prisma.toolInvocation.groupBy.mock.calls, ...prisma.toolInvocation.aggregate.mock.calls]) {
        expect(args.where).toMatchObject({ organizationId: ORG, userId: ME });
      }
    });

    it('has no user filter on the open path', async () => {
      await service.getBreakdowns(ORG, 30);
      for (const [args] of [...prisma.toolInvocation.groupBy.mock.calls, ...prisma.toolInvocation.aggregate.mock.calls]) {
        expect(args.where).not.toHaveProperty('userId');
        expect(args.where).toMatchObject({ organizationId: ORG });
      }
    });
  });

  describe('getAnalytics / analyticsQuery', () => {
    it('passes the user to the query', async () => {
      await service.getAnalytics(ORG, 7, ME);
      const sql = prisma.$queryRaw.mock.calls[0][0];
      expect(sql.values).toEqual([ORG, expect.any(String), ME]);
      expect(sql.text).toMatch(/AND ti\.user_id = \$3/);
    });

    it('binds the user id as a value, never as text', () => {
      const sql = analyticsQuery(ORG, since, "x' OR 1=1 --");
      expect(sql.values).toEqual([ORG, since.toISOString(), "x' OR 1=1 --"]);
      expect(sql.text).not.toContain('OR 1=1');
      expect(sql.text).toMatch(/c\.organization_id = \$1/);
      expect(sql.text).toMatch(/AND ti\.user_id = \$3/);
    });

    it('has no user filter on the open path', () => {
      const sql = analyticsQuery(ORG, since);
      expect(sql.values).toEqual([ORG, since.toISOString()]);
      expect(sql.text).not.toContain('user_id');
    });
  });

  describe('getToolPerformance / toolPerformanceQuery', () => {
    it('passes the user to the query', async () => {
      await service.getToolPerformance(ORG, {}, ME);
      const sql = prisma.$queryRaw.mock.calls[0][0];
      expect(sql.values.filter((v: unknown) => v === ME)).toHaveLength(2);
    });

    it('filters both the groups and the latest-error lookup, with bound values', () => {
      const sql = toolPerformanceQuery(ORG, since, until, { connectorId: 'conn-1', mcpServerId: 'srv-1' }, 25, "x' OR 1=1 --");
      expect(sql.text).not.toContain('OR 1=1');
      const filters = sql.text.match(/AND ti\.user_id = \$(\d+)/g) ?? [];
      expect(filters).toHaveLength(2);
      for (const f of filters) {
        const index = Number(f.split('$')[1]) - 1;
        expect(sql.values[index]).toBe("x' OR 1=1 --");
      }
      // The organisation filter stays.
      expect(sql.text).toMatch(/WHERE c\.organization_id = \$\d+/);
      // The user filter sits inside the LATERAL lookup, after its window bound.
      const lateral = sql.text.slice(sql.text.indexOf('LEFT JOIN LATERAL'));
      expect(lateral).toMatch(/AND ti\.user_id = \$\d+/);
    });

    it('has no user filter on the open path', () => {
      const sql = toolPerformanceQuery(ORG, since, until, {}, 25);
      expect(sql.text).not.toContain('user_id');
      expect(sql.values).not.toContain(ME);
    });
  });
});
