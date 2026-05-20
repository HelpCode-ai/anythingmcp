import * as adapter from './nutshell-crm.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('nutshell-crm adapter — static spec conformance', () => {
  it('app.nutshell.com/api/v1 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://app.nutshell.com/api/v1'));
  it('Basic auth (email + API key)', () =>
    expect(a.connector.authType).toBe('BASIC_AUTH'));
});
