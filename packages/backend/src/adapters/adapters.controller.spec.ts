import { ForbiddenException } from '@nestjs/common';
import { AdaptersController } from './adapters.controller';

function buildController() {
  const adaptersService = {
    importAdapter: jest
      .fn()
      .mockResolvedValue({ connectorId: 'c1', toolsCreated: 3 }),
  };
  const licenseGuard = {
    checkCanCreateConnector: jest.fn().mockResolvedValue(undefined),
  };
  const mcpServers = {
    attachToDefaultServer: jest
      .fn()
      .mockResolvedValue({ id: 's1', name: 'Default' }),
  };
  const controller = new AdaptersController(
    adaptersService as any,
    licenseGuard as any,
    mcpServers as any,
  );
  return { controller, adaptersService, licenseGuard, mcpServers };
}

const req = (role: string) => ({
  user: { sub: 'u1', organizationId: 'org1', role },
});

describe('AdaptersController role enforcement', () => {
  describe('POST /api/adapters/:slug/import (importAdapter)', () => {
    it('rejects VIEWER before importing the adapter', async () => {
      const { controller, adaptersService, licenseGuard } = buildController();

      await expect(
        controller.importAdapter(req('VIEWER'), 'some-slug', {}),
      ).rejects.toThrow(ForbiddenException);

      expect(licenseGuard.checkCanCreateConnector).not.toHaveBeenCalled();
      expect(adaptersService.importAdapter).not.toHaveBeenCalled();
    });

    it.each(['EDITOR', 'ADMIN'])('allows %s to import an adapter', async (role) => {
      const { controller, adaptersService } = buildController();

      await controller.importAdapter(req(role), 'some-slug', {});

      expect(adaptersService.importAdapter).toHaveBeenCalledTimes(1);
    });

    it('puts the imported connector on the default server and says which', async () => {
      const { controller, mcpServers } = buildController();

      const result = await controller.importAdapter(req('ADMIN'), 'some-slug', {});

      expect(mcpServers.attachToDefaultServer).toHaveBeenCalledWith('u1', 'org1', 'c1');
      expect(result.attachedToServer).toEqual({ id: 's1', name: 'Default' });
    });

    it('reports no server when there was none to attach to', async () => {
      const { controller, mcpServers } = buildController();
      mcpServers.attachToDefaultServer.mockResolvedValue(null);

      const result = await controller.importAdapter(req('ADMIN'), 'some-slug', {});

      expect(result.attachedToServer).toBeNull();
    });
  });
});
