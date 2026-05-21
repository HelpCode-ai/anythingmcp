import * as adapter from './copper.json';

const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: any };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
};

describe('copper adapter — static spec conformance', () => {
  it('uses api.copper.com/developer_api/v1', () => {
    expect(a.connector.baseUrl).toBe('https://api.copper.com/developer_api/v1');
  });
  it('uses X-PW-AccessToken header + extraHeaders for X-PW-Application and X-PW-UserEmail', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-PW-AccessToken');
    expect(a.connector.authConfig.extraHeaders['X-PW-Application']).toBe('developer_api');
    expect(a.connector.authConfig.extraHeaders['X-PW-UserEmail']).toBe('{{COPPER_USER_EMAIL}}');
  });
  it('search uses POST (Copper-specific — read via POST)', () => {
    const t = a.tools.find((x) => x.name === 'copper_search_people')!;
    expect(t.endpointMapping.method).toBe('POST');
    expect(t.endpointMapping.path).toBe('/people/search');
  });
});
