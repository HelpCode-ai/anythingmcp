import {
  cleanUserVariables,
  effectiveVariables,
  mergeUserCredential,
  missingUserVariables,
  pickUserTokens,
  pickUserVariables,
  supportsUserCredentials,
  userCredentialModeOf,
  userVariableCredentialsEnabled,
  userVariableNames,
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

describe('per-user variables', () => {
  const on = { variablesEnabled: true };

  it('reads the names from config.userVariables and ignores anything that is not a variable name', () => {
    expect(userVariableNames({ userVariables: ['ACME_API_KEY', 'ACME_USER'] })).toEqual(['ACME_API_KEY', 'ACME_USER']);
    expect(userVariableNames({ userVariables: ['ACME_API_KEY', 'ACME_API_KEY', 'amcp.user_email', 7, '{{X}}'] })).toEqual([
      'ACME_API_KEY',
    ]);
    expect(userVariableNames({ adapterSlug: 'acme' })).toEqual([]);
    expect(userVariableNames(null)).toEqual([]);
    expect(userVariableNames({ userVariables: 'ACME_API_KEY' })).toEqual([]);
  });

  it('keeps a browser OAuth2 connector on the provider sign-in', () => {
    expect(userCredentialModeOf({ type: 'MCP', authType: 'OAUTH2', authConfig: {} }, on)).toEqual({ mode: 'oauth' });
    expect(userCredentialModeOf({ type: 'MCP', authType: 'OAUTH2', authConfig: {} }, { variablesEnabled: false })).toEqual({
      mode: 'oauth',
    });
  });

  it('offers variables to connectors that send a key, a token or a password with each call', () => {
    for (const authType of ['NONE', 'API_KEY', 'QUERY_AUTH', 'BEARER_TOKEN', 'BASIC_AUTH', 'WS_SECURITY', 'CONNECTION_STRING']) {
      expect(userCredentialModeOf({ type: 'REST', authType }, on)).toEqual({ mode: 'variables' });
    }
    for (const type of ['REST', 'GRAPHQL', 'SOAP', 'ODATA', 'EMAIL', 'MCP']) {
      expect(userCredentialModeOf({ type, authType: 'BASIC_AUTH' }, on)).toEqual({ mode: 'variables' });
    }
  });

  it('keeps shared what works without a caller or stores a session per connector', () => {
    const refused = (input: Parameters<typeof userCredentialModeOf>[0]) => userCredentialModeOf(input, on).mode;
    expect(refused({ type: 'FILE_SEARCH', authType: 'BASIC_AUTH' })).toBeNull();
    expect(refused({ type: 'WEBHOOK', authType: 'NONE' })).toBeNull();
    expect(refused({ type: 'DATABASE', authType: 'CONNECTION_STRING' })).toBeNull();
    expect(refused({ type: 'REST', authType: 'API_KEY', webhookEnabled: true })).toBeNull();
    expect(refused({ type: 'REST', authType: 'LOGIN_TOKEN' })).toBeNull();
    expect(refused({ type: 'REST', authType: 'HMAC' })).toBeNull();
    expect(refused({ type: 'REST', authType: 'OAUTH1' })).toBeNull();
    expect(refused({ type: 'REST', authType: 'CERTIFICATE' })).toBeNull();
    expect(refused({ type: 'REST', authType: 'OAUTH2', authConfig: { grant: 'client_credentials' } })).toBeNull();
    expect(refused({ type: 'REST', authType: 'BEARER_TOKEN', renewsBearerToken: true })).toBeNull();
  });

  it('refuses variables everywhere when the switch is off, with the reason it gave before', () => {
    const out = userCredentialModeOf({ type: 'REST', authType: 'API_KEY' }, { variablesEnabled: false });
    expect(out).toEqual({ mode: null, reason: expect.stringContaining('API keys, passwords') });
  });

  it('is off unless switched on, on Cloud and self-hosted alike', () => {
    expect(userVariableCredentialsEnabled({})).toBe(false);
    expect(userVariableCredentialsEnabled({ DEPLOYMENT_MODE: 'cloud' })).toBe(false);
    expect(userVariableCredentialsEnabled({ USER_VARIABLE_CREDENTIALS: 'false' })).toBe(false);
    expect(userVariableCredentialsEnabled({ USER_VARIABLE_CREDENTIALS: 'yes' })).toBe(false);
    expect(userVariableCredentialsEnabled({ USER_VARIABLE_CREDENTIALS: 'true' })).toBe(true);
    expect(userVariableCredentialsEnabled({ DEPLOYMENT_MODE: 'cloud', USER_VARIABLE_CREDENTIALS: ' TRUE ' })).toBe(true);
  });

  it("resolves a per-user variable from the caller's own value, never from the connector's", () => {
    const connector = { ACME_API_KEY: 'admin-key', ACME_REGION: 'eu' };
    expect(effectiveVariables(connector, ['ACME_API_KEY'], { ACME_API_KEY: 'u1-key' })).toEqual({
      ACME_API_KEY: 'u1-key',
      ACME_REGION: 'eu',
    });
    // No own value: the variable is gone, not the administrator's.
    expect(effectiveVariables(connector, ['ACME_API_KEY'], {})).toEqual({ ACME_REGION: 'eu' });
    expect(effectiveVariables(connector, ['ACME_API_KEY'], { ACME_API_KEY: '' })).toEqual({ ACME_REGION: 'eu' });
    expect(effectiveVariables(connector, ['ACME_API_KEY'], undefined)).toEqual({ ACME_REGION: 'eu' });
    // A user cannot set a variable that is not per user.
    expect(effectiveVariables(connector, ['ACME_API_KEY'], { ACME_API_KEY: 'k', ACME_REGION: 'us' })).toEqual({
      ACME_API_KEY: 'k',
      ACME_REGION: 'eu',
    });
    expect(connector).toEqual({ ACME_API_KEY: 'admin-key', ACME_REGION: 'eu' });
  });

  it('names the variables a user has not entered', () => {
    expect(missingUserVariables(['A', 'B'], { A: 'x' })).toEqual(['B']);
    expect(missingUserVariables(['A', 'B'], { A: 'x', B: '' })).toEqual(['B']);
    expect(missingUserVariables(['A'], { A: 'x' })).toEqual([]);
  });

  it("reads a user's stored values for the per-user variables only", () => {
    const stored = { accessToken: 't', userVars: { A: 'x', B: 7, C: 'not-per-user' } };
    expect(pickUserVariables(stored, ['A', 'B'])).toEqual({ A: 'x' });
    expect(pickUserVariables({ userVars: ['A'] }, ['A'])).toEqual({});
    expect(pickUserVariables(null, ['A'])).toEqual({});
  });

  it('accepts exactly the per-user variables, trimmed and not empty', () => {
    expect(cleanUserVariables(['A', 'B'], { A: '  key ', B: 'user' })).toEqual({ values: { A: 'key', B: 'user' } });
    expect(cleanUserVariables(['A', 'B'], { A: 'key' })).toEqual({ error: 'A value for B is required.' });
    expect(cleanUserVariables(['A'], { A: '   ' })).toEqual({ error: 'A value for A is required.' });
    expect(cleanUserVariables(['A'], { A: 'k', ACME_REGION: 'us' })).toEqual({
      error: 'Not a per-user variable of this connector: ACME_REGION.',
    });
    expect(cleanUserVariables(['A'], { A: 'x'.repeat(9000) })).toEqual({ error: 'The value of A is too long.' });
    expect(cleanUserVariables(['A'], ['key'])).toEqual({ error: expect.any(String) });
    expect(cleanUserVariables(['A'], { A: 5 })).toEqual({ error: 'A value for A is required.' });
    expect(cleanUserVariables(['A'], { A: 'key\r\nX-Injected: 1' })).toEqual({
      error: 'The value of A contains a line break or control character.',
    });
    expect(cleanUserVariables(['A'], { A: 'k\u0000' })).toEqual({ error: expect.stringContaining('control character') });
  });
});
