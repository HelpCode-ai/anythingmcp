import * as adapter from './freshdesk.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string,string> };
};
describe('freshdesk adapter — static spec conformance', () => {
  it('domain-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('https://{{FRESHDESK_DOMAIN}}.freshdesk.com/api/v2');
  });
  it('BASIC_AUTH with key as username and X as password', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('{{FRESHDESK_API_KEY}}');
    expect(a.connector.authConfig.password).toBe('X');
  });
});
