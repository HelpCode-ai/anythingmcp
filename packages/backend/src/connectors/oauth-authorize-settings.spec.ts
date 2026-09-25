import { resolveRestAuthorizeSettings } from './oauth-authorize-settings';
import { getAdapter } from '../adapters/catalog';

const etsyCatalog = getAdapter('etsy')!.connector.authConfig!;
const pinterestCatalog = getAdapter('pinterest')!.connector.authConfig!;

describe('resolveRestAuthorizeSettings', () => {
  it('uses the stored settings as they are when the row has its own authorization URL', () => {
    const settings = resolveRestAuthorizeSettings(
      {
        clientId: 'cid',
        clientSecret: 'sec',
        authorizationUrl: 'https://login.datev.de/openidsandbox/authorize',
        tokenUrl: 'https://sandbox-api.datev.de/token',
        tokenAuthMethod: 'basic',
        scopes: 'accounting:clients:read',
      },
      null,
      // Even with catalog values at hand, a configured row is not mixed with them.
      { authorizationUrl: 'https://elsewhere.example/authorize', scopes: 'other' },
    );
    expect(settings).toEqual({
      clientId: 'cid',
      clientSecret: 'sec',
      authorizationUrl: 'https://login.datev.de/openidsandbox/authorize',
      tokenUrl: 'https://sandbox-api.datev.de/token',
      scope: 'accounting:clients:read',
      tokenAuthMethod: 'basic',
      adopted: {},
      missingVars: [],
    });
  });

  it('resolves placeholders from the env vars', () => {
    const settings = resolveRestAuthorizeSettings(
      {
        clientId: '{{ETSY_CLIENT_ID}}',
        clientSecret: '{{ETSY_CLIENT_SECRET}}',
        authorizationUrl: 'https://www.etsy.com/oauth/connect',
        tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
      },
      { ETSY_CLIENT_ID: 'keystring', ETSY_CLIENT_SECRET: 'secret' },
    );
    expect(settings.clientId).toBe('keystring');
    expect(settings.clientSecret).toBe('secret');
    expect(settings.missingVars).toEqual([]);
  });

  it('names the variables that are still unset', () => {
    const settings = resolveRestAuthorizeSettings(
      { clientId: '{{ETSY_CLIENT_ID}}', clientSecret: '{{ETSY_CLIENT_SECRET}}' },
      {},
      etsyCatalog,
    );
    expect(settings.missingVars).toEqual(['ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET']);
  });

  it('gives an Etsy row installed before the browser flow existed the catalog endpoints', () => {
    // The shape of an existing Etsy row: no authorizationUrl, no scopes.
    const settings = resolveRestAuthorizeSettings(
      {
        grant: 'refresh_token',
        tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
        clientId: 'keystring',
        clientSecret: 'secret',
        refreshToken: 'rt',
        extraHeaders: { 'x-api-key': 'keystring:secret' },
      },
      null,
      etsyCatalog,
    );
    expect(settings.authorizationUrl).toBe('https://www.etsy.com/oauth/connect');
    expect(settings.scope).toBe('email_r shops_r listings_r transactions_r');
    expect(settings.tokenUrl).toBe('https://api.etsy.com/v3/public/oauth/token');
    // Etsy authenticates the client in the body: nothing to adopt there.
    expect(settings.tokenAuthMethod).toBeUndefined();
    expect(settings.adopted).toEqual({
      authorizationUrl: 'https://www.etsy.com/oauth/connect',
      scopes: 'email_r shops_r listings_r transactions_r',
    });
  });

  it('adopts HTTP Basic for an existing Pinterest row, as Pinterest requires', () => {
    const settings = resolveRestAuthorizeSettings(
      {
        clientId: 'app-id',
        clientSecret: 'app-secret',
        refreshToken: 'pinr.old',
        tokenUrl: 'https://api.pinterest.com/v5/oauth/token',
      },
      null,
      pinterestCatalog,
    );
    expect(settings.authorizationUrl).toBe('https://www.pinterest.com/oauth/');
    expect(settings.tokenAuthMethod).toBe('basic');
    expect(settings.adopted).toEqual({
      authorizationUrl: 'https://www.pinterest.com/oauth/',
      tokenAuthMethod: 'basic',
      scopes: 'boards:read,boards:write,pins:read,pins:write,user_accounts:read',
    });
  });

  it('keeps what the row has over the catalog when it adopts', () => {
    const settings = resolveRestAuthorizeSettings(
      { clientId: 'id', scopes: 'listings_w', tokenUrl: 'https://own.example/token' },
      null,
      etsyCatalog,
    );
    expect(settings.scope).toBe('listings_w');
    expect(settings.tokenUrl).toBe('https://own.example/token');
    expect(settings.adopted).toEqual({
      authorizationUrl: 'https://www.etsy.com/oauth/connect',
    });
  });

  it('does not adopt a catalog value that needs install-time credentials', () => {
    const settings = resolveRestAuthorizeSettings({ clientId: 'id' }, null, {
      authorizationUrl: 'https://{{TENANT}}.example.com/oauth/authorize',
    });
    expect(settings.authorizationUrl).toBe('');
    expect(settings.adopted).toEqual({});
  });
});
