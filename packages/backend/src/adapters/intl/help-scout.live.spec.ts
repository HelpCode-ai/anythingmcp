import * as adapter from './help-scout.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('help-scout adapter — static spec conformance', () => {
  it('api.helpscout.net/v2', () => expect(a.connector.baseUrl).toBe('https://api.helpscout.net/v2'));
  it('OAuth2 client_credentials auth', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.grant).toBe('client_credentials');
    expect(a.connector.authConfig.tokenUrl).toBe('https://api.helpscout.net/v2/oauth2/token');
  });
});
