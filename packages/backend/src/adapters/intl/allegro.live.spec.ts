import axios from 'axios';
import * as adapter from './allegro.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Allegro REST API adapter (developer.allegro.pl, OpenAPI at
 * https://developer.allegro.pl/swagger.yaml): base https://api.allegro.pl,
 * OAuth2 authorization code at allegro.pl/auth/oauth with the client
 * credentials in a Basic header, and the media type
 * application/vnd.allegro.public.v1+json on every request (beta.v1 for the
 * customer-returns and post-purchase-issues resources). Paths, query keys and
 * bodies below were checked against that spec.
 *
 * The live block reads only, with an access token of a signed-in seller:
 *
 *   RUN_ALLEGRO_LIVE=1 ALLEGRO_ACCESS_TOKEN=... npx jest src/adapters/intl/allegro
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
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
// Every argument a tool reads: {path} segments and "$arg" values, nested ones included.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const BASE = 'https://api.allegro.pl';
const PUBLIC = 'application/vnd.allegro.public.v1+json';
const BETA = 'application/vnd.allegro.beta.v1+json';
const TOKEN = ['tok', 'en', '0a1b2c3d4e5f'].join('');
const ENV = { ALLEGRO_CLIENT_ID: 'abcdef0123456789abcdef0123456789', ALLEGRO_CLIENT_SECRET: 'secretsecretsecretsecret' };
const tokens = { getAccessToken: jest.fn(async () => TOKEN) } as unknown as OAuth2TokenService;
const execute = (name: string, params: Record<string, unknown>, svc = tokens) =>
  new RestEngine(svc, {} as LoginTokenService).execute(
    {
      baseUrl: a.connector.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, ENV),
      headers: a.connector.headers,
    },
    tool(name).endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters, params), ...ENV },
  ) as Promise<any>;
const sent = () => mockedAxios.mock.calls[0][0];

const OFF = '12345678901';
const ORD = '29738e61-7f6a-11e8-ac45-09db60ede9d6';
const WRITES_OFF = ['allegro_change_claim_status', 'allegro_create_refund', 'allegro_delete_draft_offer', 'allegro_reject_customer_return'];

describe('allegro adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with the authorization code flow and a Basic client header, without PKCE', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{ALLEGRO_CLIENT_ID}}',
      clientSecret: '{{ALLEGRO_CLIENT_SECRET}}',
      authorizationUrl: 'https://allegro.pl/auth/oauth/authorize',
      tokenUrl: 'https://allegro.pl/auth/oauth/token',
      tokenAuthMethod: 'client_secret_basic',
      pkce: false,
    });
    expect(needsBrowserAuthorization(a as never)).toBe(true);
    expect(a.requiredEnvVars).toEqual(['ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET']);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'ALLEGRO_CLIENT_SECRET')!.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.ALLEGRO_CLIENT_ID.pattern!).test(ENV.ALLEGRO_CLIENT_ID)).toBe(true);
  });

  it('sends the Bearer token and the Allegro public media type', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('allegro_get_me', {});
    expect(sent().url).toBe(`${BASE}/me`);
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent().headers.Accept).toBe(PUBLIC);
    expect(sent().headers['Content-Type']).toBe(PUBLIC);
  });

  // [tool, args, method, path]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['allegro_get_me', {}, 'GET', '/me'],
    ['allegro_get_sales_quality', {}, 'GET', '/sale/quality'],
    ['allegro_list_offers', {}, 'GET', '/sale/offers'],
    ['allegro_get_offer', { offer_id: OFF }, 'GET', `/sale/product-offers/${OFF}`],
    ['allegro_create_offer', { offer: { name: 'x' } }, 'POST', '/sale/product-offers'],
    ['allegro_edit_offer', { offer_id: OFF, changes: { name: 'x' } }, 'PATCH', `/sale/product-offers/${OFF}`],
    ['allegro_change_offer_price', { offer_id: OFF, amount: '9.99' }, 'PATCH', `/sale/product-offers/${OFF}`],
    ['allegro_change_offer_quantity', { offer_id: OFF, available: 3 }, 'PATCH', `/sale/product-offers/${OFF}`],
    ['allegro_set_offer_status', { offer_id: OFF, status: 'ENDED' }, 'PATCH', `/sale/product-offers/${OFF}`],
    ['allegro_get_offer_operation', { offer_id: OFF, operation_id: 'op1' }, 'GET', `/sale/product-offers/${OFF}/operations/op1`],
    ['allegro_delete_draft_offer', { offer_id: OFF }, 'DELETE', `/sale/offers/${OFF}`],
    ['allegro_list_offer_events', {}, 'GET', '/sale/offer-events'],
    ['allegro_search_products', { phrase: '5901234123457' }, 'GET', '/sale/products'],
    ['allegro_get_product', { product_id: 'p1' }, 'GET', '/sale/products/p1'],
    ['allegro_list_categories', {}, 'GET', '/sale/categories'],
    ['allegro_get_category', { category_id: '257931' }, 'GET', '/sale/categories/257931'],
    ['allegro_get_category_parameters', { category_id: '257931' }, 'GET', '/sale/categories/257931/parameters'],
    ['allegro_suggest_categories', { name: 'iphone 15' }, 'GET', '/sale/matching-categories'],
    ['allegro_list_shipping_rates', {}, 'GET', '/sale/shipping-rates'],
    ['allegro_list_return_policies', {}, 'GET', '/after-sales-service-conditions/return-policies'],
    ['allegro_list_implied_warranties', {}, 'GET', '/after-sales-service-conditions/implied-warranties'],
    ['allegro_list_orders', {}, 'GET', '/order/checkout-forms'],
    ['allegro_get_order', { order_id: ORD }, 'GET', `/order/checkout-forms/${ORD}`],
    ['allegro_set_order_fulfillment_status', { order_id: ORD, status: 'SENT' }, 'PUT', `/order/checkout-forms/${ORD}/fulfillment`],
    ['allegro_list_order_shipments', { order_id: ORD }, 'GET', `/order/checkout-forms/${ORD}/shipments`],
    ['allegro_add_order_shipment', { order_id: ORD, carrier_id: 'INPOST', waybill: 'W1' }, 'POST', `/order/checkout-forms/${ORD}/shipments`],
    ['allegro_list_carriers', {}, 'GET', '/order/carriers'],
    ['allegro_get_parcel_tracking', { carrier_id: 'INPOST', waybills: ['W1'] }, 'GET', '/order/carriers/INPOST/tracking'],
    ['allegro_list_order_events', {}, 'GET', '/order/events'],
    ['allegro_list_customer_returns', {}, 'GET', '/order/customer-returns'],
    ['allegro_get_customer_return', { return_id: 'r1' }, 'GET', '/order/customer-returns/r1'],
    ['allegro_reject_customer_return', { return_id: 'r1', code: 'ITEM_FIXED' }, 'POST', '/order/customer-returns/r1/rejection'],
    ['allegro_list_refunds', {}, 'GET', '/payments/refunds'],
    ['allegro_create_refund', { payment_id: 'p', order_id: ORD, command_id: 'c', reason: 'REFUND' }, 'POST', '/payments/refunds'],
    ['allegro_list_threads', {}, 'GET', '/messaging/threads'],
    ['allegro_get_thread', { thread_id: 't1' }, 'GET', '/messaging/threads/t1'],
    ['allegro_list_thread_messages', { thread_id: 't1' }, 'GET', '/messaging/threads/t1/messages'],
    ['allegro_get_message', { message_id: 'm1' }, 'GET', '/messaging/messages/m1'],
    ['allegro_reply_in_thread', { thread_id: 't1', text: 'Hi' }, 'POST', '/messaging/threads/t1/messages'],
    ['allegro_send_message', { recipient_login: 'buyer', order_id: ORD, text: 'Hi' }, 'POST', '/messaging/messages'],
    ['allegro_mark_thread_read', { thread_id: 't1' }, 'PUT', '/messaging/threads/t1/read'],
    ['allegro_list_issues', {}, 'GET', '/sale/issues'],
    ['allegro_get_issue', { issue_id: 'i1' }, 'GET', '/sale/issues/i1'],
    ['allegro_list_issue_messages', { issue_id: 'i1' }, 'GET', '/sale/issues/i1/chat'],
    ['allegro_add_issue_message', { issue_id: 'i1', text: 'Hi' }, 'POST', '/sale/issues/i1/message'],
    ['allegro_change_claim_status', { issue_id: 'i1', status: 'ACCEPTED_REFUND', message: 'ok' }, 'POST', '/sale/issues/i1/status'],
    ['allegro_list_billing_entries', {}, 'GET', '/billing/billing-entries'],
    ['allegro_list_billing_types', {}, 'GET', '/billing/billing-types'],
    ['allegro_list_payment_operations', {}, 'GET', '/payments/payment-operations'],
    ['allegro_list_ratings', {}, 'GET', '/sale/user-ratings'],
    ['allegro_get_rating', { rating_id: 'g1' }, 'GET', '/sale/user-ratings/g1'],
    ['allegro_answer_rating', { rating_id: 'g1', message: 'Thanks' }, 'PUT', '/sale/user-ratings/g1/answer'],
    ['allegro_get_ratings_summary', { user_id: '42' }, 'GET', '/users/42/ratings-summary'],
  ];

  it('covers every tool in the table', () => {
    expect(table.map((r) => r[0]).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s calls %s %s', async (name, args, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute(name, args);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(`${BASE}${path}`);
  });

  it('uses the beta media type exactly on the returns and post-purchase issue resources', () => {
    for (const t of a.tools) {
      const beta = /^\/(order\/customer-returns|sale\/issues)/.test(t.endpointMapping.path);
      expect(`${t.name}:${t.endpointMapping.headers?.Accept ?? PUBLIC}`).toBe(`${t.name}:${beta ? BETA : PUBLIC}`);
      if (beta && t.endpointMapping.method !== 'GET') expect(t.endpointMapping.headers?.['Content-Type']).toBe(BETA);
    }
  });

  it('sends the documented bodies for price, stock, status and offer edits', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('allegro_change_offer_price', { offer_id: OFF, amount: '129.99' });
    expect(sent().data).toEqual({ sellingMode: { price: { amount: '129.99', currency: 'PLN' } } });
    mockedAxios.mockClear();
    await execute('allegro_change_offer_quantity', { offer_id: OFF, available: 0 });
    expect(sent().data).toEqual({ stock: { available: 0 } });
    mockedAxios.mockClear();
    await execute('allegro_set_offer_status', { offer_id: OFF, status: 'ACTIVE' });
    expect(sent().data).toEqual({ publication: { status: 'ACTIVE' } });
    mockedAxios.mockClear();
    await execute('allegro_edit_offer', { offer_id: OFF, changes: { name: 'Better title for this offer', delivery: { handlingTime: 'PT24H' } } });
    expect(sent().data).toEqual({ name: 'Better title for this offer', delivery: { handlingTime: 'PT24H' } });
    mockedAxios.mockClear();
    const offer = { productSet: [{ product: { id: 'p1' } }], sellingMode: { price: { amount: '9.00', currency: 'PLN' } }, stock: { available: 1 }, publication: { status: 'INACTIVE' } };
    await execute('allegro_create_offer', { offer });
    expect(sent().data).toEqual(offer);
  });

  it('sends the documented order, shipment, message, return, issue and refund bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('allegro_set_order_fulfillment_status', { order_id: ORD, status: 'SENT', revision: 'rev1' });
    expect(sent().data).toEqual({ status: 'SENT' });
    expect(sent().params).toEqual({ 'checkoutForm.revision': 'rev1' });
    mockedAxios.mockClear();
    await execute('allegro_add_order_shipment', { order_id: ORD, carrier_id: 'OTHER', carrier_name: 'Kurier', waybill: 'W1', line_items: [{ id: 'l1' }] });
    expect(sent().data).toEqual({ carrierId: 'OTHER', carrierName: 'Kurier', waybill: 'W1', lineItems: [{ id: 'l1' }] });
    mockedAxios.mockClear();
    await execute('allegro_send_message', { recipient_login: 'buyer', order_id: ORD, text: 'Hello' });
    expect(sent().data).toEqual({ recipient: { login: 'buyer' }, order: { id: ORD }, text: 'Hello' });
    mockedAxios.mockClear();
    await execute('allegro_mark_thread_read', { thread_id: 't1' });
    expect(sent().data).toEqual({ read: true });
    mockedAxios.mockClear();
    await execute('allegro_reject_customer_return', { return_id: 'r1', code: 'REFUND_REJECTED', reason: 'Used item' });
    expect(sent().data).toEqual({ rejection: { code: 'REFUND_REJECTED', reason: 'Used item' } });
    mockedAxios.mockClear();
    await execute('allegro_add_issue_message', { issue_id: 'i1', text: 'We will help' });
    expect(sent().data).toEqual({ text: 'We will help', type: 'REGULAR' });
    mockedAxios.mockClear();
    await execute('allegro_create_refund', { payment_id: 'pay', order_id: ORD, command_id: 'cmd', reason: 'REFUND', line_items: [{ id: 'l1', type: 'QUANTITY', quantity: 1 }] });
    expect(sent().data).toEqual({ payment: { id: 'pay' }, order: { id: ORD }, commandId: 'cmd', reason: 'REFUND', lineItems: [{ id: 'l1', type: 'QUANTITY', quantity: 1 }] });
  });

  it('maps list filters to the dotted query keys of the API', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('allegro_list_offers', { name: 'mug', publication_status: ['ACTIVE', 'ENDED'], external_ids: ['SKU-1'], price_from: 10 });
    expect(sent().params).toEqual({ name: 'mug', 'publication.status': ['ACTIVE', 'ENDED'], 'external.id': ['SKU-1'], 'sellingMode.price.amount.gte': 10, limit: 20 });
    mockedAxios.mockClear();
    await execute('allegro_list_orders', { status: 'READY_FOR_PROCESSING', fulfillment_status: 'NEW', bought_from: '2026-10-01T00:00:00Z' });
    expect(sent().params).toEqual({ status: 'READY_FOR_PROCESSING', 'fulfillment.status': 'NEW', 'lineItems.boughtAt.gte': '2026-10-01T00:00:00Z', limit: 25 });
    mockedAxios.mockClear();
    await execute('allegro_get_parcel_tracking', { carrier_id: 'DPD', waybills: ['A', 'B'] });
    expect(sent().params).toEqual({ waybill: ['A', 'B'] });
  });

  it('trims the order list to ids, status, items and totals, without addresses', () => {
    const raw = {
      count: 1,
      totalCount: 7,
      checkoutForms: [
        {
          id: ORD,
          status: 'READY_FOR_PROCESSING',
          buyer: { id: '1', login: 'jan', email: 'jan@example.com', phoneNumber: '+48', address: { street: 'Ulica 1' } },
          delivery: { address: { street: 'Ulica 1' }, method: { id: 'm', name: 'InPost' }, cost: { amount: '9.99', currency: 'PLN' } },
          fulfillment: { status: 'NEW' },
          lineItems: [{ id: 'l1', offer: { id: OFF, name: 'Mug' }, quantity: 1, price: { amount: '20.00', currency: 'PLN' }, boughtAt: '2026-10-01T10:00:00Z' }],
          summary: { totalToPay: { amount: '29.99', currency: 'PLN' } },
          marketplace: { id: 'allegro-pl' },
        },
      ],
    };
    const out = applyResponseTransform(raw, tool('allegro_list_orders').responseMapping as never).value as any;
    expect(out.totalCount).toBe(7);
    const o = out.checkoutForms[0];
    expect(o).toMatchObject({ id: ORD, status: 'READY_FOR_PROCESSING', buyer: { id: '1', login: 'jan' }, fulfillment: { status: 'NEW' }, marketplace: 'allegro-pl' });
    expect(o.lineItems).toEqual([{ id: 'l1', offer: { id: OFF, name: 'Mug' }, quantity: 1, price: { amount: '20.00', currency: 'PLN' }, boughtAt: '2026-10-01T10:00:00Z' }]);
    expect(JSON.stringify(out)).not.toMatch(/Ulica|jan@example|\+48/);
  });

  it('every declared parameter reaches the request, path parameters are required and encoded', async () => {
    for (const t of a.tools) {
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      if (t.endpointMapping.path.includes('{')) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('allegro_get_order', { order_id: '../me' });
    expect(sent().url).toBe(`${BASE}/order/checkout-forms/..%2Fme`);
  });

  it('marks GETs read-only, everything else a write, and installs the irreversible writes switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(WRITES_OFF);
    expect(annotationsOf(tool('allegro_delete_draft_offer')).destructiveHint).toBe(true);
    for (const name of ['allegro_reply_in_thread', 'allegro_send_message', 'allegro_answer_rating', 'allegro_create_refund', 'allegro_set_offer_status']) {
      expect(tool(name).description).toMatch(/wait for a yes/);
    }
  });

  it('probes with the profile, prefixes tools with allegro_ and shares no name with another adapter', () => {
    expect(a.probe).toEqual({ tool: 'allegro_get_me' });
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    const mine = new Set(a.tools.map((t) => t.name));
    for (const name of mine) expect(name).toMatch(/^allegro_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('names every tool in the instructions, only points at tools that exist, and writes no em dashes', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\ballegro_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\ballegro_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });
});

const LIVE = process.env.RUN_ALLEGRO_LIVE === '1' && process.env.ALLEGRO_ACCESS_TOKEN ? describe : describe.skip;

LIVE('allegro adapter: live (read-only)', () => {
  const live = { getAccessToken: jest.fn(async () => process.env.ALLEGRO_ACCESS_TOKEN) } as unknown as OAuth2TokenService;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => mockedAxios.__actual.request(cfg)));

  it('reads the account, offers, orders, categories, threads and billing types', async () => {
    const me = await execute('allegro_get_me', {}, live);
    expect(me.data).toHaveProperty('id');
    expect((await execute('allegro_list_offers', { limit: 1 }, live)).data).toHaveProperty('offers');
    expect((await execute('allegro_list_orders', { limit: 1 }, live)).data).toHaveProperty('checkoutForms');
    expect((await execute('allegro_list_categories', {}, live)).data).toHaveProperty('categories');
    expect((await execute('allegro_list_threads', { limit: 1 }, live)).data).toHaveProperty('threads');
    expect(Array.isArray((await execute('allegro_list_billing_types', {}, live)).data)).toBe(true);
  }, 60000);
});
