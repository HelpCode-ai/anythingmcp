import * as adapter from './folk.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('folk adapter — static spec conformance', () => {
  it('api.folk.app/v2', () => expect(a.connector.baseUrl).toBe('https://api.folk.app/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
