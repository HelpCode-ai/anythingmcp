import * as adapter from './clockify.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { headerName: string } };
};
describe('clockify adapter — static spec conformance', () => {
  it('api.clockify.me/api/v1 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.clockify.me/api/v1'));
  it('X-Api-Key auth header', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-Api-Key');
  });
});
