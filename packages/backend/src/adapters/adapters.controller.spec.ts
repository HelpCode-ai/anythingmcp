import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
  const productEvents = { log: jest.fn().mockResolvedValue(undefined) };
  const controller = new AdaptersController(
    adaptersService as any,
    licenseGuard as any,
    mcpServers as any,
    productEvents as any,
  );
  return { controller, adaptersService, licenseGuard, mcpServers, productEvents };
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

describe('AdaptersController — import response', () => {
  it('passes the install-time test call on to the page', async () => {
    const { controller, adaptersService } = buildController();
    const probe = { ok: true, toolName: 't', durationMs: 5, sample: {} };
    adaptersService.importAdapter.mockResolvedValue({ connectorId: 'c1', toolsCreated: 3, probe });
    const result = await controller.importAdapter(req('ADMIN'), 'some-slug', {});
    expect(result.probe).toEqual(probe);
  });
});

describe('AdaptersController — starter pack', () => {
  const pack = [
    { slug: 'agent-skills', installed: false },
    { slug: 'hackernews', installed: true },
    { slug: 'nominatim', installed: false },
  ];

  function withPack() {
    const built = buildController();
    (built.adaptersService as any).starterPack = jest.fn().mockResolvedValue(pack);
    built.adaptersService.importAdapter.mockImplementation(async (slug: string) => ({
      connectorId: `c-${slug}`,
      toolsCreated: 4,
      probe: { ok: true },
    }));
    return built;
  }

  it('serves the pack for the caller workspace', async () => {
    const { controller, adaptersService } = withPack();
    await expect(controller.starterPack(req('ADMIN'))).resolves.toEqual(pack);
    expect((adaptersService as any).starterPack).toHaveBeenCalledWith('org1');
  });

  it('rejects a VIEWER before installing anything', async () => {
    const { controller, adaptersService } = withPack();
    await expect(
      controller.installStarterPack(req('VIEWER'), { slugs: ['agent-skills'] }),
    ).rejects.toThrow(ForbiddenException);
    expect(adaptersService.importAdapter).not.toHaveBeenCalled();
  });

  it.each([[undefined], [[]], ['agent-skills'], [[1]], [Array(11).fill('agent-skills')]])(
    'rejects a malformed selection %#',
    async (slugs) => {
      const { controller, adaptersService } = withPack();
      await expect(controller.installStarterPack(req('ADMIN'), { slugs })).rejects.toThrow(
        BadRequestException,
      );
      expect(adaptersService.importAdapter).not.toHaveBeenCalled();
    },
  );

  it('installs only what the pack offers', async () => {
    const { controller, adaptersService } = withPack();
    await expect(
      controller.installStarterPack(req('ADMIN'), { slugs: ['agent-skills', 'github'] }),
    ).rejects.toThrow('Not in the starter pack: github');
    expect(adaptersService.importAdapter).not.toHaveBeenCalled();
  });

  it('installs, skips what is there, reports a failure and carries on', async () => {
    const { controller, adaptersService, licenseGuard, mcpServers, productEvents } = withPack();
    licenseGuard.checkCanCreateConnector
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Trial limit reached (2 connectors).'));

    const out = await controller.installStarterPack(req('ADMIN'), {
      slugs: ['agent-skills', 'hackernews', 'nominatim', 'agent-skills'],
    });

    expect(out.results).toEqual([
      { slug: 'agent-skills', status: 'installed', connectorId: 'c-agent-skills', toolsCreated: 4, probeOk: true },
      { slug: 'hackernews', status: 'already_installed' },
      { slug: 'nominatim', status: 'failed', error: 'Trial limit reached (2 connectors).' },
    ]);
    expect(adaptersService.importAdapter).toHaveBeenCalledTimes(1);
    expect(mcpServers.attachToDefaultServer).toHaveBeenCalledWith('u1', 'org1', 'c-agent-skills');
    expect(out.server).toEqual({ id: 's1', name: 'Default' });
    expect(productEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'starter_pack_installed',
        organizationId: 'org1',
        metadata: { adapterSlug: 'agent-skills', serverId: 's1' },
      }),
    );
  });

  it('records no install event when nothing was installed', async () => {
    const { controller, productEvents } = withPack();
    const out = await controller.installStarterPack(req('ADMIN'), { slugs: ['hackernews'] });
    expect(out.results).toEqual([{ slug: 'hackernews', status: 'already_installed' }]);
    expect(productEvents.log).not.toHaveBeenCalled();
  });
});
