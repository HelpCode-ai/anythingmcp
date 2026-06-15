import { ForbiddenException } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';

const VALID_ENCRYPTION_KEY = 'a'.repeat(48);

function buildController(overrides: {
  connectorsService?: any;
  prisma?: any;
  mcpServer?: any;
  licenseGuard?: any;
} = {}) {
  const connectorsService = overrides.connectorsService ?? {
    create: jest.fn().mockResolvedValue({ id: 'c1', type: 'REST' }),
  };
  const prisma = overrides.prisma ?? {
    connector: { create: jest.fn().mockResolvedValue({ id: 'c1' }) },
    mcpTool: { create: jest.fn() },
  };
  const mcpServer = overrides.mcpServer ?? {
    reloadConnectorTools: jest.fn().mockResolvedValue(undefined),
  };
  const licenseGuard = overrides.licenseGuard ?? {
    checkCanCreateConnector: jest.fn().mockResolvedValue(undefined),
  };
  const configService = { get: jest.fn().mockReturnValue(VALID_ENCRYPTION_KEY) };

  const controller = new ConnectorsController(
    connectorsService as any,
    {} as any, // openApiParser
    {} as any, // wsdlParser
    {} as any, // graphqlParser
    {} as any, // postmanParser
    {} as any, // curlParser
    {} as any, // mcpClientEngine
    {} as any, // mcpOAuthService
    {} as any, // catalogResync
    prisma as any,
    mcpServer as any,
    configService as any,
    licenseGuard as any,
  );

  return { controller, connectorsService, prisma, mcpServer, licenseGuard };
}

const req = (role: string) => ({
  user: { sub: 'u1', organizationId: 'org1', role },
});

describe('ConnectorsController role enforcement', () => {
  describe('POST /api/connectors (create)', () => {
    it('rejects VIEWER before creating the connector', async () => {
      const { controller, connectorsService, licenseGuard } = buildController();

      await expect(
        controller.create(req('VIEWER'), {
          name: 'viewer-created-test',
          type: 'REST' as any,
          baseUrl: 'https://example.invalid',
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(licenseGuard.checkCanCreateConnector).not.toHaveBeenCalled();
      expect(connectorsService.create).not.toHaveBeenCalled();
    });

    it.each(['EDITOR', 'ADMIN'])('allows %s to create a connector', async (role) => {
      const { controller, connectorsService } = buildController();

      await controller.create(req(role), {
        name: 'ok',
        type: 'REST' as any,
        baseUrl: 'https://example.invalid',
      });

      expect(connectorsService.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/connectors/import-all (importAll)', () => {
    it('rejects VIEWER before importing any connector', async () => {
      const { controller, prisma } = buildController();

      await expect(
        controller.importAll(req('VIEWER'), {
          connectors: [
            {
              name: 'viewer-imported-test',
              type: 'REST' as any,
              baseUrl: 'https://example.invalid',
            },
          ],
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.connector.create).not.toHaveBeenCalled();
    });

    it.each(['EDITOR', 'ADMIN'])('allows %s to import connectors', async (role) => {
      const { controller, prisma } = buildController();

      await controller.importAll(req(role), {
        connectors: [
          {
            name: 'imported',
            type: 'REST' as any,
            baseUrl: 'https://example.invalid',
          },
        ],
      });

      expect(prisma.connector.create).toHaveBeenCalledTimes(1);
    });
  });
});
