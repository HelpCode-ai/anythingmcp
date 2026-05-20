import * as adapter from './coingecko.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { headerName: string } };
};
describe('coingecko adapter — static spec conformance', () => {
  it('api.coingecko.com/api/v3 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.coingecko.com/api/v3'));
  it('demo API key sent as x-cg-demo-api-key header', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('x-cg-demo-api-key');
  });
});
