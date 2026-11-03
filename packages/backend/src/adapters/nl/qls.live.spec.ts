import * as adapter from './qls.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * QLS Fulfilment and Parcel Service API (OpenAPI v1 and v2 at
 * https://api.pakketdienstqls.nl/swagger/swagger.json and swagger-v2.json):
 * base https://api.pakketdienstqls.nl, HTTP Basic auth with the mijn.pakketdienstqls.nl
 * login, company-scoped paths, answers wrapped as { meta, errors, data, pagination }.
 * Live part (reads only: companies, brands, shipping products, shipments, stock):
 *   QLS_USERNAME=... QLS_PASSWORD=... RUN_QLS_LIVE=1 npx jest src/adapters/nl/qls
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    bodyEncoding?: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, unknown>;
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'qls_';
const C = '/companies/{company_id}';
const V2 = '/v2/companies/{company_id}';

describe('qls adapter: static spec conformance', () => {
  it('authenticates with HTTP Basic, the portal login as user and password', () => {
    expect(a.region).toBe('nl');
    expect(a.category).toBe('logistics');
    expect(a.requiredEnvVars).toEqual(['QLS_USERNAME', 'QLS_PASSWORD']);
    expect(a.connector.baseUrl).toBe('https://api.pakketdienstqls.nl');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{QLS_USERNAME}}', password: '{{QLS_PASSWORD}}' });
    expect(a.envVarMeta?.QLS_PASSWORD.secret).toBe(true);
  });

  it('scopes every path but the company list to /companies/{company_id} (v1) or /v2/companies/{company_id}', () => {
    for (const t of a.tools) {
      if (t.name === 'qls_list_companies') continue;
      expect(`${t.name}:${t.endpointMapping.path.startsWith(C) || t.endpointMapping.path.startsWith(V2)}`).toBe(`${t.name}:true`);
      expect(t.parameters?.required).toContain('company_id');
    }
  });

  it('maps the documented shipment, product and service point endpoints', () => {
    expect(tool('qls_list_companies').endpointMapping).toEqual({ method: 'GET', path: '/companies' });
    expect(tool('qls_list_brands').endpointMapping).toEqual({ method: 'GET', path: `${C}/brands` });
    expect(tool('qls_get_brand').endpointMapping.path).toBe(`${C}/brands/{brand_id}`);
    expect(tool('qls_list_shipping_products').endpointMapping).toEqual({ method: 'GET', path: `${C}/products` });
    expect(tool('qls_list_service_points').endpointMapping.path).toBe(`${C}/service-points/{country}/{postal_code}`);
    expect(tool('qls_list_product_service_points').endpointMapping.path).toBe(`${C}/products/{product_id}/service-points/{country}/{postal_code}`);
    expect(tool('qls_list_shipments').endpointMapping).toMatchObject({
      method: 'GET',
      path: `${C}/shipments`,
      queryParams: { 'filter[status]': '$status', 'filter[created >]': '$created_after', 'filter[created <]': '$created_before', 'filter[receiver_contact.postalcode]': '$receiver_postalcode', search: '$search' },
    });
    expect(tool('qls_get_shipment').endpointMapping).toEqual({ method: 'GET', path: `${C}/shipments/{shipment_id}`, queryParams: { returnShipmentLabel: '$with_label' } });
    expect(tool('qls_get_shipment_return').endpointMapping.path).toBe(`${C}/shipments/{shipment_id}/returns`);
    expect(tool('qls_create_shipment').endpointMapping).toMatchObject({ method: 'POST', path: `${V2}/shipments`, bodyMapping: { brand_id: '$brand_id', product_combination_id: '$product_combination_id', receiver_contact: '$receiver_contact' } });
    expect(tool('qls_create_shipment').parameters?.required).toEqual(['company_id', 'brand_id', 'product_combination_id', 'receiver_contact']);
  });

  it('maps fulfilment orders, products, stock, returns and purchase orders', () => {
    expect(tool('qls_list_fulfillment_orders').endpointMapping).toMatchObject({ path: `${C}/fulfillment/orders`, queryParams: { 'filter[status]': '$status', 'filter[customer_reference]': '$customer_reference' } });
    expect(tool('qls_list_fulfillment_orders').parameters?.properties?.status.enum).toEqual(['error_validation', 'concept', 'received', 'pending', 'partically_sent', 'sent']);
    expect(tool('qls_get_fulfillment_order').endpointMapping.path).toBe(`${C}/fulfillment/orders/{order_id}`);
    expect(tool('qls_create_fulfillment_order').endpointMapping).toMatchObject({ method: 'POST', path: `${C}/fulfillment/orders` });
    expect(tool('qls_update_fulfillment_order').endpointMapping).toMatchObject({ method: 'PUT', path: `${C}/fulfillment/orders/{order_id}`, bodyEncoding: 'form-urlencoded' });
    expect(tool('qls_cancel_fulfillment_order').endpointMapping).toEqual({ method: 'POST', path: `${C}/fulfillment/orders/{order_id}/cancel` });
    expect(tool('qls_list_fulfillment_products').endpointMapping).toMatchObject({ path: `${C}/fulfillment/products`, queryParams: { 'filter[ean]': '$ean', 'filter[sku]': '$sku', 'filter[amount_available <]': '$amount_available_less_than' } });
    expect(tool('qls_create_fulfillment_product').endpointMapping).toMatchObject({ method: 'POST', path: `${C}/fulfillment/products`, bodyEncoding: 'form-urlencoded' });
    expect(tool('qls_update_fulfillment_product').endpointMapping).toMatchObject({ method: 'PUT', path: `${C}/fulfillment/products/{product_id}`, bodyEncoding: 'form-urlencoded' });
    expect(tool('qls_list_stock').endpointMapping).toMatchObject({ path: `${C}/fulfillment/products/stock`, queryParams: { 'filter[product_id]': '$product_id', 'filter[greater_than_modified]': '$modified_after', page: '$page' } });
    expect(tool('qls_get_product_stock').endpointMapping.path).toBe(`${C}/fulfillment/products/{product_id}/stocks`);
    expect(tool('qls_list_backorders').endpointMapping.path).toBe(`${C}/fulfillment/products/backorders`);
    expect(tool('qls_list_returns').endpointMapping).toMatchObject({ path: `${V2}/returns`, queryParams: { 'filter[status]': '$status', 'filter[processed >]': '$processed_after' } });
    expect(tool('qls_get_return').endpointMapping.path).toBe(`${V2}/returns/{return_id}`);
    expect(tool('qls_create_return_from_order').endpointMapping).toMatchObject({ method: 'POST', path: `${V2}/returns/order/{order_id}` });
    expect(tool('qls_list_purchase_orders').endpointMapping).toMatchObject({ path: `${V2}/purchase-orders`, queryParams: { 'filter[greater_than_created]': '$created_after' } });
    expect(tool('qls_list_purchase_orders_in_transit').endpointMapping.path).toBe(`${V2}/purchase-orders/in-transit`);
    expect(tool('qls_get_purchase_order').endpointMapping.path).toBe(`${V2}/purchase-orders/{purchase_order_id}`);
    expect(tool('qls_create_purchase_order').endpointMapping).toMatchObject({ method: 'POST', path: `${V2}/purchase-orders` });
    expect(tool('qls_list_suppliers').endpointMapping.path).toBe(`${C}/suppliers`);
  });

  it('drops warehouse stock locations from order and product lists, keeping the order data', () => {
    const product = { id: 'p1', name: 'Shirt', amount_total: 4, warehouse_stocks: [{ id: 'w1', rack_number: '3' }] };
    const out = applyResponseTransform(
      { meta: { code: 200 }, data: [{ id: 'o1', status: 'sent', products: [{ id: 'l1', amount_ordered: 1, product }] }], pagination: { page: 1, nextPage: false } },
      tool('qls_list_fulfillment_orders').responseMapping as never,
    ).value as { data: Array<{ products: Array<{ product: Record<string, unknown> }> }>; pagination: unknown };
    expect(out.data[0].products[0].product).toEqual({ id: 'p1', name: 'Shirt', amount_total: 4 });
    expect(out.pagination).toEqual({ page: 1, nextPage: false });
    const list = applyResponseTransform({ data: [product] }, tool('qls_list_fulfillment_products').responseMapping as never).value;
    expect(list).toEqual({ data: [{ id: 'p1', name: 'Shirt', amount_total: 4 }] });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('marks reads read-only and writes as writes; the delete is destructive and switched off', () => {
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:false`);
      else expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
    }
    expect(tool('qls_delete_fulfillment_product').enabled).toBe(false);
    expect(tool('qls_delete_fulfillment_product').annotations?.destructiveHint).toBe(true);
    expect(tool('qls_cancel_fulfillment_order').annotations?.destructiveHint).toBe(true);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_QLS_LIVE === '1' && process.env.QLS_USERNAME && process.env.QLS_PASSWORD ? describe : describe.skip;
live('qls adapter: live (read-only)', () => {
  const auth = `Basic ${Buffer.from(`${process.env.QLS_USERNAME}:${process.env.QLS_PASSWORD}`).toString('base64')}`;
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: auth, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: unknown; pagination?: unknown };
  };
  it('reads companies, brands, shipping products, shipments, orders and stock', async () => {
    const companies = (await get('/companies')).data as Array<{ id: string }>;
    expect(companies.length).toBeGreaterThan(0);
    const c = `/companies/${companies[0].id}`;
    expect(Array.isArray((await get(`${c}/brands`)).data)).toBe(true);
    expect(Array.isArray((await get(`${c}/products`)).data)).toBe(true);
    expect(Array.isArray((await get(`${c}/shipments`)).data)).toBe(true);
    expect(Array.isArray((await get(`${c}/fulfillment/orders`)).data)).toBe(true);
    expect(Array.isArray((await get(`${c}/fulfillment/products/stock?page=1`)).data)).toBe(true);
    expect((await get(`/v2/companies/${companies[0].id}/returns?page=1`)).data).toBeDefined();
  }, 60_000);
});
