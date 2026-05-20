import * as adapter from './lever.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('lever adapter — static spec conformance', () => {
  it('api.lever.co/v1 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.lever.co/v1'));
  it('Basic auth (API key as username, empty password)', () =>
    expect(a.connector.authType).toBe('BASIC_AUTH'));
});
