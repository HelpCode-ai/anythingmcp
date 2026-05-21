import * as adapter from './toggl-track.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { password: string } };
};
describe('toggl-track adapter — static spec conformance', () => {
  it('api.track.toggl.com/api/v9 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.track.toggl.com/api/v9'));
  it('Basic auth with literal password "api_token"', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.password).toBe('api_token');
  });
});
