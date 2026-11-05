import axios from 'axios';
import * as adapter from './magento.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return { __esModule: true, default: Object.assign(mocked, actual.default, { __actual: actual.default }), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;
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

// Routes and bodies from Adobe's admin OpenAPI schema (AdobeDocs/commerce-webapi, admin-schema-2.4.8.yaml, 5 Nov 2026).
describe('magento adapter: carts, promotions, special prices, credit memos, attributes and sources', () => {
  const ENV = { MAGENTO_BASE_URL: 'https://shop.example.org', MAGENTO_ACCESS_TOKEN: 'tok123' };
  const conn = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers?: Record<string, string> } };
  const send = async (name: string, params: Record<string, unknown>) => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    const { config: cfg, endpointMapping } = interpolateConnectorConfig({ baseUrl: conn.connector.baseUrl, headers: conn.connector.headers }, mt(name).endpointMapping as never, ENV);
    await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      { baseUrl: cfg.baseUrl, authType: conn.connector.authType, authConfig: interpolateDeep(conn.connector.authConfig, ENV), headers: cfg.headers } as never,
      endpointMapping,
      applySchemaDefaults(mt(name).parameters as never, params),
    );
    return mockedAxios.mock.calls[0][0];
  };
  const V1 = 'https://shop.example.org/rest/default/V1';

  it('points the docs link at developer.adobe.com', () => {
    expect((adapter as unknown as { docsUrl: string }).docsUrl).toBe('https://developer.adobe.com/commerce/webapi/rest/');
  });

  it('maps every new tool to its documented route', async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['magento_update_product_in_scope', { sku: 'MUG-1', product: { name: 'Mug' } }, 'PUT', 'https://shop.example.org/rest/all/V1/products/MUG-1'],
      ['magento_find_carts', {}, 'GET', `${V1}/carts/search`],
      ['magento_find_cart_price_rules', {}, 'GET', `${V1}/salesRules/search`],
      ['magento_get_cart_price_rule', { ruleId: 7 }, 'GET', `${V1}/salesRules/7`],
      ['magento_find_coupons', {}, 'GET', `${V1}/coupons/search`],
      ['magento_get_special_prices', { skus: ['MUG-1'] }, 'POST', `${V1}/products/special-price-information`],
      ['magento_list_credit_memos', {}, 'GET', `${V1}/creditmemos`],
      ['magento_get_credit_memo', { creditmemoId: 3 }, 'GET', `${V1}/creditmemo/3`],
      ['magento_list_attribute_options', { attributeCode: 'color' }, 'GET', `${V1}/products/attributes/color/options`],
      ['magento_list_source_items', {}, 'GET', `${V1}/inventory/source-items`],
      ['magento_create_cart_price_rule', { rule: { name: 'x' } }, 'POST', `${V1}/salesRules`],
      ['magento_update_cart_price_rule', { ruleId: 7, rule: { rule_id: 7 } }, 'PUT', `${V1}/salesRules/7`],
      ['magento_add_coupon_code', { rule_id: 7, code: 'AUTUMN' }, 'POST', `${V1}/coupons`],
      ['magento_generate_coupon_codes', { rule_id: 7, quantity: 5 }, 'POST', `${V1}/coupons/generate`],
      ['magento_schedule_special_prices', { prices: [] }, 'POST', `${V1}/products/special-price`],
      ['magento_add_attribute_option', { attributeCode: 'color', label: 'Red' }, 'POST', `${V1}/products/attributes/color/options`],
      ['magento_set_source_items', { sourceItems: [] }, 'POST', `${V1}/inventory/source-items`],
    ];
    for (const [name, params, method, url] of cases) {
      const req = await send(name, params);
      expect(`${name}:${req.method} ${req.url}`).toBe(`${name}:${method} ${url}`);
      expect(req.headers.Authorization).toBe('Bearer tok123');
    }
  });

  it('writes a product in the global scope by default, or in the store view given', async () => {
    expect((await send('magento_update_product_in_scope', { sku: 'MUG-1', product: { price: 9 } })).data).toEqual({ product: { price: 9 } });
    expect((await send('magento_update_product_in_scope', { storeCode: 'de', sku: 'MUG-1', product: { name: 'Tasse' } })).url).toBe('https://shop.example.org/rest/de/V1/products/MUG-1');
  });

  it('turns the generic filters into search criteria and leaves out the ones not given', async () => {
    const req = await send('magento_find_carts', { filter1_field: 'is_active', filter1_value: '1', filter2_field: 'items_count', filter2_value: '0', filter2_condition: 'gt', fields: 'items[id,items_count],total_count' });
    expect(req.params).toEqual({
      'searchCriteria[filter_groups][0][filters][0][field]': 'is_active',
      'searchCriteria[filter_groups][0][filters][0][value]': '1',
      'searchCriteria[filter_groups][1][filters][0][field]': 'items_count',
      'searchCriteria[filter_groups][1][filters][0][value]': '0',
      'searchCriteria[filter_groups][1][filters][0][condition_type]': 'gt',
      fields: 'items[id,items_count],total_count',
      'searchCriteria[pageSize]': 20,
      'searchCriteria[currentPage]': 1,
    });
    expect((await send('magento_find_coupons', {})).params).toEqual({ 'searchCriteria[pageSize]': 20, 'searchCriteria[currentPage]': 1 });
  });

  it('builds the documented bodies', async () => {
    expect((await send('magento_add_coupon_code', { rule_id: 7, code: 'AUTUMN', usage_limit: 100 })).data).toEqual({ coupon: { rule_id: 7, code: 'AUTUMN', usage_limit: 100, times_used: 0, is_primary: false } });
    expect((await send('magento_generate_coupon_codes', { rule_id: 7, quantity: 5, prefix: 'X-' })).data).toEqual({ couponSpec: { rule_id: 7, quantity: 5, length: 12, format: 'alphanum', prefix: 'X-' } });
    const prices = [{ sku: 'MUG-1', price: 9.9, store_id: 0, price_from: '2026-11-20 00:00:00', price_to: '2026-11-30 23:59:59' }];
    expect((await send('magento_schedule_special_prices', { prices })).data).toEqual({ prices });
    expect((await send('magento_get_special_prices', { skus: ['MUG-1'] })).data).toEqual({ skus: ['MUG-1'] });
    expect((await send('magento_add_attribute_option', { attributeCode: 'color', label: 'Red', store_labels: [{ store_id: 2, label: 'Rot' }] })).data).toEqual({ option: { label: 'Red', value: '', store_labels: [{ store_id: 2, label: 'Rot' }] } });
    const items = [{ sku: 'MUG-1', source_code: 'default', quantity: 25, status: 1 }];
    expect((await send('magento_set_source_items', { sourceItems: items })).data).toEqual({ sourceItems: items });
    expect((await send('magento_create_cart_price_rule', { rule: { name: 'Autumn' } })).data).toEqual({ rule: { name: 'Autumn' } });
  });

  it('POST reads are read-only, writes are annotated and ask for confirmation, refunds are not offered', () => {
    expect(mt('magento_get_special_prices').annotations?.readOnlyHint).toBe(true);
    for (const n of ['magento_update_product_in_scope', 'magento_create_cart_price_rule', 'magento_update_cart_price_rule', 'magento_add_coupon_code', 'magento_generate_coupon_codes', 'magento_schedule_special_prices', 'magento_add_attribute_option', 'magento_set_source_items']) {
      expect(mt(n).annotations?.readOnlyHint).toBe(false);
      expect(`${n}:${/confirm/.test((mt(n) as unknown as { description: string }).description)}`).toBe(`${n}:true`);
    }
    for (const t of m.tools) {
      expect(t.endpointMapping.path).not.toMatch(/refund/);
      expect(t.endpointMapping.path).not.toMatch(/creditmemo$/);
    }
  });
});
