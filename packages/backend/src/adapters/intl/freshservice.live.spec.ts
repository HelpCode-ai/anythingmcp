import * as adapter from './freshservice.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { password: string } };
};
describe('freshservice adapter — static spec conformance', () => {
  it('per-tenant baseUrl with subdomain placeholder', () =>
    expect(a.connector.baseUrl).toBe('https://{{FRESHSERVICE_SUBDOMAIN}}.freshservice.com/api/v2'));
  it('Basic auth with literal password "X"', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.password).toBe('X');
  });
});
