import { BadRequestException } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { decrypt, encrypt } from '../common/crypto/encryption.util';
import { UserCredentialError } from './user-credentials.service';

/**
 * A connector whose users enter their own values of some variables
 * (per-user variables, user-credential.util), here an e-mail archive every
 * colleague reads with their own login: the switch removes the connector's
 * own values, and the connection test runs with the tester's.
 */
describe('ConnectorsService with per-user variables', () => {
  const KEY = 'k'.repeat(24) + 'Zq7!pL2@vN9#xR4$';

  function setup(connector: Record<string, unknown>, ownByUser: Record<string, Record<string, string>> = {}) {
    const emailEngine = { execute: jest.fn(), testConnection: jest.fn().mockResolvedValue({ folders: 4, smtp: 'none' }) };
    const prisma = {
      connector: {
        findUnique: jest.fn().mockResolvedValue(connector),
        update: jest.fn(async ({ data }: any) => ({ ...connector, ...data })),
      },
    };
    const userCredentials = {
      removeAll: jest.fn().mockResolvedValue(0),
      resolveForCall: jest.fn(),
      variablesForCall: jest.fn(async (input: any) => {
        const userVars = input.userId ? ownByUser[input.userId] : undefined;
        if (!userVars) throw new UserCredentialError('You have not connected your own account.', 'not_connected');
        return { userVars, credentialKey: `${input.connectorId}:user:${input.userId}` };
      }),
    };
    const oauth2Tokens = { forget: jest.fn() };
    const authStatus = { clear: jest.fn().mockResolvedValue(undefined) };
    const service = new ConnectorsService(
      prisma as any,
      { get: () => KEY } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      oauth2Tokens as any,
      authStatus as any,
      undefined,
      userCredentials as any,
      emailEngine as any,
    );
    return { service, prisma, emailEngine, userCredentials, oauth2Tokens };
  }

  const archive = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    name: 'Mail archive',
    type: 'EMAIL',
    baseUrl: 'imap://archive.example.test:993',
    authType: 'BASIC_AUTH',
    authConfig: encrypt(JSON.stringify({ username: '{{ARCHIVE_USERNAME}}', password: '{{ARCHIVE_PASSWORD}}' }), KEY),
    headers: null,
    specUrl: null,
    credentialScope: 'SHARED',
    organizationId: 'org1',
    config: { email: { imapHost: 'archive.example.test', imapPort: '993' } },
    envVars: { ARCHIVE_USERNAME: 'kochf\\admin', ARCHIVE_PASSWORD: 'admin-password' },
    tools: [],
    ...over,
  });
  const switched = () =>
    archive({
      credentialScope: 'USER',
      config: { email: { imapHost: 'archive.example.test', imapPort: '993' }, userVariables: ['ARCHIVE_USERNAME', 'ARCHIVE_PASSWORD'] },
      envVars: { ARCHIVE_USERNAME: '', ARCHIVE_PASSWORD: '' },
    });

  describe('setCredentialScope', () => {
    it("removes the connector's own values and records which variables each user enters", async () => {
      const { service, prisma } = setup(archive());
      await service.setCredentialScope('c1', 'USER', { userVariables: ['ARCHIVE_USERNAME', 'ARCHIVE_PASSWORD'] });
      const { data } = prisma.connector.update.mock.calls[0][0];
      expect(data.credentialScope).toBe('USER');
      expect(data.envVars).toEqual({ ARCHIVE_USERNAME: '', ARCHIVE_PASSWORD: '' });
      expect(data.config).toEqual({
        email: { imapHost: 'archive.example.test', imapPort: '993' },
        userVariables: ['ARCHIVE_USERNAME', 'ARCHIVE_PASSWORD'],
      });
      expect(JSON.parse(decrypt(data.authConfig, KEY))).toEqual({
        username: '{{ARCHIVE_USERNAME}}',
        password: '{{ARCHIVE_PASSWORD}}',
      });
      expect(JSON.stringify(data)).not.toContain('admin-password');
    });

    it('writes nothing when a value would stay behind on the connector', async () => {
      const literal = archive({
        authConfig: encrypt(JSON.stringify({ username: '{{ARCHIVE_USERNAME}}', password: 'admin-password' }), KEY),
      });
      const { service, prisma } = setup(literal);
      await expect(
        service.setCredentialScope('c1', 'USER', { userVariables: ['ARCHIVE_USERNAME', 'ARCHIVE_PASSWORD'] }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.connector.update).not.toHaveBeenCalled();
    });

    it("forgets the list and every user's values on the way back to shared", async () => {
      const { service, prisma, userCredentials } = setup(switched());
      await service.setCredentialScope('c1', 'SHARED');
      const { data } = prisma.connector.update.mock.calls[0][0];
      expect(data.credentialScope).toBe('SHARED');
      expect(data.config).toEqual({ email: { imapHost: 'archive.example.test', imapPort: '993' } });
      expect(data.envVars).toBeUndefined();
      expect(userCredentials.removeAll).toHaveBeenCalledWith('c1', 'org1');
    });

    it('switches a provider sign-in connector as before, without touching variables or settings', async () => {
      const oauth = archive({
        type: 'MCP',
        authType: 'OAUTH2',
        authConfig: encrypt(JSON.stringify({ clientId: 'client-1', accessToken: 'admin-at', refreshToken: 'admin-rt' }), KEY),
        config: null,
        envVars: null,
      });
      const { service, prisma } = setup(oauth);
      await service.setCredentialScope('c1', 'USER');
      const { data } = prisma.connector.update.mock.calls[0][0];
      expect(Object.keys(data).sort()).toEqual(['authConfig', 'credentialScope']);
      expect(JSON.parse(decrypt(data.authConfig, KEY))).toEqual({ clientId: 'client-1' });
    });
  });

  describe('executeConnectorCall (Run Test)', () => {
    const run = (service: ConnectorsService, connector: Record<string, unknown>, userId?: string) =>
      service.executeConnectorCall(connector as any, { method: 'email_list_folders', path: '' }, {}, 'archive_list_folders', {
        type: 'object',
        properties: {},
      }, { userId });

    it("signs in with the caller's own values", async () => {
      const { service, emailEngine } = setup(switched(), {
        u1: { ARCHIVE_USERNAME: 'kochf\\u1', ARCHIVE_PASSWORD: 'u1-password' },
      });
      emailEngine.execute.mockResolvedValue({ folders: [] });
      await run(service, switched(), 'u1');
      expect(emailEngine.execute.mock.calls[0][0].authConfig).toEqual({ username: 'kochf\\u1', password: 'u1-password' });
    });

    it("sends nothing for a user without their own values, whatever is left on the connector", async () => {
      const leftover = { ...switched(), envVars: { ARCHIVE_USERNAME: 'kochf\\admin', ARCHIVE_PASSWORD: 'admin-password' } };
      const { service, emailEngine } = setup(leftover);
      await expect(run(service, leftover, 'u2')).rejects.toThrow(/not connected/);
      await expect(run(service, leftover, undefined)).rejects.toThrow();
      expect(emailEngine.execute).not.toHaveBeenCalled();
    });

    it('sends nothing when the sign-in no longer refers to the variables', async () => {
      const overwritten = {
        ...switched(),
        authConfig: encrypt(JSON.stringify({ username: 'kochf\\admin', password: 'admin-password' }), KEY),
      };
      const { service, emailEngine } = setup(overwritten, {
        u1: { ARCHIVE_USERNAME: 'kochf\\u1', ARCHIVE_PASSWORD: 'u1-password' },
      });
      await expect(run(service, overwritten, 'u1')).rejects.toThrow(/no longer uses it/);
      expect(emailEngine.execute).not.toHaveBeenCalled();
    });
  });

  describe('testConnection', () => {
    beforeEach(() => jest.restoreAllMocks());

    it("signs in with the tester's own stored values", async () => {
      const { service, emailEngine } = setup(switched(), {
        u1: { ARCHIVE_USERNAME: 'kochf\\u1', ARCHIVE_PASSWORD: 'u1-password' },
      });
      jest.spyOn(service, 'findById').mockResolvedValue(switched() as any);
      const out = await service.testConnection('c1', { userId: 'u1' });
      expect(out.ok).toBe(true);
      expect(emailEngine.testConnection.mock.calls[0][0].authConfig).toEqual({
        username: 'kochf\\u1',
        password: 'u1-password',
      });
    });

    it('tries values that are typed and not stored yet, without reading the stored ones', async () => {
      const { service, emailEngine, userCredentials } = setup(switched(), {
        u1: { ARCHIVE_USERNAME: 'kochf\\u1', ARCHIVE_PASSWORD: 'old-password' },
      });
      jest.spyOn(service, 'findById').mockResolvedValue(switched() as any);
      await service.testConnection('c1', {
        userId: 'u1',
        userVariables: { ARCHIVE_USERNAME: 'kochf\\u1', ARCHIVE_PASSWORD: 'new-password' },
      });
      expect(emailEngine.testConnection.mock.calls[0][0].authConfig.password).toBe('new-password');
      expect(userCredentials.variablesForCall).not.toHaveBeenCalled();
    });

    it("never falls back to the connector's own values for a user without theirs", async () => {
      // Values typed into the connector again after the switch.
      const leftover = { ...switched(), envVars: { ARCHIVE_USERNAME: 'kochf\\admin', ARCHIVE_PASSWORD: 'admin-password' } };
      const { service, emailEngine } = setup(leftover);
      jest.spyOn(service, 'findById').mockResolvedValue(leftover as any);
      const out = await service.testConnection('c1', { userId: 'u2' });
      expect(out).toMatchObject({ ok: false, kind: 'auth_failed' });
      expect(emailEngine.testConnection).not.toHaveBeenCalled();
    });

    it('tests a shared connector with its own values, as before', async () => {
      const { service, emailEngine, userCredentials } = setup(archive());
      jest.spyOn(service, 'findById').mockResolvedValue(archive() as any);
      await service.testConnection('c1', { userId: 'u1' });
      expect(emailEngine.testConnection.mock.calls[0][0].authConfig).toEqual({
        username: 'kochf\\admin',
        password: 'admin-password',
      });
      expect(userCredentials.variablesForCall).not.toHaveBeenCalled();
    });
  });
});
