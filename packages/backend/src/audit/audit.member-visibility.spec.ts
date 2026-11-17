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
        // A server filter matches only a server the member owns.
        mcpServer: { userId: ME },
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
      await service.getRecentInvocations(10, 0, { organizationId: ORG, mcpServerId: 'srv-1' });
      expect(prisma.toolInvocation.findMany.mock.calls[0][0].where).toEqual({
        mcpServerId: 'srv-1',
        tool: { connector: { organizationId: ORG } },
      });
    });

    it('names a server only when the member owns it', async () => {
      prisma.toolInvocation.findMany.mockResolvedValue([
        { id: 'c1', mcpServerId: 'srv-mine', mcpServer: { id: 'srv-mine', name: 'Mine', slug: 'mine', userId: ME } },
        { id: 'c2', mcpServerId: 'srv-team', mcpServer: { id: 'srv-team', name: 'Default (Alice)', slug: 'default-alice', userId: 'alice' } },
        { id: 'c3', mcpServerId: null, mcpServer: null },
      ]);
      const rows = await service.getRecentInvocations(10, 0, { organizationId: ORG, onlyUserId: ME });
      expect(prisma.toolInvocation.findMany.mock.calls[0][0].include.mcpServer.select).toEqual({
        id: true,
        name: true,
        slug: true,
        userId: true,
      });
      expect(rows).toEqual([
        { id: 'c1', mcpServerId: 'srv-mine', mcpServer: { id: 'srv-mine', name: 'Mine', slug: 'mine' } },
        { id: 'c2', mcpServerId: null, mcpServer: null },
        { id: 'c3', mcpServerId: null, mcpServer: null },
      ]);
      expect(JSON.stringify(rows)).not.toContain('Alice');
    });

    it('returns rows untouched on the open path', async () => {
      const row = { id: 'c2', mcpServerId: 'srv-team', mcpServer: { id: 'srv-team', name: 'Default (Alice)', slug: 'default-alice' } };
      prisma.toolInvocation.findMany.mockResolvedValue([row]);
      expect(await service.getRecentInvocations(10, 0, { organizationId: ORG })).toEqual([row]);
      expect(prisma.toolInvocation.findMany.mock.calls[0][0].include.mcpServer.select).toEqual({ id: true, name: true, slug: true });
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

    describe('byServer', () => {
      const rows = (errors: boolean) => [
        { mcpServerId: 'srv-mine', _count: { _all: errors ? 1 : 5 }, _sum: { repeatCount: errors ? 1 : 5 } },
        { mcpServerId: 'srv-alice', _count: { _all: errors ? 2 : 4 }, _sum: { repeatCount: errors ? 2 : 4 } },
        { mcpServerId: null, _count: { _all: errors ? 0 : 3 }, _sum: { repeatCount: errors ? 0 : 3 } },
      ];
      beforeEach(() => {
        prisma.toolInvocation.groupBy.mockImplementation(async (args: any) =>
          args.by[0] === 'mcpServerId' ? rows(args.where.status === 'ERROR') : [],
        );
        prisma.mcpServerConfig.findMany.mockResolvedValue([
          { id: 'srv-mine', name: 'Mine', userId: ME },
          { id: 'srv-alice', name: 'Default (Alice)', userId: 'alice' },
        ]);
      });

      it('names only servers the member owns; the others join the row without a server', async () => {
        const out = await service.getBreakdowns(ORG, 30, ME);
        expect(out.byServer).toEqual([
          { id: null, label: 'Other server or none', count: 7, errors: 2 },
          { id: 'srv-mine', label: 'Mine', count: 5, errors: 1 },
        ]);
        expect(JSON.stringify(out)).not.toContain('Alice');
        expect(JSON.stringify(out)).not.toContain('srv-alice');
      });

      it('lists every server on the open path', async () => {
        const out = await service.getBreakdowns(ORG, 30);
        expect(out.byServer.map((r: any) => r.label)).toEqual(['Mine', 'Default (Alice)', 'Direct / no server']);
      });
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
      // Two call filters, and three server expressions (id and name in the
      // groups, id in the latest-error lookup).
      expect(sql.values.filter((v: unknown) => v === ME)).toHaveLength(5);
    });

    it('names only servers the member owns, in the groups and in the latest-error lookup', () => {
      const sql = toolPerformanceQuery(ORG, since, until, {}, 25, ME);
      expect(sql.text).toMatch(/CASE WHEN s\.user_id = \$\d+ THEN ti\.mcp_server_id END AS mcp_server_id/);
      expect(sql.text).toMatch(/CASE WHEN s\.user_id = \$\d+ THEN s\.name END AS mcp_server_name/);
      expect(sql.text).toMatch(/GROUP BY 1, 2, 3, 4, 5, 6/);
      const lateral = sql.text.slice(sql.text.indexOf('LEFT JOIN LATERAL'));
      expect(lateral).toMatch(/LEFT JOIN mcp_server_configs ls ON ls\.id = ti\.mcp_server_id/);
      expect(lateral).toMatch(/CASE WHEN ls\.user_id = \$\d+ THEN ti\.mcp_server_id END IS NOT DISTINCT FROM page\.mcp_server_id/);
    });

    it('a server filter matches only a server the member owns', () => {
      const sql = toolPerformanceQuery(ORG, since, until, { mcpServerId: 'srv-1' }, 25, ME);
      expect(sql.text).toMatch(/AND ti\.mcp_server_id = \$\d+ AND s\.user_id = \$\d+/);
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
