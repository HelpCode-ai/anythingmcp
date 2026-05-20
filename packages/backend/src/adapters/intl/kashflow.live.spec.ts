import * as adapter from './kashflow.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string };
  tools: Array<{ endpointMapping: { path: string } }>;
};
describe('kashflow adapter — static spec conformance', () => {
  it('securedwebapp.com/api/v2 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://securedwebapp.com/api/v2'));
  it('every tool embeds username + password in the path', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.path).toContain('{KASHFLOW_USERNAME}');
      expect(t.endpointMapping.path).toContain('{KASHFLOW_PASSWORD}');
    }
  });
});
