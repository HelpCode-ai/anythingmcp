import * as adapter from './bigcommerce.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string,string> };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
};
describe('bigcommerce adapter — static spec conformance', () => {
  it('store-hash templated base URL (without version suffix)', () => {
    expect(a.connector.baseUrl).toBe('https://api.bigcommerce.com/stores/{{BIGCOMMERCE_STORE_HASH}}');
  });
  it('X-Auth-Token header', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-Auth-Token');
  });
  it('paths explicitly carry /v2 or /v3 prefix', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.path.startsWith('/v2/') || t.endpointMapping.path.startsWith('/v3/')).toBe(true);
    }
  });
});
