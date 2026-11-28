import { McpApiKeysController } from './mcp-api-keys.controller';

describe('McpApiKeysController.generateKey', () => {
  function build() {
    const keysService = { generate: jest.fn(async () => ({ id: 'k1' })) };
    const controller = new McpApiKeysController(keysService as any);
    return { controller, keysService };
  }

  it("limits a server key requested with an API key to the key's workspace", async () => {
    const { controller, keysService } = build();
    await controller.generateKey(
      { user: { sub: 'u1', role: 'ADMIN', organizationId: 'org-a' }, mcpKeyScope: 'MANAGEMENT_ADMIN' },
      { name: 'k', mcpServerId: 'srv-1' },
    );
    expect(keysService.generate).toHaveBeenCalledWith('u1', 'org-a', 'k', 'srv-1', 'MCP', {
      keyOrganizationId: 'org-a',
    });
  });

  it('leaves a dashboard session free to pick a server of any of its workspaces', async () => {
    const { controller, keysService } = build();
    await controller.generateKey(
      { user: { sub: 'u1', role: 'ADMIN', organizationId: 'org-a' } },
      { name: 'k', mcpServerId: 'srv-1' },
    );
    expect(keysService.generate).toHaveBeenCalledWith('u1', 'org-a', 'k', 'srv-1', 'MCP', {});
  });
});
