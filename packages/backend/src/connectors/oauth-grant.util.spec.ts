import { canRenewToken, isMachineGrant } from './oauth-grant.util';

describe('oauth-grant.util', () => {
  it('treats client_credentials and password as grants that need no user', () => {
    expect(isMachineGrant('client_credentials')).toBe(true);
    expect(isMachineGrant('password')).toBe(true);
    expect(isMachineGrant(undefined)).toBe(false);
    expect(isMachineGrant('refresh_token')).toBe(false);
    expect(isMachineGrant('authorization_code')).toBe(false);
  });

  it('renews after a 401 with a refresh token or a machine grant, never without a token URL', () => {
    const tokenUrl = 'https://example.com/token';
    expect(canRenewToken({ tokenUrl, refreshToken: 'rt' })).toBe(true);
    expect(canRenewToken({ tokenUrl, grant: 'password' })).toBe(true);
    expect(canRenewToken({ tokenUrl, grant: 'client_credentials' })).toBe(true);
    expect(canRenewToken({ tokenUrl })).toBe(false);
    expect(canRenewToken({ grant: 'password' })).toBe(false);
    expect(canRenewToken(undefined)).toBe(false);
  });
});
