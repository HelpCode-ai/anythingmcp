import { ConfigService } from '@nestjs/config';
import { decrypt, encrypt } from '../common/crypto/encryption.util';
import { UserCredentialError, UserCredentialsService } from './user-credentials.service';

const KEY = 'test-encryption-key-32-chars!!!!';

function setup(opts: { enterprise?: boolean; rows?: Array<Record<string, unknown>> } = {}) {
  const rows = opts.rows ?? [];
  const userConnectorCredential = {
    findFirst: jest.fn(async ({ where }: any) =>
      rows.find(
        (r) =>
          r.connectorId === where.connectorId &&
          r.userId === where.userId &&
          r.organizationId === where.organizationId,
      ) ?? null,
    ),
    findMany: jest.fn(async ({ where }: any) =>
      rows.filter((r) => r.connectorId === where.connectorId && r.organizationId === where.organizationId),
    ),
    upsert: jest.fn(async () => ({})),
    deleteMany: jest.fn(async () => ({ count: 1 })),
  };
  const edition = { hasEnterprise: jest.fn(async () => opts.enterprise ?? true) };
  const oauth2Tokens = { forget: jest.fn() };
  const config = { get: jest.fn().mockReturnValue(KEY) } as unknown as ConfigService;
  const svc = new UserCredentialsService(
    { userConnectorCredential } as any,
    edition as any,
    oauth2Tokens as any,
    config,
  );
  return { svc, userConnectorCredential, edition, oauth2Tokens };
}

const row = (userId: string, tokens: Record<string, unknown>) => ({
  connectorId: 'c1',
  userId,
  organizationId: 'org1',
  authConfig: encrypt(JSON.stringify(tokens), KEY),
});

const call = (userId?: string) => ({
  connectorId: 'c1',
  connectorName: 'MFR',
  organizationId: 'org1',
  userId,
  connectorAuthConfig: { clientId: 'client-1', tokenUrl: 'https://mcp.example.com/token', accessToken: 'admin-at' },
});

describe('UserCredentialsService.resolveForCall', () => {
  it("carries the caller's own tokens under a key of their own", async () => {
    const { svc } = setup({ rows: [row('u1', { accessToken: 'u1-at', refreshToken: 'u1-rt' })] });
    const out = await svc.resolveForCall(call('u1'));
    expect(out.credentialKey).toBe('c1:user:u1');
    expect(out.authConfig).toEqual({
      clientId: 'client-1',
      tokenUrl: 'https://mcp.example.com/token',
      accessToken: 'u1-at',
      refreshToken: 'u1-rt',
    });
  });

  it('never answers one user with another user sign-in', async () => {
    const { svc } = setup({ rows: [row('u1', { accessToken: 'u1-at' })] });
    await expect(svc.resolveForCall(call('u2'))).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('refuses a call without a user instead of falling back to the connector token', async () => {
    const { svc } = setup({ rows: [row('u1', { accessToken: 'u1-at' })] });
    const err = await svc.resolveForCall(call(undefined)).catch((e) => e);
    expect(err).toBeInstanceOf(UserCredentialError);
    expect(err.code).toBe('no_user');
    expect(err.message).toContain('No request was sent');
  });

  it('refuses without an Enterprise licence, even for a connected user', async () => {
    const { svc } = setup({ enterprise: false, rows: [row('u1', { accessToken: 'u1-at' })] });
    await expect(svc.resolveForCall(call('u1'))).rejects.toMatchObject({ code: 'not_licensed' });
  });

  it('tells a user who has not connected yet where to do it', async () => {
    const before = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://app.example.com';
    const { svc } = setup();
    const err = await svc.resolveForCall(call('u1')).catch((e) => e);
    process.env.FRONTEND_URL = before;
    expect(err.code).toBe('not_connected');
    expect(err.message).toContain('https://app.example.com/auth/connect/c1');
    expect(err.message).toContain('Connect my account');
  });
});

describe('UserCredentialsService storage', () => {
  it('stores only token fields, encrypted, and forgets the cached token', async () => {
    const { svc, userConnectorCredential, oauth2Tokens } = setup();
    await svc.store({ id: 'c1', organizationId: 'org1' }, 'u1', {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 5,
      clientSecret: 'must-not-be-stored',
    });
    const args = (userConnectorCredential.upsert.mock.calls[0] as any)[0];
    expect(args.where).toEqual({ connectorId_userId: { connectorId: 'c1', userId: 'u1' } });
    expect(args.create.organizationId).toBe('org1');
    expect(JSON.parse(decrypt(args.create.authConfig, KEY))).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 5,
    });
    expect(args.update.authStatus).toBeNull();
    expect(oauth2Tokens.forget).toHaveBeenCalledWith('c1:user:u1');
  });

  it('reports the status without any token', async () => {
    const { svc } = setup({
      rows: [{ ...row('u1', { accessToken: 'at', authorizedAt: '2026-10-27T09:00:00.000Z' }), authStatus: null }],
    });
    const status = await svc.status('c1', 'org1', 'u1');
    expect(status).toEqual({
      connected: true,
      authorizedAt: '2026-10-27T09:00:00.000Z',
      authStatus: null,
      authStatusMessage: undefined,
    });
    expect(JSON.stringify(status)).not.toContain('"at"');
    expect(await svc.status('c1', 'org1', 'u2')).toEqual({ connected: false });
  });

  it('signs every user out and forgets each cached token', async () => {
    const { svc, userConnectorCredential, oauth2Tokens } = setup({
      rows: [row('u1', {}), row('u2', {})],
    });
    expect(await svc.removeAll('c1', 'org1')).toBe(2);
    expect(userConnectorCredential.deleteMany).toHaveBeenCalledWith({
      where: { connectorId: 'c1', organizationId: 'org1' },
    });
    expect(oauth2Tokens.forget).toHaveBeenCalledWith('c1:user:u1');
    expect(oauth2Tokens.forget).toHaveBeenCalledWith('c1:user:u2');
  });
});

describe('UserCredentialsService — per-user variables', () => {
  const NAMES = ['ACME_API_KEY', 'ACME_USER'];
  const input = (userId?: string) => ({
    connectorId: 'c1',
    connectorName: 'Acme',
    organizationId: 'org1',
    userId,
    userVariables: NAMES,
  });

  it("returns the caller's own values under a key of their own", async () => {
    const { svc } = setup({
      rows: [
        row('u1', { userVars: { ACME_API_KEY: 'u1-key', ACME_USER: 'u1@example.test' } }),
        row('u2', { userVars: { ACME_API_KEY: 'u2-key', ACME_USER: 'u2@example.test' } }),
      ],
    });
    await expect(svc.variablesForCall(input('u2'))).resolves.toEqual({
      userVars: { ACME_API_KEY: 'u2-key', ACME_USER: 'u2@example.test' },
      credentialKey: 'c1:user:u2',
    });
  });

  it('refuses a user who has entered nothing, or not every variable, before anything is sent', async () => {
    const { svc } = setup({ rows: [row('u1', { userVars: { ACME_API_KEY: 'u1-key' } })] });
    await expect(svc.variablesForCall(input('u2'))).rejects.toMatchObject({ code: 'not_connected' });
    await expect(svc.variablesForCall(input('u1'))).rejects.toMatchObject({ code: 'not_connected' });
    await expect(svc.variablesForCall(input('u1'))).rejects.toBeInstanceOf(UserCredentialError);
  });

  it('refuses a call without a user and a workspace without the licence', async () => {
    const withUser = setup({ rows: [row('u1', { userVars: { ACME_API_KEY: 'k', ACME_USER: 'u' } })] });
    await expect(withUser.svc.variablesForCall(input(undefined))).rejects.toMatchObject({ code: 'no_user' });
    const unlicensed = setup({ enterprise: false, rows: [row('u1', { userVars: { ACME_API_KEY: 'k', ACME_USER: 'u' } })] });
    await expect(unlicensed.svc.variablesForCall(input('u1'))).rejects.toMatchObject({ code: 'not_licensed' });
  });

  it('stores the values encrypted and forgets what the engines cached for that user', async () => {
    const { svc, userConnectorCredential, oauth2Tokens } = setup();
    await svc.storeVariables({ id: 'c1', organizationId: 'org1' }, 'u1', { ACME_API_KEY: 'u1-key', ACME_USER: 'u1' });
    const args = (userConnectorCredential.upsert.mock.calls as any[])[0][0];
    expect(args.where).toEqual({ connectorId_userId: { connectorId: 'c1', userId: 'u1' } });
    expect(args.create.authConfig).not.toContain('u1-key');
    const stored = JSON.parse(decrypt(args.create.authConfig, KEY));
    expect(stored.userVars).toEqual({ ACME_API_KEY: 'u1-key', ACME_USER: 'u1' });
    expect(typeof stored.authorizedAt).toBe('string');
    expect(args.update.authStatus).toBeNull();
    expect(oauth2Tokens.forget).toHaveBeenCalledWith('c1:user:u1');
  });

  it('reports a user as connected only with every variable, and never returns a value', async () => {
    const { svc } = setup({
      rows: [
        row('u1', { userVars: { ACME_API_KEY: 'u1-key', ACME_USER: 'u1' }, authorizedAt: '2026-11-17T09:00:00.000Z' }),
        row('u2', { userVars: { ACME_API_KEY: 'u2-key' } }),
      ],
    });
    const full = await svc.status('c1', 'org1', 'u1', NAMES);
    expect(full).toMatchObject({ connected: true, authorizedAt: '2026-11-17T09:00:00.000Z' });
    expect(JSON.stringify(full)).not.toContain('u1-key');
    await expect(svc.status('c1', 'org1', 'u2', NAMES)).resolves.toEqual({ connected: false, missingVariables: ['ACME_USER'] });
    await expect(svc.status('c1', 'org1', 'u3', NAMES)).resolves.toEqual({ connected: false, missingVariables: NAMES });
  });
});
