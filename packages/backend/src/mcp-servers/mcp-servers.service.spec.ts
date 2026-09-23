import { McpServersService } from './mcp-servers.service';

describe('McpServersService — composed instructions', () => {
  it('limits connector instructions and skills to the caller-visible IDs', async () => {
    const prisma = {
      mcpServerConfig: {
        findUnique: jest.fn().mockResolvedValue({ instructions: 'Server policy' }),
      },
      mcpServerConnector: {
        findMany: jest.fn().mockResolvedValue([
          {
            connectorId: 'conn-visible',
            connector: {
              name: 'Visible CRM',
              instructions: 'Visible connector notes',
            },
          },
        ]),
      },
    };
    const kgSkills = {
      activeSkillsText: jest.fn().mockResolvedValue('Visible skills'),
    };
    const service = new McpServersService(prisma as any, kgSkills as any, {} as any);

    await expect(
      service.getComposedInstructions('srv-1', ['conn-visible']),
    ).resolves.toBe(
      'Server policy\n\n## Visible CRM\nVisible connector notes\n\nVisible skills',
    );
    expect(prisma.mcpServerConnector.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          mcpServerId: 'srv-1',
          connectorId: { in: ['conn-visible'] },
        },
      }),
    );
    expect(kgSkills.activeSkillsText).toHaveBeenCalledWith('srv-1', [
      'conn-visible',
    ]);
  });
});
