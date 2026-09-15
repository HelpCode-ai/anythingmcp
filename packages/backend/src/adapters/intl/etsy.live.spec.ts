import * as adapter from './etsy.json';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  tools: Array<{ name: string; useProxy?: boolean }>;
};

describe('etsy adapter — static spec conformance', () => {
  /**
   * Etsy does not block server-side requests, and routing it through the
   * web-unblocker is what broke it.
   *
   * Measured from the cloud droplet: openapi.etsy.com answers a direct
   * request with `{"error":"Invalid API key: should be in the format
   * 'keystring:shared_secret'."}` — a real API response, so the host is
   * reachable and only wants credentials. The same URL through Zyte returns
   * 520 `/download/temporary-error` on every attempt (12 of 12 in a row).
   *
   * The connector had useProxy on all nine tools and a success rate of 0 out
   * of 69 calls across twelve organisations. It was opted in as part of the
   * batch that added the feature for Deutsche Bahn and Playtomic — both of
   * which answer a direct request with an HTML block page, which Etsy does
   * not. Do not re-add this without a block page to point at.
   */
  it('does not route through the web-unblocker', () => {
    expect(a.tools.filter((t) => t.useProxy)).toEqual([]);
  });

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
