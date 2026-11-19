import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import * as adapter from './finapi.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * finAPI Access (Open Banking, account information) adapter.
 *
 * Static checks always run: the Live and Sandbox hosts offered as a choice,
 * the OAuth2 password grant (client id and secret in the form body plus the
 * finAPI user's id and password), every tool's path against finAPI's published
 * OpenAPI document (https://live.finapi.io/api-docs/openapi-access-v2.yaml),
 * and that the adapter is read-only: GET calls only, nothing under payments,
 * no bank import or update, no user management.
 * https://docs.finapi.io/
 *
 * Live checks run only with RUN_FINAPI_LIVE=1. Without credentials they
 * confirm that the sandbox token endpoint refuses an unknown client; with
 * FINAPI_CLIENT_ID, FINAPI_CLIENT_SECRET, FINAPI_USER_ID and
 * FINAPI_USER_PASSWORD (sandbox) they read the accounts. Reads only.
 *
 *   RUN_FINAPI_LIVE=1 FINAPI_CLIENT_ID=... FINAPI_CLIENT_SECRET=... FINAPI_USER_ID=... FINAPI_USER_PASSWORD=... \
 *     npx jest src/adapters/de/finapi.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; type?: string; pattern?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
    envDefaults?: Record<string, string>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
  responseMapping?: { transform?: { exclude?: string[] } };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  aliases?: string[];
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: { errorWhen?: unknown };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
// Every argument a mapping reads: {path} parts, "$name" values and ${name} in strings.
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const ENV: Record<string, string> = {
  FINAPI_HOST: 'https://sandbox.finapi.io',
  FINAPI_CLIENT_ID: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
  FINAPI_CLIENT_SECRET: 'test-client-secret-0123456789',
  FINAPI_USER_ID: 'test-user',
  FINAPI_USER_PASSWORD: 'test-user-password',
};

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
      errorWhen: a.connector.config?.errorWhen,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
// The query string as it goes over the wire, percent-decoded for reading.
const wire = (req: { params: Record<string, unknown>; paramsSerializer: (p: Record<string, unknown>) => string }) =>
  decodeURIComponent(req.paramsSerializer(req.params));

// name, HTTP method, path
const TOOLS: Array<[string, string, string]> = [
  ['finapi_list_accounts', 'GET', '/api/v2/accounts'],
  ['finapi_get_account', 'GET', '/api/v2/accounts/{account_id}'],
  ['finapi_get_daily_balances', 'GET', '/api/v2/accounts/dailyBalances'],
  ['finapi_list_bank_balances', 'GET', '/api/v2/accounts/balances'],
  ['finapi_list_transactions', 'GET', '/api/v2/transactions'],
  ['finapi_get_transaction', 'GET', '/api/v2/transactions/{transaction_id}'],
  ['finapi_list_pending_transactions', 'GET', '/api/v2/pendingTransactions'],
  ['finapi_get_cash_flows', 'GET', '/api/v2/categories/cashFlows'],
  ['finapi_list_bank_connections', 'GET', '/api/v2/bankConnections'],
  ['finapi_get_bank_connection', 'GET', '/api/v2/bankConnections/{bank_connection_id}'],
  ['finapi_search_banks', 'GET', '/api/v2/banks'],
  ['finapi_get_bank', 'GET', '/api/v2/banks/{bank_id}'],
  ['finapi_list_categories', 'GET', '/api/v2/categories'],
  ['finapi_get_category', 'GET', '/api/v2/categories/{category_id}'],
  ['finapi_list_labels', 'GET', '/api/v2/labels'],
  ['finapi_list_securities', 'GET', '/api/v2/securities'],
  ['finapi_get_security', 'GET', '/api/v2/securities/{security_id}'],
  ['finapi_list_standing_orders', 'GET', '/api/v2/bankSideStandingOrders'],
  ['finapi_get_user', 'GET', '/api/v2/users'],
];
const REQUIRED: Record<string, string[]> = {
  finapi_get_account: ['account_id'],
  finapi_get_transaction: ['transaction_id'],
  finapi_get_bank_connection: ['bank_connection_id'],
  finapi_get_bank: ['bank_id'],
  finapi_get_category: ['category_id'],
  finapi_get_security: ['security_id'],
};
const OFF: string[] = [];

describe('finapi adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('offers Live and Sandbox and signs in with the password grant', () => {
    expect(a.slug).toBe('finapi');
    expect(a.region).toBe('de');
    expect(a.category).toBe('banking');
    expect(a.icon).toBe('finapi');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{FINAPI_HOST}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'password',
      tokenUrl: '{{FINAPI_HOST}}/api/v2/oauth/token',
      clientId: '{{FINAPI_CLIENT_ID}}',
      clientSecret: '{{FINAPI_CLIENT_SECRET}}',
      username: '{{FINAPI_USER_ID}}',
      password: '{{FINAPI_USER_PASSWORD}}',
      tokenAuthMethod: 'client_secret_post',
    });
    expect(a.requiredEnvVars).toEqual(['FINAPI_HOST', 'FINAPI_CLIENT_ID', 'FINAPI_CLIENT_SECRET', 'FINAPI_USER_ID', 'FINAPI_USER_PASSWORD']);
    expect(a.envVarMeta.FINAPI_HOST.options).toEqual([
      { value: 'https://live.finapi.io', label: 'Live' },
      { value: 'https://sandbox.finapi.io', label: 'Sandbox' },
    ]);
    expect(a.envVarMeta.FINAPI_HOST.secret).toBeUndefined();
    expect(a.envVarMeta.FINAPI_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.FINAPI_USER_PASSWORD).toMatchObject({ kind: 'credential', secret: true });
    for (const name of a.requiredEnvVars) {
      const pattern = a.envVarMeta[name].pattern;
      if (pattern) expect([name, new RegExp(pattern).test(ENV[name])]).toEqual([name, true]);
    }
    expect(a.probe).toEqual({ tool: 'finapi_list_accounts', params: {} });
    for (const key of ['401', '403', '404', '423', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('only reads account information: no payments, imports, deletes or user management', () => {
    const allowed = /^\/api\/v2\/(accounts|transactions|pendingTransactions|categories|bankConnections|banks|labels|securities|bankSideStandingOrders|users)(\/|$)/;
    for (const entry of a.tools) {
      expect([entry.name, entry.endpointMapping.method]).toEqual([entry.name, 'GET']);
      expect(entry.endpointMapping.path).toMatch(allowed);
      expect(entry.endpointMapping.path).not.toMatch(/payments|standingOrders\/|import|update|connectInterface|webForms|mandatorAdmin|oauth/);
      expect(entry.endpointMapping.bodyMapping).toBeUndefined();
      expect(entry.enabled).toBeUndefined();
    }
    for (const name of a.tools.map((entry) => entry.name)) expect(name).not.toMatch(/pay|transfer|debit|delete|create|edit|import/);
    // The user read hides the password field (finAPI answers it as XXXXX).
    expect(tool('finapi_get_user').responseMapping?.transform?.exclude).toEqual(['password']);
  });

  it('requests the user token with the password grant, client id and secret in the form body', async () => {
    const service = new OAuth2TokenService(
      {} as PrismaService,
      { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService,
    );
    const post = jest
      .spyOn(mockedAxios as unknown as typeof axios, 'post')
      .mockResolvedValue({ data: { access_token: 'user-token', token_type: 'bearer', refresh_token: 'refresh', expires_in: 3600, scope: 'all' } });
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).resolves.toBe('user-token');
    const [url, body, options] = post.mock.calls[0] as unknown as [string, string, { headers: Record<string, string> }];
    expect(url).toBe('https://sandbox.finapi.io/api/v2/oauth/token');
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: 'password',
      username: ENV.FINAPI_USER_ID,
      password: ENV.FINAPI_USER_PASSWORD,
      client_id: ENV.FINAPI_CLIENT_ID,
      client_secret: ENV.FINAPI_CLIENT_SECRET,
    });
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(options.headers.Authorization).toBeUndefined();
    post.mockRestore();
  });

  it('pins every tool to its documented method and path', () => {
    expect(a.tools.map((entry) => [entry.name, entry.endpointMapping.method, entry.endpointMapping.path])).toEqual(TOOLS);
  });

  it('requires exactly the documented parameters', () => {
    for (const entry of a.tools) expect([entry.name, entry.parameters.required ?? []]).toEqual([entry.name, REQUIRED[entry.name] ?? []]);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^finapi_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const arg of declared) expect([entry.name, arg, used(entry).has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, def] of Object.entries(entry.parameters.properties ?? {})) expect([param, Boolean(def.description)]).toEqual([param, true]);
      expect(entry.description.length).toBeGreaterThan(60);
    }
  });

  it('marks reads read-only and installs only the listed tools switched off', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET';
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, read]);
    }
    expect(a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name).sort()).toEqual([...OFF].sort());
  });

  it('names every tool in the instructions and keeps the text free of MDX traps', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const outsideCode = (text: string) => text.replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, ...a.tools.map((entry) => entry.description)]) {
      expect(outsideCode(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/\u2014/);
    }
  });

  it('reads accounts, transactions and balances on the chosen host with the user token', async () => {
    ok({ accounts: [] });
    await call('finapi_list_accounts', { account_types: 'Checking,Savings' });
    const req = sent();
    expect(req.url).toBe('https://sandbox.finapi.io/api/v2/accounts');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
    expect(wire(req)).toBe('accountTypes=Checking,Savings');

    ok({ transactions: [], paging: {} });
    await call('finapi_list_transactions', { account_ids: '12,15', min_bank_booking_date: '2026-10-01', direction: 'spending', order: 'bankBookingDate,desc' });
    expect(sent().url).toBe('https://sandbox.finapi.io/api/v2/transactions');
    expect(wire(sent())).toBe('view=userView&accountIds=12,15&minBankBookingDate=2026-10-01&direction=spending&page=1&perPage=20&order=bankBookingDate,desc');

    ok({});
    await call('finapi_get_transaction', { transaction_id: 4711 });
    expect(sent().url).toBe('https://sandbox.finapi.io/api/v2/transactions/4711');

    ok({ dailyBalances: [], paging: {} });
    await call('finapi_get_daily_balances', { account_ids: '12', start_date: '2026-01-01', end_date: '2026-10-31' });
    expect(sent().url).toBe('https://sandbox.finapi.io/api/v2/accounts/dailyBalances');
    expect(sent().params).toEqual({ accountIds: '12', startDate: '2026-01-01', endDate: '2026-10-31', page: 1, perPage: 20 });

    ok({ cashFlows: [] });
    await call('finapi_get_cash_flows', { category_ids: '378', min_bank_booking_date: '2026-01-01', max_bank_booking_date: '2026-12-31' });
    expect(sent().url).toBe('https://sandbox.finapi.io/api/v2/categories/cashFlows');
    expect(sent().params).toEqual({ minBankBookingDate: '2026-01-01', maxBankBookingDate: '2026-12-31', direction: 'all', categoryIds: '378' });

    ok({ banks: [], paging: {} });
    await call('finapi_search_banks', { search: 'DE89370400440532013000', location: 'DE' });
    expect(sent().url).toBe('https://sandbox.finapi.io/api/v2/banks');
    expect(sent().params).toEqual({ search: 'DE89370400440532013000', location: 'DE', page: 1, perPage: 20 });
  });

  it('accepts comma-separated id lists and refuses nothing the API allows', () => {
    const ids = new RegExp(tool('finapi_list_transactions').parameters.properties!.account_ids.pattern!);
    for (const good of ['12', '12,15', '1,2,3']) expect(ids.test(good)).toBe(true);
    for (const bad of ['', '12,', 'a,b', '12 15']) expect(ids.test(bad)).toBe(false);
    const types = new RegExp(tool('finapi_list_accounts').parameters.properties!.account_types.pattern!);
    for (const good of ['Checking', 'Checking,Savings,CreditCard', 'Security,Loan,Membership,Bausparen']) expect(types.test(good)).toBe(true);
    expect(types.test('checking')).toBe(false);
  });
});

// Opt-in: RUN_FINAPI_LIVE=1, against the sandbox only. The refusal check
// needs no account; the read needs sandbox client credentials and a sandbox
// user. Nothing is written.
const live = process.env.RUN_FINAPI_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('finapi: live (sandbox)', () => {
  const tokenUrl = 'https://sandbox.finapi.io/api/v2/oauth/token';
  const form = { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, validateStatus: () => true };

  it('refuses an unknown client at the token endpoint', async () => {
    const response = await liveFetch.post(tokenUrl, 'grant_type=client_credentials&client_id=not-a-client&client_secret=not-a-secret', form);
    expect([400, 401]).toContain(response.status);
  });

  it('reads the accounts of the sandbox user', async () => {
    const { FINAPI_CLIENT_ID: id, FINAPI_CLIENT_SECRET: secret, FINAPI_USER_ID: user, FINAPI_USER_PASSWORD: password } = process.env;
    if (!id || !secret || !user || !password) return;
    const body = new URLSearchParams({ grant_type: 'password', client_id: id, client_secret: secret, username: user, password }).toString();
    const token = await liveFetch.post(tokenUrl, body, form);
    expect(token.status).toBe(200);
    const accounts = await liveFetch.get('https://sandbox.finapi.io/api/v2/accounts', {
      headers: { Authorization: `Bearer ${token.data.access_token}`, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(accounts.status).toBe(200);
    expect(Array.isArray(accounts.data.accounts)).toBe(true);
  });
});
