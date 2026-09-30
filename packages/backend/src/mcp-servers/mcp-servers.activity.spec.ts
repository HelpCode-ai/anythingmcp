import { NotFoundException } from '@nestjs/common';
import { McpServersController } from './mcp-servers.controller';

/**
 * The connect page polls this to see the first request from an AI client
 * arrive. It must answer for the caller's own servers only.
 */
describe('McpServersController.activity', () => {
  const last = new Date('2026-09-30T10:00:00Z');

  function makeController(server: any) {
    const service = {
      findById: jest.fn(async () => server),
      usageByServer: jest.fn(async (ids: string[]) =>
        new Map(ids.map((id) => [id, { calls30d: 3, lastCallAt: last }])),
      ),
    };
    const controller = new McpServersController(service as any, {} as any, {} as any);
    return { controller, service };
  }

  it("returns the server's calls and last call time", async () => {
    const { controller } = makeController({ id: 's1', organizationId: 'org-1' });
    const res = await controller.activity({ user: { organizationId: 'org-1' } }, 's1');
    expect(res).toEqual({ calls30d: 3, lastCallAt: last });
  });

  it("answers 404 for another workspace's server without reading its usage", async () => {
    const { controller, service } = makeController({ id: 's2', organizationId: 'org-2' });
    await expect(
      controller.activity({ user: { organizationId: 'org-1' } }, 's2'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(service.usageByServer).not.toHaveBeenCalled();
  });

  it('answers 404 for a server that does not exist', async () => {
    const { controller } = makeController(null);
    await expect(
      controller.activity({ user: { organizationId: 'org-1' } }, 'nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
