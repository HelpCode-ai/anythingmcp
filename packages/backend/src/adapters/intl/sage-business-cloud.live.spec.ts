import * as adapter from './sage-business-cloud.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { tokenUrl: string } };
};
describe('sage-business-cloud adapter — static spec conformance', () => {
  it('api.accounting.sage.com/v3.1 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.accounting.sage.com/v3.1'));
  it('OAuth2 with Sage token endpoint', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.tokenUrl).toBe('https://oauth.accounting.sage.com/token');
  });
});
