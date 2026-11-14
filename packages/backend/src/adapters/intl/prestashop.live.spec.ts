import axios from 'axios';
import * as adapter from './prestashop.json';
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
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

/**
 * Two layers of verification for the PrestaShop adapter:
 *
 *   1. Static — always runs. Locks in the Webservice contract: `<shop>/api`,
 *      the key as Basic username with an empty password, JSON on every call,
 *      writes as partial XML over PATCH/POST, and customer reads that never
 *      ask for the password hash.
 *
 *   2. Live — opt-in, against a real shop (the official prestashop/prestashop
 *      Docker image works: enable the Webservice, create a key):
 *        PRESTASHOP_LIVE_URL=http://localhost:8089 PRESTASHOP_LIVE_KEY=<key> \
 *          npx jest src/adapters/intl/prestashop.live.spec.ts
 *      Add PRESTASHOP_LIVE_WRITE=1 to also run the two PATCH tools; they write
 *      back the values they just read, so the shop is left as it was.
 */

type Tool = {
  name: string;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
  };
};
const a = adapter as unknown as {
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  probe: { tool: string; params?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const ENV = { PRESTASHOP_URL: 'https://shop.example.org', PRESTASHOP_WEBSERVICE_KEY: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' };
const send = async (name: string, params: Record<string, unknown>) => {
  mockedAxios.mockReset();
  mockedAxios.mockResolvedValue({ data: {}, headers: { 'content-type': 'application/json' } });
  const { config: cfg, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping as never, ENV);
  await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: cfg.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: cfg.headers } as never,
    endpointMapping,
    applySchemaDefaults(tool(name).parameters as never, params),
  );
  return mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];
};

describe('prestashop adapter: static spec conformance', () => {
  it('targets <shop>/api with the key as Basic username and an empty password', () => {
    expect(a.connector.baseUrl).toBe('{{PRESTASHOP_URL}}/api');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{PRESTASHOP_WEBSERVICE_KEY}}', password: '' });
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('health-checks the API root, which answers XML only (JSON there crashes PrestaShop 8)', () => {
    expect(a.connector.healthcheckPath).toBe('/');
    expect(a.connector.headers['Io-Format']).toBeUndefined();
  });

  it('asks for JSON on every call', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.queryParams?.output_format}`).toBe(`${t.name}:JSON`);
  });

  it('has no DELETE tool', () => {
    for (const t of a.tools) expect(t.endpointMapping.method).not.toBe('DELETE');
  });

  it('writes are partial XML bodies (the Webservice reads no JSON input)', () => {
    for (const n of [
      'prestashop_update_product_price',
      'prestashop_update_stock_quantity',
      'prestashop_change_order_state',
      'prestashop_update_product',
      'prestashop_add_product',
      'prestashop_update_product_feature_value',
      'prestashop_add_combination',
      'prestashop_set_order_tracking_number',
    ]) {
      const m = tool(n).endpointMapping;
      expect(m.headers?.['Content-Type']).toBe('application/xml');
      expect(m.bodyMapping?.__raw).toMatch(/^<prestashop><\w+>.*<\/prestashop>$/);
      expect(m.bodyEncoding).toBeUndefined();
    }
    expect(tool('prestashop_update_product_price').endpointMapping.method).toBe('PATCH');
    expect(tool('prestashop_update_stock_quantity').endpointMapping.method).toBe('PATCH');
    expect(tool('prestashop_change_order_state').endpointMapping.method).toBe('POST');
  });

  it('sendemail is 0/1: PHP reads the string "false" as true', () => {
    const p = tool('prestashop_change_order_state').parameters!.properties!.send_email as { type: string; enum: number[] };
    expect(p.type).toBe('integer');
    expect(p.enum).toEqual([0, 1]);
  });

  it('customer reads use a fixed field list without passwd or secure_key, and no raw filters', () => {
    for (const n of ['prestashop_list_customers', 'prestashop_get_customer']) {
      const q = tool(n).endpointMapping.queryParams!;
      expect(tool(n).endpointMapping.path).toBe('/customers');
      expect(q.display).toMatch(/^\[[a-z_,]+\]$/);
      expect(q.display).not.toMatch(/passwd|secure_key|reset_password/);
      expect(q.__rawquery).toBeUndefined();
      expect(q.display.includes('$')).toBe(false);
    }
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      const walk = (v: unknown) => {
        if (v && typeof v === 'object') return Object.values(v).forEach(walk);
        const s = String(v);
        if (/^\$\w+$/.test(s)) used.add(s.slice(1));
        for (const [, p] of s.matchAll(/\$\{(\w+)\}/g)) used.add(p);
      };
      walk(m.queryParams ?? {});
      walk(m.bodyMapping ?? {});
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  // Resources and fields from devdocs.prestashop-project.org/8/webservice/resources (checked 5 Nov 2026).
  it('maps the feature, attribute, brand, shipping and product write routes', async () => {
    const R = 'https://shop.example.org/api';
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['prestashop_list_product_features', {}, 'GET', '/product_features'],
      ['prestashop_list_product_feature_values', { feature_id: 7 }, 'GET', '/product_feature_values'],
      ['prestashop_get_product_feature_value', { feature_value_id: 23 }, 'GET', '/product_feature_values/23'],
      ['prestashop_list_attribute_groups', {}, 'GET', '/product_options'],
      ['prestashop_list_attribute_values', { attribute_group_id: 1 }, 'GET', '/product_option_values'],
      ['prestashop_list_brands', {}, 'GET', '/manufacturers'],
      ['prestashop_list_order_shipping', { order_id: 12 }, 'GET', '/order_carriers'],
      ['prestashop_update_product', { product_id: 5, fields_xml: '<active>1</active>' }, 'PATCH', '/products/5'],
      ['prestashop_add_product', { fields_xml: '<price>10</price>' }, 'POST', '/products'],
      ['prestashop_update_product_feature_value', { feature_value_id: 23, language_id: 1, value: 'Cotton' }, 'PATCH', '/product_feature_values/23'],
      ['prestashop_add_combination', { product_id: 5, fields_xml: '<minimal_quantity>1</minimal_quantity>' }, 'POST', '/combinations'],
      ['prestashop_set_order_tracking_number', { order_carrier_id: 9, tracking_number: '00340434' }, 'PATCH', '/order_carriers/9'],
    ];
    for (const [name, params, method, path] of cases) {
      const req = await send(name, params);
      expect(`${name}:${String(req.method).toUpperCase()} ${req.url}`).toBe(`${name}:${method} ${R}${path}`);
      expect(req.params.output_format).toBe('JSON');
    }
  });

  it('builds the list filters and the XML documents', async () => {
    expect((await send('prestashop_list_product_feature_values', { feature_id: 7, language: 1 })).params).toEqual({ output_format: 'JSON', display: 'full', 'filter[id_feature]': '[7]', limit: '50', language: 1 });
    expect((await send('prestashop_list_attribute_values', { attribute_group_id: 2 })).params).toEqual({ output_format: 'JSON', display: 'full', 'filter[id_attribute_group]': '[2]', limit: '50' });
    expect((await send('prestashop_list_order_shipping', { order_id: 12 })).params).toEqual({ output_format: 'JSON', display: 'full', 'filter[id_order]': '[12]', limit: '50' });
    const features = '<associations><product_features><product_feature><id>7</id><id_feature_value>23</id_feature_value></product_feature></product_features></associations>';
    expect((await send('prestashop_update_product', { product_id: 5, fields_xml: features })).data).toBe(`<prestashop><product><id>5</id>${features}</product></prestashop>`);
    expect((await send('prestashop_add_product', { fields_xml: '<price>10</price><name><language id="1"><![CDATA[Mug & Co]]></language></name>' })).data).toBe(
      '<prestashop><product><price>10</price><name><language id="1"><![CDATA[Mug & Co]]></language></name></product></prestashop>',
    );
    expect((await send('prestashop_update_product_feature_value', { feature_value_id: 23, language_id: 2, value: 'Baumwolle & Leinen' })).data).toBe(
      '<prestashop><product_feature_value><id>23</id><value><language id="2"><![CDATA[Baumwolle & Leinen]]></language></value></product_feature_value></prestashop>',
    );
    expect((await send('prestashop_add_combination', { product_id: 5, fields_xml: '<minimal_quantity>1</minimal_quantity>' })).data).toBe(
      '<prestashop><combination><id_product>5</id_product><minimal_quantity>1</minimal_quantity></combination></prestashop>',
    );
    expect((await send('prestashop_set_order_tracking_number', { order_carrier_id: 9, tracking_number: '00340434' })).data).toBe(
      '<prestashop><order_carrier><id>9</id><tracking_number><![CDATA[00340434]]></tracking_number></order_carrier></prestashop>',
    );
  });

  it('uploads a product image as the multipart field image, fetched from the URL', () => {
    const m = tool('prestashop_upload_product_image').endpointMapping;
    expect(m).toMatchObject({ method: 'POST', path: '/images/products/{product_id}', bodyEncoding: 'form-data', bodyMapping: { image: { __file: '$image_url' } } });
    expect(tool('prestashop_upload_product_image').parameters?.properties?.image_url).toMatchObject({ type: 'string', format: 'uri' });
  });

  it('probes with a one-row product list', () => {
    expect(a.probe).toEqual({ tool: 'prestashop_list_products', params: { limit: '1' } });
  });
});

const SHOP_URL = process.env.PRESTASHOP_LIVE_URL;
const KEY = process.env.PRESTASHOP_LIVE_KEY;
const live = SHOP_URL && KEY ? describe : describe.skip;
const liveWrite = SHOP_URL && KEY && process.env.PRESTASHOP_LIVE_WRITE === '1' ? it : it.skip;

live('prestashop adapter: live against a shop', () => {
  beforeAll(() => mockedAxios.mockImplementation((cfg: unknown) => (mockedAxios.__actual as any).request(cfg)));
  const engine = new RestEngine({} as unknown as OAuth2TokenService, {} as unknown as LoginTokenService);
  const cfg = {
    baseUrl: `${(SHOP_URL ?? '').replace(/\/+$/, '')}/api`,
    authType: 'BASIC_AUTH',
    authConfig: { username: KEY ?? '', password: '' },
    headers: a.connector.headers,
  };
  const run = (n: string, params: Record<string, unknown> = {}) =>
    engine.execute(cfg, tool(n).endpointMapping as any, params) as Promise<any>;

  let productId: number;
  let orderId: number;
  let customerId: number;

  it('health check: the API root lists the resources the key may use', async () => {
    const res = await engine.execute(cfg, { method: 'GET', path: a.connector.healthcheckPath } as any, {});
    expect(JSON.stringify(res)).toMatch(/products/);
  });

  it('list_products with display, filter, sort and limit', async () => {
    const res = await run('prestashop_list_products', {
      display: '[id,name,price,reference,active]',
      active: 1,
      sort: '[id_ASC]',
      limit: '0,2',
    });
    expect(res.products.length).toBeGreaterThan(0);
    expect(res.products.length).toBeLessThanOrEqual(2);
    productId = res.products[0].id;
    expect(res.products[0]).toHaveProperty('price');
    const byName = await run('prestashop_list_products', {
      display: '[id,name]',
      name_contains: String(res.products[0].name?.[0]?.value ?? res.products[0].name).slice(0, 5),
      language: 1,
    });
    expect(byName.products.map((p: any) => p.id)).toContain(productId);
  });

  it('get_product returns associations', async () => {
    const res = await run('prestashop_get_product', { product_id: productId, language: 1 });
    expect(res.product.id).toBe(productId);
    expect(res.product.associations).toBeDefined();
  });

  it('combinations and stock rows of the product', async () => {
    const stock = await run('prestashop_list_stock_availables', { product_id: productId });
    expect(stock.stock_availables[0]).toHaveProperty('quantity');
    const comb = await run('prestashop_list_combinations', { product_id: productId, limit: '5' });
    expect(Array.isArray(comb) || Array.isArray(comb.combinations)).toBe(true);
  });

  it('orders, one order, its history and the statuses', async () => {
    const list = await run('prestashop_list_orders', { display: '[id,reference,current_state,id_customer,date_add]', sort: '[id_DESC]', limit: '3' });
    expect(list.orders.length).toBeGreaterThan(0);
    orderId = list.orders[0].id;
    customerId = Number(list.orders[0].id_customer);
    const byDate = await run('prestashop_list_orders', { date_from: '2000-01-01', date_to: '2100-01-01', limit: '1' });
    expect(byDate.orders.length).toBe(1);
    const order = await run('prestashop_get_order', { order_id: orderId });
    expect(order.order.associations.order_rows.length).toBeGreaterThan(0);
    const hist = await run('prestashop_list_order_histories', { order_id: orderId });
    expect(hist.order_histories[0]).toHaveProperty('id_order_state');
    const states = await run('prestashop_list_order_states', { language: 1 });
    expect(states.order_states[0]).toHaveProperty('paid');
  });

  it('customers never carry the password hash', async () => {
    const one = await run('prestashop_get_customer', { customer_id: customerId });
    expect(one.customers[0].id).toBe(customerId);
    expect(one.customers[0]).not.toHaveProperty('passwd');
    const list = await run('prestashop_list_customers', { email: one.customers[0].email });
    expect(list.customers[0].id).toBe(customerId);
  });

  it('addresses, carriers, categories', async () => {
    const addr = await run('prestashop_list_addresses', { customer_id: customerId });
    expect(Array.isArray(addr) || addr.addresses[0].id_customer === String(customerId)).toBe(true);
    const carriers = await run('prestashop_list_carriers', { deleted: 0, language: 1 });
    expect(carriers.carriers[0]).toHaveProperty('name');
    const cats = await run('prestashop_list_categories', { display: '[id,name,id_parent]', parent_id: 2, language: 1 });
    expect(cats.categories.length).toBeGreaterThan(0);
  });

  liveWrite('update_product_price and update_stock_quantity write back the current values', async () => {
    const p = await run('prestashop_get_product', { product_id: productId });
    const price = Number(p.product.price);
    const after = await run('prestashop_update_product_price', { product_id: productId, price });
    expect(Number(after.product.price)).toBe(price);
    const stock = await run('prestashop_list_stock_availables', { product_id: productId, product_attribute_id: 0 });
    const row = stock.stock_availables[0];
    const res = await run('prestashop_update_stock_quantity', { stock_available_id: row.id, quantity: Number(row.quantity) });
    expect(Number(res.stock_available.quantity)).toBe(Number(row.quantity));
  });
});
