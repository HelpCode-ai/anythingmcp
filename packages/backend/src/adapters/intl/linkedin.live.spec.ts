import * as adapter from './linkedin.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string };
  tools: Array<{ endpointMapping: { headers?: Record<string,string> } }>;
};
describe('linkedin adapter — static spec conformance', () => {
  it('api.linkedin.com/v2', () => expect(a.connector.baseUrl).toBe('https://api.linkedin.com/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
  it('every tool pins LinkedIn-Version header', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.headers?.['LinkedIn-Version']).toBeTruthy();
    }
  });
});
