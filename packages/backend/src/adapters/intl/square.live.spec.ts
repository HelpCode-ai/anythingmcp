import axios from 'axios';
import { randomUUID } from 'node:crypto';
import * as adapter from './square.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Square adapter:
 *
 *   1. Static: always runs. Pins the bearer token, the Square-Version header,
 *      the environment variable patterns, every tool's method and URL, the
 *      bodies of searches, refunds, orders and invoices, and which tools are
 *      read-only, destructive or switched off.
 *
 *   2. Live: skipped unless SQUARE_ACCESS_TOKEN is set. Uses the sandbox
 *      unless SQUARE_API_URL says otherwise (the token must match):
 *
 *        SQUARE_ACCESS_TOKEN=EAAA... npx jest src/adapters/intl/square.live.spec.ts
 *
 *      Reads the merchant, locations, payments, refunds, orders, customers,
 *      catalog, inventory, invoices and team members.
 *
 *      SQUARE_LIVE_WRITE=1 (sandbox only) adds three round-trips, each
 *      cleaned up in `finally`: a customer created, read, updated, found and
 *      deleted; a catalog item created, read, searched, its inventory read
 *      and deleted; an order and a draft invoice for the test customer that
 *      is published and cancelled (deleted if publishing failed). A sandbox
 *      payment of 1.00 made with Square's test card nonce is read and
 *      refunded by 0.50.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const SANDBOX = 'https://connect.squareupsandbox.com';
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: { token: env.SQUARE_ACCESS_TOKEN },
      headers: config.headers,
    },
    endpointMapping,
    applySchemaDefaults(tool(name).parameters, params),
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) =>
  execute(name, { SQUARE_API_URL: SANDBOX, SQUARE_ACCESS_TOKEN: 'test-token' }, params);
const sent = () => mockedAxios.mock.calls[0][0];

describe('square adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
    expect(a.prerequisites).toMatch(/sandbox/);
  });

  it('sends the access token as Bearer and pins a Square-Version', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SQUARE_ACCESS_TOKEN}}' });
    expect(a.connector.baseUrl).toBe('{{SQUARE_API_URL}}');
    expect(a.connector.headers['Square-Version']).toMatch(/^20\d\d-\d\d-\d\d$/);
    expect(a.connector.headers['Square-Version']).toBe('2026-09-16');
    expect(a.instructions).toContain(a.connector.headers['Square-Version']);
  });

  it('validates the environment URL and marks the token as secret', () => {
    expect(a.requiredEnvVars).toEqual(['SQUARE_ACCESS_TOKEN', 'SQUARE_API_URL']);
    const env = new RegExp(a.envVarMeta.SQUARE_API_URL.pattern!);
    expect(env.test(SANDBOX)).toBe(true);
    expect(env.test('https://connect.squareup.com')).toBe(true);
    expect(env.test(`${SANDBOX}/`)).toBe(false);
    expect(env.test('https://connect.squareup.com.evil.example')).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'SQUARE_API_URL')!.kind).toBe('address');
    expect(described.find((d) => d.name === 'SQUARE_ACCESS_TOKEN')!.secret).toBe(true);
  });

  it('probes and health-checks with the merchant behind the token', () => {
    expect(a.probe.tool).toBe('square_get_merchant');
    expect(tool('square_get_merchant').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/v2/merchants/me');
  });

  it('prefixes every tool with square_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^square_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, including the POST searches and the inventory batch read', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'square_get_catalog_object',
      'square_get_customer',
      'square_get_inventory_count',
      'square_get_inventory_counts',
      'square_get_invoice',
      'square_get_location',
      'square_get_merchant',
      'square_get_order',
      'square_get_payment',
      'square_get_refund',
      'square_get_team_member',
      'square_list_catalog',
      'square_list_customers',
      'square_list_invoices',
      'square_list_locations',
      'square_list_payments',
      'square_list_refunds',
      'square_search_catalog_items',
      'square_search_catalog_objects',
      'square_search_customers',
      'square_search_invoices',
      'square_search_orders',
      'square_search_team_members',
    ]);
  });

  it('marks refunds, cancellations and catalog replacement destructive, and installs deletes switched off', () => {
    for (const name of ['square_refund_payment', 'square_cancel_invoice', 'square_upsert_catalog_object']) {
      const ann = annotationsOf(tool(name));
      expect(`${name}:${ann.readOnlyHint}:${ann.destructiveHint}:${ann.idempotentHint}`).toBe(`${name}:false:true:false`);
      expect(tool(name).description).toMatch(/confirm/i);
    }
    expect(tool('square_publish_invoice').description).toMatch(/confirm/i);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([
      'square_delete_catalog_object',
      'square_delete_customer',
      'square_delete_invoice',
    ]);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bsquare_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bsquare_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['square_get_merchant', {}, 'GET', '/v2/merchants/me'],
    ['square_list_locations', {}, 'GET', '/v2/locations'],
    ['square_get_location', { location_id: 'main' }, 'GET', '/v2/locations/main'],
    ['square_list_payments', {}, 'GET', '/v2/payments'],
    ['square_get_payment', { payment_id: 'P1' }, 'GET', '/v2/payments/P1'],
    ['square_list_refunds', {}, 'GET', '/v2/refunds'],
    ['square_get_refund', { refund_id: 'R1' }, 'GET', '/v2/refunds/R1'],
    ['square_refund_payment', { payment_id: 'P1', amount_money: { amount: 100, currency: 'EUR' }, idempotency_key: 'k' }, 'POST', '/v2/refunds'],
    ['square_search_orders', { location_ids: ['L1'] }, 'POST', '/v2/orders/search'],
    ['square_get_order', { order_id: 'O1' }, 'GET', '/v2/orders/O1'],
    ['square_create_order', { location_id: 'L1', line_items: [], idempotency_key: 'k' }, 'POST', '/v2/orders'],
    ['square_list_customers', {}, 'GET', '/v2/customers'],
    ['square_search_customers', {}, 'POST', '/v2/customers/search'],
    ['square_get_customer', { customer_id: 'C1' }, 'GET', '/v2/customers/C1'],
    ['square_create_customer', { given_name: 'Ana' }, 'POST', '/v2/customers'],
    ['square_update_customer', { customer_id: 'C1', note: 'x' }, 'PUT', '/v2/customers/C1'],
    ['square_delete_customer', { customer_id: 'C1' }, 'DELETE', '/v2/customers/C1'],
    ['square_list_catalog', {}, 'GET', '/v2/catalog/list'],
    ['square_search_catalog_items', {}, 'POST', '/v2/catalog/search-catalog-items'],
    ['square_search_catalog_objects', {}, 'POST', '/v2/catalog/search'],
    ['square_get_catalog_object', { object_id: 'OBJ1' }, 'GET', '/v2/catalog/object/OBJ1'],
    ['square_upsert_catalog_object', { object: {}, idempotency_key: 'k' }, 'POST', '/v2/catalog/object'],
    ['square_delete_catalog_object', { object_id: 'OBJ1' }, 'DELETE', '/v2/catalog/object/OBJ1'],
    ['square_get_inventory_counts', {}, 'POST', '/v2/inventory/counts/batch-retrieve'],
    ['square_get_inventory_count', { catalog_object_id: 'V1' }, 'GET', '/v2/inventory/V1'],
    ['square_list_invoices', { location_id: 'L1' }, 'GET', '/v2/invoices'],
    ['square_search_invoices', { location_id: 'L1' }, 'POST', '/v2/invoices/search'],
    ['square_get_invoice', { invoice_id: 'inv:1' }, 'GET', '/v2/invoices/inv%3A1'],
    ['square_create_invoice', { location_id: 'L1', order_id: 'O1', customer_id: 'C1', payment_requests: [], idempotency_key: 'k' }, 'POST', '/v2/invoices'],
    ['square_publish_invoice', { invoice_id: 'inv:1', version: 0 }, 'POST', '/v2/invoices/inv%3A1/publish'],
    ['square_cancel_invoice', { invoice_id: 'inv:1', version: 1 }, 'POST', '/v2/invoices/inv%3A1/cancel'],
    ['square_delete_invoice', { invoice_id: 'inv:1' }, 'DELETE', '/v2/invoices/inv%3A1'],
    ['square_search_team_members', {}, 'POST', '/v2/team-members/search'],
    ['square_get_team_member', { team_member_id: 'T1' }, 'GET', '/v2/team-members/T1'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url: `${SANDBOX}${path}`,
        headers: expect.objectContaining({ Authorization: 'Bearer test-token', 'Square-Version': '2026-09-16' }),
      }),
    );
  });

  it('refunds with the idempotency key, payment and amount', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('square_refund_payment', { payment_id: 'P1', amount_money: { amount: 50, currency: 'EUR' }, reason: 'Damaged', idempotency_key: 'k1' });
    expect(sent().data).toEqual({ idempotency_key: 'k1', payment_id: 'P1', amount_money: { amount: 50, currency: 'EUR' }, reason: 'Damaged' });
  });

  it('wraps the order fields in an order object', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const items = [{ name: 'Repair', quantity: '1', base_price_money: { amount: 4500, currency: 'EUR' } }];
    await call('square_create_order', { location_id: 'L1', line_items: items, customer_id: 'C1', idempotency_key: 'k2' });
    expect(sent().data).toEqual({ order: { location_id: 'L1', line_items: items, customer_id: 'C1' }, idempotency_key: 'k2' });
  });

  it('builds the invoice with the recipient, card payments by default and EMAIL delivery', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const requests = [{ request_type: 'BALANCE', due_date: '2026-11-01' }];
    await call('square_create_invoice', { location_id: 'L1', order_id: 'O1', customer_id: 'C1', payment_requests: requests, title: 'Repair', idempotency_key: 'k3' });
    expect(sent().data).toEqual({
      invoice: {
        location_id: 'L1',
        order_id: 'O1',
        primary_recipient: { customer_id: 'C1' },
        payment_requests: requests,
        accepted_payment_methods: { card: true },
        delivery_method: 'EMAIL',
        title: 'Repair',
      },
      idempotency_key: 'k3',
    });
  });

  it('searches invoices of one location and, when given, one customer', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('square_search_invoices', { location_id: 'L1' });
    expect(sent().data).toEqual({ query: { filter: { location_ids: ['L1'] }, sort: { field: 'INVOICE_SORT_DATE', order: 'DESC' } } });
    mockedAxios.mockClear();
    await call('square_search_invoices', { location_id: 'L1', customer_ids: ['C1'], limit: 10 });
    expect(sent().data).toEqual({ query: { filter: { location_ids: ['L1'], customer_ids: ['C1'] }, sort: { field: 'INVOICE_SORT_DATE', order: 'DESC' } }, limit: 10 });
  });

  it('puts the team member filters in query.filter and lists ITEM by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('square_search_team_members', { status: 'ACTIVE', location_ids: ['L1'] });
    expect(sent().data).toEqual({ query: { filter: { location_ids: ['L1'], status: 'ACTIVE' } } });
    mockedAxios.mockClear();
    await call('square_list_catalog', {});
    expect(sent().params).toEqual({ types: 'ITEM' });
  });

  it('publishes with the version and deletes a customer with an optional version in the query', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('square_publish_invoice', { invoice_id: 'inv:1', version: 0, idempotency_key: 'k4' });
    expect(sent().data).toEqual({ version: 0, idempotency_key: 'k4' });
    mockedAxios.mockClear();
    await call('square_delete_customer', { customer_id: 'C1', version: 3 });
    expect(sent().params).toEqual({ version: 3 });
    expect(sent().data).toBeUndefined();
  });
});

const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('square adapter: live API', () => {
  const host = process.env.SQUARE_API_URL || SANDBOX;
  const write = process.env.SQUARE_LIVE_WRITE === '1' && host === SANDBOX;
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    execute(name, { SQUARE_API_URL: host, SQUARE_ACCESS_TOKEN: TOKEN as string }, params);
  let locationId = '';
  let currency = 'USD';

  beforeAll(async () => {
    const merchant = await run('square_get_merchant');
    locationId = merchant.merchant.main_location_id;
    currency = merchant.merchant.currency;
  }, 30_000);

  it('reads the merchant, locations, payments, refunds and orders', async () => {
    const locations = await run('square_list_locations');
    expect(locations.locations.map((l: { id: string }) => l.id)).toContain(locationId);
    const main = await run('square_get_location', { location_id: 'main' });
    expect(main.location.id).toBe(locationId);
    const payments = await run('square_list_payments', { limit: 5, location_id: locationId });
    if (payments.payments?.length) {
      const one = await run('square_get_payment', { payment_id: payments.payments[0].id });
      expect(one.payment.id).toBe(payments.payments[0].id);
    }
    const refunds = await run('square_list_refunds', { limit: 5 });
    if (refunds.refunds?.length) {
      const one = await run('square_get_refund', { refund_id: refunds.refunds[0].id });
      expect(one.refund.id).toBe(refunds.refunds[0].id);
    }
    const orders = await run('square_search_orders', { location_ids: [locationId], limit: 5 });
    if (orders.orders?.length) {
      const one = await run('square_get_order', { order_id: orders.orders[0].id });
      expect(one.order.id).toBe(orders.orders[0].id);
    }
  }, 60_000);

  it('reads customers, the catalog, inventory, invoices and team members', async () => {
    const customers = await run('square_list_customers', { limit: 5, count: true });
    if (customers.customers?.length) {
      const one = await run('square_get_customer', { customer_id: customers.customers[0].id });
      expect(one.customer.id).toBe(customers.customers[0].id);
    }
    await run('square_search_customers', { query: { filter: { created_at: { start_at: '2020-01-01T00:00:00Z' } } }, limit: 5 });
    const catalog = await run('square_list_catalog', { types: 'ITEM' });
    const items = await run('square_search_catalog_items', { limit: 5 });
    expect(items).toBeDefined();
    await run('square_search_catalog_objects', { object_types: ['ITEM'], limit: 5 });
    const firstItem = catalog.objects?.[0];
    if (firstItem) {
      const one = await run('square_get_catalog_object', { object_id: firstItem.id, include_related_objects: true });
      expect(one.object.id).toBe(firstItem.id);
      const variation = firstItem.item_data?.variations?.[0];
      if (variation) {
        await run('square_get_inventory_counts', { catalog_object_ids: [variation.id], location_ids: [locationId] });
        await run('square_get_inventory_count', { catalog_object_id: variation.id, location_ids: locationId });
      }
    }
    const invoices = await run('square_list_invoices', { location_id: locationId, limit: 5 });
    if (invoices.invoices?.length) {
      const one = await run('square_get_invoice', { invoice_id: invoices.invoices[0].id });
      expect(one.invoice.id).toBe(invoices.invoices[0].id);
    }
    await run('square_search_invoices', { location_id: locationId, limit: 5 });
    const team = await run('square_search_team_members', { status: 'ACTIVE', limit: 5 });
    if (team.team_members?.length) {
      const one = await run('square_get_team_member', { team_member_id: team.team_members[0].id });
      expect(one.team_member.id).toBe(team.team_members[0].id);
    }
  }, 60_000);

  (write ? it : it.skip)('creates, reads, updates, finds and deletes a customer; invoices them and cancels it', async () => {
    const created = await run('square_create_customer', {
      given_name: 'AnythingMCP',
      family_name: `Test ${Date.now()}`,
      email_address: 'anythingmcp-test@example.com',
      note: 'Created by the AnythingMCP live spec; safe to delete.',
      idempotency_key: randomUUID(),
    });
    const customer = created.customer;
    try {
      const read = await run('square_get_customer', { customer_id: customer.id });
      expect(read.customer.family_name).toBe(customer.family_name);
      const updated = await run('square_update_customer', { customer_id: customer.id, note: 'Updated by the live spec', version: read.customer.version });
      expect(updated.customer.note).toBe('Updated by the live spec');
      await run('square_search_customers', { query: { filter: { email_address: { exact: 'anythingmcp-test@example.com' } } } });

      const order = await run('square_create_order', {
        location_id: locationId,
        customer_id: customer.id,
        line_items: [{ name: 'AnythingMCP test line', quantity: '1', base_price_money: { amount: 100, currency } }],
        idempotency_key: randomUUID(),
      });
      const due = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
      const draft = await run('square_create_invoice', {
        location_id: locationId,
        order_id: order.order.id,
        customer_id: customer.id,
        payment_requests: [{ request_type: 'BALANCE', due_date: due }],
        title: 'AnythingMCP live spec',
        idempotency_key: randomUUID(),
      });
      let published: { id: string; version: number } | undefined;
      try {
        expect(draft.invoice.status).toBe('DRAFT');
        const res = await run('square_publish_invoice', { invoice_id: draft.invoice.id, version: draft.invoice.version, idempotency_key: randomUUID() });
        published = res.invoice;
        expect(res.invoice.status).toMatch(/UNPAID|SCHEDULED|PAYMENT_PENDING/);
      } finally {
        if (published) {
          const cancelled = await run('square_cancel_invoice', { invoice_id: published.id, version: published.version });
          expect(cancelled.invoice.status).toBe('CANCELED');
        } else {
          await run('square_delete_invoice', { invoice_id: draft.invoice.id, version: draft.invoice.version });
        }
      }
    } finally {
      await run('square_delete_customer', { customer_id: customer.id });
    }
  }, 120_000);

  (write ? it : it.skip)('creates a catalog item, reads and searches it, reads its inventory and deletes it', async () => {
    const name = `AnythingMCP test ${Date.now()}`;
    const created = await run('square_upsert_catalog_object', {
      object: {
        type: 'ITEM',
        id: '#amcp-item',
        item_data: {
          name,
          variations: [{ type: 'ITEM_VARIATION', id: '#amcp-var', item_variation_data: { item_id: '#amcp-item', name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 250, currency } } }],
        },
      },
      idempotency_key: randomUUID(),
    });
    const itemId = created.catalog_object.id;
    try {
      const read = await run('square_get_catalog_object', { object_id: itemId });
      expect(read.object.item_data.name).toBe(name);
      const variationId = read.object.item_data.variations[0].id;
      await run('square_get_inventory_count', { catalog_object_id: variationId });
      await run('square_search_catalog_objects', { object_types: ['ITEM'], query: { exact_query: { attribute_name: 'name', attribute_value: name } } });
    } finally {
      const deleted = await run('square_delete_catalog_object', { object_id: itemId });
      expect(deleted.deleted_object_ids).toContain(itemId);
    }
  }, 120_000);

  (write ? it : it.skip)('refunds part of a sandbox test payment', async () => {
    // Created directly: the connector has no tool that takes card payments.
    const payment = await mockedAxios.__actual.post(
      `${host}/v2/payments`,
      { source_id: 'cnon:card-nonce-ok', idempotency_key: randomUUID(), amount_money: { amount: 100, currency }, location_id: locationId, note: 'AnythingMCP live spec' },
      { headers: { Authorization: `Bearer ${TOKEN}`, 'Square-Version': '2026-09-16', 'Content-Type': 'application/json' } },
    );
    const paymentId = payment.data.payment.id;
    const read = await run('square_get_payment', { payment_id: paymentId });
    expect(read.payment.status).toBe('COMPLETED');
    const refund = await run('square_refund_payment', { payment_id: paymentId, amount_money: { amount: 50, currency }, reason: 'AnythingMCP live spec', idempotency_key: randomUUID() });
    expect(refund.refund.status).toMatch(/PENDING|COMPLETED/);
    const again = await run('square_get_refund', { refund_id: refund.refund.id });
    expect(again.refund.payment_id).toBe(paymentId);
  }, 120_000);
});
