import * as adapter from './dropbox.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('dropbox adapter — static spec conformance', () => {
  it('api.dropboxapi.com/2 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.dropboxapi.com/2'));
  it('OAuth2 refresh flow', () =>
    expect(a.connector.authType).toBe('OAUTH2'));
});
