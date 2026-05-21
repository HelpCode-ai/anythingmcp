import * as adapter from './basecamp.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string; headers?: Record<string,string> } }>;
};
describe('basecamp adapter — static spec conformance', () => {
  it('account-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('https://3.basecampapi.com/{{BASECAMP_ACCOUNT_ID}}');
  });
  it('every tool sets User-Agent header (Basecamp requirement)', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.headers?.['User-Agent']).toMatch(/AnythingMCP/);
    }
  });
});
