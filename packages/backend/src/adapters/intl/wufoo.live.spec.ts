import * as adapter from './wufoo.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('wufoo adapter — static spec conformance', () => {
  it('subdomain-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('https://{{WUFOO_SUBDOMAIN}}.wufoo.com/api/v3');
  });
  it('Basic with key + literal "footastic" password (Wufoo convention)', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('{{WUFOO_API_KEY}}');
    expect(a.connector.authConfig.password).toBe('footastic');
  });
});
