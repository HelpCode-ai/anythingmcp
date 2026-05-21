import * as adapter from './freshbooks.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('freshbooks adapter — static spec conformance', () => {
  it('api.freshbooks.com base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.freshbooks.com'));
  it('OAuth2 refresh-token flow', () =>
    expect(a.connector.authType).toBe('OAUTH2'));
});
