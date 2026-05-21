import * as adapter from './greenhouse.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('greenhouse adapter — static spec conformance', () => {
  it('harvest.greenhouse.io/v1 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://harvest.greenhouse.io/v1'));
  it('Basic auth (API key as username)', () =>
    expect(a.connector.authType).toBe('BASIC_AUTH'));
});
