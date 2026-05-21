import * as adapter from './recurly.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string,string> };
  tools: Array<{ endpointMapping: { headers?: Record<string,string> } }>;
};
describe('recurly adapter — static spec conformance', () => {
  it('v3.recurly.com', () => expect(a.connector.baseUrl).toBe('https://v3.recurly.com'));
  it('Basic auth, key as user', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('{{RECURLY_API_KEY}}');
  });
  it('every tool pins the required version Accept header', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.headers?.Accept).toBe('application/vnd.recurly.v2021-02-25');
    }
  });
});
