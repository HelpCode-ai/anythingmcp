import * as adapter from './zoho-crm.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { tokenUrl: string; tokenPrefix: string } };
};
describe('zoho-crm adapter — static spec conformance', () => {
  it('zohoapis.com/crm/v8 base URL (US DC default)', () =>
    expect(a.connector.baseUrl).toBe('https://www.zohoapis.com/crm/v8'));
  it('OAuth2 with Zoho-oauthtoken header prefix', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.tokenUrl).toBe('https://accounts.zoho.com/oauth/v2/token');
    expect(a.connector.authConfig.tokenPrefix).toBe('Zoho-oauthtoken');
  });
});
