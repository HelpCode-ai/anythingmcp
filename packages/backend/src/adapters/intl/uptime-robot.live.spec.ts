import * as adapter from './uptime-robot.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ endpointMapping: { method: string } }>;
};
describe('uptime-robot adapter — static spec conformance', () => {
  it('api.uptimerobot.com/v2 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.uptimerobot.com/v2'));
  it('QUERY_AUTH injects api_key + format=json on every request', () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(Object.keys(a.connector.authConfig)).toContain('api_key');
    expect(a.connector.authConfig.format).toBe('json');
  });
  it('every tool POSTs', () => {
    for (const t of a.tools) expect(t.endpointMapping.method).toBe('POST');
  });
});
