import * as adapter from './help-scout.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('help-scout adapter — static spec conformance', () => {
  it('api.helpscout.net/v2', () => expect(a.connector.baseUrl).toBe('https://api.helpscout.net/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
