import * as adapter from './mollie.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('mollie adapter — static spec conformance', () => {
  it('api.mollie.com/v2', () => expect(a.connector.baseUrl).toBe('https://api.mollie.com/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});

const byName = (name: string) => {
  const found = (adapter as unknown as { tools: Array<{ name: string; parameters: { required?: string[] }; endpointMapping: Record<string, unknown> }> }).tools.find((x) => x.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

describe('mollie adapter: payment links', () => {
  const t = (name: string) => byName(name);
  it('lists, reads and creates payment links on /payment-links', () => {
    expect(t('mollie_list_payment_links').endpointMapping).toMatchObject({ method: 'GET', path: '/payment-links' });
    expect(t('mollie_get_payment_link').endpointMapping).toMatchObject({ method: 'GET', path: '/payment-links/{paymentLinkId}' });
    expect(t('mollie_list_payment_link_payments').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/payment-links/{paymentLinkId}/payments',
    });
    expect(t('mollie_create_payment_link').endpointMapping).toMatchObject({ method: 'POST', path: '/payment-links' });
  });
});
