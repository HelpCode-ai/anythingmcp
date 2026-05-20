import * as adapter from './crisp.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string,string> };
  tools: Array<{ endpointMapping: { headers?: Record<string,string> } }>;
};
describe('crisp adapter — static spec conformance', () => {
  it('website-id baked into baseUrl', () => {
    expect(a.connector.baseUrl).toBe('https://api.crisp.chat/v1/website/{{CRISP_WEBSITE_ID}}');
  });
  it('Basic auth with plugin identifier+key', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('{{CRISP_PLUGIN_IDENTIFIER}}');
    expect(a.connector.authConfig.password).toBe('{{CRISP_PLUGIN_KEY}}');
  });
  it('every tool sends X-Crisp-Tier: plugin', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.headers?.['X-Crisp-Tier']).toBe('plugin');
    }
  });
});
