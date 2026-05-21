import * as adapter from './ecwid.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('ecwid adapter — static spec conformance', () => {
  it('store-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('https://app.ecwid.com/api/v3/{{ECWID_STORE_ID}}');
  });
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
