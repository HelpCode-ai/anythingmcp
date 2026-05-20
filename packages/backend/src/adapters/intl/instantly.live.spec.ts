import * as adapter from './instantly.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('instantly adapter — static spec conformance', () => {
  it('api.instantly.ai/api/v2', () => expect(a.connector.baseUrl).toBe('https://api.instantly.ai/api/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
