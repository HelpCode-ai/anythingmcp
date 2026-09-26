import { McpServersService } from './mcp-servers.service';

describe('McpServersService.usageByServer', () => {
  function serviceWith(rows: unknown[]) {
    const groupBy = jest.fn().mockResolvedValue(rows);
    const prisma = { toolInvocation: { groupBy } };
    return { service: new McpServersService(prisma as any, {} as any, {} as any), groupBy };
  }

  it('returns calls and last call per server over the last 30 days', async () => {
    const last = new Date('2026-09-25T10:00:00Z');
    const { service, groupBy } = serviceWith([
      { mcpServerId: 's1', _count: { _all: 42 }, _max: { createdAt: last } },
    ]);

    const usage = await service.usageByServer(['s1', 's2']);

    expect(usage.get('s1')).toEqual({ calls30d: 42, lastCallAt: last });
    // No row: the server served nothing in the window.
    expect(usage.has('s2')).toBe(false);

    const where = groupBy.mock.calls[0][0].where;
    expect(where.mcpServerId).toEqual({ in: ['s1', 's2'] });
    const days = (Date.now() - where.createdAt.gte.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it('does not query when there are no servers', async () => {
    const { service, groupBy } = serviceWith([]);
    expect((await service.usageByServer([])).size).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
  });
});
