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

type MTool = { name: string; enabled?: boolean; parameters: { properties?: Record<string, unknown>; required?: string[] }; endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> }; annotations?: { readOnlyHint?: boolean } };
const m = adapter as unknown as { instructions: string; tools: MTool[] };
const mt = (n: string) => m.tools.find((x) => x.name === n)!;

describe('magento adapter: low stock and guest checkout', () => {
  const G = '{{MAGENTO_BASE_URL}}/rest/{storeCode}/V1/guest-carts';
  it('lists low-stock items with the required threshold and scope', () => {
    expect(mt('magento_list_low_stock_items').endpointMapping).toEqual({
      method: 'GET',
      path: '/stockItems/lowStock/',
      queryParams: { qty: '$qty', scopeId: '$scopeId', pageSize: '$pageSize', currentPage: '$currentPage' },
    });
    expect(mt('magento_list_low_stock_items').parameters.required).toEqual(['qty', 'scopeId']);
  });

  it('maps the guest cart flow to the documented guest-carts routes in the chosen store view', () => {
    expect(mt('magento_create_guest_cart').endpointMapping).toEqual({ method: 'POST', path: G });
    expect(mt('magento_add_guest_cart_item').endpointMapping).toEqual({
      method: 'POST',
      path: `${G}/{cartId}/items`,
      bodyMapping: { cartItem: { sku: '$sku', qty: '$qty', quote_id: '$cartId', product_option: '$product_option' } },
    });
    expect(mt('magento_apply_guest_cart_coupon').endpointMapping).toMatchObject({ method: 'PUT', path: `${G}/{cartId}/coupons/{couponCode}` });
    expect(mt('magento_estimate_guest_cart_shipping').endpointMapping).toEqual({ method: 'POST', path: `${G}/{cartId}/estimate-shipping-methods`, bodyMapping: { address: '$address' } });
    expect(mt('magento_set_guest_cart_shipping').endpointMapping).toEqual({ method: 'POST', path: `${G}/{cartId}/shipping-information`, bodyMapping: { addressInformation: '$addressInformation' } });
    expect(mt('magento_place_guest_order').endpointMapping).toEqual({
      method: 'POST',
      path: `${G}/{cartId}/payment-information`,
      bodyMapping: { email: '$email', paymentMethod: '$paymentMethod', billingAddress: '$billingAddress' },
    });
    for (const n of ['magento_get_guest_cart', 'magento_get_guest_cart_totals', 'magento_list_guest_cart_payment_methods']) expect(mt(n).endpointMapping.method).toBe('GET');
    expect(mt('magento_estimate_guest_cart_shipping').annotations?.readOnlyHint).toBe(true);
  });

  it('installs every cart write and the order placement switched off; reads stay on', () => {
    const cart = m.tools.filter((t) => t.endpointMapping.path.includes('/guest-carts'));
    expect(cart.length).toBe(9);
    for (const t of cart) {
      const write = t.endpointMapping.method !== 'GET' && t.annotations?.readOnlyHint !== true;
      expect(`${t.name}:${t.enabled === false}`).toBe(`${t.name}:${write}`);
      if (write) expect(t.annotations?.readOnlyHint).toBe(false);
    }
  });

  it('every declared parameter reaches the request, path parameters are required, every tool is in the instructions', () => {
    for (const t of m.tools) {
      const used = new Set<string>();
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) {
        used.add(p);
        expect(`${t.name}:${p}:${(t.parameters.required ?? []).includes(p)}`).toBe(`${t.name}:${p}:true`);
      }
      const walk = (v: unknown): void => {
        if (typeof v === 'string' && v.startsWith('$')) used.add(v.slice(1));
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(t.endpointMapping.queryParams);
      walk(t.endpointMapping.bodyMapping);
      for (const p of Object.keys(t.parameters.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
      expect(`${t.name}:${m.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/\u2014/);
  });
});
