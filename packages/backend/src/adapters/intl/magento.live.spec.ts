import * as adapter from './magento.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('magento adapter — static spec conformance', () => {
  it('per-store templated base URL ending /rest/default/V1', () => {
    expect(a.connector.baseUrl).toBe('{{MAGENTO_BASE_URL}}/rest/default/V1');
  });
  it('Bearer auth (integration admin token)', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
