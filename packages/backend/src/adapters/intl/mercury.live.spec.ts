import axios from 'axios';
import * as adapter from './mercury.json';
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
 * Two layers of verification for the Mercury adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with the API token, every tool's
 *      method, URL, query and body through the real RestEngine, checked
 *      against the OpenAPI definitions Mercury publishes per operation
 *      (docs.mercury.com/reference/*.md, read 15 Oct 2026). Also that no tool
 *      can move money (none of Mercury's send-money, transfer or request
 *      routes is used), that the three actions ask for confirmation and ship
 *      switched off, and that account, routing, IBAN and card numbers never
 *      reach the model.
 *
 *   2. Live: skipped unless RUN_MERCURY_LIVE=1. Without a token it checks
 *      that Mercury refuses a made-up token with 401 noTokenInDB on the real
 *      routes while a made-up route answers 404 (Mercury routes before it
 *      checks the token). With MERCURY_API_TOKEN (a Read Only token;
 *      MERCURY_API_HOST=https://api-sandbox.mercury.com for the sandbox) it
 *      reads the organization, accounts, transactions, cards, statements,
 *      recipients and users, shaped by each tool's response mapping. Nothing
 *      is written unless RUN_MERCURY_LIVE_WRITES=1 too: then the note of the
 *      newest transaction is written back unchanged (needs a token allowed to
 *      update transactions, from an allow-listed IP). No card is ever frozen.
 *
 *        RUN_MERCURY_LIVE=1 MERCURY_API_TOKEN=secret-token:... npx jest src/adapters/intl/mercury.live.spec.ts
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

const BASE = 'https://api.mercury.com/api/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'secret-token:mercury_production_' + 'amcp0'.repeat(8);
const ENV: Record<string, string> = { MERCURY_API_TOKEN: FAKE_TOKEN };
const UUID = '00000000-0000-4000-8000-000000000000';

const run = (mapping: Tool['endpointMapping'], params: Record<string, unknown>, env = ENV, schema?: Tool['parameters'], base?: string) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: base ?? a.connector.baseUrl, headers: a.connector.headers },
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
const call = (name: string, params: Record<string, unknown>, env = ENV, base?: string) =>
  run(tool(name).endpointMapping, params, env, tool(name).parameters, base);
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, env = ENV, base?: string) => shape(name, await call(name, params, env, base));
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => sent().paramsSerializer(sent().params) as string;

const WRITES = ['mercury_freeze_card', 'mercury_unfreeze_card', 'mercury_update_transaction'];

describe('mercury adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('banking');
    expect(a.icon).toBe('mercury');
  });

  it('calls api.mercury.com/api/v1 with the token as Bearer and checks it on /organization', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{MERCURY_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/organization');
    expect(a.probe).toEqual({ tool: 'mercury_get_organization' });
    expect(a.requiredEnvVars).toEqual(['MERCURY_API_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.MERCURY_API_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.MERCURY_API_TOKEN.pattern!);
    expect(pattern.test(FAKE_TOKEN)).toBe(true);
    // The documented token keeps its secret-token: prefix.
    expect(pattern.test('mercury_production_abc')).toBe(false);
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/noTokenInDB/);
  });

  it('prefixes every tool with mercury_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^mercury_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('cannot move money: no send-money, transfer, recipient, invoice or card-issuing write', () => {
    for (const t of a.tools) {
      const { method, path } = t.endpointMapping;
      expect(path).not.toMatch(/transfer|internal|reveal|vault|pan|safe|invoice|customer|webhook|attachment/i);
      if (method !== 'GET') {
        expect(WRITES).toContain(t.name);
        // POST /account/{id}/transactions is Mercury's send-money route.
        expect(path).not.toMatch(/send-money|\/transactions$|recipient|\/cards$|cancel|categories/);
      }
      // The one send-money path in use is the read-only approval-request list.
      if (/send-money/.test(path)) expect(`${method} ${path}`).toBe('GET /request-send-money');
    }
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => `${t.endpointMapping.method} ${t.endpointMapping.path}`).sort()).toEqual([
      'PATCH /transaction/{transactionId}',
      'POST /cards/{cardId}/freeze',
      'POST /cards/{cardId}/unfreeze',
    ]);
    expect(a.instructions).toMatch(/\*\*It cannot send money, by design\.\*\*/);
    expect(a.instructions).toMatch(/Never give this connector a Read and Write token/);
    expect(a.description).toMatch(/cannot send money/);
  });

  it('marks only the three actions as writes, ships them off and asks for confirmation', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const name of WRITES) {
      expect(tool(name).description).toMatch(/confirm/i);
      expect(tool(name).description).toMatch(/switched off/);
    }
    expect(annotationsOf(tool('mercury_freeze_card'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsOf(tool('mercury_update_transaction'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('recommends a Read Only token, says financial data is sensitive and writes no em dashes', () => {
    expect(a.instructions).toMatch(/choose \*\*Read Only\*\*/);
    expect(a.instructions).toMatch(/\*\*Financial data is sensitive\.\*\*/);
    expect(a.instructions).toContain('https://api-sandbox.mercury.com/api/v1');
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmercury_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmercury_[a-z_]+/g)]),
    ]
      .map((m) => m[0])
      // The token format `secret-token:mercury_production_...` is not a tool.
      .filter((m) => m !== 'mercury_production_');
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
    ['mercury_get_organization', {}, 'GET', '/organization'],
    ['mercury_list_accounts', {}, 'GET', '/accounts'],
    ['mercury_get_account', { accountId: UUID }, 'GET', `/account/${UUID}`],
    ['mercury_list_account_transactions', { accountId: UUID }, 'GET', `/account/${UUID}/transactions`],
    ['mercury_list_transactions', {}, 'GET', '/transactions'],
    ['mercury_get_transaction', { transactionId: UUID }, 'GET', `/transaction/${UUID}`],
    ['mercury_list_cards', {}, 'GET', '/cards'],
    ['mercury_get_card', { cardId: UUID }, 'GET', `/cards/${UUID}`],
    ['mercury_list_account_cards', { accountId: UUID }, 'GET', `/account/${UUID}/cards`],
    ['mercury_list_account_statements', { accountId: UUID }, 'GET', `/account/${UUID}/statements`],
    ['mercury_list_recipients', {}, 'GET', '/recipients'],
    ['mercury_get_recipient', { recipientId: UUID }, 'GET', `/recipient/${UUID}`],
    ['mercury_list_treasury_accounts', {}, 'GET', '/treasury'],
    ['mercury_list_treasury_transactions', { treasuryId: UUID }, 'GET', `/treasury/${UUID}/transactions`],
    ['mercury_list_treasury_statements', { treasuryId: UUID }, 'GET', `/treasury/${UUID}/statements`],
    ['mercury_list_credit_accounts', {}, 'GET', '/credit'],
    ['mercury_list_users', {}, 'GET', '/users'],
    ['mercury_list_categories', {}, 'GET', '/categories'],
    ['mercury_list_payment_approval_requests', {}, 'GET', '/request-send-money'],
    ['mercury_freeze_card', { cardId: UUID }, 'POST', `/cards/${UUID}/freeze`],
    ['mercury_unfreeze_card', { cardId: UUID }, 'POST', `/cards/${UUID}/unfreeze`],
    ['mercury_update_transaction', { transactionId: UUID, note: 'Annual renewal' }, 'PATCH', `/transaction/${UUID}`],
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
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('filters transactions across accounts with repeated accountId and status parameters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mercury_list_transactions', { accountId: ['a1', 'a2'], status: ['sent', 'pending'], start: '2026-09-01', order: 'desc' });
    expect(sent().params).toEqual({ accountId: ['a1', 'a2'], status: ['sent', 'pending'], start: '2026-09-01', order: 'desc', limit: 100 });
    expect(query()).toBe('accountId=a1&accountId=a2&status=sent&status=pending&start=2026-09-01&limit=100&order=desc');
  });

  it('pages one account with offset and filters by date and search text', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mercury_list_account_transactions', { accountId: UUID, start: '2026-09-01', end: '2026-09-30', search: 'AWS', offset: 100 });
    expect(sent().params).toEqual({ start: '2026-09-01', end: '2026-09-30', search: 'AWS', offset: 100, limit: 100 });
  });

  it('updates only the fields given and freezes without a body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mercury_update_transaction', { transactionId: UUID, note: 'Annual renewal' });
    expect(sent().data).toEqual({ note: 'Annual renewal' });
    mockedAxios.mockClear();
    await call('mercury_update_transaction', { transactionId: UUID, categoryId: 'cat_1' });
    expect(sent().data).toEqual({ categoryId: 'cat_1' });
    mockedAxios.mockClear();
    await call('mercury_freeze_card', { cardId: UUID });
    expect(sent().data ?? {}).toEqual({});
  });

  it('never hands account or routing numbers to the model', () => {
    const account = {
      id: 'acc_1', name: 'Mercury Checking ••1234', status: 'active', type: 'mercury', kind: 'checking',
      accountNumber: '202512341234', routingNumber: '091311229', availableBalance: 1500.25, currentBalance: 1600,
      legalBusinessName: 'Acme Inc.', createdAt: '2024-01-01T00:00:00Z', dashboardLink: 'https://app.mercury.com/x',
      canReceiveTransactions: true, canSendRealTimePayments: false,
    };
    const one = shape('mercury_get_account', account);
    expect(one).toMatchObject({ id: 'acc_1', availableBalance: 1500.25, currentBalance: 1600 });
    const list = shape('mercury_list_accounts', { accounts: [account], page: { nextPage: 'acc_2' } });
    expect(list.page).toEqual({ nextPage: 'acc_2' });
    const statements = shape('mercury_list_account_statements', {
      statements: [{ id: 'st_1', startDate: '2026-09-01', endDate: '2026-09-30', endingBalance: 1600, accountNumber: '202512341234', routingNumber: '091311229', ein: '12-3456789', companyLegalName: 'Acme Inc.', companyLegalAddress: {}, downloadUrl: 'https://x/st.pdf', transactions: [{ id: 't1' }] }],
      page: {},
    });
    expect(statements.statements[0]).toEqual({ id: 'st_1', startDate: '2026-09-01', endDate: '2026-09-30', endingBalance: 1600, companyLegalName: 'Acme Inc.', downloadUrl: 'https://x/st.pdf' });
    expect(JSON.stringify([one, list, statements])).not.toMatch(/202512341234|091311229|12-3456789/);
    for (const name of ['mercury_get_account', 'mercury_list_accounts', 'mercury_list_account_statements']) {
      expect(tool(name).responseMapping!.transform.fallbackToRaw).toBe(false);
    }
  });

  it('drops counterparty bank details from transactions and recipients', () => {
    const tx = {
      id: 't1', accountId: 'acc_1', amount: -120.5, status: 'sent', kind: 'outgoingPayment', createdAt: '2026-09-01T00:00:00Z',
      counterpartyId: 'r1', counterpartyName: 'Acme Supplies', note: null, categoryData: { id: 'cat_1', name: 'Software' },
      details: { electronicRoutingInfo: { accountNumber: '987654321', routingNumber: '021000021', electronicAccountType: 'businessChecking' } },
      attachments: [{ fileName: 'receipt.pdf', url: 'https://x/r.pdf', attachmentType: 'receipt' }],
    };
    const one = shape('mercury_get_transaction', tx);
    expect(one).toMatchObject({ id: 't1', amount: -120.5, category: 'Software', categoryId: 'cat_1', attachments: tx.attachments });
    const list = shape('mercury_list_transactions', { transactions: [tx], page: {} });
    const recipient = {
      id: 'r1', name: 'Acme Supplies', status: 'active', emails: ['ap@acme.example'], defaultPaymentMethod: 'ach', isBusiness: true,
      electronicRoutingInfo: { accountNumber: '987654321', routingNumber: '021000021', bankName: 'Chase', electronicAccountType: 'businessChecking' },
      internationalWireRoutingInfo: { iban: 'DE89370400440532013000', swiftCode: 'COBADEFFXXX' }, attachments: [],
    };
    const r = shape('mercury_get_recipient', recipient);
    expect(r).toEqual({ id: 'r1', name: 'Acme Supplies', status: 'active', isBusiness: true, emails: ['ap@acme.example'], defaultPaymentMethod: 'ach', bankName: 'Chase' });
    const rl = shape('mercury_list_recipients', { recipients: [recipient], total: 1, page: {} });
    expect(rl.total).toBe(1);
    expect(JSON.stringify([one, list, r, rl])).not.toMatch(/987654321|021000021|DE89|COBADEFF/);
  });

  it('keeps the last four card digits and drops the expiry', () => {
    const card = { id: 'card_1', accountId: 'acc_1', lastFour: '4242', nameOnCard: 'Ada L', status: 'active', type: 'virtual', kind: 'debit', userId: 'u1', expiration: { month: 8, year: 2029 }, spendLimitType: 'cardLimit', budgets: [], categoryLocks: [], isAgentCard: false };
    const out = shape('mercury_get_card', card);
    expect(out).toMatchObject({ id: 'card_1', lastFour: '4242', status: 'active' });
    expect(JSON.stringify(out)).not.toMatch(/2029/);
  });
});

const live = process.env.RUN_MERCURY_LIVE === '1' ? describe : describe.skip;
live('mercury adapter: live', () => {
  const real = !!process.env.MERCURY_API_TOKEN;
  const env = () => ({ MERCURY_API_TOKEN: process.env.MERCURY_API_TOKEN! });
  const base = process.env.MERCURY_API_HOST ? `${process.env.MERCURY_API_HOST}/api/v1` : undefined;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['mercury_get_organization', {}],
    ['mercury_list_accounts', {}],
    ['mercury_list_transactions', { limit: 1 }],
    ['mercury_list_recipients', { limit: 1 }],
    ['mercury_freeze_card', { cardId: UUID }],
    ['mercury_update_transaction', { transactionId: UUID, note: 'x' }],
  ])('%s reaches Mercury and is refused with a made-up token (401 noTokenInDB)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401, data: { errors: { errorCode: 'noTokenInDB' } } } });
  }, 30000);

  it('answers 404 on a made-up route with the same token (routing comes before the token check)', async () => {
    await expect(run({ method: 'GET', path: '/amcp-no-such-route' }, {})).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (real ? it : it.skip)('reads the organization, accounts, transactions, cards, statements, recipients and users', async () => {
    const org = await shaped('mercury_get_organization', {}, env(), base);
    expect(typeof org.legalBusinessName).toBe('string');
    const accounts = await shaped('mercury_list_accounts', {}, env(), base);
    expect(JSON.stringify(accounts)).not.toMatch(/accountNumber|routingNumber/);
    const first = accounts.accounts[0];
    if (first) {
      const txs = await shaped('mercury_list_account_transactions', { accountId: first.id, limit: 5 }, env(), base);
      expect(Array.isArray(txs.transactions)).toBe(true);
      expect(JSON.stringify(txs)).not.toMatch(/"details"/);
      if (txs.transactions[0]) {
        const one = await shaped('mercury_get_transaction', { transactionId: txs.transactions[0].id }, env(), base);
        expect(one.id).toBe(txs.transactions[0].id);
      }
      const statements = await shaped('mercury_list_account_statements', { accountId: first.id, limit: 3 }, env(), base);
      expect(JSON.stringify(statements)).not.toMatch(/accountNumber|routingNumber/);
    }
    const all = await shaped('mercury_list_transactions', { limit: 5, order: 'desc' }, env(), base);
    expect(Array.isArray(all.transactions)).toBe(true);
    const cards = await shaped('mercury_list_cards', { limit: 5 }, env(), base);
    expect(Array.isArray(cards.cards)).toBe(true);
    const recipients = await shaped('mercury_list_recipients', { limit: 5 }, env(), base);
    expect(JSON.stringify(recipients)).not.toMatch(/accountNumber|routingNumber|iban/);
    const users = await shaped('mercury_list_users', {}, env(), base);
    expect(Array.isArray(users.users)).toBe(true);
  }, 120000);

  const writes = real && process.env.RUN_MERCURY_LIVE_WRITES === '1';
  (writes ? it : it.skip)('writes the newest transaction note back unchanged (no card is frozen)', async () => {
    const all = await shaped('mercury_list_transactions', { limit: 5, order: 'desc' }, env(), base);
    const tx = all.transactions.find((t: { note?: string | null }) => t.note);
    if (!tx) return;
    const out = await shaped('mercury_update_transaction', { transactionId: tx.id, note: tx.note }, env(), base);
    expect(out.note).toBe(tx.note);
  }, 60000);
});
