import * as adapter from './salesloft.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
};
describe('salesloft adapter — static spec conformance', () => {
  it('api.salesloft.com/v2', () => expect(a.connector.baseUrl).toBe('https://api.salesloft.com/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
  it('all paths end with .json (Salesloft v2 convention)', () => {
    for (const t of a.tools) expect(t.endpointMapping.path.endsWith('.json')).toBe(true);
  });
});
