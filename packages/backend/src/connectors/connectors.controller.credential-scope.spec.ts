import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';
import { encrypt } from '../common/crypto/encryption.util';

/**
 * Per-user credentials on the connector endpoints: who may switch a
 * connector, what it takes (Enterprise, browser OAuth2), and that every
 * member may sign in with their own account once it is per user.
 */
const KEY = 'a'.repeat(48);

function build(opts: {
  connector: Record<string, unknown>;
  enterprise?: boolean;
}) {
  const connectorsService = {
    findById: jest.fn().mockResolvedValue(opts.connector),
    setCredentialScope: jest.fn(async (_id: string, scope: string) => ({ credentialScope: scope })),
  };
  const edition = {
    assertEnterprise: jest.fn(async () => {
      if (!opts.enterprise) throw new ForbiddenException('Per-user sign-in for connectors is available with AnythingMCP Enterprise.');
    }),
  };
  const userCredentials = {
    status: jest.fn().mockResolvedValue({ connected: true }),
    remove: jest.fn().mockResolvedValue(true),
  };
  const mcpOAuthService = {
    discoverMetadata: jest.fn().mockResolvedValue({
      issuer: 'https://mcp.example.com/',
      authorization_endpoint: 'https://mcp.example.com/authorize',
      token_endpoint: 'https://mcp.example.com/token',
      registration_endpoint: 'https://mcp.example.com/register',
      code_challenge_methods_supported: ['S256'],
    }),
    registerClient: jest.fn().mockResolvedValue({ clientId: 'dyn-1', tokenAuthMethod: 'none' }),
    generateCodeVerifier: () => 'v',
    generateCodeChallenge: () => 'c',
    generateState: () => 'state-1',
    storePendingFlow: jest.fn().mockResolvedValue(undefined),
    buildAuthorizationUrl: () => 'https://mcp.example.com/authorize?x=1',
  };
  (connectorsService as any).updateAuthConfigMerge = jest.fn().mockResolvedValue(undefined);
  const controller = new ConnectorsController(
    connectorsService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    mcpOAuthService as any,
    {} as any,
    {} as any,
    { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) } as any,
    { get: jest.fn((k: string) => (k === 'SERVER_URL' ? 'https://amcp.example.com' : KEY)) } as any,
    {} as any,
    {} as any,
    { isCloud: () => false } as any,
    edition as any,
    userCredentials as any,
  );
  return { controller, connectorsService, edition, userCredentials, mcpOAuthService };
}

const req = (role: string, sub = 'u-member') => ({ user: { sub, organizationId: 'org1', role } });

const oauthConnector = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'MFR',
  type: 'MCP',
  userId: 'u-admin',
  organizationId: 'org1',
  baseUrl: 'https://mcp.example.com',
  authType: 'OAUTH2',
  authConfig: encrypt(JSON.stringify({}), KEY),
  credentialScope: 'SHARED',
  config: null,
  envVars: null,
  headers: null,
  ...over,
});

describe('PATCH /connectors/:id/credential-scope', () => {
  it('switches an OAuth2 connector to per-user with Enterprise', async () => {
    const { controller, connectorsService } = build({ connector: oauthConnector(), enterprise: true });
    await expect(
      controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', { credentialScope: 'USER' }),
    ).resolves.toEqual({ credentialScope: 'USER' });
    expect(connectorsService.setCredentialScope).toHaveBeenCalledWith('c1', 'USER');
  });

  it('refuses per-user without Enterprise', async () => {
    const { controller, connectorsService } = build({ connector: oauthConnector(), enterprise: false });
    await expect(
      controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', { credentialScope: 'USER' }),
    ).rejects.toThrow(ForbiddenException);
    expect(connectorsService.setCredentialScope).not.toHaveBeenCalled();
  });

  it('refuses per-user for an API key connector', async () => {
    const { controller } = build({ connector: oauthConnector({ authType: 'API_KEY' }), enterprise: true });
    await expect(
      controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', { credentialScope: 'USER' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lets only the owner or an admin switch', async () => {
    const { controller } = build({ connector: oauthConnector(), enterprise: true });
    await expect(
      controller.updateCredentialScope(req('MEMBER'), 'c1', { credentialScope: 'USER' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('switches back to shared without Enterprise (a lapsed licence must not trap the connector)', async () => {
    const { controller, connectorsService } = build({
      connector: oauthConnector({ credentialScope: 'USER' }),
      enterprise: false,
    });
    await controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', { credentialScope: 'SHARED' });
    expect(connectorsService.setCredentialScope).toHaveBeenCalledWith('c1', 'SHARED');
  });
});

describe('POST /connectors/:id/oauth/authorize on a per-user connector', () => {
  it('lets any member start their own sign-in, marked as theirs', async () => {
    const { controller, mcpOAuthService } = build({
      connector: oauthConnector({ credentialScope: 'USER' }),
      enterprise: true,
    });
    const out = await controller.initiateOAuth(req('MEMBER'), 'c1', {});
    expect(out).toEqual({ authorizationUrl: expect.any(String) });
    expect(mcpOAuthService.storePendingFlow).toHaveBeenCalledWith(
      'state-1',
      expect.objectContaining({ userId: 'u-member', forUser: true }),
      expect.anything(),
    );
  });

  it('refuses a member on another organization', async () => {
    const { controller } = build({
      connector: oauthConnector({ credentialScope: 'USER', organizationId: 'other' }),
      enterprise: true,
    });
    await expect(controller.initiateOAuth(req('MEMBER'), 'c1', {})).rejects.toThrow(ForbiddenException);
  });

  it('refuses without Enterprise', async () => {
    const { controller } = build({ connector: oauthConnector({ credentialScope: 'USER' }), enterprise: false });
    await expect(controller.initiateOAuth(req('MEMBER'), 'c1', {})).rejects.toThrow(ForbiddenException);
  });

  it('keeps a shared connector for its owner and admins', async () => {
    const { controller } = build({ connector: oauthConnector(), enterprise: true });
    await expect(controller.initiateOAuth(req('MEMBER'), 'c1', {})).rejects.toThrow(ForbiddenException);
  });
});

describe('/connectors/:id/my-credential', () => {
  it("answers with the caller's own status", async () => {
    const { controller, userCredentials } = build({ connector: oauthConnector({ credentialScope: 'USER' }) });
    await expect(controller.getMyCredential(req('VIEWER'), 'c1')).resolves.toEqual({ connected: true });
    expect(userCredentials.status).toHaveBeenCalledWith('c1', 'org1', 'u-member');
  });

  it("removes the caller's own sign-in only", async () => {
    const { controller, userCredentials } = build({ connector: oauthConnector({ credentialScope: 'USER' }) });
    await controller.deleteMyCredential(req('MEMBER'), 'c1');
    expect(userCredentials.remove).toHaveBeenCalledWith('c1', 'org1', 'u-member');
  });
});
