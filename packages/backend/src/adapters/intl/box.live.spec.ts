import * as adapter from './box.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('box adapter — static spec conformance', () => {
  it('api.box.com/2.0 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.box.com/2.0'));
  it('OAuth2 refresh flow', () =>
    expect(a.connector.authType).toBe('OAUTH2'));
});
