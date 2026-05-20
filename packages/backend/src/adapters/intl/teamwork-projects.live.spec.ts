import * as adapter from './teamwork-projects.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { password: string } };
};
describe('teamwork-projects adapter — static spec conformance', () => {
  it('per-tenant baseUrl with subdomain placeholder', () =>
    expect(a.connector.baseUrl).toBe('https://{{TEAMWORK_SUBDOMAIN}}.teamwork.com/projects/api/v3'));
  it('Basic auth with literal password "x"', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.password).toBe('x');
  });
});
