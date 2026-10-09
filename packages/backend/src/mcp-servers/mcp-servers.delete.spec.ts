import { McpServersService } from './mcp-servers.service';

describe('Deleting an MCP server', () => {
  it('switches off the keys created for it, in the same transaction', async () => {
    const prisma = {
      mcpApiKey: { updateMany: jest.fn((args) => ({ op: 'keys', args })) },
      mcpServerConfig: { delete: jest.fn((args) => ({ op: 'server', args })) },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    };
    const service = new McpServersService(prisma as any, {} as any, {} as any);

    await service.delete('srv-1');

    // The key column is cleared by ON DELETE SET NULL, and a key without a
    // server opens every server of its organization: it must be off first.
    expect(prisma.$transaction).toHaveBeenCalledWith([
      { op: 'keys', args: { where: { mcpServerId: 'srv-1' }, data: { isActive: false } } },
      { op: 'server', args: { where: { id: 'srv-1' } } },
    ]);
  });
});
