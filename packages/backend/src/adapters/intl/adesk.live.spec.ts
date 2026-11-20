import axios from 'axios';
import * as adapter from './adesk.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { assertNoResponseBodyError, ResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Adesk public API v1 adapter (https://api.adesk.ru/v1, api_token in the query).
 *
 * Static checks always run: the token as the api_token query parameter on
 * reads and writes alike, every tool's method and path against Adesk's API
 * description, the form-encoded write bodies, the rules that turn Adesk's
 * HTTP 200 error bodies into failed calls, and which tools install switched
 * off. Every write is a bookkeeping record: no tool moves money.
 * https://adesk.ru/api-docs/
 *
 * Live checks run only with RUN_ADESK_LIVE=1. Without a token one call
 * confirms the "Auth required" answer (HTTP 200, code 401); with
 * ADESK_API_TOKEN it reads the legal entities and the accounts. Reads only.
 * Never send a made-up token: Adesk locks an address out after a few.
 *
 *   RUN_ADESK_LIVE=1 ADESK_API_TOKEN=... npx jest src/adapters/intl/adesk.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config: { errorWhen: unknown };
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

const ENV: Record<string, string> = { ADESK_API_TOKEN: 'test-token-0123456789abcdef0123456789' };
const BASE = 'https://api.adesk.ru/v1';
const AUTH = { api_token: ENV.ADESK_API_TOKEN };

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: { success: true }, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const formOf = (req: { data?: unknown }) => Object.fromEntries(new URLSearchParams(String(req.data ?? '')));

// name, method, path, required parameters: as in Adesk's API description (v1).
const CONTRACT: Array<[string, string, string, string[]]> = [
  ['adesk_list_transactions', 'GET', '/transactions', []],
  ['adesk_get_transaction', 'GET', '/transaction/{transaction_id}', ['transaction_id']],
  ['adesk_create_transaction', 'POST', '/transaction', ['date', 'type', 'amount', 'bank_account']],
  ['adesk_update_transaction', 'POST', '/transaction/{transaction_id}', ['transaction_id', 'date', 'amount', 'bank_account']],
  ['adesk_complete_transaction', 'POST', '/transaction/{transaction_id}/complete', ['transaction_id']],
  ['adesk_delete_transaction', 'POST', '/transaction/{transaction_id}/remove', ['transaction_id']],
  ['adesk_list_transaction_categories', 'GET', '/transactions/categories', []],
  ['adesk_save_transaction_category', 'POST', '/transactions/category', ['name', 'type', 'kind']],
  ['adesk_list_bank_accounts', 'GET', '/bank-accounts', []],
  ['adesk_get_bank_account', 'GET', '/bank-account/{bank_account_id}', ['bank_account_id']],
  ['adesk_create_bank_account', 'POST', '/bank-account', ['name', 'currency', 'legal_entity']],
  ['adesk_list_legal_entities', 'GET', '/legal-entities', []],
  ['adesk_get_legal_entity', 'GET', '/legal-entity/{legal_entity_id}', ['legal_entity_id']],
  ['adesk_list_contractors', 'GET', '/contractors', []],
  ['adesk_get_contractor', 'GET', '/contractor/{contractor_id}', ['contractor_id']],
  ['adesk_list_contractor_commitments', 'GET', '/contractor/{contractor_id}/commitments', ['contractor_id']],
  ['adesk_list_contractor_requisites', 'GET', '/contractor/{contractor_id}/requisites', ['contractor_id']],
  ['adesk_create_contractor', 'POST', '/contractor', ['name']],
  ['adesk_update_contractor', 'POST', '/contractor/{contractor_id}', ['contractor_id']],
  ['adesk_delete_contractor', 'POST', '/contractor/{contractor_id}/remove', ['contractor_id']],
  ['adesk_list_projects', 'GET', '/projects', []],
  ['adesk_get_project', 'GET', '/project/{project_id}', ['project_id']],
  ['adesk_get_project_stats', 'GET', '/projects/{project_id}/stats', ['project_id']],
  ['adesk_create_project', 'POST', '/project', ['name']],
  ['adesk_update_project', 'POST', '/project/{project_id}', ['project_id']],
  ['adesk_list_project_categories', 'GET', '/projects/categories', []],
  ['adesk_list_commitments', 'POST', '/commitments', []],
  ['adesk_create_commitment', 'POST', '/commitment', ['amount', 'type', 'date', 'contractor', 'legal_entity', 'currency']],
  ['adesk_update_commitment', 'POST', '/commitment/{commitment_id}', ['commitment_id', 'legal_entity']],
  ['adesk_delete_commitment', 'POST', '/commitment/{commitment_id}/remove', ['commitment_id']],
  ['adesk_list_tags', 'GET', '/tags', []],
  ['adesk_list_budgets', 'GET', '/budgets', []],
  ['adesk_get_budget', 'GET', '/budget/{budget_id}', ['budget_id']],
];
// Reads that Adesk takes as a POST.
const POST_READS = ['adesk_list_commitments'];

describe('adesk adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the token as the api_token query parameter to api.adesk.ru/v1', () => {
    expect(a.slug).toBe('adesk');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('accounting');
    expect(a.icon).toBe('adesk');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ api_token: '{{ADESK_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['ADESK_API_TOKEN']);
    expect(a.optionalEnvVars).toBeUndefined();
    expect(a.envVarMeta.ADESK_API_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    const token = new RegExp(a.envVarMeta.ADESK_API_TOKEN.pattern!);
    expect(token.test(ENV.ADESK_API_TOKEN)).toBe(true);
    for (const bad of ['', 'short', 'has a space in the token 0123456789']) expect(token.test(bad)).toBe(false);
  });

  it('probes the legal entities and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'adesk_list_legal_entities', params: {} });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(CONTRACT.map(([name]) => name));
    for (const [name, method, path, required] of CONTRACT) {
      const entry = tool(name);
      expect(entry.endpointMapping.method).toBe(method);
      expect(entry.endpointMapping.path).toBe(path);
      expect(entry.parameters.required ?? []).toEqual(required);
      // v1 takes write parameters as a form, never as JSON.
      if (entry.endpointMapping.bodyMapping) expect(entry.endpointMapping.bodyEncoding).toBe('form-urlencoded');
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^adesk_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('marks reads read-only, installs deletes switched off, and has no transfer or bulk tool', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET' || POST_READS.includes(entry.name);
      expect(annotationsOf(entry).readOnlyHint).toBe(read);
      if (entry.endpointMapping.path.endsWith('/remove')) expect(entry.enabled).toBe(false);
      expect(entry.endpointMapping.path).not.toMatch(/^\/transfer/);
      expect(entry.endpointMapping.path).not.toMatch(/^\/(contractors|budgets)\/remove$/);
      expect(entry.endpointMapping.path).not.toContain('/v2/');
      expect(JSON.stringify(entry.endpointMapping)).not.toContain('is_deleted');
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['adesk_delete_commitment', 'adesk_delete_contractor', 'adesk_delete_transaction']);
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('turns the error bodies Adesk answers with HTTP 200 into failed calls', () => {
    const rules = a.connector.config.errorWhen;
    const failure = (body: unknown) => {
      try {
        assertNoResponseBodyError(body, rules);
        return undefined;
      } catch (e) {
        return e as ResponseBodyError;
      }
    };
    expect(failure({ success: false, message: 'Auth required', code: 401 })?.status).toBe(401);
    expect(failure({ success: false, message: 'Payment required', code: 21 })?.status).toBe(403);
    expect(failure({ success: false, message: 'Too many requests', code: 429 })?.status).toBe(429);
    const invalid = failure({ success: false, errors: { amount: ['Обязательное поле.'] } });
    expect(invalid?.status).toBe(400);
    expect(invalid?.message).toContain('amount');
    expect(failure({ success: true, transactions: [], recordsTotal: 0, recordsFiltered: 0 })).toBeUndefined();
  });

  it('lists transactions for a period with the token in the query', async () => {
    ok();
    await call('adesk_list_transactions', { range: 'custom', range_start: '2026-10-01', range_end: '2026-10-31', type: 'income', date_type: 'cashier', start: 0, length: 100 });
    const req = sent();
    expect(req.url).toBe(`${BASE}/transactions`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.params).toEqual({
      ...AUTH,
      range: 'custom',
      range_start: '2026-10-01',
      range_end: '2026-10-31',
      type: 'income',
      date_type: 'cashier',
      start: 0,
      length: 100,
    });
    expect(header(req, 'Authorization')).toBeUndefined();
  });

  it('reads single records and reports on the documented paths', async () => {
    ok();
    await call('adesk_get_transaction', { transaction_id: 5590 });
    expect(sent().url).toBe(`${BASE}/transaction/5590`);
    expect(sent().params).toEqual(AUTH);

    ok();
    await call('adesk_list_bank_accounts', { status: 'open', with_sum_amount: true });
    expect(sent().url).toBe(`${BASE}/bank-accounts`);
    expect(sent().params).toEqual({ ...AUTH, status: 'open', with_sum_amount: true });

    ok();
    await call('adesk_list_contractors', { q: 'Борей', with_balance: true });
    expect(sent().url).toBe(`${BASE}/contractors`);
    expect(sent().params).toEqual({ ...AUTH, q: 'Борей', with_balance: true });

    ok();
    await call('adesk_get_project_stats', { project_id: 60, range: 'this_year', data_type: 'cashflow' });
    expect(sent().url).toBe(`${BASE}/projects/60/stats`);
    expect(sent().params).toEqual({ ...AUTH, range: 'this_year', data_type: 'cashflow' });

    ok();
    await call('adesk_get_budget', { budget_id: 50, method: 'accrual' });
    expect(sent().url).toBe(`${BASE}/budget/50`);
    expect(sent().params).toEqual({ ...AUTH, method: 'accrual' });
  });

  it('sends transaction writes as a form with the token still in the query', async () => {
    ok();
    await call('adesk_create_transaction', {
      date: '2026-11-19',
      type: 'outcome',
      amount: 1500.5,
      bank_account: 43,
      category: 48,
      contractor: 15,
      description: 'Office rent',
      is_planned: true,
      tags: '3,12',
    });
    let req = sent();
    expect(req.url).toBe(`${BASE}/transaction`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.params).toEqual(AUTH);
    expect(header(req, 'Content-Type')).toMatch(/application\/x-www-form-urlencoded/);
    expect(typeof req.data).toBe('string');
    expect(formOf(req)).toEqual({
      date: '2026-11-19',
      type: 'outcome',
      amount: '1500.5',
      bank_account: '43',
      category: '48',
      contractor: '15',
      description: 'Office rent',
      is_planned: 'true',
      tags: '3,12',
    });

    ok();
    await call('adesk_update_transaction', {
      transaction_id: 5590,
      date: '2026-11-20',
      amount: 900,
      bank_account: 43,
      is_splitted: true,
      parts: '[{"amount": 600, "category": 48}, {"amount": 300, "project": 46}]',
    });
    req = sent();
    expect(req.url).toBe(`${BASE}/transaction/5590`);
    expect(formOf(req)).toEqual({
      date: '2026-11-20',
      amount: '900',
      bank_account: '43',
      is_splitted: 'true',
      parts: '[{"amount": 600, "category": 48}, {"amount": 300, "project": 46}]',
    });

    ok();
    await call('adesk_complete_transaction', { transaction_id: 5590 });
    req = sent();
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.url).toBe(`${BASE}/transaction/5590/complete`);
    expect(req.params).toEqual(AUTH);
    expect(req.data).toBeUndefined();
  });

  it('builds the contractor, project, commitment and category forms as documented', async () => {
    ok();
    await call('adesk_create_contractor', { name: 'ИП Борей', email: 'borealis@example.test' });
    expect(sent().url).toBe(`${BASE}/contractor`);
    expect(formOf(sent())).toEqual({ name: 'ИП Борей', email: 'borealis@example.test' });

    ok();
    await call('adesk_update_contractor', { contractor_id: 1245, phone_number: '+79999999999' });
    expect(sent().url).toBe(`${BASE}/contractor/1245`);
    expect(formOf(sent())).toEqual({ phone_number: '+79999999999' });

    ok();
    await call('adesk_create_project', { name: 'Mobile app', type: 'deal', deal_legal_entity: 5, deal_amount: 60000, currency: 'RUR' });
    expect(sent().url).toBe(`${BASE}/project`);
    expect(formOf(sent())).toEqual({ name: 'Mobile app', type: 'deal', deal_legal_entity: '5', deal_amount: '60000', currency: 'RUR' });

    ok();
    await call('adesk_create_commitment', { amount: 2400.99, type: 'in', date: '2026-11-19', contractor: 3, legal_entity: 5, currency: 'RUR', vat_percent: 20 });
    expect(sent().url).toBe(`${BASE}/commitment`);
    expect(formOf(sent())).toEqual({ amount: '2400.99', type: 'in', date: '2026-11-19', contractor: '3', legal_entity: '5', currency: 'RUR', vat_percent: '20' });

    ok();
    await call('adesk_list_commitments', { range: 'this_month' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/commitments`);
    expect(formOf(sent())).toEqual({ range: 'this_month' });

    ok();
    await call('adesk_save_transaction_category', { name: 'Marketing', type: 2, kind: 1 });
    expect(sent().url).toBe(`${BASE}/transactions/category`);
    expect(formOf(sent())).toEqual({ name: 'Marketing', type: '2', kind: '1' });

    ok();
    await call('adesk_delete_transaction', { transaction_id: 7 });
    expect(sent().url).toBe(`${BASE}/transaction/7/remove`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
  });
});

// Opt-in: RUN_ADESK_LIVE=1. The first check sends no token at all (a made-up
// token counts toward Adesk's lock-out); the reads need ADESK_API_TOKEN.
const live = process.env.RUN_ADESK_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('adesk: live', () => {
  it('answers a call without a token with HTTP 200 and code 401', async () => {
    const response = await liveFetch.get(`${BASE}/legal-entities`, { validateStatus: () => true });
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ success: false, code: 401 });
  });

  it('reads the legal entities and the accounts', async () => {
    const token = process.env.ADESK_API_TOKEN;
    if (!token) throw new Error('Set ADESK_API_TOKEN for the live check');
    const entities = await liveFetch.get(`${BASE}/legal-entities`, { params: { api_token: token }, validateStatus: () => true });
    expect(entities.status).toBe(200);
    expect(entities.data.success).toBe(true);
    expect(Array.isArray(entities.data.legalEntities)).toBe(true);
    const accounts = await liveFetch.get(`${BASE}/bank-accounts`, { params: { api_token: token }, validateStatus: () => true });
    expect(accounts.status).toBe(200);
    expect(Array.isArray(accounts.data.bankAccounts)).toBe(true);
  });
});
