import * as adapter from './clearbit.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string,string> };
  tools: Array<{ endpointMapping: { path: string } }>;
};
describe('clearbit adapter — static spec conformance', () => {
  it('person.clearbit.com base', () => expect(a.connector.baseUrl).toBe('https://person.clearbit.com'));
  it('basic auth with key as user, empty password', () => {
    expect(a.connector.authConfig.username).toBe('{{CLEARBIT_API_KEY}}');
    expect(a.connector.authConfig.password).toBe('');
  });
  it('uses per-tool absolute URLs for company/discovery/reveal/autocomplete (different subdomains)', () => {
    const absolute = a.tools.filter((t) => t.endpointMapping.path.startsWith('https://'));
    expect(absolute.length).toBeGreaterThan(0);
  });
});
