import * as adapter from './nominatim.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string; headers?: Record<string,string> } }>;
};
describe('nominatim adapter — static spec conformance', () => {
  it('nominatim.openstreetmap.org', () => expect(a.connector.baseUrl).toBe('https://nominatim.openstreetmap.org'));
  it('NONE auth (public, no key)', () => expect(a.connector.authType).toBe('NONE'));
  it('every tool pins User-Agent (Nominatim policy requirement)', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.headers?.['User-Agent']).toMatch(/AnythingMCP/);
    }
  });
});
