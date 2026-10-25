import { ConnectorsService } from './connectors.service';
import { encrypt } from '../common/crypto/encryption.util';
import { authCredentialRef, credentialRef } from './engines/connector-auth-status.service';

/**
 * A recorded credential status (connector-auth-status.service.ts) belongs to
 * the credential that was refused. A new authorization or a new token clears
 * it; an edit that leaves the credential as it was keeps it, or the same
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

  it('a new authorization clears what was recorded against the old refresh token', async () => {
    await service.updateAuthConfigMerge('conn-gsc', { refreshToken: 'rt-new', authorizedAt: 'now' });
    expect(authStatus.clear).toHaveBeenCalledWith('conn-gsc', { exceptRef: credentialRef('rt-new') });
  });

  it('an edit of static settings keeps the status of the refresh token still stored', async () => {
    await service.updateAuthConfigMerge('conn-gsc', { scopes: 'b' });
    expect(authStatus.clear).toHaveBeenCalledWith('conn-gsc', { exceptRef: credentialRef('rt-dead') });
  });

  it('starts the bearer renewal over on any edit, since the app id and secret are variables', async () => {
    await service.update('conn-gsc', { envVars: { META_APP_ID: '1' } });
    expect(bearer.forget).toHaveBeenCalledWith('conn-gsc');
    expect(authStatus.clear).toHaveBeenLastCalledWith('conn-gsc', { exceptRef: credentialRef('rt-dead') });
    await service.update('conn-gsc', { authConfig: { token: 'EAApasted' } });
    expect(authStatus.clear).toHaveBeenLastCalledWith('conn-gsc', { exceptRef: credentialRef('EAApasted') });
  });
});

describe('authCredentialRef', () => {
  it('names the refresh token of an OAuth connector, else the pasted token', () => {
    expect(authCredentialRef({ refreshToken: 'rt', token: 'x' })).toBe(credentialRef('rt'));
    expect(authCredentialRef({ token: 'EAA' })).toBe(credentialRef('EAA'));
    expect(authCredentialRef({})).toBeUndefined();
    expect(credentialRef('rt')).toMatch(/^[0-9a-f]{16}$/);
    expect(credentialRef('rt')).not.toBe(credentialRef('rt2'));
  });
});
