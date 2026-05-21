import * as adapter from './tally.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('tally adapter — static spec conformance', () => {
  it('api.tally.so', () => expect(a.connector.baseUrl).toBe('https://api.tally.so'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
