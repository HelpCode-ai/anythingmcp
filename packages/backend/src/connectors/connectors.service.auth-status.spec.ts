import { ConnectorsService, credentialsChanged } from './connectors.service';
import { encrypt } from '../common/crypto/encryption.util';

/**
 * A recorded credential status (connector-auth-status.service.ts) belongs to
 * the credential that was refused. A new authorization or a new token clears
 * it; an edit that leaves the credential as it was does not, or the same
 * refused token would start a new incident and a second email.
 */
describe('ConnectorsService: credential status after an edit', () => {
  const KEY = 'k'.repeat(24) + 'Zq7!pL2@vN9#xR4$';
  const stored = { tokenUrl: 'https://oauth2.googleapis.com/token', refreshToken: 'rt-dead', scopes: 'a' };
  let authStatus: { clear: jest.Mock };
  let bearer: { forget: jest.Mock };
  let service: ConnectorsService;

  beforeEach(() => {
    const row = { id: 'conn-gsc', type: 'REST', authConfig: encrypt(JSON.stringify(stored), KEY) };
    const prisma = {
      connector: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
    };
    authStatus = { clear: jest.fn() };
    bearer = { forget: jest.fn() };
    service = new ConnectorsService(
      prisma as any,
      { get: () => KEY } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      { forget: jest.fn() } as any,
      authStatus as any,
      bearer as any,
    );
  });

  it('clears the status when a new authorization stores a new refresh token', async () => {
    await service.updateAuthConfigMerge('conn-gsc', { refreshToken: 'rt-new', authorizedAt: 'now' });
    expect(authStatus.clear).toHaveBeenCalledWith('conn-gsc');
  });

  it('keeps it when only static settings change', async () => {
    await service.updateAuthConfigMerge('conn-gsc', { scopes: 'b' });
    expect(authStatus.clear).not.toHaveBeenCalled();
  });

  it('starts the bearer renewal over on any edit, since the app id and secret are variables', async () => {
    await service.update('conn-gsc', { envVars: { META_APP_ID: '1' } });
    expect(bearer.forget).toHaveBeenCalledWith('conn-gsc');
    expect(authStatus.clear).not.toHaveBeenCalled();
    await service.update('conn-gsc', { authConfig: { ...stored, refreshToken: 'pasted' } });
    expect(authStatus.clear).toHaveBeenCalledWith('conn-gsc');
  });
});

describe('credentialsChanged', () => {
  it('looks at the credential, not at the settings around it', () => {
    expect(credentialsChanged({ token: 'a', tokenRenewal: { provider: 'meta' } }, { token: 'a' })).toBe(false);
    expect(credentialsChanged({ token: 'a' }, { token: 'b' })).toBe(true);
    expect(credentialsChanged({ refreshToken: 'a', scopes: 'x' }, { refreshToken: 'a', scopes: 'y' })).toBe(false);
    expect(credentialsChanged({ clientSecret: 'a' }, { clientSecret: 'b' })).toBe(true);
  });
});
