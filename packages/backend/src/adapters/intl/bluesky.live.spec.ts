import * as adapter from './bluesky.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string };
  tools: Array<{ name: string; endpointMapping: { path: string } }>;
};
describe('bluesky adapter — static spec conformance', () => {
  it('bsky.social base URL', () => expect(a.connector.baseUrl).toBe('https://bsky.social'));
  it('uses XRPC path namespace for every tool', () => {
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/xrpc\//);
  });
  it('exposes session create + refresh', () => {
    const names = a.tools.map((t) => t.name);
    expect(names).toContain('bluesky_create_session');
    expect(names).toContain('bluesky_refresh_session');
  });
});
