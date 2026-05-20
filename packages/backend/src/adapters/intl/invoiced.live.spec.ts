import * as adapter from './invoiced.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('invoiced adapter — static spec conformance', () => {
  it('api.invoiced.com base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.invoiced.com'));
  it('Basic auth (API key as username)', () =>
    expect(a.connector.authType).toBe('BASIC_AUTH'));
});
