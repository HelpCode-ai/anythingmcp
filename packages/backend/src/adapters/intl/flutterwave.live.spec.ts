import * as adapter from './flutterwave.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('flutterwave adapter — static spec conformance', () => {
  it('api.flutterwave.com/v3 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.flutterwave.com/v3'));
  it('Bearer auth (secret key)', () =>
    expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
