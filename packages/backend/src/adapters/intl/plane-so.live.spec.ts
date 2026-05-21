import * as adapter from './plane-so.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { headerName: string } };
};
describe('plane-so adapter — static spec conformance', () => {
  it('api.plane.so/api/v1 base URL (cloud default)', () =>
    expect(a.connector.baseUrl).toBe('https://api.plane.so/api/v1'));
  it('X-API-Key header auth', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-API-Key');
  });
});
