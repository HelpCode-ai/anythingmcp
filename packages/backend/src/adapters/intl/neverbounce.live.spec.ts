import * as adapter from './neverbounce.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
};
describe('neverbounce adapter — static spec conformance', () => {
  it('api.neverbounce.com/v4.2', () => expect(a.connector.baseUrl).toBe('https://api.neverbounce.com/v4.2'));
  it('QUERY_AUTH with key', () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig.key).toBe('{{NEVERBOUNCE_API_KEY}}');
  });
});
