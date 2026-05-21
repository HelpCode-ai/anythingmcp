import * as adapter from './dropbox-sign.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('dropbox-sign adapter — static spec conformance', () => {
  it('api.hellosign.com/v3 (legacy hellosign domain still authoritative)', () =>
    expect(a.connector.baseUrl).toBe('https://api.hellosign.com/v3'));
  it('Basic auth with key as user, empty password', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('{{DROPBOX_SIGN_API_KEY}}');
    expect(a.connector.authConfig.password).toBe('');
  });
});
