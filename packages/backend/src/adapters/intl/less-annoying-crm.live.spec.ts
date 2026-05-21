import * as adapter from './less-annoying-crm.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string };
  tools: Array<{ endpointMapping: { method: string; path: string } }>;
};
describe('less-annoying-crm adapter — static spec conformance', () => {
  it('api.lessannoyingcrm.com base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.lessannoyingcrm.com'));
  it('every tool POSTs to root (Function-dispatch envelope)', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.endpointMapping.path).toBe('/');
    }
  });
});
