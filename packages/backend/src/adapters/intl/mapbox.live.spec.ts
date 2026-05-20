import * as adapter from './mapbox.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
};
describe('mapbox adapter — static spec conformance', () => {
  it('api.mapbox.com', () => expect(a.connector.baseUrl).toBe('https://api.mapbox.com'));
  it('QUERY_AUTH with access_token', () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig.access_token).toBe('{{MAPBOX_ACCESS_TOKEN}}');
  });
});
