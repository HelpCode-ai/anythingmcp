import * as adapter from './apollo.json';

const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
};

describe('apollo adapter — static spec conformance', () => {
  it('api.apollo.io/v1', () => expect(a.connector.baseUrl).toBe('https://api.apollo.io/v1'));
  it('X-Api-Key header', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-Api-Key');
  });
  it('people search uses POST /mixed_people/search', () => {
    const t = a.tools.find((x) => x.name === 'apollo_search_people')!;
    expect(t.endpointMapping.method).toBe('POST');
    expect(t.endpointMapping.path).toBe('/mixed_people/search');
  });
});
