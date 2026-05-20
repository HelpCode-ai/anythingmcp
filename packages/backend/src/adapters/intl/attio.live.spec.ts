import * as adapter from './attio.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('attio adapter — static spec conformance', () => {
  it('api.attio.com/v2', () => expect(a.connector.baseUrl).toBe('https://api.attio.com/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
