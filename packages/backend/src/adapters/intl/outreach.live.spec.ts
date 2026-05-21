import * as adapter from './outreach.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
};
describe('outreach adapter — static spec conformance', () => {
  it('api.outreach.io/api/v2', () => expect(a.connector.baseUrl).toBe('https://api.outreach.io/api/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
  it('update uses PATCH (JSON:API convention)', () => {
    const t = a.tools.find((x) => x.name === 'outreach_update_prospect')!;
    expect(t.endpointMapping.method).toBe('PATCH');
  });
});
