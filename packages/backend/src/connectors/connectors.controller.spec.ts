import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';

const VALID_ENCRYPTION_KEY = 'a'.repeat(48);

function buildController(overrides: {
  connectorsService?: any;
  prisma?: any;
  mcpServer?: any;
  licenseGuard?: any;
  mcpServers?: any;
  deployment?: any;
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
  const mcpServers = overrides.mcpServers ?? {
    attachToDefaultServer: jest
      .fn()
      .mockResolvedValue({ id: 's1', name: 'Default' }),
  };
  const deployment = overrides.deployment ?? { isCloud: () => true };

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
    mcpServers as any,
    deployment as any,
  );

  return {
    controller,
    connectorsService,
    prisma,
    mcpServer,
    licenseGuard,
    mcpServers,
    deployment,
  };
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

/**
 * A connector that is not on any MCP server is reachable by nobody. Assigning
 * it used to be a separate page, and in the fortnight to 11 Sep 2026, 49 of the
 * 84 workspaces that imported a working connector never found it.
 */
describe('ConnectorsController attaches new connectors to a server', () => {
  const dto = {
    name: 'Acme',
    type: 'REST',
    baseUrl: 'https://api.acme.example/v1',
  } as any;

  it('attaches to the default server and reports which one', async () => {
    const { controller, mcpServers } = buildController();

    const result: any = await controller.create(req('ADMIN'), dto);

    expect(mcpServers.attachToDefaultServer).toHaveBeenCalledWith(
      'u1',
      'org1',
      'c1',
    );
    expect(result.attachedToServer).toEqual({ id: 's1', name: 'Default' });
  });

  it('still returns the connector when there is no server to attach to', async () => {
    const { controller } = buildController({
      mcpServers: { attachToDefaultServer: jest.fn().mockResolvedValue(null) },
    });

    const result: any = await controller.create(req('ADMIN'), dto);

    expect(result.id).toBe('c1');
    expect(result.attachedToServer).toBeNull();
  });
});

describe('ConnectorsController base-URL validation', () => {
  // The real row that started this: a ClickUp API key typed into the URL field,
  // which the UI prefixed with https:// and the API stored without complaint.
  const pastedApiKey = {
    name: 'Click Up',
    type: 'MCP',
    baseUrl: 'https://pk_56532023_AZFKELRKU7FWLDAE9W9X0I9M8KYVIC64',
  } as any;

  it('refuses to create a connector whose URL is not a server address', async () => {
    const { controller, connectorsService } = buildController();

    await expect(controller.create(req('ADMIN'), pastedApiKey)).rejects.toThrow(
      BadRequestException,
    );
    expect(connectorsService.create).not.toHaveBeenCalled();
  });

  it('refuses before consuming the licence check', async () => {
    const { controller, licenseGuard } = buildController();

    await expect(
      controller.create(req('ADMIN'), pastedApiKey),
    ).rejects.toThrow(BadRequestException);
    expect(licenseGuard.checkCanCreateConnector).not.toHaveBeenCalled();
  });

  it('allows a Docker service name when self-hosted', async () => {
    const { controller, connectorsService } = buildController({
      deployment: { isCloud: () => false },
    });

    await controller.create(req('ADMIN'), {
      name: 'weclapp',
      type: 'REST',
      baseUrl: 'http://weclapp:8080',
    } as any);

    expect(connectorsService.create).toHaveBeenCalled();
  });

  it('validates the URL on update too', async () => {
    const { controller, connectorsService } = buildController({
      connectorsService: {
        findById: jest
          .fn()
          .mockResolvedValue({ id: 'c1', type: 'REST', organizationId: 'org1' }),
        update: jest.fn(),
      },
    });

    await expect(
      controller.update(req('ADMIN'), 'c1', { baseUrl: 'https://Ahmad1' } as any),
    ).rejects.toThrow(BadRequestException);
    expect(connectorsService.update).not.toHaveBeenCalled();
  });

  it('leaves an update that does not touch the URL alone', async () => {
    const { controller, connectorsService } = buildController({
      connectorsService: {
        findById: jest
          .fn()
          .mockResolvedValue({ id: 'c1', type: 'REST', organizationId: 'org1' }),
        update: jest.fn().mockResolvedValue({ id: 'c1' }),
      },
    });

    await controller.update(req('ADMIN'), 'c1', { name: 'Renamed' } as any);

    expect(connectorsService.update).toHaveBeenCalled();
  });
});
