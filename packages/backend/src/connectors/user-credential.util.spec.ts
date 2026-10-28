import {
  mergeUserCredential,
  pickUserTokens,
  supportsUserCredentials,
  withoutUserTokens,
} from './user-credential.util';

describe('user-credential.util', () => {
  const connectorAuth = {
    tokenUrl: 'https://mcp.example.com/token',
    clientId: 'client-1',
    clientSecret: 'secret',
    resource: 'https://mcp.example.com/mcp',
    // Left on the connector by the admin who authorized it before the switch.
    accessToken: 'admin-at',
    refreshToken: 'admin-rt',
    expiresAt: 1,
    authorizedAt: '2026-10-01T00:00:00.000Z',
  };

  it('never carries the connector own tokens into a user call', () => {
    const merged = mergeUserCredential(connectorAuth, {});
    expect(merged.accessToken).toBeUndefined();
    expect(merged.refreshToken).toBeUndefined();
    expect(merged.clientId).toBe('client-1');
  });

  it('takes the client from the connector and the tokens from the user', () => {
    const merged = mergeUserCredential(connectorAuth, {
      accessToken: 'user-at',
      refreshToken: 'user-rt',
      expiresAt: 2,
      // Not a token field: a user row cannot change the client.
      clientId: 'evil',
    });
    expect(merged).toEqual({
      tokenUrl: 'https://mcp.example.com/token',
      clientId: 'client-1',
      clientSecret: 'secret',
      resource: 'https://mcp.example.com/mcp',
      accessToken: 'user-at',
      refreshToken: 'user-rt',
      expiresAt: 2,
    });
  });

  it('splits an auth config into client settings and tokens', () => {
    expect(withoutUserTokens(connectorAuth)).toEqual({
      tokenUrl: 'https://mcp.example.com/token',
      clientId: 'client-1',
      clientSecret: 'secret',
      resource: 'https://mcp.example.com/mcp',
    });
    expect(pickUserTokens({ ...connectorAuth, expiresIn: undefined })).toEqual({
      accessToken: 'admin-at',
      refreshToken: 'admin-rt',
      expiresAt: 1,
      authorizedAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('allows per-user credentials for browser OAuth2 only', () => {
    expect(supportsUserCredentials('REST', 'OAUTH2', {})).toBe(true);
    expect(supportsUserCredentials('MCP', 'OAUTH2', { grant: 'authorization_code' })).toBe(true);
    expect(supportsUserCredentials('REST', 'OAUTH2', { grant: 'client_credentials' })).toBe(false);
    expect(supportsUserCredentials('REST', 'OAUTH2', { grant: 'password' })).toBe(false);
    expect(supportsUserCredentials('REST', 'API_KEY', {})).toBe(false);
    expect(supportsUserCredentials('REST', 'BEARER_TOKEN', {})).toBe(false);
  });

  it('allows it only on connector types whose engine sends an OAuth2 token', () => {
    for (const type of ['REST', 'GRAPHQL', 'MCP', 'ODATA']) {
      expect(supportsUserCredentials(type, 'OAUTH2', {})).toBe(true);
    }
    expect(supportsUserCredentials('SOAP', 'OAUTH2', {})).toBe(false);
    expect(supportsUserCredentials('DATABASE', 'OAUTH2', {})).toBe(false);
  });
});
