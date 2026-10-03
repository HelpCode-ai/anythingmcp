import { computeSetupState } from './connector-setup-status.util';

const etsyAuth = {
  grant: 'refresh_token',
  authorizationUrl: 'https://www.etsy.com/oauth/connect',
  tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
  clientId: '{{ETSY_CLIENT_ID}}',
  clientSecret: '{{ETSY_CLIENT_SECRET}}',
  refreshToken: '{{ETSY_REFRESH_TOKEN}}',
  extraHeaders: { 'x-api-key': '{{ETSY_CLIENT_ID}}:{{ETSY_CLIENT_SECRET}}' },
};

describe('computeSetupState', () => {
  it('is ready for a keyless connector', () => {
    expect(computeSetupState({ authType: 'NONE', baseUrl: 'https://openplzapi.org/de' })).toEqual({
      status: 'ready',
      missing: [],
    });
  });

  it('needs input when a credential was never filled in', () => {
    expect(
      computeSetupState({ authType: 'BEARER_TOKEN', authConfig: { token: '{{LEXWARE_API_KEY}}' } }),
    ).toEqual({ status: 'needs_input', missing: ['LEXWARE_API_KEY'] });
  });

  it('counts a variable set later in the env vars', () => {
    expect(
      computeSetupState({
        authType: 'BEARER_TOKEN',
        authConfig: JSON.stringify({ token: '{{LEXWARE_API_KEY}}' }),
        envVars: { LEXWARE_API_KEY: 'k' },
      }).status,
    ).toBe('ready');
  });

  it('needs input for an address variable (weclapp tenant)', () => {
    expect(
      computeSetupState({
        authType: 'API_KEY',
        baseUrl: 'https://{{WECLAPP_TENANT}}.weclapp.com/webapp/api/v2',
        authConfig: { apiKey: 'k', headerName: 'AuthenticationToken' },
      }),
    ).toEqual({ status: 'needs_input', missing: ['WECLAPP_TENANT'] });
  });

  it('asks for the Etsy app keys first, not for the refresh token', () => {
    expect(computeSetupState({ authType: 'OAUTH2', authConfig: etsyAuth })).toEqual({
      status: 'needs_input',
      missing: ['ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET'],
    });
  });

  it('needs authorization once the Etsy keys are in but nobody authorized', () => {
    expect(
      computeSetupState({
        authType: 'OAUTH2',
        authConfig: etsyAuth,
        envVars: { ETSY_CLIENT_ID: 'ks', ETSY_CLIENT_SECRET: 'ss' },
      }),
    ).toEqual({ status: 'needs_authorization', missing: [] });
  });

  it('is ready after the authorization stored a refresh token', () => {
    expect(
      computeSetupState({
        authType: 'OAUTH2',
        authConfig: { ...etsyAuth, refreshToken: 'rt-123', accessToken: 'at' },
        envVars: { ETSY_CLIENT_ID: 'ks', ETSY_CLIENT_SECRET: 'ss' },
      }).status,
    ).toBe('ready');
  });

  it('finds the authorization URL in the catalog for an older install', () => {
    const { authorizationUrl: _omit, ...rowWithoutUrl } = etsyAuth;
    expect(
      computeSetupState({
        authType: 'OAUTH2',
        authConfig: rowWithoutUrl,
        envVars: { ETSY_CLIENT_ID: 'ks', ETSY_CLIENT_SECRET: 'ss' },
        config: { adapterSlug: 'etsy' },
      }).status,
    ).toBe('needs_authorization');
  });

  it('treats client_credentials as ready once the keys are there', () => {
    expect(
      computeSetupState({
        authType: 'OAUTH2',
        authConfig: { grant: 'client_credentials', tokenUrl: 't', clientId: 'id', clientSecret: 's' },
      }).status,
    ).toBe('ready');
  });

  it('asks for a pasted refresh token when there is no browser flow', () => {
    expect(
      computeSetupState({
        authType: 'OAUTH2',
        authConfig: { tokenUrl: 't', clientId: 'id', clientSecret: 's', refreshToken: '{{DROPBOX_REFRESH_TOKEN}}' },
      }),
    ).toEqual({ status: 'needs_input', missing: ['DROPBOX_REFRESH_TOKEN'] });
  });

  it('ignores caller-context placeholders, which resolve at call time', () => {
    expect(
      computeSetupState({
        authType: 'API_KEY',
        authConfig: { apiKey: 'k' },
        headers: { 'X-User': '{{amcp.user.email}}' },
      }).status,
    ).toBe('ready');
  });
});
