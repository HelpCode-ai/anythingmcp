import * as adapter from './gocardless.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; headers: Record<string, string> };
};
describe('gocardless adapter — static spec conformance', () => {
  it('api.gocardless.com base URL (live default)', () =>
    expect(a.connector.baseUrl).toBe('https://api.gocardless.com'));
  it('Bearer auth + GoCardless-Version header', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.headers['GoCardless-Version']).toBe('2015-07-06');
  });
});
