import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { encrypt } from '../common/crypto/encryption.util';

const VALID_ENCRYPTION_KEY = 'a'.repeat(48);

function buildController(overrides: {
  connectorsService?: any;
  prisma?: any;
  mcpServer?: any;
  licenseGuard?: any;
  mcpServers?: any;
  deployment?: any;
  mcpOAuthService?: any;
  serverUrl?: string;
} = {}) {
  const connectorsService = overrides.connectorsService ?? {
    create: jest.fn().mockResolvedValue({ id: 'c1', type: 'REST' }),
  };
  const prisma = overrides.prisma ?? {
    connector: {
      create: jest.fn().mockResolvedValue({ id: 'c1' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    mcpTool: { create: jest.fn() },
  };
  const mcpServer = overrides.mcpServer ?? {
    reloadConnectorTools: jest.fn().mockResolvedValue(undefined),
  };
  const licenseGuard = overrides.licenseGuard ?? {
    checkCanCreateConnector: jest.fn().mockResolvedValue(undefined),
  };
  const configService = {
    get: jest.fn((key: string) =>
      key === 'SERVER_URL' ? overrides.serverUrl : VALID_ENCRYPTION_KEY,
    ),
  };
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
    (overrides.mcpOAuthService ?? {}) as any, // mcpOAuthService
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

    it('stores "in body" explicitly for client_credentials, whose default is Basic', async () => {
      // Otherwise saving the form on an Amadeus connector (which needs body
      // credentials) would clear the setting and fall back to Basic.
      const { encrypt } = require('../common/crypto/encryption.util');
      const authConfig = encrypt(
        JSON.stringify({ grant: 'client_credentials', tokenAuthMethod: 'client_secret_post' }),
        VALID_ENCRYPTION_KEY,
      );
      const { controller, connectorsService } = build(oauthConnector({ authConfig }));

      await controller.updateOAuthConfig(req('ADMIN'), 'c1', {
        tokenAuthMethod: '',
      });

      expect(connectorsService.updateAuthConfigMerge).toHaveBeenCalledWith('c1', {
        tokenAuthMethod: 'client_secret_post',
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

    it('reports Basic for client_credentials with nothing stored, as the token service sends', async () => {
      const { encrypt } = require('../common/crypto/encryption.util');
      const authConfig = encrypt(
        JSON.stringify({ grant: 'client_credentials', clientId: 'x', clientSecret: 'y' }),
        VALID_ENCRYPTION_KEY,
      );
      const { controller } = build(oauthConnector({ authConfig }));

      const result = await controller.getOAuthConfig(req('ADMIN'), 'c1');

      expect(result.tokenAuthMethod).toBe('client_secret_basic');
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

describe('OAuth 1.0a credentials endpoint', () => {
  const oauth1Connector = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    type: 'REST',
    authType: 'OAUTH1',
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

  it('merges only the fields that were typed, trimmed', async () => {
    // "Leave empty to keep current": the form sends only what the user typed,
    // so the stored secret must survive a new consumer key.
    const { controller, connectorsService, mcpServer } = build(oauth1Connector());

    const res = await controller.updateOAuth1Config(req('ADMIN'), 'c1', {
      consumerKey: '  MyAppKey-123  ',
    });

    expect(connectorsService.updateAuthConfigMerge).toHaveBeenCalledWith('c1', {
      consumerKey: 'MyAppKey-123',
    });
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('c1');
    expect(JSON.stringify(res)).not.toContain('MyAppKey-123');
  });

  it('passes both halves through when both are typed', async () => {
    const { controller, connectorsService } = build(oauth1Connector());

    await controller.updateOAuth1Config(req('ADMIN'), 'c1', {
      consumerKey: 'key',
      consumerSecret: 'secret',
    });

    expect(connectorsService.updateAuthConfigMerge).toHaveBeenCalledWith('c1', {
      consumerKey: 'key',
      consumerSecret: 'secret',
    });
  });

  it('removes the access token when it is sent empty', async () => {
    const { controller, connectorsService } = build(oauth1Connector());

    await controller.updateOAuth1Config(req('ADMIN'), 'c1', {
      token: '',
      tokenSecret: ' ',
    });

    expect(connectorsService.updateAuthConfigMerge).toHaveBeenCalledWith('c1', {
      token: undefined,
      tokenSecret: undefined,
    });
  });

  it('refuses to empty the consumer key or secret', async () => {
    const { controller, connectorsService } = build(oauth1Connector());

    await expect(
      controller.updateOAuth1Config(req('ADMIN'), 'c1', { consumerSecret: '  ' }),
    ).rejects.toThrow(/consumer secret cannot be empty/);
    expect(connectorsService.updateAuthConfigMerge).not.toHaveBeenCalled();
  });

  it('refuses an e-mail address as the consumer key', async () => {
    const { controller, connectorsService } = build(oauth1Connector());

    await expect(
      controller.updateOAuth1Config(req('ADMIN'), 'c1', {
        consumerKey: 'someone@example.com',
      }),
    ).rejects.toThrow(/looks like an e-mail address/);
    expect(connectorsService.updateAuthConfigMerge).not.toHaveBeenCalled();
  });

  it('does not write anything when nothing was typed', async () => {
    const { controller, connectorsService, mcpServer } = build(oauth1Connector());

    await controller.updateOAuth1Config(req('ADMIN'), 'c1', {});

    expect(connectorsService.updateAuthConfigMerge).not.toHaveBeenCalled();
    expect(mcpServer.reloadConnectorTools).not.toHaveBeenCalled();
  });

  it('rejects connectors that do not use OAuth 1.0a', async () => {
    const { controller, connectorsService } = build(
      oauth1Connector({ authType: 'OAUTH2' }),
    );

    await expect(
      controller.updateOAuth1Config(req('ADMIN'), 'c1', { consumerKey: 'key' }),
    ).rejects.toThrow(BadRequestException);
    expect(connectorsService.updateAuthConfigMerge).not.toHaveBeenCalled();
  });

  it('rejects VIEWER', async () => {
    const { controller, connectorsService } = build(oauth1Connector());

    await expect(
      controller.updateOAuth1Config(req('VIEWER'), 'c1', { consumerKey: 'key' }),
    ).rejects.toThrow(ForbiddenException);
    expect(connectorsService.updateAuthConfigMerge).not.toHaveBeenCalled();
  });

  it('rejects an editor who does not own the connector', async () => {
    const { controller, connectorsService } = build(
      oauth1Connector({ userId: 'someone-else' }),
    );

    await expect(
      controller.updateOAuth1Config(req('EDITOR'), 'c1', { consumerKey: 'key' }),
    ).rejects.toThrow(ForbiddenException);
    expect(connectorsService.updateAuthConfigMerge).not.toHaveBeenCalled();
  });
});

describe('PUT :id/env-vars — a base URL variable without https://', () => {
  const build = (connector: any) =>
    buildController({
      connectorsService: {
        findById: jest.fn().mockResolvedValue(connector),
        update: jest.fn().mockResolvedValue(connector),
      },
    });

  it('adds https:// to the Substack publication, in the variable and the base URL', async () => {
    const { controller, connectorsService } = build({
      id: 'c1',
      type: 'REST',
      userId: 'u1',
      organizationId: 'org1',
      baseUrl: 'yourname.substack.com',
      envVars: { SUBSTACK_PUBLICATION_URL: 'yourname.substack.com' },
      config: { adapterSlug: 'substack' },
    });

    await controller.updateEnvVars(req('ADMIN'), 'c1', {
      envVars: { SUBSTACK_PUBLICATION_URL: ' yourname.substack.com ' },
    });

    expect(connectorsService.update).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({
        envVars: { SUBSTACK_PUBLICATION_URL: 'https://yourname.substack.com' },
        baseUrl: 'https://yourname.substack.com',
      }),
    );
  });

  it('refuses a value that is not a web address, naming the variable', async () => {
    const { controller, connectorsService } = build({
      id: 'c1',
      type: 'REST',
      userId: 'u1',
      organizationId: 'org1',
      baseUrl: 'https://yourname.substack.com',
      envVars: {},
      config: { adapterSlug: 'substack' },
    });

    await expect(
      controller.updateEnvVars(req('ADMIN'), 'c1', {
        envVars: { SUBSTACK_PUBLICATION_URL: 'someone@example.com' },
      }),
    ).rejects.toThrow(/^SUBSTACK_PUBLICATION_URL must be a full URL/);
    expect(connectorsService.update).not.toHaveBeenCalled();
  });

  it('uses the stored template of a hand-built connector', async () => {
    const { controller, connectorsService } = build({
      id: 'c1',
      type: 'REST',
      userId: 'u1',
      organizationId: 'org1',
      baseUrl: '{{SHOP_URL}}/api',
      envVars: {},
      config: null,
    });

    await controller.updateEnvVars(req('ADMIN'), 'c1', {
      envVars: { SHOP_URL: 'shop.example.com', TOKEN: 'abc' },
    });

    expect(connectorsService.update).toHaveBeenCalledWith('c1', {
      envVars: { SHOP_URL: 'https://shop.example.com', TOKEN: 'abc' },
    });
  });
});

/**
 * "Authorize with Provider" on REST connectors. The Etsy cases use the shape
 * of rows installed before the adapter could be authorized in the browser:
 * no authorizationUrl or scopes stored, and — for credentials typed after
 * install — the client id/secret as placeholders with the values in envVars.
 */
describe('POST :id/oauth/authorize (REST)', () => {
  const SERVER = 'https://cloud.anythingmcp.com';

  const setup = (connector: Record<string, unknown>) => {
    const mcpOAuthService = new McpOAuthService();
    const store = jest.spyOn(mcpOAuthService, 'storePendingFlow');
    const { controller } = buildController({
      connectorsService: { findById: jest.fn().mockResolvedValue(connector) },
      mcpOAuthService,
      serverUrl: SERVER,
    });
    return { controller, store, mcpOAuthService };
  };

  const row = (authConfig: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    id: 'c1',
    type: 'REST',
    authType: 'OAUTH2',
    userId: 'u1',
    organizationId: 'org1',
    config: { adapterSlug: 'etsy' },
    envVars: null,
    authConfig: encrypt(JSON.stringify(authConfig), VALID_ENCRYPTION_KEY),
    ...over,
  });

  const legacyEtsy = {
    grant: 'refresh_token',
    tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
    clientId: '{{ETSY_CLIENT_ID}}',
    clientSecret: '{{ETSY_CLIENT_SECRET}}',
    refreshToken: '12345678.working-refresh-token',
    extraHeaders: { 'x-api-key': '{{ETSY_CLIENT_ID}}:{{ETSY_CLIENT_SECRET}}' },
  };

  it('starts Etsy PKCE authorization for an existing row, resolving env vars and using the catalog endpoints', async () => {
    const { controller, store } = setup(
      row(legacyEtsy, {
        envVars: { ETSY_CLIENT_ID: 'keystring', ETSY_CLIENT_SECRET: 'secret' },
      }),
    );

    const result: any = await controller.initiateOAuth(req('ADMIN'), 'c1');

    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://www.etsy.com/oauth/connect');
    expect(url.searchParams.get('client_id')).toBe('keystring');
    expect(url.searchParams.get('redirect_uri')).toBe(`${SERVER}/api/mcp-oauth/callback`);
    expect(url.searchParams.get('scope')).toBe('email_r shops_r listings_r transactions_r');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const [state, flow] = store.mock.calls[0];
    expect(url.searchParams.get('state')).toBe(state);
    // The verifier stays on the server; the URL carries its S256 image.
    expect(url.searchParams.get('code_challenge')).toBe(
      new McpOAuthService().generateCodeChallenge(flow.codeVerifier),
    );
    expect(result.authorizationUrl).not.toContain(flow.codeVerifier);
    expect(flow).toMatchObject({
      clientId: 'keystring',
      clientSecret: 'secret',
      tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
      tokenAuthMethod: undefined,
      persistAuthConfig: {
        authorizationUrl: 'https://www.etsy.com/oauth/connect',
        scopes: 'email_r shops_r listings_r transactions_r',
      },
    });
  });

  it('asks for the client credentials before sending anyone to Etsy', async () => {
    const { controller, store } = setup(row(legacyEtsy));
    const result: any = await controller.initiateOAuth(req('ADMIN'), 'c1');
    expect(result.error).toContain('ETSY_CLIENT_ID and ETSY_CLIENT_SECRET');
    expect(result.authorizationUrl).toBeUndefined();
    expect(store).not.toHaveBeenCalled();
  });

  it('uses a row\'s own endpoints unchanged (DATEV)', async () => {
    const { controller, store } = setup(
      row(
        {
          clientId: 'cid',
          clientSecret: 'sec',
          authorizationUrl: 'https://login.datev.de/openidsandbox/authorize',
          tokenUrl: 'https://sandbox-api.datev.de/token',
          tokenAuthMethod: 'basic',
          scopes: 'datev:accounting:clients accounting:clients:read accounting:documents',
        },
        { config: { adapterSlug: 'datev-sandbox' } },
      ),
    );

    const result: any = await controller.initiateOAuth(req('ADMIN'), 'c1');

    const url = new URL(result.authorizationUrl);
    expect(url.host).toBe('login.datev.de');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(store.mock.calls[0][1]).toMatchObject({
      clientId: 'cid',
      clientSecret: 'sec',
      tokenUrl: 'https://sandbox-api.datev.de/token',
      tokenAuthMethod: 'basic',
      persistAuthConfig: {},
    });
  });

  it('still reports a missing authorization URL for a connector outside the catalog', async () => {
    const { controller } = setup(
      row({ clientId: 'id', tokenUrl: 'https://x.example/token' }, { config: null }),
    );
    const result: any = await controller.initiateOAuth(req('ADMIN'), 'c1');
    expect(result.error).toBe('No authorization URL configured for this connector');
  });
});

describe('Connector secrets are never returned', () => {
  const { encrypt } = require('../common/crypto/encryption.util');
  const TOKEN = 'test-access-token-value';

  const catalogConnector = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    name: 'WhatsApp',
    type: 'REST',
    authType: 'BEARER_TOKEN',
    userId: 'owner',
    organizationId: 'org1',
    baseUrl: 'https://graph.facebook.com/v21.0',
    headers: { Accept: 'application/json', 'X-Api-Key': 'test-header-key' },
    config: { adapterSlug: 'whatsapp' },
    envVars: {
      WHATSAPP_ACCESS_TOKEN: TOKEN,
      WHATSAPP_BUSINESS_ACCOUNT_ID: '1234567890',
    },
    tools: [],
    ...over,
  });

  const build = (connector: any, extra: Record<string, unknown> = {}) =>
    buildController({
      connectorsService: {
        findById: jest.fn().mockResolvedValue(connector),
        findByOrg: jest.fn().mockResolvedValue([connector]),
        update: jest.fn().mockImplementation(async (_id: string, data: any) => ({
          ...connector,
          ...data,
        })),
      },
      ...extra,
    });

  it.each(['VIEWER', 'EDITOR', 'ADMIN'])('GET :id masks secrets for %s', async (role) => {
    const { controller } = build(catalogConnector());

    const result: any = await controller.findOne(req(role), 'c1');

    expect(result.envVars).toEqual({
      WHATSAPP_ACCESS_TOKEN: '',
      WHATSAPP_BUSINESS_ACCOUNT_ID: '1234567890',
    });
    expect(result.maskedEnvVars).toEqual(['WHATSAPP_ACCESS_TOKEN']);
    expect(result.headers).toEqual({ Accept: 'application/json', 'X-Api-Key': '' });
    expect(result.maskedHeaders).toEqual(['X-Api-Key']);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain('test-header-key');
  });

  it.each(['VIEWER', 'EDITOR', 'ADMIN'])('GET / masks secrets for %s', async (role) => {
    const { controller } = build(catalogConnector());

    const result: any[] = await controller.list(req(role), {} as any);

    expect(result[0].envVars.WHATSAPP_ACCESS_TOKEN).toBe('');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  describe('GET export-all', () => {
    const buildExport = () =>
      buildController({
        prisma: {
          connector: {
            findMany: jest.fn().mockResolvedValue([catalogConnector()]),
          },
        },
      });

    it('carries the secrets for an admin, so a backup can be restored', async () => {
      const { controller } = buildExport();
      const result: any = await controller.exportAll(req('ADMIN'));
      expect(result.secretsIncluded).toBe(true);
      expect(result.connectors[0].envVars.WHATSAPP_ACCESS_TOKEN).toBe(TOKEN);
      expect(result.connectors[0].headers['X-Api-Key']).toBe('test-header-key');
    });

    it.each(['VIEWER', 'EDITOR'])('leaves them out for %s', async (role) => {
      const { controller } = buildExport();
      const result: any = await controller.exportAll(req(role));
      expect(result.secretsIncluded).toBe(false);
      expect(result.connectors[0]).toMatchObject({
        envVars: { WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_BUSINESS_ACCOUNT_ID: '1234567890' },
        maskedEnvVars: ['WHATSAPP_ACCESS_TOKEN'],
        maskedHeaders: ['X-Api-Key'],
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain('test-header-key');
    });

    it('never exports authConfig', async () => {
      const { controller } = buildController({
        prisma: {
          connector: {
            findMany: jest
              .fn()
              .mockResolvedValue([catalogConnector({ authConfig: 'ciphertext' })]),
          },
        },
      });
      const result: any = await controller.exportAll(req('ADMIN'));
      expect(result.connectors[0]).not.toHaveProperty('authConfig');
    });
  });

  describe('PUT :id/env-vars', () => {
    it('keeps a secret sent back empty and does not return it', async () => {
      const { controller, connectorsService } = build(
        catalogConnector({ userId: 'u1', config: null }),
      );

      const result: any = await controller.updateEnvVars(req('EDITOR'), 'c1', {
        envVars: { WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_BUSINESS_ACCOUNT_ID: '999' },
      });

      expect(connectorsService.update).toHaveBeenCalledWith('c1', {
        envVars: { WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_BUSINESS_ACCOUNT_ID: '999' },
      });
      expect(result.envVars.WHATSAPP_ACCESS_TOKEN).toBe('');
      expect(result.maskedEnvVars).toEqual(['WHATSAPP_ACCESS_TOKEN']);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it('replaces a retyped secret and removes a variable left out', async () => {
      const { controller, connectorsService } = build(
        catalogConnector({ userId: 'u1', config: null }),
      );

      await controller.updateEnvVars(req('ADMIN'), 'c1', {
        envVars: { WHATSAPP_ACCESS_TOKEN: ' new-token ' },
      });

      expect(connectorsService.update).toHaveBeenCalledWith('c1', {
        envVars: { WHATSAPP_ACCESS_TOKEN: 'new-token' },
      });
    });

    it('still rejects VIEWER', async () => {
      const { controller, connectorsService } = build(catalogConnector());
      await expect(
        controller.updateEnvVars(req('VIEWER'), 'c1', { envVars: {} }),
      ).rejects.toThrow(ForbiddenException);
      expect(connectorsService.update).not.toHaveBeenCalled();
    });
  });

  describe('PUT :id', () => {
    it('keeps masked env vars and headers sent back empty', async () => {
      const { controller, connectorsService } = build(
        catalogConnector({ userId: 'u1' }),
      );

      await controller.update(req('EDITOR'), 'c1', {
        name: 'Renamed',
        envVars: { WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_BUSINESS_ACCOUNT_ID: '1' },
        headers: { Accept: 'application/json', 'X-Api-Key': '' },
      });

      expect(connectorsService.update).toHaveBeenCalledWith('c1', {
        name: 'Renamed',
        envVars: { WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_BUSINESS_ACCOUNT_ID: '1' },
        headers: { Accept: 'application/json', 'X-Api-Key': 'test-header-key' },
      });
    });

    it('returns the updated connector masked', async () => {
      const { controller } = build(catalogConnector({ userId: 'u1' }));
      const result: any = await controller.update(req('ADMIN'), 'c1', { name: 'x' });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });
  });

  it('create returns the new connector masked', async () => {
    const { controller } = buildController({
      connectorsService: {
        create: jest.fn().mockResolvedValue(catalogConnector({ config: null })),
      },
    });
    const result: any = await controller.create(req('EDITOR'), {
      name: 'x',
      type: 'REST' as any,
      baseUrl: 'https://example.invalid',
      envVars: { WHATSAPP_ACCESS_TOKEN: TOKEN },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(result.attachedToServer).toEqual({ id: 's1', name: 'Default' });
  });

  describe('authConfig is never part of a response', () => {
    const authConfig = encrypt(JSON.stringify({ token: TOKEN }), VALID_ENCRYPTION_KEY);
    const withAuth = (over: Record<string, unknown> = {}) =>
      catalogConnector({ authConfig, ...over });
    const expectNoAuthConfig = (result: any) => {
      expect(result).not.toHaveProperty('authConfig');
      expect(JSON.stringify(result)).not.toContain(authConfig);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    };

    it.each(['VIEWER', 'EDITOR', 'ADMIN'])('GET :id for %s', async (role) => {
      const { controller } = build(withAuth());
      expectNoAuthConfig(await controller.findOne(req(role), 'c1'));
    });

    it.each(['VIEWER', 'EDITOR', 'ADMIN'])('GET / for %s', async (role) => {
      const { controller } = build(withAuth());
      const result: any[] = await controller.list(req(role), {} as any);
      expect(result).toHaveLength(1);
      expectNoAuthConfig(result[0]);
    });

    it('PUT :id, also when new credentials were sent', async () => {
      const { controller, connectorsService } = build(withAuth({ userId: 'u1' }));
      const result: any = await controller.update(req('ADMIN'), 'c1', {
        name: 'x',
        authConfig: { token: 'new-token-value' },
      });
      // The credentials still reach the service; only the response omits them.
      expect(connectorsService.update).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ authConfig: { token: 'new-token-value' } }),
      );
      expectNoAuthConfig(result);
      expect(JSON.stringify(result)).not.toContain('new-token-value');
    });

    it('POST / (create)', async () => {
      const { controller } = buildController({
        connectorsService: {
          create: jest.fn().mockResolvedValue(withAuth({ config: null })),
        },
      });
      const result: any = await controller.create(req('EDITOR'), {
        name: 'x',
        type: 'REST' as any,
        baseUrl: 'https://example.invalid',
        authType: 'BEARER_TOKEN' as any,
        authConfig: { token: TOKEN },
      });
      expectNoAuthConfig(result);
      expect(result.attachedToServer).toEqual({ id: 's1', name: 'Default' });
    });

    it('PUT :id/env-vars', async () => {
      const { controller } = build(withAuth({ userId: 'u1', config: null }));
      const result: any = await controller.updateEnvVars(req('EDITOR'), 'c1', {
        envVars: { WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_BUSINESS_ACCOUNT_ID: '1' },
      });
      expectNoAuthConfig(result);
      expect(result).toHaveProperty('warnings');
    });

    it('drops a decrypted authConfig as well as the stored ciphertext', async () => {
      const { controller } = build(withAuth({ authConfig: { token: TOKEN } }));
      expectNoAuthConfig(await controller.findOne(req('ADMIN'), 'c1'));
    });
  });
});

describe('PUT :id/env-vars on a catalog connector keeps working credentials', () => {
  const { encrypt, decrypt } = require('../common/crypto/encryption.util');

  const is24 = (authConfig: Record<string, unknown>, envVars: Record<string, string>) => ({
    id: 'c1',
    name: 'ImmobilienScout24',
    type: 'REST',
    authType: 'OAUTH1',
    userId: 'u1',
    organizationId: 'org1',
    baseUrl: 'https://rest.immobilienscout24.de/restapi/api',
    headers: null,
    config: { adapterSlug: 'immobilienscout24' },
    authConfig: encrypt(JSON.stringify(authConfig), VALID_ENCRYPTION_KEY),
    envVars,
  });

  const build = (connector: any) =>
    buildController({
      connectorsService: {
        findById: jest.fn().mockResolvedValue(connector),
        update: jest.fn().mockImplementation(async (_id: string, data: any) => ({
          ...connector,
          ...data,
        })),
      },
    });

  it('does not overwrite a consumer key corrected in the auth editor', async () => {
    const connector = is24(
      { consumerKey: 'corrected-key', consumerSecret: 'app-secret' },
      { IS24_CONSUMER_KEY: 'someone@example.test', IS24_CONSUMER_SECRET: 'app-secret' },
    );
    const { controller, connectorsService } = build(connector);

    // The editor sends the (masked) secrets back empty and changes nothing.
    await controller.updateEnvVars(req('ADMIN'), 'c1', {
      envVars: { IS24_CONSUMER_KEY: '', IS24_CONSUMER_SECRET: '' },
    });

    const data = connectorsService.update.mock.calls[0][1];
    expect(data.envVars).toEqual(connector.envVars);
    expect(data).not.toHaveProperty('authConfig');
    expect(data).not.toHaveProperty('baseUrl');
  });

  it('repairs an install from before the rename, reading the old variable names', async () => {
    const connector = is24(
      { consumerKey: '{{IS24_CONSUMER_KEY}}', consumerSecret: '{{IS24_CONSUMER_SECRET}}' },
      { IS24_CLIENT_ID: 'app-key', IS24_CLIENT_SECRET: 'app-secret' },
    );
    const { controller, connectorsService } = build(connector);

    const result: any = await controller.updateEnvVars(req('ADMIN'), 'c1', {
      envVars: { IS24_CLIENT_ID: '', IS24_CLIENT_SECRET: '' },
    });

    const data = connectorsService.update.mock.calls[0][1];
    expect(data.authConfig).toEqual({ consumerKey: 'app-key', consumerSecret: 'app-secret' });
    expect(result.warnings).toEqual([
      expect.stringMatching(/^IS24_CONSUMER_KEY is not set; used IS24_CLIENT_ID/),
      expect.stringMatching(/^IS24_CONSUMER_SECRET is not set; used IS24_CLIENT_SECRET/),
    ]);
    expect(JSON.stringify(result)).not.toContain('app-secret');
  });

  it('applies a changed variable to the field that uses it', async () => {
    const connector = is24(
      { consumerKey: 'old-key', consumerSecret: 'app-secret', token: 'kept-token' },
      { IS24_CONSUMER_KEY: 'old-key', IS24_CONSUMER_SECRET: 'app-secret' },
    );
    const { controller, connectorsService } = build(connector);

    await controller.updateEnvVars(req('ADMIN'), 'c1', {
      envVars: { IS24_CONSUMER_KEY: 'new-key', IS24_CONSUMER_SECRET: '' },
    });

    const data = connectorsService.update.mock.calls[0][1];
    expect(data.authConfig).toEqual({
      consumerKey: 'new-key',
      consumerSecret: 'app-secret',
      token: 'kept-token',
    });
    expect(decrypt(connector.authConfig, VALID_ENCRYPTION_KEY)).toContain('old-key');
  });

  it('keeps the stored key and names the variable when it is removed', async () => {
    const connector = is24(
      { consumerKey: 'working-key', consumerSecret: 'app-secret' },
      { IS24_CONSUMER_KEY: 'working-key', IS24_CONSUMER_SECRET: 'app-secret' },
    );
    const { controller, connectorsService } = build(connector);

    const result: any = await controller.updateEnvVars(req('ADMIN'), 'c1', {
      envVars: { IS24_CONSUMER_SECRET: '' },
    });

    const data = connectorsService.update.mock.calls[0][1];
    expect(data).not.toHaveProperty('authConfig');
    expect(result.warnings).toEqual([
      'IS24_CONSUMER_KEY is not set, so authConfig.consumerKey kept its stored ' +
        'value. Add IS24_CONSUMER_KEY to change it.',
    ]);
  });

  it('refuses an e-mail address arriving as the consumer key through a variable', async () => {
    const connector = is24(
      { consumerKey: 'working-key', consumerSecret: 'app-secret' },
      { IS24_CONSUMER_KEY: 'working-key', IS24_CONSUMER_SECRET: 'app-secret' },
    );
    const { controller, connectorsService } = build(connector);

    await expect(
      controller.updateEnvVars(req('ADMIN'), 'c1', {
        envVars: { IS24_CONSUMER_KEY: 'someone@example.test', IS24_CONSUMER_SECRET: '' },
      }),
    ).rejects.toThrow(/consumer key \(IS24_CONSUMER_KEY\) looks like an e-mail/);
    expect(connectorsService.update).not.toHaveBeenCalled();
  });
});

describe('PUT :id — switching to OAuth 1.0a', () => {
  const build = (connector: any) =>
    buildController({
      connectorsService: {
        findById: jest.fn().mockResolvedValue(connector),
        update: jest.fn().mockResolvedValue(connector),
      },
    });
  const apiKeyConnector = {
    id: 'c1',
    type: 'REST',
    authType: 'API_KEY',
    userId: 'u1',
    organizationId: 'org1',
    baseUrl: 'https://api.example.test',
    config: null,
    envVars: null,
    headers: null,
  };

  it('refuses an e-mail address as the consumer key', async () => {
    const { controller, connectorsService } = build(apiKeyConnector);
    await expect(
      controller.update(req('ADMIN'), 'c1', {
        authType: 'OAUTH1' as any,
        authConfig: { consumerKey: ' someone@example.test ', consumerSecret: 's' },
      }),
    ).rejects.toThrow(/looks like an e-mail address/);
    expect(connectorsService.update).not.toHaveBeenCalled();
  });

  it('accepts a real consumer key', async () => {
    const { controller, connectorsService } = build(apiKeyConnector);
    await controller.update(req('ADMIN'), 'c1', {
      authType: 'OAUTH1' as any,
      authConfig: { consumerKey: 'app-key', consumerSecret: 's' },
    });
    expect(connectorsService.update).toHaveBeenCalledTimes(1);
  });

  it('does not apply the check to other auth types', async () => {
    const { controller, connectorsService } = build(apiKeyConnector);
    await controller.update(req('ADMIN'), 'c1', {
      authType: 'BASIC_AUTH' as any,
      authConfig: { consumerKey: 'someone@example.test', username: 'someone@example.test' },
    });
    expect(connectorsService.update).toHaveBeenCalledTimes(1);
  });
});
