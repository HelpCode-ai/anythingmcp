import * as adapter from './insightly.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('insightly adapter — static spec conformance', () => {
  it('pod-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('https://api.{{INSIGHTLY_POD}}.insightly.com/v3.1');
  });
  it('Basic auth with key as user', () => {
    expect(a.connector.authConfig.username).toBe('{{INSIGHTLY_API_KEY}}');
    expect(a.connector.authConfig.password).toBe('');
  });
});
