import * as adapter from './amadeus.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('amadeus adapter — static spec conformance', () => {
  it('test.api.amadeus.com (test env by default)', () =>
    expect(a.connector.baseUrl).toBe('https://test.api.amadeus.com'));
  it('Bearer auth (OAuth2 client-credentials access token)', () =>
    expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
