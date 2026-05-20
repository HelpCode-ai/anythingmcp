import * as adapter from './statsig.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string };
  tools: Array<{ name: string; endpointMapping: { path: string } }>;
};
describe('statsig adapter — static spec conformance', () => {
  it('SDK base URL is api.statsig.com/v1', () => expect(a.connector.baseUrl).toBe('https://api.statsig.com/v1'));
  it('Console tools use absolute URLs to statsigapi.net (different host)', () => {
    // Use URL parsing + exact-host comparison (not substring includes) so the
    // test cannot match URLs like https://statsigapi.net.evil.example/...
    const consoleTools = a.tools.filter((t) => {
      try {
        const u = new URL(t.endpointMapping.path);
        return u.hostname === 'statsigapi.net';
      } catch {
        return false;
      }
    });
    expect(consoleTools.length).toBeGreaterThan(0);
    for (const t of consoleTools) {
      expect(t.endpointMapping.path).toMatch(/^https:\/\/statsigapi\.net\/console\/v1\//);
    }
  });
});
