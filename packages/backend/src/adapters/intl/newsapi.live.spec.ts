import * as adapter from './newsapi.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { headerName: string } };
};
describe('newsapi adapter — static spec conformance', () => {
  it('newsapi.org/v2 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://newsapi.org/v2'));
  it('X-Api-Key header auth', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-Api-Key');
  });
});
