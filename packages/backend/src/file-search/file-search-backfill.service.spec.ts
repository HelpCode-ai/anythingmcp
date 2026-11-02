import { buildFileSearchBuiltinTools } from './file-search-builtins';
import { FileSearchBackfillService } from './file-search-backfill.service';

type Row = { id: string; organizationId: string; name: string; config: unknown; isActive: boolean; type: string };

const OLD_SET = ['guide', 'search', 'find', 'list', 'read', 'grep', 'status', 'get_file', 'share_file'];

function make(connectors: Row[], tools: Array<{ connectorId: string; name: string }>) {
  const created: any[] = [];
  const prisma = {
    connector: {
      findMany: jest.fn(async (args: any) => {
        const rows = connectors.filter((c) => c.type === args.where.type).sort((a, b) => a.id.localeCompare(b.id));
        const start = args.cursor ? rows.findIndex((r) => r.id === args.cursor.id) + (args.skip ?? 0) : 0;
        return rows.slice(start, start + args.take);
      }),
    },
    mcpTool: {
      findMany: jest.fn(async (args: any) => tools.filter((t) => args.where.connectorId.in.includes(t.connectorId))),
      createMany: jest.fn(async (args: any) => {
        const fresh = args.data.filter((d: any) => !tools.some((t) => t.connectorId === d.connectorId && t.name === d.name));
        created.push(...fresh);
        tools.push(...fresh.map((d: any) => ({ connectorId: d.connectorId, name: d.name })));
        return { count: fresh.length };
      }),
    },
  };
  const repo = {
    withTenant: jest.fn(async (_org: string, fn: any) => fn({ fileSource: { findMany: async () => [{ connectorId: 'c1', summary: '432 supplier folders' }] } })),
  };
  const mcpServer = { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) };
  const service = new FileSearchBackfillService(prisma as any, repo as any, mcpServer as any);
  return { service, prisma, created, mcpServer };
}

const fileSearch = (id: string, prefix: string, extra: Partial<Row> = {}): Row => ({
  id, organizationId: 'org-1', name: `Folder ${id}`, type: 'FILE_SEARCH', isActive: true, config: { fileSearch: { toolPrefix: prefix } }, ...extra,
});
const oldTools = (connectorId: string, prefix: string) => OLD_SET.map((n) => ({ connectorId, name: `${prefix}_${n}` }));

describe('FileSearchBackfillService', () => {
  it('creates only the missing built-in tools and reloads the connector', async () => {
    const { service, created, mcpServer } = make([fileSearch('c1', 'pricelists')], oldTools('c1', 'pricelists'));
    expect(await service.backfillBuiltinTools()).toEqual({ connectors: 1, tools: 1 });
    expect(created).toHaveLength(1);
    const expected = buildFileSearchBuiltinTools({ prefix: 'pricelists', displayName: 'Folder c1', summary: '432 supplier folders' }).find((t) => t.name === 'pricelists_view_page')!;
    expect(created[0]).toMatchObject({ connectorId: 'c1', name: 'pricelists_view_page', isEnabled: true, description: expected.description, endpointMapping: { method: 'file_view', path: '' } });
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('c1');
  });

  it('is idempotent and never touches existing tools', async () => {
    const { service, prisma, mcpServer } = make([fileSearch('c1', 'pricelists')], oldTools('c1', 'pricelists'));
    await service.backfillBuiltinTools();
    prisma.mcpTool.createMany.mockClear();
    mcpServer.reloadConnectorTools.mockClear();
    expect(await service.backfillBuiltinTools()).toEqual({ connectors: 0, tools: 0 });
    expect(prisma.mcpTool.createMany).not.toHaveBeenCalled();
    expect(mcpServer.reloadConnectorTools).not.toHaveBeenCalled();
    expect((prisma as any).mcpTool.update).toBeUndefined();
  });

  it('creates share_file switched off when it is missing too', async () => {
    const tools = oldTools('c1', 'p').filter((t) => t.name !== 'p_share_file');
    const { service, created } = make([fileSearch('c1', 'p')], tools);
    await service.backfillBuiltinTools();
    expect(created.find((t) => t.name === 'p_share_file')).toMatchObject({ isEnabled: false });
    expect(created.find((t) => t.name === 'p_view_page')).toMatchObject({ isEnabled: true });
  });

  it('ignores other connector types, File Share connectors and never-activated drafts', async () => {
    const { service, prisma, created } = make(
      [
        fileSearch('c1', 'rest_like', { type: 'REST' }),
        fileSearch('c2', 'share', { config: { fileShare: true } }),
        fileSearch('c3', 'draft'),
      ],
      [{ connectorId: 'c2', name: 'share_upload' }, { connectorId: 'c2', name: 'share_list' }, { connectorId: 'c2', name: 'share_revoke' }],
    );
    expect(await service.backfillBuiltinTools()).toEqual({ connectors: 0, tools: 0 });
    expect(created).toEqual([]);
    expect(prisma.mcpTool.createMany).not.toHaveBeenCalled();
  });

  it('does not reload inactive connectors and pages through every connector in batches', async () => {
    const connectors = Array.from({ length: 120 }, (_, i) => fileSearch(`c${String(i).padStart(3, '0')}`, `f${i}`, { isActive: i % 2 === 0 }));
    const tools = connectors.flatMap((c, i) => oldTools(c.id, `f${i}`));
    const { service, prisma, mcpServer } = make(connectors, tools);
    expect(await service.backfillBuiltinTools()).toEqual({ connectors: 120, tools: 120 });
    expect(prisma.connector.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.connector.findMany.mock.calls[0][0].take).toBe(50);
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledTimes(60);
  });

  it('logs an error instead of failing boot', async () => {
    const { service, prisma } = make([], []);
    prisma.connector.findMany.mockRejectedValue(new Error('database down'));
    const error = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => service.onApplicationBootstrap()).not.toThrow();
      await new Promise((r) => setImmediate(r));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('database down'));
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});
