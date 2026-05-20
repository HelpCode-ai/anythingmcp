import * as adapter from './statsig.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string };
  tools: Array<{ name: string; endpointMapping: { path: string } }>;
};
describe('statsig adapter — static spec conformance', () => {
  it('SDK base URL is api.statsig.com/v1', () => expect(a.connector.baseUrl).toBe('https://api.statsig.com/v1'));
  it('Console tools use absolute URLs to statsigapi.net (different host)', () => {
    const consoleTools = a.tools.filter((t) => t.endpointMapping.path.startsWith('https://statsigapi.net'));
    expect(consoleTools.length).toBeGreaterThan(0);
    for (const t of consoleTools) {
      expect(t.endpointMapping.path).toMatch(/^https:\/\/statsigapi\.net\/console\/v1\//);
    }
  });
});
