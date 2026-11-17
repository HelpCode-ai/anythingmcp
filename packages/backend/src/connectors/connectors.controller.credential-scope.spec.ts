import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';
import { encrypt } from '../common/crypto/encryption.util';
import { UserCredentialError } from './user-credentials.service';

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
    hasEnterprise: jest.fn(async () => !!opts.enterprise),
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
    { recentEvents: jest.fn().mockResolvedValue([]) } as any,
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
    const { controller, userCredentials } = build({
      connector: oauthConnector({ credentialScope: 'USER' }),
      enterprise: true,
    });
    await expect(controller.getMyCredential(req('VIEWER'), 'c1')).resolves.toEqual({
      connected: true,
      available: true,
    });
    expect(userCredentials.status).toHaveBeenCalledWith('c1', 'org1', 'u-member');
  });

  it('says per-user sign-in is not available without Enterprise', async () => {
    const { controller } = build({ connector: oauthConnector(), enterprise: false });
    await expect(controller.getMyCredential(req('ADMIN'), 'c1')).resolves.toEqual({
      connected: false,
      available: false,
    });
  });

  it("removes the caller's own sign-in only", async () => {
    const { controller, userCredentials } = build({ connector: oauthConnector({ credentialScope: 'USER' }) });
    await controller.deleteMyCredential(req('MEMBER'), 'c1');
    expect(userCredentials.remove).toHaveBeenCalledWith('c1', 'org1', 'u-member');
  });
});

/**
 * Per-user variables: a connector with a key or a password instead of a
 * provider sign-in, where every user enters their own values.
 */
describe('per-user variables on the connector endpoints', () => {
  const keyConnector = (over: Record<string, unknown> = {}) =>
    oauthConnector({
      name: 'Acme',
      type: 'REST',
      authType: 'API_KEY',
      authConfig: encrypt(JSON.stringify({ headerName: 'X-Api-Key', apiKey: '{{ACME_API_KEY}}' }), KEY),
      envVars: { ACME_API_KEY: 'admin-key' },
      ...over,
    });
  const switchedConnector = (over: Record<string, unknown> = {}) =>
    keyConnector({ credentialScope: 'USER', config: { userVariables: ['ACME_API_KEY'] }, envVars: { ACME_API_KEY: '' }, ...over });

  const PREVIEW = { credentialScope: 'USER', config: { userVariables: ['ACME_API_KEY'] }, envVars: { ACME_API_KEY: '' } };

  /**
   * `test` answers a connection test with real values; `blind` answers the
   * one the switch runs with values that are nobody's (refused by default,
   * as an API that checks its key does).
   */
  function buildWithTest(
    connector: Record<string, unknown>,
    test: { ok: boolean; message: string; kind?: string },
    blind: { ok: boolean; message: string; kind?: string } = { ok: false, kind: 'auth_failed', message: 'refused' },
  ) {
    const built = build({ connector, enterprise: true });
    (built.connectorsService as any).testConnection = jest.fn(async (_id: string, options: any) =>
      options?.as ? blind : test,
    );
    (built.connectorsService as any).previewUserVariableSwitch = jest.fn().mockResolvedValue(PREVIEW);
    (built.connectorsService as any).update = jest.fn(async (_id: string, data: any) => ({ ...connector, ...data }));
    (built.userCredentials as any).storeVariables = jest.fn().mockResolvedValue(undefined);
    return built as typeof built & {
      connectorsService: { testConnection: jest.Mock; previewUserVariableSwitch: jest.Mock; update: jest.Mock };
      userCredentials: { storeVariables: jest.Mock };
    };
  }
  const flag = process.env.USER_VARIABLE_CREDENTIALS;
  beforeEach(() => {
    process.env.USER_VARIABLE_CREDENTIALS = 'true';
  });
  afterEach(() => {
    if (flag === undefined) delete process.env.USER_VARIABLE_CREDENTIALS;
    else process.env.USER_VARIABLE_CREDENTIALS = flag;
  });

  describe('PATCH :id/credential-scope', () => {
    it('switches once the connection test passes with the current values', async () => {
      const { controller, connectorsService } = buildWithTest(keyConnector(), { ok: true, message: 'Connection successful' });
      await expect(
        controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', {
          credentialScope: 'USER',
          userVariables: ['ACME_API_KEY'],
        }),
      ).resolves.toEqual({ credentialScope: 'USER', userVariables: ['ACME_API_KEY'] });
      expect((connectorsService as any).testConnection).toHaveBeenCalledWith('c1', { userId: 'u-admin' });
      expect(connectorsService.setCredentialScope).toHaveBeenCalledWith('c1', 'USER', { userVariables: ['ACME_API_KEY'] });
    });

    it('tries the connection in the switched state with values that are nobody\'s, and they must be refused', async () => {
      const { controller, connectorsService } = buildWithTest(keyConnector(), { ok: true, message: 'Connection successful' });
      await controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', {
        credentialScope: 'USER',
        userVariables: ['ACME_API_KEY'],
      });
      const blindCall = connectorsService.testConnection.mock.calls.find(([, options]) => options.as);
      expect(blindCall![1].as).toBe(PREVIEW);
      expect(blindCall![1].userVariables.ACME_API_KEY).toMatch(/^amcp-check-[0-9a-f]{18}$/);
      expect(blindCall![1].userVariables.ACME_API_KEY).not.toBe('admin-key');
    });

    it('refuses when the test passes without the values: it could not check anyone', async () => {
      const { controller, connectorsService } = buildWithTest(
        keyConnector(),
        { ok: true, message: 'Connection successful' },
        { ok: true, message: 'Connection successful' },
      );
      await expect(
        controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', {
          credentialScope: 'USER',
          userVariables: ['ACME_API_KEY'],
        }),
      ).rejects.toThrow(/passes without these values/);
      expect(connectorsService.setCredentialScope).not.toHaveBeenCalled();
    });

    it('is refused on a server where per-user values are not switched on (the default)', async () => {
      delete process.env.USER_VARIABLE_CREDENTIALS;
      const { controller, connectorsService } = buildWithTest(keyConnector(), { ok: true, message: 'ok' });
      await expect(
        controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', {
          credentialScope: 'USER',
          userVariables: ['ACME_API_KEY'],
        }),
      ).rejects.toThrow(/API keys, passwords and client-credentials grants stay shared/);
      expect(connectorsService.testConnection).not.toHaveBeenCalled();
      expect(connectorsService.setCredentialScope).not.toHaveBeenCalled();
    });

    it('refuses while the connection test does not pass: it is how each user is checked later', async () => {
      const { controller, connectorsService } = buildWithTest(keyConnector(), {
        ok: false,
        kind: 'not_found',
        message: 'The API answered 404 for /.',
      });
      await expect(
        controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', {
          credentialScope: 'USER',
          userVariables: ['ACME_API_KEY'],
        }),
      ).rejects.toThrow(/connection test has to pass/);
      expect(connectorsService.setCredentialScope).not.toHaveBeenCalled();
    });

    it('asks which variables when none are named', async () => {
      const { controller } = buildWithTest(keyConnector(), { ok: true, message: 'ok' });
      await expect(
        controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', { credentialScope: 'USER' }),
      ).rejects.toThrow(/every user enters their own values/);
    });

    it('refuses when per-user variables are switched off on the server', async () => {
      process.env.USER_VARIABLE_CREDENTIALS = 'false';
      const { controller, connectorsService } = buildWithTest(keyConnector(), { ok: true, message: 'ok' });
      await expect(
        controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', {
          credentialScope: 'USER',
          userVariables: ['ACME_API_KEY'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(connectorsService.setCredentialScope).not.toHaveBeenCalled();
    });

    it('refuses variables for a connector users sign in to through the provider', async () => {
      const { controller } = buildWithTest(oauthConnector(), { ok: true, message: 'ok' });
      await expect(
        controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', {
          credentialScope: 'USER',
          userVariables: ['ACME_API_KEY'],
        }),
      ).rejects.toThrow(/sign in through the provider/);
    });

    it('refuses a connector that receives webhooks', async () => {
      const { controller } = buildWithTest(keyConnector({ webhookEnabled: true }), { ok: true, message: 'ok' });
      await expect(
        controller.updateCredentialScope(req('ADMIN', 'u-admin'), 'c1', {
          credentialScope: 'USER',
          userVariables: ['ACME_API_KEY'],
        }),
      ).rejects.toThrow(/webhooks/);
    });
  });

  describe('PUT :id on a connector with per-user variables', () => {
    it('refuses a sign-in that replaces the variable with one value for everyone', async () => {
      const { controller, connectorsService } = buildWithTest(switchedConnector(), { ok: true, message: 'ok' });
      await expect(
        controller.update(req('ADMIN', 'u-admin'), 'c1', {
          authConfig: { headerName: 'X-Api-Key', apiKey: 'one-key-for-everyone' },
        } as any),
      ).rejects.toThrow(/replace \{\{ACME_API_KEY\}\} with one value for everyone/);
      expect(connectorsService.update).not.toHaveBeenCalled();
    });

    it('refuses a change of the sign-in method', async () => {
      const { controller, connectorsService } = buildWithTest(switchedConnector(), { ok: true, message: 'ok' });
      await expect(
        controller.update(req('ADMIN', 'u-admin'), 'c1', { authType: 'BEARER_TOKEN' } as any),
      ).rejects.toThrow(/Switch it back to a shared sign-in/);
      expect(connectorsService.update).not.toHaveBeenCalled();
    });

    it('refuses a sign-in that starts renewing the token in the background', async () => {
      const bearer = switchedConnector({
        authType: 'BEARER_TOKEN',
        authConfig: encrypt(JSON.stringify({ token: '{{ACME_API_KEY}}' }), KEY),
      });
      const { controller, connectorsService } = buildWithTest(bearer, { ok: true, message: 'ok' });
      await expect(
        controller.update(req('ADMIN', 'u-admin'), 'c1', {
          authConfig: { token: '{{ACME_API_KEY}}', tokenRenewal: { provider: 'meta', appId: 'a', appSecret: 's' } },
        } as any),
      ).rejects.toThrow(/switch it back to a shared sign-in before making this change/);
      expect(connectorsService.update).not.toHaveBeenCalled();
    });

    it('refuses turning webhooks on, and moving the variable into the name of the header', async () => {
      const { controller, connectorsService } = buildWithTest(switchedConnector(), { ok: true, message: 'ok' });
      await expect(controller.update(req('ADMIN', 'u-admin'), 'c1', { webhookEnabled: true } as any)).rejects.toThrow();
      await expect(
        controller.update(req('ADMIN', 'u-admin'), 'c1', {
          authConfig: { headerName: '{{ACME_API_KEY}}', apiKey: '{{ACME_API_KEY}}' },
        } as any),
      ).rejects.toThrow(/how or where the connector signs in/);
      expect(connectorsService.update).not.toHaveBeenCalled();
    });

    it('accepts a sign-in that still refers to the variable', async () => {
      const { controller, connectorsService } = buildWithTest(switchedConnector(), { ok: true, message: 'ok' });
      await controller
        .update(req('ADMIN', 'u-admin'), 'c1', { authConfig: { headerName: 'X-Acme-Key', apiKey: '{{ACME_API_KEY}}' } } as any)
        .catch(() => undefined);
      expect(connectorsService.update).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ authConfig: { headerName: 'X-Acme-Key', apiKey: '{{ACME_API_KEY}}' } }),
      );
    });

    it('never stores a value of a per-user variable on the connector again', async () => {
      const { controller, connectorsService } = buildWithTest(switchedConnector(), { ok: true, message: 'ok' });
      await controller
        .update(req('ADMIN', 'u-admin'), 'c1', { envVars: { ACME_API_KEY: 'typed-again', ACME_REGION: 'eu' } } as any)
        .catch(() => undefined);
      expect(connectorsService.update).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ envVars: { ACME_API_KEY: '', ACME_REGION: 'eu' } }),
      );
    });

    it('leaves a shared connector free to take a value in the same place', async () => {
      const { controller, connectorsService } = buildWithTest(keyConnector(), { ok: true, message: 'ok' });
      await controller
        .update(req('ADMIN', 'u-admin'), 'c1', { authConfig: { headerName: 'X-Api-Key', apiKey: 'a-shared-key' } } as any)
        .catch(() => undefined);
      expect(connectorsService.update).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ authConfig: { headerName: 'X-Api-Key', apiKey: 'a-shared-key' } }),
      );
    });
  });

  describe('POST :id/discover-tools on a connector with per-user variables', () => {
    it('lists nothing when the connector has changed to a sign-in that keeps a session', async () => {
      const changed = switchedConnector({ type: 'MCP', authType: 'LOGIN_TOKEN' });
      const { controller, userCredentials } = buildWithTest(changed, { ok: true, message: 'ok' });
      (userCredentials as any).variablesForCall = jest.fn();
      const out: any = await controller.discoverMcpTools(req('ADMIN', 'u-admin'), 'c1');
      expect(out.error).toContain('LOGIN_TOKEN');
      expect(out.error).toContain('Nothing was sent');
      expect((userCredentials as any).variablesForCall).not.toHaveBeenCalled();
    });

    it('lists nothing for a caller who has not entered their own values', async () => {
      const { controller, userCredentials } = buildWithTest(switchedConnector({ type: 'MCP' }), { ok: true, message: 'ok' });
      (userCredentials as any).variablesForCall = jest.fn().mockRejectedValue(
        new UserCredentialError('You have not connected your own account. No request was sent to the API.', 'not_connected'),
      );
      const out: any = await controller.discoverMcpTools(req('ADMIN', 'u-admin'), 'c1');
      expect(out.error).toContain('You have not connected your own account');
    });
  });

  describe('GET :id/my-credential', () => {
    it('names the variables to enter, never a value', async () => {
      const { controller, userCredentials } = buildWithTest(switchedConnector(), { ok: true, message: 'ok' });
      userCredentials.status.mockResolvedValue({ connected: false, missingVariables: ['ACME_API_KEY'] });
      await expect(controller.getMyCredential(req('VIEWER'), 'c1')).resolves.toEqual({
        connected: false,
        missingVariables: ['ACME_API_KEY'],
        available: true,
        mode: 'variables',
        variables: [{ name: 'ACME_API_KEY', label: 'Acme API Key', secret: true }],
      });
      expect(userCredentials.status).toHaveBeenCalledWith('c1', 'org1', 'u-member', ['ACME_API_KEY']);
    });
  });

  describe('PUT :id/my-credential', () => {
    it('stores values that pass the connection test, for the caller only', async () => {
      const { controller, connectorsService, userCredentials } = buildWithTest(switchedConnector(), {
        ok: true,
        message: 'Connection successful',
      });
      userCredentials.status.mockResolvedValue({ connected: true });
      await expect(
        controller.setMyCredential(req('VIEWER'), 'c1', { variables: { ACME_API_KEY: '  u-key  ' } }),
      ).resolves.toEqual({ connected: true });
      expect(connectorsService.testConnection).toHaveBeenCalledWith('c1', {
        userId: 'u-member',
        userVariables: { ACME_API_KEY: 'u-key' },
      });
      expect(userCredentials.storeVariables).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1', organizationId: 'org1' }),
        'u-member',
        { ACME_API_KEY: 'u-key' },
      );
    });

    it('stores nothing when the values are refused', async () => {
      const { controller, userCredentials } = buildWithTest(switchedConnector(), {
        ok: false,
        kind: 'auth_failed',
        message: 'The credentials were rejected.',
      });
      await expect(
        controller.setMyCredential(req('VIEWER'), 'c1', { variables: { ACME_API_KEY: 'wrong' } }),
      ).rejects.toThrow(/nothing was saved/);
      expect(userCredentials.storeVariables).not.toHaveBeenCalled();
    });

    it('stores nothing when a variable is missing or unknown, and does not even try them', async () => {
      const { controller, connectorsService, userCredentials } = buildWithTest(switchedConnector(), { ok: true, message: 'ok' });
      await expect(controller.setMyCredential(req('VIEWER'), 'c1', { variables: {} })).rejects.toThrow(BadRequestException);
      await expect(
        controller.setMyCredential(req('VIEWER'), 'c1', { variables: { ACME_API_KEY: 'k', ACME_TENANT: 'other' } }),
      ).rejects.toThrow(/Not a per-user variable/);
      expect(connectorsService.testConnection).not.toHaveBeenCalled();
      expect(userCredentials.storeVariables).not.toHaveBeenCalled();
    });

    it('refuses on a shared connector, on a provider sign-in, without the licence and for another workspace', async () => {
      const shared = buildWithTest(keyConnector(), { ok: true, message: 'ok' });
      await expect(
        shared.controller.setMyCredential(req('VIEWER'), 'c1', { variables: { ACME_API_KEY: 'k' } }),
      ).rejects.toThrow(BadRequestException);

      const oauth = buildWithTest(oauthConnector({ credentialScope: 'USER' }), { ok: true, message: 'ok' });
      await expect(
        oauth.controller.setMyCredential(req('VIEWER'), 'c1', { variables: { ACME_API_KEY: 'k' } }),
      ).rejects.toThrow(BadRequestException);

      const unlicensed = build({ connector: switchedConnector(), enterprise: false });
      await expect(
        unlicensed.controller.setMyCredential(req('VIEWER'), 'c1', { variables: { ACME_API_KEY: 'k' } }),
      ).rejects.toThrow(ForbiddenException);

      const elsewhere = buildWithTest(switchedConnector({ organizationId: 'other' }), { ok: true, message: 'ok' });
      await expect(
        elsewhere.controller.setMyCredential(req('VIEWER'), 'c1', { variables: { ACME_API_KEY: 'k' } }),
      ).rejects.toThrow(ForbiddenException);
      expect(elsewhere.userCredentials.storeVariables).not.toHaveBeenCalled();
    });
  });
});
