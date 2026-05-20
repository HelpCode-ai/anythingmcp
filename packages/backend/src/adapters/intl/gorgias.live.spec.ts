import * as adapter from './gorgias.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('gorgias adapter — static spec conformance', () => {
  it('per-subdomain baseUrl with placeholder', () =>
    expect(a.connector.baseUrl).toBe('https://{{GORGIAS_SUBDOMAIN}}.gorgias.com/api'));
  it('Basic auth (email + API key)', () =>
    expect(a.connector.authType).toBe('BASIC_AUTH'));
});
