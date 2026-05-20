import * as adapter from './height.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('height adapter — static spec conformance', () => {
  it('api.height.app', () => expect(a.connector.baseUrl).toBe('https://api.height.app'));
  it('api-key prefix (NOT Bearer)', () => expect(a.connector.authConfig.apiKey).toBe('api-key {{HEIGHT_API_KEY}}'));
});
