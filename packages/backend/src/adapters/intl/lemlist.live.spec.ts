import * as adapter from './lemlist.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
};
describe('lemlist adapter — static spec conformance', () => {
  it('api.lemlist.com/api', () => expect(a.connector.baseUrl).toBe('https://api.lemlist.com/api'));
  it('BASIC_AUTH with empty username and key as password (Lemlist convention)', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('');
    expect(a.connector.authConfig.password).toBe('{{LEMLIST_API_KEY}}');
  });
});
