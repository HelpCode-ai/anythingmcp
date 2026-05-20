import * as adapter from './hunter.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
};
describe('hunter adapter — static spec conformance', () => {
  it('api.hunter.io/v2', () => expect(a.connector.baseUrl).toBe('https://api.hunter.io/v2'));
  it('QUERY_AUTH with api_key', () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig.api_key).toBe('{{HUNTER_API_KEY}}');
  });
});
