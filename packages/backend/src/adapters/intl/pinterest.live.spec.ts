import * as adapter from './pinterest.json';
const a = adapter as unknown as {
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
};
describe('pinterest adapter — static spec conformance', () => {
  it('api.pinterest.com/v5 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.pinterest.com/v5'));
  it('OAuth2 with refresh-token flow', () =>
    expect(a.connector.authType).toBe('OAUTH2'));

  it('can be authorized in the browser, and still accepts a pasted refresh token', () => {
    const auth = a.connector.authConfig;
    expect(auth.authorizationUrl).toBe('https://www.pinterest.com/oauth/');
    expect(auth.tokenUrl).toBe('https://api.pinterest.com/v5/oauth/token');
    expect(auth.refreshToken).toBe('{{PINTEREST_REFRESH_TOKEN}}');
    expect(auth.scopes).toBe('boards:read,boards:write,pins:read,pins:write,user_accounts:read');
    expect(a.requiredEnvVars).toEqual(['PINTEREST_CLIENT_ID', 'PINTEREST_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['PINTEREST_REFRESH_TOKEN']);
  });

  // Pinterest's token endpoint takes the client as HTTP Basic
  // (developers.pinterest.com, "Set up authentication and authorization").
  it('authenticates the client at the token endpoint with HTTP Basic', () =>
    expect(a.connector.authConfig.tokenAuthMethod).toBe('basic'));

  it('tells users the callback URL to register', () => {
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('Authorize with Provider');
  });
});
