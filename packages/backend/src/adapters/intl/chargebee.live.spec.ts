import * as adapter from './chargebee.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('chargebee adapter — static spec conformance', () => {
  it('site-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('https://{{CHARGEBEE_SITE}}.chargebee.com/api/v2');
  });
  it('BASIC_AUTH with key as username + empty password', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('{{CHARGEBEE_API_KEY}}');
    expect(a.connector.authConfig.password).toBe('');
  });
});
