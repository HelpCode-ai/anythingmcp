import * as adapter from './agilecrm.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('agilecrm adapter — static spec conformance', () => {
  it('per-tenant baseUrl with subdomain placeholder', () =>
    expect(a.connector.baseUrl).toBe('https://{{AGILECRM_DOMAIN}}.agilecrm.com/dev/api'));
  it('Basic auth', () => expect(a.connector.authType).toBe('BASIC_AUTH'));
});
