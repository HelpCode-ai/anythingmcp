import * as adapter from './omnisend.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { headerName: string } };
};
describe('omnisend adapter — static spec conformance', () => {
  it('api.omnisend.com/v3 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.omnisend.com/v3'));
  it('X-API-KEY header auth', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-API-KEY');
  });
});
