import {
  describeMissing,
  rebuildCatalogCredentials,
  withAliases,
  type CatalogTemplate,
} from './catalog-env-rebuild.util';

const IS24: CatalogTemplate = {
  connector: {
    baseUrl: 'https://rest.immobilienscout24.de/restapi/api',
    authType: 'OAUTH1',
    authConfig: {
      consumerKey: '{{IS24_CONSUMER_KEY}}',
      consumerSecret: '{{IS24_CONSUMER_SECRET}}',
    },
  },
  envVarAliases: {
    IS24_CONSUMER_KEY: ['IS24_CLIENT_ID'],
    IS24_CONSUMER_SECRET: ['IS24_CLIENT_SECRET'],
  },
};

const base = {
  connectorAuthType: 'OAUTH1',
  storedBaseUrl: 'https://rest.immobilienscout24.de/restapi/api',
  storedHeaders: null,
};

describe('rebuildCatalogCredentials', () => {
  it('keeps a consumer key corrected in the auth editor when another variable is edited', () => {
    const result = rebuildCatalogCredentials({
      ...base,
      adapter: IS24,
      // Fixed with PATCH :id/oauth1-config; the variable still holds the typo.
      storedAuthConfig: { consumerKey: 'corrected-key', consumerSecret: 'secret-1' },
      previousEnvVars: { IS24_CONSUMER_KEY: 'wrong-key', IS24_CONSUMER_SECRET: 'secret-1' },
      nextEnvVars: { IS24_CONSUMER_KEY: 'wrong-key', IS24_CONSUMER_SECRET: 'secret-2' },
    });

    expect(result.authConfig).toEqual({
      consumerKey: 'corrected-key',
      consumerSecret: 'secret-2',
    });
    expect(result.missing).toEqual([]);
  });

  it('rebuilds a field whose variable changed', () => {
    const result = rebuildCatalogCredentials({
      ...base,
      adapter: IS24,
      storedAuthConfig: { consumerKey: 'old-key', consumerSecret: 'secret-1' },
      previousEnvVars: { IS24_CONSUMER_KEY: 'old-key', IS24_CONSUMER_SECRET: 'secret-1' },
      nextEnvVars: { IS24_CONSUMER_KEY: 'new-key', IS24_CONSUMER_SECRET: 'secret-1' },
    });
    expect(result.authConfig).toEqual({ consumerKey: 'new-key', consumerSecret: 'secret-1' });
  });

  it('reports no change when nothing the templates use changed', () => {
    const result = rebuildCatalogCredentials({
      ...base,
      adapter: IS24,
      storedAuthConfig: { consumerKey: 'k', consumerSecret: 's' },
      previousEnvVars: { IS24_CONSUMER_KEY: 'k', IS24_CONSUMER_SECRET: 's' },
      nextEnvVars: { IS24_CONSUMER_KEY: 'k', IS24_CONSUMER_SECRET: 's', OTHER: 'x' },
    });
    expect(result.authConfig).toBeUndefined();
    expect(result.baseUrl).toBeUndefined();
    expect(result.headers).toBeUndefined();
  });

  it('reads a renamed variable under its old name (IS24 installs from before #712)', () => {
    const result = rebuildCatalogCredentials({
      ...base,
      adapter: IS24,
      // What the old wholesale rebuild left behind.
      storedAuthConfig: {
        consumerKey: '{{IS24_CONSUMER_KEY}}',
        consumerSecret: '{{IS24_CONSUMER_SECRET}}',
      },
      previousEnvVars: { IS24_CLIENT_ID: 'app-key', IS24_CLIENT_SECRET: 'app-secret' },
      nextEnvVars: { IS24_CLIENT_ID: 'app-key', IS24_CLIENT_SECRET: 'app-secret' },
    });

    expect(result.authConfig).toEqual({ consumerKey: 'app-key', consumerSecret: 'app-secret' });
    expect(result.aliasesUsed).toEqual([
      { variable: 'IS24_CONSUMER_KEY', from: 'IS24_CLIENT_ID' },
      { variable: 'IS24_CONSUMER_SECRET', from: 'IS24_CLIENT_SECRET' },
    ]);
    expect(result.missing).toEqual([]);
  });

  it('prefers the current name over an alias', () => {
    expect(
      withAliases({ IS24_CONSUMER_KEY: 'new', IS24_CLIENT_ID: 'old' }, IS24.envVarAliases),
    ).toMatchObject({ IS24_CONSUMER_KEY: 'new' });
  });

  it('without an alias, keeps the stored credential and reports the variable', () => {
    const result = rebuildCatalogCredentials({
      ...base,
      adapter: { ...IS24, envVarAliases: undefined },
      storedAuthConfig: { consumerKey: 'working-key', consumerSecret: 'working-secret' },
      previousEnvVars: { IS24_CLIENT_ID: 'working-key', IS24_CLIENT_SECRET: 'working-secret' },
      // The user edits the old variable, which the template no longer reads.
      nextEnvVars: { IS24_CLIENT_ID: 'other-key', IS24_CLIENT_SECRET: 'working-secret' },
    });

    // Nothing is rebuilt, but the variables the connector actually reads are
    // named, so the edit to IS24_CLIENT_ID does not look like it worked.
    expect(result.authConfig).toBeUndefined();
    expect(result.missing).toEqual([
      { variable: 'IS24_CONSUMER_KEY', field: 'authConfig.consumerKey', kept: true },
      { variable: 'IS24_CONSUMER_SECRET', field: 'authConfig.consumerSecret', kept: true },
    ]);

    // Removing the current variable leaves nothing to resolve the field from.
    const removed = rebuildCatalogCredentials({
      ...base,
      adapter: IS24,
      storedAuthConfig: { consumerKey: 'working-key', consumerSecret: 'working-secret' },
      previousEnvVars: { IS24_CONSUMER_KEY: 'working-key', IS24_CONSUMER_SECRET: 'working-secret' },
      nextEnvVars: { IS24_CONSUMER_SECRET: 'working-secret' },
    });
    expect(removed.authConfig).toBeUndefined();
    expect(removed.missing).toEqual([
      { variable: 'IS24_CONSUMER_KEY', field: 'authConfig.consumerKey', kept: true },
    ]);
    expect(describeMissing(removed.missing)).toEqual([
      'IS24_CONSUMER_KEY is not set, so authConfig.consumerKey kept its stored value. ' +
        'Add IS24_CONSUMER_KEY to change it.',
    ]);
  });

  it('keeps fields the template does not know about (issued OAuth tokens)', () => {
    const adapter: CatalogTemplate = {
      connector: {
        baseUrl: 'https://api.example.test',
        authType: 'OAUTH2',
        authConfig: {
          clientId: '{{X_CLIENT_ID}}',
          clientSecret: '{{X_CLIENT_SECRET}}',
          tokenUrl: 'https://api.example.test/token',
        },
      },
    };
    const result = rebuildCatalogCredentials({
      adapter,
      connectorAuthType: 'OAUTH2',
      storedBaseUrl: 'https://api.example.test',
      storedHeaders: null,
      storedAuthConfig: {
        clientId: 'id',
        clientSecret: 'old',
        tokenUrl: 'https://api.example.test/token',
        accessToken: 'issued-at',
        refreshToken: 'issued-rt',
      },
      previousEnvVars: { X_CLIENT_ID: 'id', X_CLIENT_SECRET: 'old' },
      nextEnvVars: { X_CLIENT_ID: 'id', X_CLIENT_SECRET: 'new' },
    });
    expect(result.authConfig).toEqual({
      clientId: 'id',
      clientSecret: 'new',
      tokenUrl: 'https://api.example.test/token',
      accessToken: 'issued-at',
      refreshToken: 'issued-rt',
    });
  });

  it('leaves authConfig alone when the connector was switched to another auth type', () => {
    const result = rebuildCatalogCredentials({
      ...base,
      connectorAuthType: 'BEARER_TOKEN',
      adapter: IS24,
      storedAuthConfig: { token: 'hand-typed' },
      previousEnvVars: { IS24_CONSUMER_KEY: 'a' },
      nextEnvVars: { IS24_CONSUMER_KEY: 'b' },
    });
    expect(result.authConfig).toBeUndefined();
  });

  it('keeps a base URL and headers customised by hand unless their variable changes', () => {
    const adapter: CatalogTemplate = {
      connector: {
        baseUrl: '{{SHOP_URL}}/api',
        authType: 'NONE',
        headers: { 'X-Account': '{{ACCOUNT_ID}}', Accept: 'application/json' },
      },
    };
    const stored = {
      adapter,
      connectorAuthType: 'NONE',
      storedAuthConfig: null,
      storedBaseUrl: 'https://sandbox.example.test/api',
      storedHeaders: { 'X-Account': '42', Accept: 'application/json', 'X-Custom': 'mine' },
      previousEnvVars: { SHOP_URL: 'https://shop.example.test', ACCOUNT_ID: '42' },
    };

    const untouched = rebuildCatalogCredentials({
      ...stored,
      nextEnvVars: { SHOP_URL: 'https://shop.example.test', ACCOUNT_ID: '42', OTHER: '1' },
    });
    expect(untouched.baseUrl).toBeUndefined();
    expect(untouched.headers).toBeUndefined();

    const changed = rebuildCatalogCredentials({
      ...stored,
      nextEnvVars: { SHOP_URL: 'https://new.example.test', ACCOUNT_ID: '43' },
    });
    expect(changed.baseUrl).toBe('https://new.example.test/api');
    expect(changed.headers).toEqual({
      'X-Account': '43',
      Accept: 'application/json',
      'X-Custom': 'mine',
    });
  });

  it('fills a field missing from the stored copy, and leaves caller-context variables alone', () => {
    const adapter: CatalogTemplate = {
      connector: {
        baseUrl: 'https://api.example.test',
        authType: 'API_KEY',
        authConfig: { headerName: 'X-Api-Key', apiKey: '{{KEY}}', user: '{{amcp.user_email}}' },
      },
    };
    const result = rebuildCatalogCredentials({
      adapter,
      connectorAuthType: 'API_KEY',
      storedAuthConfig: {},
      storedBaseUrl: 'https://api.example.test',
      storedHeaders: null,
      previousEnvVars: {},
      nextEnvVars: { KEY: 'k' },
    });
    expect(result.authConfig).toEqual({
      headerName: 'X-Api-Key',
      apiKey: 'k',
      user: '{{amcp.user_email}}',
    });
    expect(result.missing).toEqual([]);
  });
});
