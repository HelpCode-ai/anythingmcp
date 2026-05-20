import * as adapter from './bamboohr.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { password: string } };
  tools: Array<{ endpointMapping: { path: string } }>;
};
describe('bamboohr adapter — static spec conformance', () => {
  it('api.bamboohr.com/api/gateway.php base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.bamboohr.com/api/gateway.php'));
  it('Basic auth with literal password "x"', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.password).toBe('x');
  });
  it('every tool path embeds the subdomain placeholder', () => {
    for (const t of a.tools) expect(t.endpointMapping.path).toContain('{BAMBOOHR_SUBDOMAIN}');
  });
});
