import axios from 'axios';
import * as adapter from './brex.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Brex adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with the user token, every
 *      tool's method, URL, query and body through the real RestEngine, checked
 *      against Brex's published OpenAPI files (developer.brex.com, Team,
 *      Transactions, Expenses, Budgets, Payments and Travel APIs, read
 *      15 Oct 2026). Also that no tool can move money, that the three admin
 *      actions ask for confirmation and ship switched off, and that bank
 *      account, routing and card numbers never reach the model.
 *
 *   2. Live: skipped unless RUN_BREX_LIVE=1. Without a token it checks that
 *      Brex refuses a made-up bxt_ token with 403 "Invalid or Revoked Token"
 *      on the real routes (a token without the bxt_ shape gets 401) while a
 *      made-up route answers 404 (Brex routes before it checks the token).
 *      With BREX_API_TOKEN (read-only scopes) it reads the company, users,
 *      cards, accounts, transactions, expenses, budgets and vendors, shaped by
 *      each tool's response mapping as production does. Nothing is written
 *      unless RUN_BREX_LIVE_WRITES=1 too: then the memo of the newest card
 *      expense is written back unchanged (needs the expenses.card scope). No
 *      card is ever locked by this spec.
 *
 *        RUN_BREX_LIVE=1 BREX_API_TOKEN=bxt_... npx jest src/adapters/intl/brex.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const HOST = 'https://api.brex.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'bxt_' + 'amcp0'.repeat(8);
const ENV: Record<string, string> = { BREX_API_TOKEN: FAKE_TOKEN };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const run = (mapping: Tool['endpointMapping'], params: Record<string, unknown>, env = ENV, schema?: Tool['parameters']) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    mapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults((schema ?? {}) as any, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>, env = ENV) =>
  run(tool(name).endpointMapping, params, env, tool(name).parameters);
// What the model receives: the raw answer shaped by the tool's response mapping.
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) => shape(name, await call(name, params, env));
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => sent().paramsSerializer(sent().params) as string;

const WRITES = ['brex_lock_card', 'brex_unlock_card', 'brex_update_expense_memo'];

describe('brex adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('banking');
    expect(a.icon).toBe('brex');
  });

  it('calls api.brex.com with the user token as Bearer and checks it on /v2/company', () => {
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{BREX_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/v2/company');
    expect(a.probe).toEqual({ tool: 'brex_get_company' });
    expect(a.requiredEnvVars).toEqual(['BREX_API_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.BREX_API_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.BREX_API_TOKEN.pattern!);
    expect(pattern.test(FAKE_TOKEN)).toBe(true);
    expect(pattern.test(`Bearer ${FAKE_TOKEN}`)).toBe(false);
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with brex_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^brex_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('cannot move money: no tool reaches a transfer, payment, card-number or card-issuing route', () => {
    for (const t of a.tools) {
      const { method, path } = t.endpointMapping;
      // Payments API routes that move or prepare money, and the card-number routes.
      expect(path).not.toMatch(/transfer|payment|payout|linked_accounts|incoming|wire|ach|cheque|check|\/pan|secure_email/i);
      expect(path).not.toMatch(/referral|onboarding/i);
      if (method !== 'GET') {
        expect(WRITES).toContain(t.name);
        // No create (POST /v2/cards), terminate, budget, limit, vendor or expense creation.
        expect(`${method} ${path}`).not.toMatch(/^POST \/v2\/cards$|terminate|budget|spend_limit|vendor|receipt|\/v2\/users/);
      }
    }
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => `${t.endpointMapping.method} ${t.endpointMapping.path}`).sort()).toEqual([
      'POST /v2/cards/{card_id}/lock',
      'POST /v2/cards/{card_id}/unlock',
      'PUT /v1/expenses/card/{expense_id}',
    ]);
    expect(a.instructions).toMatch(/\*\*It cannot send money, by design\.\*\*/);
    expect(a.description).toMatch(/cannot send money/);
  });

  it('marks only the three admin actions as writes, ships them off and asks for confirmation', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const name of WRITES) {
      expect(tool(name).description).toMatch(/confirm/i);
      expect(tool(name).description).toMatch(/switched off/);
    }
    expect(annotationsOf(tool('brex_lock_card'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsOf(tool('brex_update_expense_memo'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('recommends read-only scopes and says financial data is sensitive', () => {
    expect(a.instructions).toMatch(/\*\*Financial data is sensitive\.\*\*/);
    expect(a.instructions).toMatch(/\*\*Read-only by default\.\*\*/);
    for (const scope of ['companies.readonly', 'transactions.card.readonly', 'accounts.cash.readonly', 'expenses.card.readonly', 'budgets.readonly', 'vendors.readonly']) {
      expect(a.instructions).toContain(`\`${scope}\``);
    }
    expect(a.instructions).toMatch(/Do \*\*not\*\* select `transfers`, `incoming_transfers`, `cards\.pan`/);
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bbrex_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbrex_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
      for (const p of t.endpointMapping.path.match(/\{(\w+)\}/g) ?? []) {
        expect(t.parameters.required).toContain(p.slice(1, -1));
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['brex_get_company', {}, 'GET', '/v2/company'],
    ['brex_get_current_user', {}, 'GET', '/v2/users/me'],
    ['brex_list_users', {}, 'GET', '/v2/users'],
    ['brex_get_user', { user_id: 'cuuser_1' }, 'GET', '/v2/users/cuuser_1'],
    ['brex_list_departments', {}, 'GET', '/v2/departments'],
    ['brex_list_locations', {}, 'GET', '/v2/locations'],
    ['brex_list_cards', {}, 'GET', '/v2/cards'],
    ['brex_get_card', { card_id: 'cucard_1' }, 'GET', '/v2/cards/cucard_1'],
    ['brex_lock_card', { card_id: 'cucard_1', reason: 'CARD_LOST' }, 'POST', '/v2/cards/cucard_1/lock'],
    ['brex_unlock_card', { card_id: 'cucard_1' }, 'POST', '/v2/cards/cucard_1/unlock'],
    ['brex_list_card_accounts', {}, 'GET', '/v2/accounts/card'],
    ['brex_list_card_transactions', {}, 'GET', '/v2/transactions/card/primary'],
    ['brex_list_card_statements', {}, 'GET', '/v2/accounts/card/primary/statements'],
    ['brex_list_cash_accounts', {}, 'GET', '/v2/accounts/cash'],
    ['brex_get_cash_account', { account_id: 'dpacc_1' }, 'GET', '/v2/accounts/cash/dpacc_1'],
    ['brex_list_cash_transactions', { account_id: 'dpacc_1' }, 'GET', '/v2/transactions/cash/dpacc_1'],
    ['brex_list_cash_statements', { account_id: 'dpacc_1' }, 'GET', '/v2/accounts/cash/dpacc_1/statements'],
    ['brex_list_expenses', {}, 'GET', '/v1/expenses'],
    ['brex_get_expense', { expense_id: 'expense_1' }, 'GET', '/v1/expenses/expense_1'],
    ['brex_update_expense_memo', { expense_id: 'expense_1', memo: 'Team lunch' }, 'PUT', '/v1/expenses/card/expense_1'],
    ['brex_list_budgets', {}, 'GET', '/v2/budgets'],
    ['brex_get_budget', { budget_id: 'budget_1' }, 'GET', '/v2/budgets/budget_1'],
    ['brex_list_spend_limits', {}, 'GET', '/v2/spend_limits'],
    ['brex_get_spend_limit', { spend_limit_id: 'limit_1' }, 'GET', '/v2/spend_limits/limit_1'],
    ['brex_list_vendors', {}, 'GET', '/v1/vendors'],
    ['brex_get_vendor', { vendor_id: 'vendor_1' }, 'GET', '/v1/vendors/vendor_1'],
    ['brex_list_trips', {}, 'GET', '/v1/trips'],
    ['brex_get_trip', { trip_id: 'trip_1' }, 'GET', '/v1/trips/trip_1'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the documented URL with the Bearer token', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('filters users with the documented repeated status[] and department_id[] parameters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('brex_list_users', { name: 'ada', status: ['ACTIVE', 'INVITED'], department_id: ['d1'], limit: 20 });
    expect(query()).toBe('name=ada&status%5B%5D=ACTIVE&status%5B%5D=INVITED&department_id%5B%5D=d1&limit=20');
  });

  it('pages card transactions (50 by default), filters by posted date and expands the expense id', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('brex_list_card_transactions', { posted_at_start: '2026-09-01T00:00:00Z', user_ids: ['u1', 'u2'], expand: ['expense_id'], cursor: 'c1' });
    expect(sent().params).toEqual({ posted_at_start: '2026-09-01T00:00:00Z', user_ids: ['u1', 'u2'], 'expand[]': ['expense_id'], cursor: 'c1', limit: 50 });
    expect(query()).toContain('user_ids=u1&user_ids=u2&expand%5B%5D=expense_id');
  });

  it('filters expenses with the documented array parameters and caps a page at 100', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('brex_list_expenses', {
      compliance_status: ['DUE', 'OVERDUE'],
      expense_type: ['CARD'],
      purchased_at_start: '2026-09-01T00:00:00Z',
      expand: ['merchant', 'receipts.download_uris'],
    });
    expect(sent().params).toEqual({
      'compliance_status[]': ['DUE', 'OVERDUE'],
      'expense_type[]': ['CARD'],
      purchased_at_start: '2026-09-01T00:00:00Z',
      'expand[]': ['merchant', 'receipts.download_uris'],
      limit: 50,
    });
    expect(tool('brex_list_expenses').parameters.properties!.limit).toMatchObject({ maximum: 100 });
  });

  it('builds the documented bodies for the lock and the memo, and the unlock has none', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('brex_lock_card', { card_id: 'c1', reason: 'FRAUD', description: 'Unknown charge' });
    expect(sent().data).toEqual({ reason: 'FRAUD', description: 'Unknown charge' });
    expect(tool('brex_lock_card').parameters.required).toEqual(['card_id', 'reason']);
    mockedAxios.mockClear();
    await call('brex_lock_card', { card_id: 'c1', reason: 'CARD_LOST' });
    expect(sent().data).toEqual({ reason: 'CARD_LOST' });
    mockedAxios.mockClear();
    await call('brex_update_expense_memo', { expense_id: 'e1', memo: 'Client dinner' });
    expect(sent().data).toEqual({ memo: 'Client dinner' });
    mockedAxios.mockClear();
    await call('brex_unlock_card', { card_id: 'c1' });
    expect(sent().data ?? {}).toEqual({});
  });

  it('never hands account or routing numbers of a cash account to the model', () => {
    const account = {
      id: 'dpacc_1', name: 'Operating', status: 'ACTIVE', primary: true,
      current_balance: { amount: 1250000, currency: 'USD' }, available_balance: { amount: 1200000, currency: 'USD' },
      account_number: '123456789012', routing_number: '021000021',
    };
    const one = shape('brex_get_cash_account', account);
    expect(one).toEqual({ id: 'dpacc_1', name: 'Operating', status: 'ACTIVE', primary: true, current_balance: account.current_balance, available_balance: account.available_balance });
    const list = shape('brex_list_cash_accounts', { next_cursor: null, items: [account] });
    expect(list.items[0].id).toBe('dpacc_1');
    expect(JSON.stringify([one, list])).not.toMatch(/123456789012|021000021/);
    expect(tool('brex_get_cash_account').responseMapping!.transform.fallbackToRaw).toBe(false);
  });

  it('keeps the last four card digits and drops addresses and expiry', () => {
    const card = {
      id: 'cucard_1', owner: { type: 'USER', user_id: 'cuuser_1' }, status: 'ACTIVE', last_four: '4242', card_name: 'Ads',
      card_type: 'VIRTUAL', limit_type: 'CARD', spend_controls: { spend_limit: { amount: 50000, currency: 'USD' }, spend_duration: 'MONTHLY' },
      billing_address: { line1: '1 Main St', city: 'SF', country: 'US', postal_code: '94105' }, mailing_address: null,
      expiration_date: { month: 8, year: 2029 }, created_at: '2026-01-01T00:00:00Z',
    };
    const out = shape('brex_get_card', card);
    expect(out).toMatchObject({ id: 'cucard_1', last_four: '4242', owner_user_id: 'cuuser_1', status: 'ACTIVE', spend_controls: card.spend_controls });
    expect(JSON.stringify(out)).not.toMatch(/Main St|2029/);
  });

  it('shows only the payment method types of a vendor, never its bank details', () => {
    const vendor = {
      id: 'vendor_1', company_name: 'Acme', email: 'ap@acme.example', phone: null,
      payment_accounts: [
        { details: { type: 'ACH', payment_instrument_id: 'pi_1', routing_number: '021000021', account_number: '000123456789', account_type: 'CHECKING' } },
        { details: { type: 'INTERNATIONAL_WIRE', payment_instrument_id: 'pi_2', iban: 'DE89370400440532013000', swift_code: 'COBADEFFXXX' } },
      ],
    };
    const out = shape('brex_get_vendor', vendor);
    expect(out).toEqual({ id: 'vendor_1', company_name: 'Acme', email: 'ap@acme.example', phone: null, payment_account_types: ['ACH', 'INTERNATIONAL_WIRE'] });
    const list = shape('brex_list_vendors', { next_cursor: 'n1', items: [vendor] });
    expect(list.next_cursor).toBe('n1');
    expect(JSON.stringify([out, list])).not.toMatch(/021000021|000123456789|DE89|COBADEFF/);
  });

  it('shapes card transactions, expenses and card accounts as documented', () => {
    const tx = {
      next_cursor: 'abc',
      items: [{
        id: 'tx_1', card_id: 'cucard_1', description: 'AWS', amount: { amount: 12345, currency: 'USD' }, initiated_at_date: '2026-09-01',
        posted_at_date: '2026-09-02', type: 'PURCHASE', merchant: { raw_descriptor: 'AWS EMEA', mcc: '7372', country: 'USA' },
        card_metadata: { k: 'v' }, expense_id: 'expense_1', card_transaction_operation_reference_id: 'op_1',
      }],
    };
    const out = shape('brex_list_card_transactions', tx);
    expect(out).toEqual({
      next_cursor: 'abc',
      items: [{ id: 'tx_1', description: 'AWS', amount: { amount: 12345, currency: 'USD' }, type: 'PURCHASE', initiated_at_date: '2026-09-01', posted_at_date: '2026-09-02', merchant: tx.items[0].merchant, card_id: 'cucard_1', expense_id: 'expense_1' }],
    });
    const expense = { id: 'expense_1', memo: 'Hosting', updated_at: '2026-09-03T00:00:00Z', status: 'APPROVED', review: { compliance_status: 'COMPLETED', approval_steps: [] }, dashboard_url: 'https://dashboard.brex.com/x', receipts: [{ id: 'r1', download_uris: ['https://s3.example/r1'] }] };
    expect(shape('brex_get_expense', expense)).toEqual({ id: 'expense_1', memo: 'Hosting', status: 'APPROVED', updated_at: expense.updated_at, compliance_status: 'COMPLETED', receipts: expense.receipts, dashboard_url: expense.dashboard_url });
    const accounts = [{ id: 'ca_1', status: 'ACTIVE', current_balance: { amount: 1, currency: 'USD' }, available_balance: { amount: 2, currency: 'USD' }, account_limit: { amount: 3, currency: 'USD' }, current_statement_period: { start_date: '2026-09-01', end_date: '2026-10-01' } }];
    expect(shape('brex_list_card_accounts', accounts)).toEqual({ accounts });
  });
});

const live = process.env.RUN_BREX_LIVE === '1' ? describe : describe.skip;
live('brex adapter: live', () => {
  const real = !!process.env.BREX_API_TOKEN;
  const env = () => ({ BREX_API_TOKEN: process.env.BREX_API_TOKEN! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['brex_get_company', {}],
    ['brex_list_card_transactions', { limit: 1 }],
    ['brex_list_cash_accounts', {}],
    ['brex_list_expenses', { limit: 1 }],
    ['brex_lock_card', { card_id: 'cucard_amcp_none', reason: 'OTHER' }],
  ])('%s reaches Brex and is refused with a made-up token (403 Invalid or Revoked Token)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 403, data: { message: 'Invalid or Revoked Token' } } });
  }, 30000);

  it('answers 401 when the token does not even look like a Brex token', async () => {
    await expect(call('brex_get_company', {}, { BREX_API_TOKEN: 'amcp' + '0'.repeat(20) })).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers 404 on a made-up route with the same token (routing comes before the token check)', async () => {
    await expect(run({ method: 'GET', path: '/v2/amcp-no-such-route' }, {})).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (real ? it : it.skip)('reads the company, users, cards, accounts, transactions, expenses, budgets and vendors', async () => {
    const company = await shaped('brex_get_company', {}, env());
    expect(typeof company.legal_name).toBe('string');
    const users = await shaped('brex_list_users', { limit: 5 }, env());
    expect(Array.isArray(users.items)).toBe(true);
    const cards = await shaped('brex_list_cards', { limit: 5 }, env());
    expect(Array.isArray(cards.items)).toBe(true);
    expect(JSON.stringify(cards)).not.toMatch(/billing_address|expiration_date/);
    const cash = await shaped('brex_list_cash_accounts', {}, env());
    expect(JSON.stringify(cash)).not.toMatch(/account_number|routing_number/);
    const since = new Date(Date.now() - 30 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const txs = await shaped('brex_list_card_transactions', { posted_at_start: since, limit: 5 }, env());
    expect(Array.isArray(txs.items)).toBe(true);
    const expenses = await shaped('brex_list_expenses', { limit: 5 }, env());
    expect(Array.isArray(expenses.items)).toBe(true);
    if (expenses.items[0]) {
      const one = await shaped('brex_get_expense', { expense_id: expenses.items[0].id }, env());
      expect(one.id).toBe(expenses.items[0].id);
    }
    const limits = await shaped('brex_list_spend_limits', { limit: 5 }, env());
    expect(Array.isArray(limits.items)).toBe(true);
    const vendors = await shaped('brex_list_vendors', { limit: 5 }, env());
    expect(JSON.stringify(vendors)).not.toMatch(/routing_number|account_number|iban/);
  }, 120000);

  const writes = real && process.env.RUN_BREX_LIVE_WRITES === '1';
  (writes ? it : it.skip)('writes the memo of the newest card expense back unchanged (no card is locked)', async () => {
    const list = await shaped('brex_list_expenses', { expense_type: ['CARD'], limit: 1 }, env());
    if (!list.items[0]) return;
    const { id, memo } = list.items[0];
    const out = await shaped('brex_update_expense_memo', { expense_id: id, memo: memo ?? '' }, env());
    expect(out.id).toBe(id);
  }, 60000);
});
