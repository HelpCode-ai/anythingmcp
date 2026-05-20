import * as adapter from './kustomer.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('kustomer adapter — static spec conformance', () => {
  it('subdomain-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('https://{{KUSTOMER_SUBDOMAIN}}.api.kustomerapp.com/v1');
  });
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
