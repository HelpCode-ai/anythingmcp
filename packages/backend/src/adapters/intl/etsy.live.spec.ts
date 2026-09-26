import * as adapter from './etsy.json';
import { interpolateString } from '../../common/env-interpolation.util';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  instructions: string;
  connector: {
    baseUrl: string;
    authType: string;
    healthcheckPath?: string;
    authConfig: Record<string, unknown>;
  };
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

  /**
   * New installs authorize in the browser: Etsy's authorization code flow with
   * PKCE, which the platform always runs. A pasted refresh token still works,
   * so ETSY_REFRESH_TOKEN is optional rather than gone — connectors installed
   * that way are in daily use.
   */
  it('can be authorized in the browser, and still accepts a pasted refresh token', () => {
    const auth = a.connector.authConfig;
    expect(auth.authorizationUrl).toBe('https://www.etsy.com/oauth/connect');
    // Space-separated, as Etsy documents; read-only, like every tool here.
    expect(auth.scopes).toBe('email_r shops_r listings_r transactions_r');
    // Etsy takes the client in the body (client_id, and the shared secret it
    // checks). Basic would change the refresh request of every Etsy row.
    expect(auth.tokenAuthMethod).toBeUndefined();
    expect(a.requiredEnvVars).toEqual(['ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['ETSY_REFRESH_TOKEN']);
  });

  it('tells users the callback URL to register', () => {
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('/api/mcp-oauth/callback');
    expect(a.instructions).toContain('Authorize with Provider');
  });

  /**
   * The API key must carry the keystring AND the shared secret, colon
   * separated, on every request — OAuth bearer or not.
   *
   * This test used to assert the keystring alone, which is how the bug
   * survived: 54 installed connectors, 70 calls, 70 failures with
   * `403 Invalid API key: should be in the format 'keystring:shared_secret'`.
   * That exact string is quoted in the proxy test above, where it was read as
   * "the host is reachable and only wants credentials" — Etsy was in fact
   * naming the required format, and nobody heard it until a customer did.
   *
   * Verified against Etsy with a real key: keystring alone → 403 "Shared
   * secret is required in x-api-key header", keystring:shared_secret → 200.
   */
  it('carries keystring:shared_secret as x-api-key, not the keystring alone', () => {
    const extra = a.connector.authConfig.extraHeaders as Record<string, string>;
    expect(extra['x-api-key']).toBe('{{ETSY_CLIENT_ID}}:{{ETSY_CLIENT_SECRET}}');
    expect(
      interpolateString(extra['x-api-key'], {
        ETSY_CLIENT_ID: 'aa11bb22cc33dd44ee55ff66',
        ETSY_CLIENT_SECRET: 'zz99yy88',
      }),
    ).toBe('aa11bb22cc33dd44ee55ff66:zz99yy88');
  });

  /**
   * "/" is a 404 on the Etsy API, so Test connection failed on a connector
   * that was otherwise fine and sent people looking in the wrong place.
   * openapi-ping needs only the API key, which makes a green test mean the
   * key is genuinely accepted.
   */
  it('points the healthcheck at an endpoint that exists', () => {
    expect(a.connector.healthcheckPath).toBe('/openapi-ping');
  });

  it('asks for the same 3 env vars (client id/secret required, refresh token optional)', () => {
    expect([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])].sort()).toEqual([
      'ETSY_CLIENT_ID',
      'ETSY_CLIENT_SECRET',
      'ETSY_REFRESH_TOKEN',
    ]);
  });
});
