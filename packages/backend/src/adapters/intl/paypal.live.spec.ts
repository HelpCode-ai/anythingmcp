import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './paypal.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the PayPal adapter:
 *
 *   1. Static: always runs. Pins the client-credentials token request (HTTP
 *      Basic at PAYPAL_API_URL/v1/oauth2/token), the environment variable
 *      patterns, every tool's method and URL, the bodies and headers of the
 *      money-moving calls, and which tools are read-only or destructive.
 *
 *   2. Live: skipped unless PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set.
 *      Uses the sandbox unless PAYPAL_API_URL says otherwise:
 *
 *        PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
 *          npx jest src/adapters/intl/paypal.live.spec.ts
 *
 *      Reads products, plans, subscriptions, invoices, the transaction
 *      history, balances and disputes. Optional ids read what cannot be
 *      created without a buyer: PAYPAL_CAPTURE_ID, PAYPAL_AUTHORIZATION_ID,
 *      PAYPAL_PAYOUT_BATCH_ID.
 *
 *      PAYPAL_LIVE_WRITE=1 (sandbox only) adds: an order that is created,
 *      read and refused at capture (no buyer approved it); a draft invoice
 *      that is read, found by search, sent, reminded and cancelled (deleted
 *      instead if sending failed). With PAYPAL_CAPTURE_ID it also refunds
 *      0.01 of that capture; with PAYPAL_CANCEL_SUBSCRIPTION_ID it cancels
 *      that sandbox subscription.
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
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios; post: jest.Mock };

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
  probe: { tool: string; params?: Record<string, unknown> };
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

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const ENV = { PAYPAL_API_URL: SANDBOX, PAYPAL_CLIENT_ID: 'client-id', PAYPAL_CLIENT_SECRET: 'client-secret' };
const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
// Resolves {{VAR}} the way DynamicMcpTools does before the engine runs.
const resolved = (name: string, env: Record<string, string> = ENV) =>
  interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping, env);
const call = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = resolved(name);
  return newEngine().execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: { ...a.connector.authConfig }, headers: config.headers },
    endpointMapping,
    applySchemaDefaults(tool(name).parameters, params),
  );
};
const sent = () => mockedAxios.mock.calls[0][0];

describe('paypal adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
    expect(a.prerequisites).toMatch(/sandbox/);
  });

  it('gets its token with the client-credentials grant at the chosen environment', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{PAYPAL_CLIENT_ID}}',
      clientSecret: '{{PAYPAL_CLIENT_SECRET}}',
      tokenUrl: '{{PAYPAL_API_URL}}/v1/oauth2/token',
      tokenAuthMethod: 'client_secret_basic',
    });
    // No browser sign-in: nothing to authorize.
    expect(a.connector.authConfig.authorizationUrl).toBeUndefined();
    expect(a.connector.baseUrl).toBe('{{PAYPAL_API_URL}}');
  });

  it('sends client id and secret as HTTP Basic and grant_type=client_credentials in the body', async () => {
    const service = new OAuth2TokenService(
      {} as PrismaService,
      { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService,
    );
    const post = jest.spyOn(mockedAxios, 'post').mockResolvedValue({ data: { access_token: 'A21AA', expires_in: 32400 } });
    const authConfig = interpolateDeep({ ...a.connector.authConfig }, ENV);
    await expect(service.getAccessToken(authConfig)).resolves.toBe('A21AA');
    const [url, body, options] = post.mock.calls[0] as [string, string, { headers: Record<string, string> }];
    expect(url).toBe(`${SANDBOX}/v1/oauth2/token`);
    expect(body).toBe('grant_type=client_credentials');
    expect(options.headers.Authorization).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
    post.mockRestore();
  });

  it('validates the environment URL and marks the secret as secret', () => {
    expect(a.requiredEnvVars).toEqual(['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_API_URL']);
    const env = new RegExp(a.envVarMeta.PAYPAL_API_URL.pattern!);
    expect(env.test(SANDBOX)).toBe(true);
    expect(env.test('https://api-m.paypal.com')).toBe(true);
    expect(env.test('https://api.paypal.com')).toBe(false);
    expect(env.test(`${SANDBOX}/`)).toBe(false);
    expect(env.test('https://api-m.paypal.com.evil.example')).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'PAYPAL_API_URL')!.kind).toBe('address');
    expect(described.find((d) => d.name === 'PAYPAL_CLIENT_SECRET')!.secret).toBe(true);
  });

  it('probes with a one-product page and health-checks the same endpoint', () => {
    expect(a.probe).toEqual({ tool: 'paypal_list_products', params: { page_size: 1 } });
    expect(tool('paypal_list_products').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/v1/catalogs/products?page_size=1');
  });

  it('prefixes every tool with paypal_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^paypal_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, including the POST invoice search', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'paypal_get_authorization',
      'paypal_get_balances',
      'paypal_get_capture',
      'paypal_get_dispute',
      'paypal_get_invoice',
      'paypal_get_order',
      'paypal_get_payout_batch',
      'paypal_get_plan',
      'paypal_get_product',
      'paypal_get_refund',
      'paypal_get_subscription',
      'paypal_list_disputes',
      'paypal_list_invoices',
      'paypal_list_plans',
      'paypal_list_products',
      'paypal_list_subscription_transactions',
      'paypal_list_subscriptions',
      'paypal_search_invoices',
      'paypal_search_transactions',
    ]);
  });

  it('marks money-moving and cancelling tools destructive and non-idempotent, and asks for confirmation', () => {
    for (const name of ['paypal_capture_order', 'paypal_refund_capture', 'paypal_cancel_invoice', 'paypal_cancel_subscription']) {
      const ann = annotationsOf(tool(name));
      expect(`${name}:${ann.readOnlyHint}:${ann.destructiveHint}:${ann.idempotentHint}`).toBe(`${name}:false:true:false`);
      expect(tool(name).description).toMatch(/confirm/i);
    }
    expect(annotationsOf(tool('paypal_delete_draft_invoice')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('paypal_create_order')).destructiveHint).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['paypal_delete_draft_invoice']);
    expect(a.instructions).toMatch(/Money moves: confirm first/);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bpaypal_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bpaypal_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['paypal_create_order', { purchase_units: [] }, 'POST', '/v2/checkout/orders'],
    ['paypal_get_order', { order_id: '5O190127TN364715T' }, 'GET', '/v2/checkout/orders/5O190127TN364715T'],
    ['paypal_capture_order', { order_id: '5O190127TN364715T' }, 'POST', '/v2/checkout/orders/5O190127TN364715T/capture'],
    ['paypal_get_capture', { capture_id: '2GG279541U471931P' }, 'GET', '/v2/payments/captures/2GG279541U471931P'],
    ['paypal_refund_capture', { capture_id: '2GG279541U471931P' }, 'POST', '/v2/payments/captures/2GG279541U471931P/refund'],
    ['paypal_get_refund', { refund_id: '1JU08902781691411' }, 'GET', '/v2/payments/refunds/1JU08902781691411'],
    ['paypal_get_authorization', { authorization_id: '0VF52814937998046' }, 'GET', '/v2/payments/authorizations/0VF52814937998046'],
    ['paypal_list_invoices', {}, 'GET', '/v2/invoicing/invoices'],
    ['paypal_search_invoices', {}, 'POST', '/v2/invoicing/search-invoices'],
    ['paypal_create_draft_invoice', { detail: { currency_code: 'EUR' }, items: [] }, 'POST', '/v2/invoicing/invoices'],
    ['paypal_get_invoice', { invoice_id: 'INV2-Z56S-5LLA-Q52L-CPZ5' }, 'GET', '/v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5'],
    ['paypal_send_invoice', { invoice_id: 'INV2-A' }, 'POST', '/v2/invoicing/invoices/INV2-A/send'],
    ['paypal_remind_invoice', { invoice_id: 'INV2-A' }, 'POST', '/v2/invoicing/invoices/INV2-A/remind'],
    ['paypal_cancel_invoice', { invoice_id: 'INV2-A' }, 'POST', '/v2/invoicing/invoices/INV2-A/cancel'],
    ['paypal_delete_draft_invoice', { invoice_id: 'INV2-A' }, 'DELETE', '/v2/invoicing/invoices/INV2-A'],
    ['paypal_search_transactions', { start_date: '2026-09-01T00:00:00Z', end_date: '2026-09-30T23:59:59Z' }, 'GET', '/v1/reporting/transactions'],
    ['paypal_get_balances', {}, 'GET', '/v1/reporting/balances'],
    ['paypal_list_disputes', {}, 'GET', '/v1/customer/disputes'],
    ['paypal_get_dispute', { dispute_id: 'PP-D-27803' }, 'GET', '/v1/customer/disputes/PP-D-27803'],
    ['paypal_list_products', {}, 'GET', '/v1/catalogs/products'],
    ['paypal_get_product', { product_id: 'PROD-XYAB12ABSB7868434' }, 'GET', '/v1/catalogs/products/PROD-XYAB12ABSB7868434'],
    ['paypal_list_plans', {}, 'GET', '/v1/billing/plans'],
    ['paypal_get_plan', { plan_id: 'P-5ML4271244454362WXNWU5NQ' }, 'GET', '/v1/billing/plans/P-5ML4271244454362WXNWU5NQ'],
    ['paypal_list_subscriptions', {}, 'GET', '/v1/billing/subscriptions'],
    ['paypal_get_subscription', { subscription_id: 'I-BW452GLLEP1G' }, 'GET', '/v1/billing/subscriptions/I-BW452GLLEP1G'],
    ['paypal_list_subscription_transactions', { subscription_id: 'I-BW452GLLEP1G', start_time: '2026-01-01T00:00:00Z', end_time: '2026-10-01T00:00:00Z' }, 'GET', '/v1/billing/subscriptions/I-BW452GLLEP1G/transactions'],
    ['paypal_cancel_subscription', { subscription_id: 'I-BW452GLLEP1G', reason: 'Customer request' }, 'POST', '/v1/billing/subscriptions/I-BW452GLLEP1G/cancel'],
    ['paypal_get_payout_batch', { payout_batch_id: 'FYXMPQTX4JC9N' }, 'GET', '/v1/payments/payouts/FYXMPQTX4JC9N'],
  ])('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url: `${SANDBOX}${path}`,
        headers: expect.objectContaining({ Authorization: 'Bearer test-token', Accept: 'application/json' }),
      }),
    );
  });

  it('covers every tool in the URL table', () => {
    expect(a.tools.length).toBe(28);
  });

  it('creates an order with CAPTURE by default and asks for the full representation', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const units = [{ amount: { currency_code: 'EUR', value: '19.99' } }];
    await call('paypal_create_order', { purchase_units: units, request_id: 'req-1' });
    expect(sent().data).toEqual({ intent: 'CAPTURE', purchase_units: units });
    expect(sent().headers).toEqual(expect.objectContaining({ Prefer: 'return=representation', 'PayPal-Request-Id': 'req-1' }));
  });

  it('captures with an empty JSON body and omits the idempotency header when none is given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('paypal_capture_order', { order_id: 'ORDER1' });
    expect(sent().data).toEqual({});
    expect(sent().headers['Content-Type']).toBe('application/json');
    expect(sent().headers['PayPal-Request-Id']).toBeUndefined();
  });

  it('refunds a capture in part with a note, or in full with an empty body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('paypal_refund_capture', { capture_id: 'CAP1', amount: { currency_code: 'EUR', value: '5.00' }, note_to_payer: 'Sorry', request_id: 'r2' });
    expect(sent().data).toEqual({ amount: { currency_code: 'EUR', value: '5.00' }, note_to_payer: 'Sorry' });
    expect(sent().headers['PayPal-Request-Id']).toBe('r2');
    mockedAxios.mockClear();
    await call('paypal_refund_capture', { capture_id: 'CAP1' });
    expect(sent().data).toEqual({});
  });

  it('searches invoices with filters in the body and paging in the query', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('paypal_search_invoices', { status: ['SENT', 'UNPAID'], recipient_email: 'ana@example.com', page: 2 });
    expect(sent().data).toEqual({ status: ['SENT', 'UNPAID'], recipient_email: 'ana@example.com' });
    expect(sent().params).toEqual({ page: 2, page_size: 20, total_required: 'true' });
  });

  it('asks for all transaction details by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('paypal_search_transactions', { start_date: '2026-09-01T00:00:00Z', end_date: '2026-09-30T23:59:59Z', transaction_status: 'S' });
    expect(sent().params).toEqual({
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-30T23:59:59Z',
      transaction_status: 'S',
      fields: 'all',
      page_size: 100,
      page: 1,
    });
    // The offset of a local time must survive as `+`, encoded.
    expect(sent().paramsSerializer({ start_date: '2026-09-01T00:00:00+02:00' })).toBe('start_date=2026-09-01T00:00:00%2B02:00');
  });

  it('sends, reminds and cancels invoices with notification flags only', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('paypal_send_invoice', { invoice_id: 'INV2-A', send_to_recipient: false });
    expect(sent().data).toEqual({ send_to_recipient: false });
    mockedAxios.mockClear();
    await call('paypal_cancel_invoice', { invoice_id: 'INV2-A' });
    expect(sent().data).toEqual({});
    mockedAxios.mockClear();
    await call('paypal_cancel_subscription', { subscription_id: 'I-1', reason: 'Asked by customer' });
    expect(sent().data).toEqual({ reason: 'Asked by customer' });
  });
});

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const live = CLIENT_ID && CLIENT_SECRET ? describe : describe.skip;

live('paypal adapter: live REST API', () => {
  const host = process.env.PAYPAL_API_URL || SANDBOX;
  const isSandbox = host === SANDBOX;
  const write = process.env.PAYPAL_LIVE_WRITE === '1' && isSandbox;
  let token = '';
  beforeAll(async () => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
    const res = await mockedAxios.__actual.post(`${host}/v1/oauth2/token`, 'grant_type=client_credentials', {
      auth: { username: CLIENT_ID as string, password: CLIENT_SECRET as string },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    token = res.data.access_token;
    expect(token).toBeTruthy();
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => {
    const { config, endpointMapping } = resolved(name, { ...ENV, PAYPAL_API_URL: host });
    return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      { baseUrl: config.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: config.headers } as never,
      endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );
  };
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

  it('reads products, plans and subscriptions', async () => {
    const products = await run('paypal_list_products', { page_size: 5, total_required: true });
    expect(Array.isArray(products.products ?? [])).toBe(true);
    if (products.products?.length) {
      const one = await run('paypal_get_product', { product_id: products.products[0].id });
      expect(one.id).toBe(products.products[0].id);
    }
    const plans = await run('paypal_list_plans', { page_size: 5 });
    expect(Array.isArray(plans.plans ?? [])).toBe(true);
    if (plans.plans?.length) {
      const plan = await run('paypal_get_plan', { plan_id: plans.plans[0].id });
      expect(plan.id).toBe(plans.plans[0].id);
      const subs = await run('paypal_list_subscriptions', { plan_ids: plan.id, page_size: 5 });
      expect(Array.isArray(subs.subscriptions ?? [])).toBe(true);
      if (subs.subscriptions?.length) {
        const sub = await run('paypal_get_subscription', { subscription_id: subs.subscriptions[0].id, fields: 'plan' });
        expect(sub.id).toBe(subs.subscriptions[0].id);
        const txs = await run('paypal_list_subscription_transactions', {
          subscription_id: sub.id,
          start_time: iso(new Date(Date.now() - 300 * 86400_000)),
          end_time: iso(new Date()),
        });
        expect(txs).toBeDefined();
      }
    }
  }, 60_000);

  it('reads invoices, the transaction history, balances and disputes', async () => {
    const invoices = await run('paypal_list_invoices', { page_size: 5, total_required: true });
    expect(typeof invoices.total_items).toBe('number');
    if (invoices.items?.length) {
      const one = await run('paypal_get_invoice', { invoice_id: invoices.items[0].id });
      expect(one.id).toBe(invoices.items[0].id);
    }
    const found = await run('paypal_search_invoices', { status: ['DRAFT', 'SENT', 'UNPAID', 'PAID'], page_size: 5 });
    expect(found).toBeDefined();
    const history = await run('paypal_search_transactions', {
      start_date: iso(new Date(Date.now() - 30 * 86400_000)),
      end_date: iso(new Date()),
      page_size: 10,
    });
    expect(Array.isArray(history.transaction_details)).toBe(true);
    const balances = await run('paypal_get_balances');
    expect(Array.isArray(balances.balances)).toBe(true);
    const disputes = await run('paypal_list_disputes', { page_size: 5 });
    if (disputes.items?.length) {
      const one = await run('paypal_get_dispute', { dispute_id: disputes.items[0].dispute_id });
      expect(one.dispute_id).toBe(disputes.items[0].dispute_id);
    }
  }, 60_000);

  it('reads a capture, an authorization and a payout batch when their ids are given', async () => {
    if (process.env.PAYPAL_CAPTURE_ID) {
      const capture = await run('paypal_get_capture', { capture_id: process.env.PAYPAL_CAPTURE_ID });
      expect(capture.id).toBe(process.env.PAYPAL_CAPTURE_ID);
    }
    if (process.env.PAYPAL_AUTHORIZATION_ID) {
      const auth = await run('paypal_get_authorization', { authorization_id: process.env.PAYPAL_AUTHORIZATION_ID });
      expect(auth.id).toBe(process.env.PAYPAL_AUTHORIZATION_ID);
    }
    if (process.env.PAYPAL_PAYOUT_BATCH_ID) {
      const batch = await run('paypal_get_payout_batch', { payout_batch_id: process.env.PAYPAL_PAYOUT_BATCH_ID });
      expect(batch.batch_header.payout_batch_id).toBe(process.env.PAYPAL_PAYOUT_BATCH_ID);
    }
  }, 60_000);

  (write ? it : it.skip)('creates an order, reads it, and is refused at capture without buyer approval', async () => {
    const order = await run('paypal_create_order', {
      purchase_units: [{ amount: { currency_code: 'EUR', value: '1.00' }, description: 'AnythingMCP live spec' }],
    });
    expect(order.status).toMatch(/CREATED|PAYER_ACTION_REQUIRED/);
    const read = await run('paypal_get_order', { order_id: order.id });
    expect(read.id).toBe(order.id);
    await expect(run('paypal_capture_order', { order_id: order.id, request_id: `amcp-${Date.now()}` })).rejects.toMatchObject({
      response: { status: 422 },
    });
  }, 60_000);

  (write ? it : it.skip)('creates a draft invoice, finds it, sends, reminds and cancels it', async () => {
    const recipient = process.env.PAYPAL_TEST_BUYER_EMAIL || 'anythingmcp-buyer@example.com';
    const created = await run('paypal_create_draft_invoice', {
      detail: { currency_code: 'EUR', note: 'AnythingMCP live spec, safe to ignore', payment_term: { term_type: 'NET_10' } },
      primary_recipients: [{ billing_info: { email_address: recipient } }],
      items: [{ name: 'AnythingMCP test line', quantity: '1', unit_amount: { currency_code: 'EUR', value: '1.00' } }],
    });
    expect(created.status).toBe('DRAFT');
    let isSent = false;
    try {
      const read = await run('paypal_get_invoice', { invoice_id: created.id });
      expect(read.detail.invoice_number).toBe(created.detail.invoice_number);
      const found = await run('paypal_search_invoices', { invoice_number: created.detail.invoice_number });
      expect(found.items.map((i: { id: string }) => i.id)).toContain(created.id);
      await run('paypal_send_invoice', { invoice_id: created.id });
      isSent = true;
      const afterSend = await run('paypal_get_invoice', { invoice_id: created.id });
      expect(afterSend.status).toMatch(/SENT|UNPAID/);
      await run('paypal_remind_invoice', { invoice_id: created.id, send_to_invoicer: false });
    } finally {
      if (isSent) {
        await run('paypal_cancel_invoice', { invoice_id: created.id, send_to_recipient: false });
        const cancelled = await run('paypal_get_invoice', { invoice_id: created.id });
        expect(cancelled.status).toBe('CANCELLED');
      } else {
        await run('paypal_delete_draft_invoice', { invoice_id: created.id });
      }
    }
  }, 120_000);

  (write && process.env.PAYPAL_CAPTURE_ID ? it : it.skip)('refunds 0.01 of the given sandbox capture and reads the refund', async () => {
    const capture = await run('paypal_get_capture', { capture_id: process.env.PAYPAL_CAPTURE_ID });
    const refund = await run('paypal_refund_capture', {
      capture_id: capture.id,
      amount: { currency_code: capture.amount.currency_code, value: '0.01' },
      note_to_payer: 'AnythingMCP live spec',
      request_id: `amcp-refund-${Date.now()}`,
    });
    expect(refund.status).toMatch(/COMPLETED|PENDING/);
    const read = await run('paypal_get_refund', { refund_id: refund.id });
    expect(read.id).toBe(refund.id);
  }, 60_000);

  (write && process.env.PAYPAL_CANCEL_SUBSCRIPTION_ID ? it : it.skip)('cancels the given sandbox subscription', async () => {
    const id = process.env.PAYPAL_CANCEL_SUBSCRIPTION_ID as string;
    await run('paypal_cancel_subscription', { subscription_id: id, reason: 'AnythingMCP live spec' });
    const sub = await run('paypal_get_subscription', { subscription_id: id });
    expect(sub.status).toBe('CANCELLED');
  }, 60_000);
});
