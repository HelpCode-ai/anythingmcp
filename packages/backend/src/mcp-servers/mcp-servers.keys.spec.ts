import { NotFoundException } from '@nestjs/common';
import { McpServersController } from './mcp-servers.controller';
import { McpServersService } from './mcp-servers.service';

/**
 * MCP API keys are bearer credentials. The server detail must never hand a
 * member another member's key (a VIEWER could otherwise impersonate an admin),
 * and never a full key after creation.
 */
describe('MCP server detail: API keys', () => {
  const FULL_KEY = `mcp_${'a'.repeat(56)}deadbeef`;

  function makeService(rows: any[]) {
    const prisma = {
      mcpServerConfig: {
        findUnique: jest.fn(async () => ({ id: 's1', organizationId: 'org-1' })),
      },
      mcpApiKey: {
        findMany: jest.fn(async ({ where }: any) =>
          rows.filter(
            (r) =>
              r.mcpServerId === where.mcpServerId &&
              r.userId === where.userId &&
              r.organizationId === where.organizationId,
          ),
        ),
      },
    };
    const service = new McpServersService(prisma as any, {} as any, {} as any);
    return { service, prisma };
  }

  const rows = [
    { id: 'k-admin', userId: 'admin', organizationId: 'org-1', mcpServerId: 's1', name: 'Admin', key: FULL_KEY, keySuffix: 'deadbeef' },
    { id: 'k-viewer', userId: 'viewer', organizationId: 'org-1', mcpServerId: 's1', name: 'Viewer', key: `hashed_${'b'.repeat(48)}`, keySuffix: 'cafebabe' },
  ];

  it('masks from the stored suffix and never selects the key column', async () => {
    const { service, prisma } = makeService(rows);
    const res = await service.listOwnKeysForServer('s1', 'viewer', 'org-1');
    const args = (prisma.mcpApiKey.findMany as jest.Mock).mock.calls[0][0];
    expect(args.select.key).toBeUndefined();
    expect(args.select.keySuffix).toBe(true);
    expect(res).toEqual([expect.objectContaining({ id: 'k-viewer', key: `mcp_${'•'.repeat(24)}cafebabe` })]);
    expect(res[0]).not.toHaveProperty('keySuffix');
  });

  it('does not load API keys in findById', async () => {
    const { service, prisma } = makeService(rows);
    await service.findById('s1');
    const args = (prisma.mcpServerConfig.findUnique as jest.Mock).mock.calls[0][0];
    expect(args.include.apiKeys).toBeUndefined();
  });

  it("returns only the caller's keys, masked", async () => {
    const { service } = makeService(rows);
    const controller = new McpServersController(service, {} as any, {} as any);
    const res: any = await controller.get(
      { user: { sub: 'viewer', organizationId: 'org-1', role: 'VIEWER' } },
      's1',
    );
    expect(res.apiKeys.map((k: any) => k.id)).toEqual(['k-viewer']);
    expect(res.apiKeys[0].key).toBe(`mcp_${'•'.repeat(24)}cafebabe`);
    expect(JSON.stringify(res)).not.toContain(FULL_KEY);
  });

  it("answers 404 for another workspace's server without reading keys", async () => {
    const { service, prisma } = makeService(rows);
    const controller = new McpServersController(service, {} as any, {} as any);
    await expect(
      controller.get({ user: { sub: 'x', organizationId: 'org-2', role: 'ADMIN' } }, 's1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.mcpApiKey.findMany).not.toHaveBeenCalled();
  });
});
