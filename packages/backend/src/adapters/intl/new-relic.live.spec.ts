import * as adapter from './new-relic.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { headerName: string } };
};
describe('new-relic adapter — static spec conformance', () => {
  it('api.newrelic.com base URL (US default)', () =>
    expect(a.connector.baseUrl).toBe('https://api.newrelic.com'));
  it('Api-Key header auth', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Api-Key');
  });
});
