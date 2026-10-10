import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as adapterJson from './baselinker.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import {
  assertNoResponseBodyError,
  describeErrorWhenProblems,
  ResponseBodyError,
} from '../../connectors/engines/response-error.util';

/**
 * Static checks and request-shape checks against a local server always run.
 * The live block runs read-only methods through the real RestEngine when a
 * token is set (mind the 100 requests per minute):
 *   BASELINKER_TOKEN=1-23-ABC npx jest src/adapters/intl/baselinker.live.spec.ts
 * BASELINKER_LIVE_WRITE=1 also adds an order whose buyer is "AnythingMCP test",
 * moves it to its own status again, and deletes it at the end.
 */

type Mapping = { method: string; path: string; bodyEncoding?: string; bodyMapping: { method: string; parameters: { __json: unknown } } };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: Record<string, boolean>;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: Mapping;
};
const a = adapterJson as unknown as {
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    config: { errorWhen: unknown };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const rules = a.connector.config.errorWhen;
const statusOf = (body: unknown): number | null => {
  try {
    assertNoResponseBodyError(body, rules);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ResponseBodyError);
    return (e as ResponseBodyError).status;
  }
};
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const OFF = ['baselinker_add_order', 'baselinker_create_package', 'baselinker_update_inventory_products_stock'];
const WRITES = [...OFF, 'baselinker_set_order_status'].sort();

describe('baselinker adapter: static spec conformance', () => {
  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('sends the token in X-BLToken', () => {
    expect(a.connector.baseUrl).toBe('https://api.baselinker.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-BLToken', apiKey: '{{BASELINKER_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['BASELINKER_TOKEN']);
  });

  it('posts every method to connector.php as method plus JSON parameters', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('baselinker_')).toBe(true);
      const m = t.endpointMapping;
      expect(`${t.name}:${m.method} ${m.path} ${m.bodyEncoding}`).toBe(`${t.name}:POST /connector.php form-urlencoded`);
      expect(Object.keys(m.bodyMapping)).toEqual(['method', 'parameters']);
      expect(m.bodyMapping.method).toMatch(/^(get|set|add|update|create)[A-Z]\w+$/);
      expect(m.bodyMapping.parameters).toHaveProperty('__json');
      const expected = t.name.replace(/^baselinker_/, '').replace(/_([a-z])/g, (_x, c: string) => c.toUpperCase());
      expect(m.bodyMapping.method.toLowerCase()).toBe(expected.toLowerCase());
    }
  });

  it('marks reads read-only and switches off the risky writes', () => {
    const writes = a.tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const t of a.tools.filter((x) => x.annotations?.readOnlyHint)) expect(t.endpointMapping.bodyMapping.method).toMatch(/^get/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    expect(tool('baselinker_set_order_status').description).toMatch(/confirm/i);
  });

  it('probes with the status list, which needs no argument', () => {
    expect(a.probe.tool).toBe('baselinker_get_order_status_list');
    expect(tool('baselinker_get_order_status_list').parameters.required).toBeUndefined();
  });

  it('has well-formed errorWhen rules that classify ERROR bodies', () => {
    expect(describeErrorWhenProblems(rules)).toEqual([]);
    expect(statusOf({ status: 'SUCCESS', orders: [] })).toBeNull();
    expect(statusOf({ status: 'ERROR', error_code: 'ERROR_BAD_TOKEN', error_message: 'Invalid user token' })).toBe(401);
    expect(statusOf({ status: 'ERROR', error_code: 'ERROR_USER_ACCOUNT_BLOCKED', error_message: 'Query limit exceeded, API blocked until 2026-10-10 12:00:00' })).toBe(429);
    expect(statusOf({ status: 'ERROR', error_code: 'ERROR_USER_ACCOUNT_BLOCKED', error_message: 'Account blocked' })).toBe(403);
    expect(statusOf({ status: 'ERROR', error_code: 'ERROR_ORDER_NOT_FOUND', error_message: 'Order not found' })).toBe(404);
    expect(statusOf({ status: 'ERROR', error_code: 'ERROR_PARSE_JSON_PARAMETERS', error_message: '' })).toBe(400);
    expect(statusOf({ status: 'ERROR', error_code: 'ERROR_UNKNOWN_METHOD', error_message: 'An unknown method has been used' })).toBe(400);
  });

  it('documents the token path, paging, the rate limit and the read-only setup', () => {
    expect(a.instructions).toContain('Account & other → My account → API');
    expect(a.instructions).toContain('100 requests per minute');
    expect(a.instructions).toMatch(/date_confirmed_from.*\+ 1/);
    expect(a.instructions).toContain('Read-only setup');
    expect(JSON.stringify(adapterJson)).not.toContain('—');
  });
});

describe('baselinker adapter: requests through the real engine', () => {
  let server: http.Server;
  let origin: string;
  let reply: unknown = { status: 'SUCCESS', orders: [] };
  const seen: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        // Base labels its JSON answers text/html.
        res.setHeader('Content-Type', 'text/html; charset=UTF-8');
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen.length = 0;
    reply = { status: 'SUCCESS', orders: [] };
  });

  const run = (name: string, params: Record<string, unknown>) =>
    engine().execute(
      { baseUrl: origin, authType: 'API_KEY', authConfig: { headerName: 'X-BLToken', apiKey: '1-23-ABC' }, headers: a.connector.headers, errorWhen: rules },
      tool(name).endpointMapping,
      params,
    );

  it('getOrders goes out as a form with the given filters as JSON, and the text/html answer is parsed', async () => {
    const res = await run('baselinker_get_orders', { date_confirmed_from: 1759276800, status_id: 7, get_unconfirmed_orders: false });
    expect(res).toEqual({ status: 'SUCCESS', orders: [] });
    const [req] = seen;
    expect(req.url).toBe('/connector.php');
    expect(req.headers['x-bltoken']).toBe('1-23-ABC');
    expect(req.headers['content-type']).toContain('application/x-www-form-urlencoded');
    const form = new URLSearchParams(req.body);
    expect(form.get('method')).toBe('getOrders');
    expect(JSON.parse(form.get('parameters')!)).toEqual({ date_confirmed_from: 1759276800, status_id: 7, get_unconfirmed_orders: false });
  });

  it('a method without arguments sends parameters {}', async () => {
    await run('baselinker_get_inventories', {});
    expect(new URLSearchParams(seen[0].body).get('parameters')).toBe('{}');
  });

  it('stock updates keep the product to warehouse map intact', async () => {
    await run('baselinker_update_inventory_products_stock', { inventory_id: 3, products: { '1234': { bl_1: 10 }, '5678': { bl_1: 0 } } });
    expect(JSON.parse(new URLSearchParams(seen[0].body).get('parameters')!)).toEqual({
      inventory_id: 3,
      products: { '1234': { bl_1: 10 }, '5678': { bl_1: 0 } },
    });
  });

  it('addOrder passes the whole order object through', async () => {
    const order = { order_status_id: 1, date_add: 1759276800, currency: 'EUR', products: [{ name: 'Mug', quantity: 1, price_brutto: 9.5 }] };
    await run('baselinker_add_order', { order });
    expect(JSON.parse(new URLSearchParams(seen[0].body).get('parameters')!)).toEqual(order);
  });

  it('an ERROR body becomes a failed call', async () => {
    reply = { status: 'ERROR', error_code: 'ERROR_BAD_TOKEN', error_message: 'Invalid user token' };
    await expect(run('baselinker_get_order_status_list', {})).rejects.toMatchObject({ status: 401 });
  });
});

const TOKEN = process.env.BASELINKER_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('baselinker adapter: live calls', () => {
  const config = () => ({
    baseUrl: a.connector.baseUrl,
    authType: 'API_KEY',
    authConfig: { headerName: 'X-BLToken', apiKey: TOKEN as string },
    headers: a.connector.headers,
    errorWhen: rules,
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(config(), tool(name).endpointMapping, params);

  let statuses: Array<{ id: number }> = [];

  it('reads statuses (the probe), sources and couriers', async () => {
    const s = await run('baselinker_get_order_status_list');
    expect(s.status).toBe('SUCCESS');
    statuses = s.statuses;
    expect((await run('baselinker_get_order_sources')).status).toBe('SUCCESS');
    expect(Array.isArray((await run('baselinker_get_couriers_list')).couriers)).toBe(true);
  }, 30000);

  it('reads recent orders and their packages', async () => {
    const res = await run('baselinker_get_orders', { date_confirmed_from: Math.floor(Date.now() / 1000) - 30 * 86400 });
    expect(Array.isArray(res.orders)).toBe(true);
    expect(res.orders.length).toBeLessThanOrEqual(100);
    if (res.orders[0]) {
      const p = await run('baselinker_get_order_packages', { order_id: res.orders[0].order_id });
      expect(Array.isArray(p.packages)).toBe(true);
    }
  }, 30000);

  it('reads catalogs, warehouses, a product page, product data and stock', async () => {
    const inv = await run('baselinker_get_inventories');
    expect(Array.isArray(inv.inventories)).toBe(true);
    expect((await run('baselinker_get_inventory_warehouses')).status).toBe('SUCCESS');
    const inventoryId = inv.inventories[0]?.inventory_id;
    if (!inventoryId) return;
    const list = await run('baselinker_get_inventory_products_list', { inventory_id: inventoryId, page: 1 });
    expect(list.status).toBe('SUCCESS');
    const ids = Object.keys(list.products ?? {}).slice(0, 2).map(Number);
    if (ids.length) {
      const data = await run('baselinker_get_inventory_products_data', { inventory_id: inventoryId, products: ids });
      expect(Object.keys(data.products)).toEqual(expect.arrayContaining(ids.map(String)));
    }
    const stock = await run('baselinker_get_inventory_products_stock', { inventory_id: inventoryId, page: 1 });
    expect(stock.status).toBe('SUCCESS');
  }, 60000);

  it('a wrong token surfaces as a 401 error, not a 200 body', async () => {
    await expect(
      engine().execute({ ...config(), authConfig: { headerName: 'X-BLToken', apiKey: '0-0-WRONG' } }, tool('baselinker_get_inventories').endpointMapping, {}),
    ).rejects.toMatchObject({ status: 401 });
  }, 30000);

  (process.env.BASELINKER_LIVE_WRITE === '1' ? it : it.skip)(
    'adds an "AnythingMCP test" order, sets its status and deletes it',
    async () => {
      const statusId = statuses[0]?.id ?? (await run('baselinker_get_order_status_list')).statuses[0].id;
      let orderId: number | undefined;
      try {
        const blank = Object.fromEntries(
          ['payment_method', 'user_comments', 'admin_comments', 'phone', 'user_login', 'delivery_method', 'delivery_company', 'delivery_address',
            'delivery_postcode', 'delivery_city', 'delivery_state', 'delivery_country_code', 'delivery_point_id', 'delivery_point_name',
            'delivery_point_address', 'delivery_point_postcode', 'delivery_point_city', 'invoice_fullname', 'invoice_company', 'invoice_nip',
            'invoice_address', 'invoice_postcode', 'invoice_city', 'invoice_state', 'invoice_country_code', 'extra_field_1', 'extra_field_2'].map((k) => [k, '']),
        );
        const added = await run('baselinker_add_order', {
          order: {
            ...blank,
            order_status_id: statusId,
            date_add: Math.floor(Date.now() / 1000),
            currency: 'EUR',
            payment_method_cod: false,
            paid: false,
            email: 'anythingmcp-test@example.com',
            delivery_fullname: 'AnythingMCP test',
            delivery_price: 0,
            want_invoice: false,
            products: [{ storage: 'db', storage_id: 0, product_id: '', variant_id: 0, name: 'AnythingMCP test item', sku: '', ean: '', price_brutto: 1, tax_rate: 0, quantity: 1, weight: 0 }],
          },
        });
        orderId = added.order_id;
        expect(orderId).toBeTruthy();
        await run('baselinker_set_order_status', { order_id: orderId, status_id: statusId });
        const got = await run('baselinker_get_orders', { order_id: orderId });
        expect(got.orders[0].delivery_fullname).toBe('AnythingMCP test');
      } finally {
        if (orderId) {
          await engine().execute(
            config(),
            { ...tool('baselinker_get_orders').endpointMapping, bodyMapping: { method: 'deleteOrders', parameters: { __json: { order_ids: [orderId] } } } },
            {},
          );
        }
      }
    },
    60000,
  );
});
