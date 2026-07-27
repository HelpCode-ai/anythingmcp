import { BadRequestException, ForbiddenException } from '@nestjs/common';
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

describe('OAuth2 config endpoints', () => {
  const oauthConnector = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    type: 'REST',
    authType: 'OAUTH2',
    userId: 'u1',
    organizationId: 'org1',
    ...over,
  });

  const build = (connector: any) =>
    buildController({
      connectorsService: {
        findById: jest.fn().mockResolvedValue(connector),
        updateAuthConfigMerge: jest.fn().mockResolvedValue(connector),
      },
    });

  describe('PATCH :id/oauth-config', () => {
    it('merges only the fields that were sent', async () => {
      // A partial edit must not blank the rest of the config — the stored
      // tokens and endpoints live in the same object.
      const { controller, connectorsService } = build(oauthConnector());

      await controller.updateOAuthConfig(req('ADMIN'), 'c1', {
        tokenAuthMethod: 'client_secret_basic',
      });

      expect(connectorsService.updateAuthConfigMerge).toHaveBeenCalledWith('c1', {
        tokenAuthMethod: 'client_secret_basic',
      });
    });

    it('passes client credentials through when supplied', async () => {
      const { controller, connectorsService } = build(oauthConnector());

      await controller.updateOAuthConfig(req('ADMIN'), 'c1', {
        clientId: 'public-client',
        clientSecret: 'public',
        tokenAuthMethod: 'client_secret_basic',
      });

      expect(connectorsService.updateAuthConfigMerge).toHaveBeenCalledWith('c1', {
        clientId: 'public-client',
        clientSecret: 'public',
        tokenAuthMethod: 'client_secret_basic',
      });
    });

    it('resets to the default when the auth method is cleared', async () => {
      const { controller, connectorsService } = build(oauthConnector());

      await controller.updateOAuthConfig(req('ADMIN'), 'c1', {
        tokenAuthMethod: '',
      });

      expect(connectorsService.updateAuthConfigMerge).toHaveBeenCalledWith('c1', {
        tokenAuthMethod: undefined,
      });
    });

    it('does not write anything when the body is empty', async () => {
      const { controller, connectorsService } = build(oauthConnector());

      await controller.updateOAuthConfig(req('ADMIN'), 'c1', {});

      expect(connectorsService.updateAuthConfigMerge).not.toHaveBeenCalled();
    });

    it('rejects connectors that do not use OAuth2', async () => {
      const { controller, connectorsService } = build(
        oauthConnector({ authType: 'BEARER_TOKEN' }),
      );

      await expect(
        controller.updateOAuthConfig(req('ADMIN'), 'c1', {
          tokenAuthMethod: 'client_secret_basic',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(connectorsService.updateAuthConfigMerge).not.toHaveBeenCalled();
    });

    it('rejects VIEWER', async () => {
      const { controller, connectorsService } = build(oauthConnector());

      await expect(
        controller.updateOAuthConfig(req('VIEWER'), 'c1', {
          tokenAuthMethod: 'client_secret_basic',
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(connectorsService.updateAuthConfigMerge).not.toHaveBeenCalled();
    });
  });

  describe('GET :id/oauth-config', () => {
    it('never returns the client secret or the issued tokens', async () => {
      const { encrypt } = require('../common/crypto/encryption.util');
      const authConfig = encrypt(
        JSON.stringify({
          clientId: 'public-client',
          clientSecret: 'public',
          tokenUrl: 'https://example.invalid/token',
          tokenAuthMethod: 'client_secret_basic',
          accessToken: 'at',
          refreshToken: 'rt',
        }),
        VALID_ENCRYPTION_KEY,
      );
      const { controller } = build(oauthConnector({ authConfig }));

      const result = await controller.getOAuthConfig(req('ADMIN'), 'c1');

      expect(result).toMatchObject({
        clientId: 'public-client',
        tokenUrl: 'https://example.invalid/token',
        tokenAuthMethod: 'client_secret_basic',
        hasClientSecret: true,
        hasAccessToken: true,
        hasRefreshToken: true,
      });
      expect(JSON.stringify(result)).not.toContain('public"');
      expect(JSON.stringify(result)).not.toContain('"at"');
      expect(JSON.stringify(result)).not.toContain('"rt"');
    });

    it('reports the default auth method when none is stored', async () => {
      const { controller } = build(oauthConnector({ authConfig: null }));

      const result = await controller.getOAuthConfig(req('ADMIN'), 'c1');

      expect(result.tokenAuthMethod).toBe('client_secret_post');
      expect(result.hasClientSecret).toBe(false);
    });

    it('degrades gracefully when the stored config cannot be decrypted', async () => {
      // e.g. after an encryption-key rotation — the page must still load.
      const { controller } = build(oauthConnector({ authConfig: 'not-decryptable' }));

      const result = await controller.getOAuthConfig(req('ADMIN'), 'c1');

      expect(result.clientId).toBe('');
      expect(result.tokenAuthMethod).toBe('client_secret_post');
    });
  });
});
