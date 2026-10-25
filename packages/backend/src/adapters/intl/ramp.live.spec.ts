import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './ramp.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Ramp adapter:
 *
 *   1. Static: always runs. Pins the client-credentials token request (HTTP
 *      Basic at /developer/v1/token with only read scopes), every tool's
 *      method, URL, query and body through the real RestEngine, checked
 *      against Ramp's published OpenAPI file
 *      (docs.ramp.com/openapi/developer-api.json, read 15 Oct 2026). Also that
 *      no tool can move money, that the three admin actions ask for
 *      confirmation and ship switched off, and that bank details and card
 *      addresses never reach the model.
 *
 *   2. Live: skipped unless RUN_RAMP_LIVE=1. Without credentials it checks
 *      that Ramp refuses a made-up token on the real routes with its JSON
 *      404 DEVELOPER_7002 "Access token ... not found" (Ramp answers 404, not
 *      401, here) while a made-up route answers an HTML 404, and that the
 *      token endpoint refuses made-up client credentials. With RAMP_CLIENT_ID
 *      and RAMP_CLIENT_SECRET (RAMP_API_HOST=https://demo-api.ramp.com for the
 *      sandbox) it gets a token with the adapter's own read scopes and reads
 *      the business, users, cards, funds, transactions, bills and vendors,
 *      shaped by each tool's response mapping. Nothing is written unless
 *      RUN_RAMP_LIVE_WRITES=1 too: then the newest transaction's memo is
 *      written back unchanged (the app needs memos:write). No card is ever
 *      suspended by this spec.
 *
 *        RUN_RAMP_LIVE=1 RAMP_CLIENT_ID=... RAMP_CLIENT_SECRET=... \
 *          RAMP_API_HOST=https://demo-api.ramp.com npx jest src/adapters/intl/ramp.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[]; maxLength?: number }>; required?: string[] };
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

const HOST = 'https://api.ramp.com';
const BASE = `${HOST}/developer/v1`;
const ENV: Record<string, string> = { RAMP_CLIENT_ID: 'amcp-client-id', RAMP_CLIENT_SECRET: 'amcp-client-secret' };
const FAKE_TOKEN = 'ramp_business_tok_' + 'amcp0'.repeat(6);
const READ_SCOPES = [
  'business:read', 'users:read', 'departments:read', 'locations:read', 'entities:read', 'cards:read', 'funds:read',
  'spend_programs:read', 'transactions:read', 'reimbursements:read', 'bills:read', 'vendors:read', 'receipts:read',
  'accounting:read', 'statements:read',
];

// Mirrors DynamicMcpTools: {{VAR}} interpolated, schema defaults applied, and
// the OAuth2 token supplied by the token service (stubbed here).
const run = (
  mapping: Tool['endpointMapping'],
  params: Record<string, unknown>,
  opts: { token?: string; base?: string; schema?: Tool['parameters'] } = {},
) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: opts.base ?? a.connector.baseUrl, headers: a.connector.headers },
    mapping,
    ENV,
  );
  const token = opts.token ?? FAKE_TOKEN;
  return new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue(token) } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  ).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: config.headers } as any,
    endpointMapping,
    applySchemaDefaults((opts.schema ?? {}) as any, params),
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>, opts: { token?: string; base?: string } = {}) =>
  run(tool(name).endpointMapping, params, { ...opts, schema: tool(name).parameters });
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, opts: { token?: string; base?: string } = {}) =>
  shape(name, await call(name, params, opts));
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = ['ramp_lock_card', 'ramp_unlock_card', 'ramp_update_transaction_memo'];

describe('ramp adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('banking');
    expect(a.icon).toBe('ramp');
  });

  it('gets its token with the client-credentials grant and asks only for read scopes', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{RAMP_CLIENT_ID}}',
      clientSecret: '{{RAMP_CLIENT_SECRET}}',
      tokenUrl: `${BASE}/token`,
      tokenAuthMethod: 'client_secret_basic',
      scopes: READ_SCOPES.join(' '),
    });
    expect(a.connector.authConfig.authorizationUrl).toBeUndefined();
    for (const scope of a.connector.authConfig.scopes.split(' ')) expect(scope).toMatch(/:read$/);
    expect(a.connector.healthcheckPath).toBe('/business');
    expect(a.probe).toEqual({ tool: 'ramp_get_business' });
    // Every scope the token asks for must be allowed in the Ramp app: say so.
    for (const scope of READ_SCOPES) expect(a.instructions).toContain(`\`${scope}\``);
  });

  it('sends client id and secret as HTTP Basic with grant_type and the read scopes in the body', async () => {
    const service = new OAuth2TokenService(
      {} as PrismaService,
      { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService,
    );
    const post = jest.spyOn(mockedAxios as any, 'post').mockResolvedValue({ data: { access_token: FAKE_TOKEN, expires_in: 864000, token_type: 'Bearer' } });
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).resolves.toBe(FAKE_TOKEN);
    const [url, body, options] = post.mock.calls[0] as unknown as [string, string, { headers: Record<string, string> }];
    expect(url).toBe(`${BASE}/token`);
    const form = new URLSearchParams(String(body));
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe(READ_SCOPES.join(' '));
    expect(form.get('client_secret')).toBeNull();
    expect(options.headers.Authorization).toBe(`Basic ${Buffer.from('amcp-client-id:amcp-client-secret').toString('base64')}`);
    post.mockRestore();
  });

  it('describes both credentials and marks the secret as secret', () => {
    expect(a.requiredEnvVars).toEqual(['RAMP_CLIENT_ID', 'RAMP_CLIENT_SECRET']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.RAMP_CLIENT_ID).toMatchObject({ kind: 'credential', required: true });
    expect(meta.RAMP_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true, required: true });
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['404']).toMatch(/DEVELOPER_7002/);
  });

  it('prefixes every tool with ramp_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^ramp_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('cannot move money: no tool reaches a transfer, payment, vault, card-issuing or fund-changing route', () => {
    for (const t of a.tools) {
      const { method, path } = t.endpointMapping;
      expect(path).not.toMatch(/transfer|vault|embedded|agent|repayment|cashback|bank-accounts|token/i);
      if (method !== 'GET') {
        expect(WRITES).toContain(t.name);
        // No bill, reimbursement, fund, card-issuing, vendor or user write.
        expect(path).not.toMatch(/^\/(bills|reimbursements|funds|vendors|users|purchase-orders|spend-programs|applications)/);
        expect(`${method} ${path}`).not.toMatch(/^POST \/cards\/(physical|virtual)$/);
      }
    }
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => `${t.endpointMapping.method} ${t.endpointMapping.path}`).sort()).toEqual([
      'DELETE /cards/physical/{card_id}/suspension',
      'POST /cards/physical/{card_id}/suspension',
      'POST /memos/{transaction_id}',
    ]);
    expect(a.instructions).toMatch(/\*\*It cannot send money, by design\.\*\*/);
    expect(a.instructions).toMatch(/Never allow `bills:write`, `reimbursements:write`, `cards:read_vault` or `limits:write`/);
    expect(a.description).toMatch(/cannot send or approve payments/);
  });

  it('marks only the three admin actions as writes, ships them off and asks for confirmation', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const name of WRITES) {
      expect(tool(name).description).toMatch(/confirm/i);
      expect(tool(name).description).toMatch(/switched off/);
    }
    // DELETE of a suspension lifts it: a write, but it removes nothing.
    expect(annotationsOf(tool('ramp_unlock_card'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsOf(tool('ramp_update_transaction_memo'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool('ramp_update_transaction_memo').parameters.properties!.memo.maxLength).toBe(255);
  });

  it('says financial data is sensitive, documents sandbox and paging, and writes no em dashes', () => {
    expect(a.instructions).toMatch(/\*\*Financial data is sensitive\.\*\*/);
    expect(a.instructions).toMatch(/\*\*Read-only by default\.\*\*/);
    expect(a.instructions).toContain('https://demo-api.ramp.com/developer/v1');
    expect(a.instructions).toMatch(/200 requests per 10 seconds/);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bramp_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bramp_[a-z_]+/g)]),
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
    ['ramp_get_business', {}, 'GET', '/business'],
    ['ramp_get_business_balance', {}, 'GET', '/business/balance'],
    ['ramp_list_users', {}, 'GET', '/users'],
    ['ramp_get_user', { user_id: 'u1' }, 'GET', '/users/u1'],
    ['ramp_list_departments', {}, 'GET', '/departments'],
    ['ramp_list_locations', {}, 'GET', '/locations'],
    ['ramp_list_entities', {}, 'GET', '/entities'],
    ['ramp_list_physical_cards', {}, 'GET', '/cards/physical'],
    ['ramp_get_physical_card', { card_id: 'c1' }, 'GET', '/cards/physical/c1'],
    ['ramp_list_virtual_cards', {}, 'GET', '/cards/virtual'],
    ['ramp_get_virtual_card', { card_id: 'v1' }, 'GET', '/cards/virtual/v1'],
    ['ramp_list_funds', {}, 'GET', '/funds'],
    ['ramp_get_fund', { fund_id: 'f1' }, 'GET', '/funds/f1'],
    ['ramp_list_spend_programs', {}, 'GET', '/spend-programs'],
    ['ramp_get_spend_program', { spend_program_id: 'sp1' }, 'GET', '/spend-programs/sp1'],
    ['ramp_list_transactions', {}, 'GET', '/transactions'],
    ['ramp_get_transaction', { transaction_id: 't1' }, 'GET', '/transactions/t1'],
    ['ramp_list_reimbursements', {}, 'GET', '/reimbursements'],
    ['ramp_get_reimbursement', { reimbursement_id: 'r1' }, 'GET', '/reimbursements/r1'],
    ['ramp_list_bills', {}, 'GET', '/bills'],
    ['ramp_get_bill', { bill_id: 'b1' }, 'GET', '/bills/b1'],
    ['ramp_list_vendors', {}, 'GET', '/vendors'],
    ['ramp_get_vendor', { vendor_id: 'vd1' }, 'GET', '/vendors/vd1'],
    ['ramp_list_receipts', {}, 'GET', '/receipts'],
    ['ramp_get_receipt', { receipt_id: 'rc1' }, 'GET', '/receipts/rc1'],
    ['ramp_list_gl_accounts', {}, 'GET', '/accounting/accounts'],
    ['ramp_list_statements', {}, 'GET', '/statements'],
    ['ramp_get_statement', { statement_id: 's1' }, 'GET', '/statements/s1'],
    ['ramp_lock_card', { card_id: 'c1' }, 'POST', '/cards/physical/c1/suspension'],
    ['ramp_unlock_card', { card_id: 'c1' }, 'DELETE', '/cards/physical/c1/suspension'],
    ['ramp_update_transaction_memo', { transaction_id: 't1', memo: 'Team offsite' }, 'POST', '/memos/t1'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the documented URL with the OAuth2 token', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('filters and sorts transactions with the documented query parameters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('ramp_list_transactions', { from_date: '2026-09-01T00:00:00Z', requires_memo: true, state: 'ALL', order_by_date_desc: true, page_size: 50, start: 'tx_9' });
    expect(sent().params).toEqual({ from_date: '2026-09-01T00:00:00Z', requires_memo: true, state: 'ALL', order_by_date_desc: true, page_size: 50, start: 'tx_9' });
  });

  it('passes bill status summaries as one comma-separated value', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('ramp_list_bills', { status_summaries: 'APPROVAL_PENDING,PAYMENT_SCHEDULED', payment_status: 'OPEN' });
    expect(sent().paramsSerializer(sent().params)).toBe('status_summaries=APPROVAL_PENDING,PAYMENT_SCHEDULED&payment_status=OPEN');
  });

  it('sends only the memo to /memos and no body to the suspension routes', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('ramp_update_transaction_memo', { transaction_id: 't1', memo: 'Client dinner' });
    expect(sent().data).toEqual({ memo: 'Client dinner' });
    mockedAxios.mockClear();
    await call('ramp_lock_card', { card_id: 'c1' });
    expect(sent().data ?? {}).toEqual({});
  });

  it('pages with page.next and keeps transaction fields that matter', () => {
    const raw = {
      data: [{
        id: 'fd14', amount: 90.0, currency_code: 'USD', state: 'CLEARED', user_transaction_time: '2026-09-01T10:00:00+00:00',
        merchant_name: 'Vanta', merchant_id: 'm1', memo: null, card_id: 'c1', sk_category_name: 'SaaS / Software',
        card_holder: { user_id: 'u1', first_name: 'Patrick', last_name: 'Robinson', department_name: 'Executive', department_id: 'd1', location_name: 'SF' },
        merchant_data: { receipt: [{ description: 'Vanta', total: 5000 }] }, accounting_field_selections: [{ id: 'x' }], limit_id: 'f1',
        receipts: ['rc1'], sync_status: 'SYNCED',
      }],
      page: { next: `${BASE}/transactions?start=fd14&page_size=20` },
    };
    const out = shape('ramp_list_transactions', raw);
    expect(out.next_page).toBe(raw.page.next);
    expect(out.data[0]).toEqual({
      id: 'fd14', amount: 90, currency_code: 'USD', state: 'CLEARED', user_transaction_time: '2026-09-01T10:00:00+00:00',
      merchant_name: 'Vanta', merchant_id: 'm1', memo: null, card_id: 'c1', sk_category_name: 'SaaS / Software',
      card_holder: { user_id: 'u1', first_name: 'Patrick', last_name: 'Robinson', department_name: 'Executive', location_name: 'SF' },
      limit_id: 'f1', receipts: ['rc1'], sync_status: 'SYNCED',
    });
    expect(JSON.stringify(out)).not.toContain('merchant_data');
  });

  it('never hands entity bank accounts, card addresses or vendor bank data to the model', () => {
    const entities = {
      data: [{
        id: 'e1', entity_name: 'Shop Canada', currency: 'CAD', is_primary: true, location_ids: ['l1'],
        connected_subsidiary: { external_id: '426', id: 'cs1', name: 'Ramp Canada Inc.' },
        accounts: [{ bank_account_id: 'ba1', external_name: 'Checking Account' }],
        payment_accounts: [{ account_name: 'Business Checking', account_number_last_four: '6789' }],
      }],
      page: { next: null },
    };
    const e = shape('ramp_list_entities', entities);
    expect(e.data[0]).toEqual({ id: 'e1', entity_name: 'Shop Canada', currency: 'CAD', is_primary: true, location_ids: ['l1'], connected_subsidiary: 'Ramp Canada Inc.' });
    expect(JSON.stringify(e)).not.toMatch(/6789|Checking/);
    const card = {
      id: 'c1', display_name: 'T&E', cardholder_id: 'u1', cardholder_name: 'Julie Phillip', last_four: '3751', state: 'ACTIVE',
      is_suspended: false, is_physical: true, fund_id: 'f1', expiration: '0227', created_at: '2022-05-04T00:00:00+00:00',
      fulfillment: { fulfillment_status: 'ISSUED', shipping: { recipient_address: { address1: '123 Main St', city: 'New York City' } } },
    };
    const c = shape('ramp_get_physical_card', card);
    expect(c).toMatchObject({ id: 'c1', last_four: '3751', fulfillment_status: 'ISSUED', is_suspended: false });
    expect(JSON.stringify(c)).not.toMatch(/Main St|0227/);
    const vendor = {
      id: 'vd1', name: 'Amazon', is_active: true, default_payment_method: { policy: { data: { account_nickname: 'Primary', payment_method: 'ACH', id: 'ba9' }, kind: 'BANK_ACCOUNT' } },
      tax_address: { address_line_1: '442 Good St' }, federal_tax_classification: 'C_CORP', total_spend_ytd: { amount: 100, currency_code: 'USD' },
    };
    const v = shape('ramp_get_vendor', vendor);
    expect(v).toEqual({ id: 'vd1', name: 'Amazon', is_active: true, default_payment_method: 'ACH', total_spend_ytd: { amount: 100, currency_code: 'USD' } });
  });

  it('leaves the statement lines out of a statement', () => {
    const st = { id: 's1', start_date: '2023-05-06', end_date: '2023-05-08', charges: { amount: 1, currency_code: 'USD' }, statement_url: 'https://x/s.pdf', statement_lines: [{ id: 'l1', type: 'CARD_TRANSACTION' }] };
    expect(shape('ramp_get_statement', st)).toEqual({ id: 's1', start_date: '2023-05-06', end_date: '2023-05-08', charges: st.charges, statement_url: st.statement_url });
  });
});

const live = process.env.RUN_RAMP_LIVE === '1' ? describe : describe.skip;
live('ramp adapter: live', () => {
  const real = !!(process.env.RAMP_CLIENT_ID && process.env.RAMP_CLIENT_SECRET);
  const host = process.env.RAMP_API_HOST ?? HOST;
  const base = `${host}/developer/v1`;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['ramp_get_business', {}],
    ['ramp_list_transactions', { page_size: 2 }],
    ['ramp_list_bills', { page_size: 2 }],
    ['ramp_lock_card', { card_id: 'amcp-none' }],
  ])('%s reaches Ramp and is refused with a made-up token (JSON 404 DEVELOPER_7002)', async (name, params) => {
    await expect(call(name, params, { base: `${HOST}/developer/v1` })).rejects.toMatchObject({
      response: { status: 404, data: { error_v2: { error_code: 'DEVELOPER_7002' } } },
    });
  }, 30000);

  it('answers an HTML 404 on a made-up route (Ramp routes before it checks the token)', async () => {
    const err = await run({ method: 'GET', path: '/amcp-no-such-route' }, {}, { base: `${HOST}/developer/v1` }).catch((e) => e);
    expect(err.response.status).toBe(404);
    expect(typeof err.response.data).toBe('string');
    expect(err.response.data).toMatch(/Not Found/);
  }, 30000);

  it('refuses made-up client credentials at the token endpoint', async () => {
    const res = await mockedAxios.__actual.post(`${HOST}/developer/v1/token`, `grant_type=client_credentials&scope=business:read`, {
      auth: { username: 'amcp-fake-client', password: 'amcp-fake-secret' },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
    });
    expect([400, 401]).toContain(res.status);
    expect(res.data.access_token).toBeUndefined();
  }, 30000);

  const withToken = async (scopes = a.connector.authConfig.scopes) => {
    const service = new OAuth2TokenService({} as PrismaService, { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService);
    const authConfig = interpolateDeep({ ...a.connector.authConfig, tokenUrl: `${base}/token`, scopes }, {
      RAMP_CLIENT_ID: process.env.RAMP_CLIENT_ID!,
      RAMP_CLIENT_SECRET: process.env.RAMP_CLIENT_SECRET!,
    });
    const token = await service.getAccessToken(authConfig);
    expect(token).toBeTruthy();
    return token as string;
  };

  (real ? it : it.skip)('gets a token with the read scopes and reads business, users, cards, funds, transactions, bills and vendors', async () => {
    const token = await withToken();
    const opts = { token, base };
    const business = await shaped('ramp_get_business', {}, opts);
    expect(typeof business.id).toBe('string');
    const users = await shaped('ramp_list_users', { page_size: 5 }, opts);
    expect(Array.isArray(users.data)).toBe(true);
    const cards = await shaped('ramp_list_physical_cards', { page_size: 5 }, opts);
    expect(JSON.stringify(cards)).not.toMatch(/recipient_address|expiration/);
    const funds = await shaped('ramp_list_funds', { page_size: 5 }, opts);
    expect(Array.isArray(funds.data)).toBe(true);
    const txs = await shaped('ramp_list_transactions', { page_size: 5, order_by_date_desc: true }, opts);
    expect(Array.isArray(txs.data)).toBe(true);
    if (txs.data[0]) {
      const one = await shaped('ramp_get_transaction', { transaction_id: txs.data[0].id }, opts);
      expect(one.id).toBe(txs.data[0].id);
    }
    const bills = await shaped('ramp_list_bills', { page_size: 5 }, opts);
    expect(Array.isArray(bills.data)).toBe(true);
    const vendors = await shaped('ramp_list_vendors', { page_size: 5 }, opts);
    expect(Array.isArray(vendors.data)).toBe(true);
    const entities = await shaped('ramp_list_entities', {}, opts);
    expect(JSON.stringify(entities)).not.toMatch(/payment_accounts|account_number/);
  }, 120000);

  const writes = real && process.env.RUN_RAMP_LIVE_WRITES === '1';
  (writes ? it : it.skip)('writes the newest transaction memo back unchanged (no card is suspended)', async () => {
    const token = await withToken(`${a.connector.authConfig.scopes} memos:write`);
    const opts = { token, base };
    const txs = await shaped('ramp_list_transactions', { page_size: 2, order_by_date_desc: true }, opts);
    const tx = txs.data.find((t: { memo?: string | null }) => t.memo);
    if (!tx) return;
    const out = await shaped('ramp_update_transaction_memo', { transaction_id: tx.id, memo: tx.memo }, opts);
    expect(out.memo).toBe(tx.memo);
  }, 60000);
});
