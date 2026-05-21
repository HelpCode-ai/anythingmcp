import * as adapter from './mollie.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('mollie adapter — static spec conformance', () => {
  it('api.mollie.com/v2', () => expect(a.connector.baseUrl).toBe('https://api.mollie.com/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
