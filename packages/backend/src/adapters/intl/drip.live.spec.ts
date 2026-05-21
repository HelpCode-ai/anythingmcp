import * as adapter from './drip.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('drip adapter — static spec conformance', () => {
  it('account-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('https://api.getdrip.com/v2/{{DRIP_ACCOUNT_ID}}');
  });
  it('Basic with token as username and empty password', () => {
    expect(a.connector.authConfig.username).toBe('{{DRIP_API_TOKEN}}');
    expect(a.connector.authConfig.password).toBe('');
  });
});
