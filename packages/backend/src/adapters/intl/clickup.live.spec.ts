import * as adapter from './clickup.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
};
describe('clickup adapter — static spec conformance', () => {
  it('api.clickup.com/api/v2', () => expect(a.connector.baseUrl).toBe('https://api.clickup.com/api/v2'));
  it('Authorization header with raw token (no Bearer prefix)', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Authorization');
    expect(a.connector.authConfig.apiKey).toBe('{{CLICKUP_API_TOKEN}}');
  });
});
