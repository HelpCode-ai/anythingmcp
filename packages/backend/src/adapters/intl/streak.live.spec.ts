import * as adapter from './streak.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { password: string } };
};
describe('streak adapter — static spec conformance', () => {
  it('api.streak.com/api base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.streak.com/api'));
  it('Basic auth with empty password (API key as username)', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.password).toBe('');
  });
});
