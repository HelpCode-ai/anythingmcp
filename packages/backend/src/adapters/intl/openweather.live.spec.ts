import * as adapter from './openweather.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ name: string; endpointMapping: { path: string } }>;
};
describe('openweather adapter — static spec conformance', () => {
  it('api.openweathermap.org base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.openweathermap.org'));
  it('QUERY_AUTH on appid', () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(Object.keys(a.connector.authConfig)).toContain('appid');
  });
  it('exposes the geocode tool first in the list', () =>
    expect(a.tools[0].name).toBe('openweather_geocode_city'));
  it('weather endpoints use /data/2.5/', () => {
    const weather = a.tools.filter((t) => t.endpointMapping.path.startsWith('/data/2.5/'));
    expect(weather.length).toBeGreaterThanOrEqual(4);
  });
});
