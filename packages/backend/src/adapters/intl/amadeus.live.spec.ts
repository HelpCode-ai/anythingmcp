import * as adapter from './amadeus.json';
const a = adapter as unknown as {
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
};
describe('amadeus adapter — static spec conformance', () => {
  // test.api.amadeus.com stopped resolving when Amadeus retired the
  // Self-Service portal (2026-07-17); production is the host that still exists.
  it('api.amadeus.com, with the token URL on the same host', () => {
    expect(a.connector.baseUrl).toBe('https://api.amadeus.com');
    expect(a.connector.authConfig.tokenUrl).toBe(
      'https://api.amadeus.com/v1/security/oauth2/token',
    );
  });
  // Tokens last ~30 minutes, so a pasted Bearer token cannot work; the
  // engine mints them from the API key/secret instead.
  it('OAuth2 client-credentials, credentials as form fields', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toMatchObject({
      grant: 'client_credentials',
      tokenAuthMethod: 'client_secret_post',
      clientId: '{{AMADEUS_CLIENT_ID}}',
      clientSecret: '{{AMADEUS_CLIENT_SECRET}}',
    });
    expect(a.requiredEnvVars).toEqual(['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET']);
  });
});
