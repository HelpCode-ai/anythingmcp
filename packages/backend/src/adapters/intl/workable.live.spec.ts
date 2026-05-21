import * as adapter from './workable.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('workable adapter — static spec conformance', () => {
  it('per-tenant baseUrl with subdomain placeholder', () =>
    expect(a.connector.baseUrl).toBe('https://{{WORKABLE_SUBDOMAIN}}.workable.com/spi/v3'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
