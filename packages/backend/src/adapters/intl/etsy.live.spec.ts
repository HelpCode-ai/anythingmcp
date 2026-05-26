import * as adapter from './etsy.json';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
};

describe('etsy adapter — static spec conformance', () => {
  it('targets the official Etsy Open API v3 base URL', () => {
    expect(a.connector.baseUrl).toBe('https://openapi.etsy.com/v3/application');
  });

  it('uses OAUTH2 with refresh_token grant so access tokens auto-renew', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.grant).toBe('refresh_token');
    expect(a.connector.authConfig.tokenUrl).toBe(
      'https://api.etsy.com/v3/public/oauth/token',
    );
    expect(a.connector.authConfig.clientId).toBe('{{ETSY_CLIENT_ID}}');
    expect(a.connector.authConfig.clientSecret).toBe('{{ETSY_CLIENT_SECRET}}');
    expect(a.connector.authConfig.refreshToken).toBe('{{ETSY_REFRESH_TOKEN}}');
  });

  it('carries x-api-key alongside the Bearer token (Etsy v3 dual-auth)', () => {
    const extra = a.connector.authConfig.extraHeaders as Record<string, string>;
    expect(extra['x-api-key']).toBe('{{ETSY_CLIENT_ID}}');
  });

  it('asks only for 3 env vars (client id/secret + initial refresh token)', () => {
    expect(a.requiredEnvVars.sort()).toEqual([
      'ETSY_CLIENT_ID',
      'ETSY_CLIENT_SECRET',
      'ETSY_REFRESH_TOKEN',
    ]);
  });
});
