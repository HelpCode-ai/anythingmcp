import * as adapter from './salesflare.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { headerName: string } };
};
describe('salesflare adapter — static spec conformance', () => {
  it('api.salesflare.com base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.salesflare.com'));
  it('raw API key sent as Authorization header value', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Authorization');
  });
});
