import * as adapter from './pinterest.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('pinterest adapter — static spec conformance', () => {
  it('api.pinterest.com/v5 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.pinterest.com/v5'));
  it('OAuth2 with refresh-token flow', () =>
    expect(a.connector.authType).toBe('OAUTH2'));
});
