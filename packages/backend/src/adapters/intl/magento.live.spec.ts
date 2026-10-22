import * as adapter from './magento.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('magento adapter — static spec conformance', () => {
  it('per-store templated base URL ending /rest/default/V1', () => {
    expect(a.connector.baseUrl).toBe('{{MAGENTO_BASE_URL}}/rest/default/V1');
  });
  it('Bearer auth (integration admin token)', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});

describe('magento adapter: CMS pages and blocks', () => {
  const cms = (adapter as unknown as { tools: Array<{ name: string; enabled?: boolean; endpointMapping: Record<string, unknown> }> }).tools.filter((x) => x.name.includes('_cms_'));
  it('always uses the all store code, so pages are not moved to one store view', () => {
    expect(cms.length).toBe(8);
    for (const x of cms) expect(String(x.endpointMapping.path)).toMatch(/^\{\{MAGENTO_BASE_URL\}\}\/rest\/all\/V1\/cms(Page|Block)/);
  });
  it('installs the CMS writes switched off and has no delete', () => {
    for (const x of cms.filter((y) => y.endpointMapping.method !== 'GET')) {
      expect((x as { enabled?: boolean }).enabled).toBe(false);
      expect(x.endpointMapping.method).not.toBe('DELETE');
    }
  });
});
