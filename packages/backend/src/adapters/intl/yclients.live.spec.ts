import axios from 'axios';
import * as adapter from './yclients.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * YCLIENTS REST API adapter (the same API runs as Altegio outside the CIS).
 *
 * Static checks always run: the host choice, the composite Authorization
 * header built from the partner token and the user token, the versioned
 * Accept header, every tool's method, path and required parameters against
 * the YCLIENTS documentation (https://developers.yclients.com/ru/, legacy
 * path spellings that api.alteg.io routes to the same handlers), the write
 * bodies, and which tools install switched off. No tool books a payment or
 * creates a financial transaction.
 *
 * Live checks run only with RUN_YCLIENTS_LIVE=1. Without credentials they
 * confirm that every host refuses a call without tokens; with
 * YCLIENTS_API_HOST, YCLIENTS_PARTNER_TOKEN and YCLIENTS_USER_TOKEN they list
 * the branches of the user. Reads only.
 *
 *   RUN_YCLIENTS_LIVE=1 YCLIENTS_API_HOST=https://api.yclients.com \
 *     YCLIENTS_PARTNER_TOKEN=... YCLIENTS_USER_TOKEN=... \
 *     npx jest src/adapters/intl/yclients.live.spec.ts
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
    bodyTemplate?: string;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  aliases: string[];
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<
    string,
    { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> }
  >;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
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
  walk(m.bodyTemplate ?? '');
  walk(m.headers ?? {});
  return out;
};

const ENV: Record<string, string> = {
  YCLIENTS_API_HOST: 'https://api.yclients.com',
  YCLIENTS_PARTNER_TOKEN: 'partner0token0abcdefghij',
  YCLIENTS_USER_TOKEN: 'user0token0123456789abcdef012345',
};
const BASE = 'https://api.yclients.com/api/v1';
const AUTH = `Bearer ${ENV.YCLIENTS_PARTNER_TOKEN}, User ${ENV.YCLIENTS_USER_TOKEN}`;
const ACCEPT = 'application/vnd.yclients.v2+json';

const call = (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200) => mockedAxios.mockResolvedValueOnce({ status, data: { success: true, data: [], meta: [] }, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// name, method, path, required parameters.
const CONTRACT: Array<[string, string, string, string[]]> = [
  ['yclients_list_companies', 'GET', '/companies', []],
  ['yclients_get_company', 'GET', '/company/{company_id}', ['company_id']],
  ['yclients_list_service_categories', 'GET', '/company/{company_id}/service_categories', ['company_id']],
  ['yclients_list_services', 'GET', '/company/{company_id}/services', ['company_id']],
  ['yclients_get_service', 'GET', '/company/{company_id}/services/{service_id}', ['company_id', 'service_id']],
  ['yclients_list_staff', 'GET', '/company/{company_id}/staff', ['company_id']],
  ['yclients_get_staff', 'GET', '/company/{company_id}/staff/{staff_id}', ['company_id', 'staff_id']],
  ['yclients_get_staff_schedule', 'GET', '/company/{company_id}/staff/schedule', ['company_id', 'start_date', 'end_date']],
  ['yclients_list_bookable_services', 'GET', '/book_services/{company_id}', ['company_id']],
  ['yclients_list_bookable_staff', 'GET', '/book_staff/{company_id}', ['company_id']],
  ['yclients_list_bookable_dates', 'GET', '/book_dates/{company_id}', ['company_id']],
  ['yclients_list_bookable_times', 'GET', '/book_times/{company_id}/{staff_id}/{date}', ['company_id', 'staff_id', 'date']],
  ['yclients_list_journal_seances', 'GET', '/timetable/seances/{company_id}/{staff_id}/{date}', ['company_id', 'staff_id', 'date']],
  ['yclients_list_records', 'GET', '/records/{company_id}', ['company_id']],
  ['yclients_get_record', 'GET', '/record/{company_id}/{record_id}', ['company_id', 'record_id']],
  ['yclients_create_record', 'POST', '/records/{company_id}', ['company_id', 'staff_id', 'services', 'client', 'datetime', 'seance_length']],
  [
    'yclients_update_record',
    'PUT',
    '/record/{company_id}/{record_id}',
    ['company_id', 'record_id', 'staff_id', 'services', 'client', 'datetime', 'seance_length'],
  ],
  ['yclients_delete_record', 'DELETE', '/record/{company_id}/{record_id}', ['company_id', 'record_id']],
  ['yclients_search_clients', 'POST', '/company/{company_id}/clients/search', ['company_id']],
  ['yclients_get_client', 'GET', '/client/{company_id}/{client_id}', ['company_id', 'client_id']],
  ['yclients_create_client', 'POST', '/clients/{company_id}', ['company_id', 'name', 'phone']],
  ['yclients_update_client', 'PUT', '/client/{company_id}/{client_id}', ['company_id', 'client_id', 'name', 'phone']],
  ['yclients_delete_client', 'DELETE', '/client/{company_id}/{client_id}', ['company_id', 'client_id']],
  ['yclients_search_client_visits', 'POST', '/company/{company_id}/clients/visits/search', ['company_id']],
  ['yclients_get_visit', 'GET', '/visits/{visit_id}', ['visit_id']],
  ['yclients_get_visit_details', 'GET', '/visit/details/{company_id}/{record_id}/{visit_id}', ['company_id', 'record_id', 'visit_id']],
  ['yclients_list_goods', 'GET', '/goods/{company_id}', ['company_id']],
  ['yclients_get_good', 'GET', '/goods/{company_id}/{good_id}', ['company_id', 'good_id']],
  ['yclients_list_storages', 'GET', '/storages/{company_id}', ['company_id']],
  ['yclients_list_goods_transactions', 'GET', '/storages/transactions/{company_id}', ['company_id']],
  ['yclients_list_accounts', 'GET', '/accounts/{company_id}', ['company_id']],
  ['yclients_list_transactions', 'GET', '/transactions/{company_id}', ['company_id']],
  ['yclients_get_analytics_overall', 'GET', '/company/{company_id}/analytics/overall/', ['company_id', 'date_from', 'date_to']],
  [
    'yclients_get_analytics_chart',
    'GET',
    '/company/{company_id}/analytics/overall/charts/{chart}/',
    ['company_id', 'chart', 'date_from', 'date_to'],
  ],
  ['yclients_list_comments', 'GET', '/comments/{company_id}/', ['company_id']],
];
// POST searches that only read.
const READ_POSTS = ['yclients_search_clients', 'yclients_search_client_visits'];

describe('yclients adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('offers the YCLIENTS and Altegio hosts and builds one Authorization header from two tokens', () => {
    expect(a.slug).toBe('yclients');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('scheduling');
    expect(a.icon).toBe('yclients');
    expect(a.aliases).toContain('Altegio');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{YCLIENTS_API_HOST}}/api/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'Authorization',
      apiKey: 'Bearer {{YCLIENTS_PARTNER_TOKEN}}, User {{YCLIENTS_USER_TOKEN}}',
    });
    expect(a.connector.headers).toMatchObject({ Accept: ACCEPT, 'Content-Type': 'application/json' });
    expect(a.requiredEnvVars).toEqual(['YCLIENTS_API_HOST', 'YCLIENTS_PARTNER_TOKEN', 'YCLIENTS_USER_TOKEN']);
    expect(a.optionalEnvVars ?? []).toEqual([]);

    const host = a.envVarMeta.YCLIENTS_API_HOST;
    expect(host.secret).toBeUndefined();
    expect(host.options!.map((o) => o.value)).toEqual(['https://api.yclients.com', 'https://api.yclients.ru', 'https://api.alteg.io']);
    for (const option of host.options!) {
      expect(option.value).toMatch(/^https:\/\/api\.(yclients\.(com|ru)|alteg\.io)$/);
      expect(option.label.length).toBeGreaterThan(3);
    }
    for (const name of ['YCLIENTS_PARTNER_TOKEN', 'YCLIENTS_USER_TOKEN']) {
      expect(a.envVarMeta[name]).toMatchObject({ kind: 'credential', secret: true });
      const pattern = new RegExp(a.envVarMeta[name].pattern!);
      expect(pattern.test(ENV[name])).toBe(true);
      for (const bad of ['', 'short', 'has space 0123456789abcdef', 'Bearer partner0token0abcdefghij']) expect(pattern.test(bad)).toBe(false);
    }
  });

  it('probes the branches of the user and explains 401, 403, 404, 422 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'yclients_list_companies', params: { my: 1, count: 1 } });
    for (const key of ['401', '403', '404', '422', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(CONTRACT.map(([name]) => name).sort());
    for (const [name, method, path, required] of CONTRACT) {
      const entry = tool(name);
      expect(entry.endpointMapping.method).toBe(method);
      expect(entry.endpointMapping.path).toBe(path);
      expect([...(entry.parameters.required ?? [])].sort()).toEqual([...required].sort());
      // The tokens travel in the connector's header only.
      expect(entry.endpointMapping.headers).toBeUndefined();
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^yclients_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('marks reads read-only, installs the two deletes switched off, and moves no money', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET' || READ_POSTS.includes(entry.name);
      expect(annotationsOf(entry).readOnlyHint).toBe(read);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['yclients_delete_client', 'yclients_delete_record']);
    for (const entry of a.tools) {
      if (entry.endpointMapping.method === 'DELETE') expect(entry.enabled).toBe(false);
      // Finance, sales, stock and visit endpoints are read only; no payments, SMS or e-mail campaigns.
      if (/\/transactions\/|^\/accounts\/|^\/visits?\/|^\/goods\/|^\/storages\//.test(entry.endpointMapping.path)) {
        expect(entry.endpointMapping.method).toBe('GET');
      }
      expect(entry.endpointMapping.path).not.toMatch(/payment|finance_transactions|\/sms\/|\/email\/|loyalty|storage_operations|\/auth/);
    }
    // A client card is written without money fields.
    for (const name of ['yclients_create_client', 'yclients_update_client']) {
      const body = tool(name).endpointMapping.bodyMapping!;
      expect(body.spent).toBeUndefined();
      expect(body.balance).toBeUndefined();
    }
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists the branches of the user with both tokens in one header', async () => {
    ok();
    await call('yclients_list_companies', {});
    const req = sent();
    expect(req.url).toBe(`${BASE}/companies`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.params).toEqual({ my: 1, page: 1 });
    expect(header(req, 'Authorization')).toBe(AUTH);
    expect(header(req, 'Accept')).toBe(ACCEPT);
  });

  it('calls the host that was chosen', async () => {
    for (const host of ['https://api.yclients.ru', 'https://api.alteg.io']) {
      ok();
      await call('yclients_list_staff', { company_id: 4564 }, { ...ENV, YCLIENTS_API_HOST: host });
      expect(sent().url).toBe(`${host}/api/v1/company/4564/staff`);
      expect(header(sent(), 'Authorization')).toBe(AUTH);
    }
  });

  it('reads services, schedules, free slots and appointments on the documented paths', async () => {
    ok();
    await call('yclients_list_services', { company_id: 4564, staff_id: 9 });
    expect(sent().url).toBe(`${BASE}/company/4564/services`);
    expect(sent().params).toEqual({ staff_id: 9 });

    ok();
    await call('yclients_get_staff_schedule', {
      company_id: 4564,
      start_date: '2026-12-01',
      end_date: '2026-12-07',
      staff_ids: [9, 12],
      include: ['busy_intervals'],
    });
    expect(sent().url).toBe(`${BASE}/company/4564/staff/schedule`);
    expect(sent().params).toEqual({
      start_date: '2026-12-01',
      end_date: '2026-12-07',
      'staff_ids[]': [9, 12],
      'include[]': ['busy_intervals'],
    });

    ok();
    await call('yclients_list_bookable_times', { company_id: 4564, staff_id: 0, date: '2026-12-01', service_ids: [331, 333] });
    expect(sent().url).toBe(`${BASE}/book_times/4564/0/2026-12-01`);
    expect(sent().params).toEqual({ 'service_ids[]': [331, 333] });

    ok();
    await call('yclients_list_bookable_dates', { company_id: 4564, staff_id: 9, date_from: '2026-12-01', date_to: '2026-12-31' });
    expect(sent().url).toBe(`${BASE}/book_dates/4564`);
    expect(sent().params).toEqual({ staff_id: 9, date_from: '2026-12-01', date_to: '2026-12-31' });

    ok();
    await call('yclients_list_records', { company_id: 4564, start_date: '2026-12-01', end_date: '2026-12-01', staff_id: 9 });
    expect(sent().url).toBe(`${BASE}/records/4564`);
    expect(sent().params).toEqual({ start_date: '2026-12-01', end_date: '2026-12-01', staff_id: 9, page: 1, count: 50 });

    ok();
    await call('yclients_get_record', { company_id: 4564, record_id: 2, include_finance_transactions: 1 });
    expect(sent().url).toBe(`${BASE}/record/4564/2`);
    expect(sent().params).toEqual({ include_finance_transactions: 1 });

    ok();
    await call('yclients_list_journal_seances', { company_id: 4564, staff_id: 9, date: '2026-12-01' });
    expect(sent().url).toBe(`${BASE}/timetable/seances/4564/9/2026-12-01`);
  });

  it('reads visits, products, finance and analytics on the documented paths', async () => {
    ok();
    await call('yclients_get_visit_details', { company_id: 4564, record_id: 2, visit_id: 77 });
    expect(sent().url).toBe(`${BASE}/visit/details/4564/2/77`);

    ok();
    await call('yclients_list_goods', { company_id: 4564, term: 'shampoo' });
    expect(sent().url).toBe(`${BASE}/goods/4564`);
    expect(sent().params).toEqual({ term: 'shampoo', page: 1, count: 25 });

    ok();
    await call('yclients_list_transactions', { company_id: 4564, start_date: '2026-11-01', end_date: '2026-11-30', balance_is: 1 });
    expect(sent().url).toBe(`${BASE}/transactions/4564`);
    expect(String(sent().method).toUpperCase()).toBe('GET');
    expect(sent().params).toEqual({ start_date: '2026-11-01', end_date: '2026-11-30', balance_is: 1, page: 1, count: 50 });

    ok();
    await call('yclients_get_analytics_overall', { company_id: 4564, date_from: '2026-11-01', date_to: '2026-11-30' });
    expect(sent().url).toBe(`${BASE}/company/4564/analytics/overall/`);
    expect(sent().params).toEqual({ date_from: '2026-11-01', date_to: '2026-11-30' });

    ok();
    await call('yclients_get_analytics_chart', { company_id: 4564, chart: 'income_daily', date_from: '2026-11-01', date_to: '2026-11-30', staff_id: 9 });
    expect(sent().url).toBe(`${BASE}/company/4564/analytics/overall/charts/income_daily/`);
    expect(sent().params).toEqual({ date_from: '2026-11-01', date_to: '2026-11-30', staff_id: 9 });

    ok();
    await call('yclients_list_comments', { company_id: 4564, rating: 5 });
    expect(sent().url).toBe(`${BASE}/comments/4564/`);
    expect(sent().params).toEqual({ rating: 5, page: 1 });
  });

  it('builds the appointment bodies as YCLIENTS documents them', async () => {
    const record = {
      staff_id: 8886,
      services: [{ id: 331, first_cost: 9000, discount: 50, cost: 4500 }],
      client: { phone: '79161234567', name: 'Anna', email: 'anna@example.test' },
      datetime: '2026-12-01T14:30:00+03:00',
      seance_length: 3600,
      comment: 'first visit',
    };
    ok(201);
    await call('yclients_create_record', { company_id: 24699, ...record });
    let req = sent();
    expect(req.url).toBe(`${BASE}/records/24699`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    // No SMS and no double booking unless asked for.
    expect(req.data).toEqual({ ...record, save_if_busy: false, send_sms: false });
    expect(header(req, 'Authorization')).toBe(AUTH);

    ok();
    await call('yclients_update_record', { company_id: 24699, record_id: 999, ...record, attendance: -1 });
    req = sent();
    expect(req.url).toBe(`${BASE}/record/24699/999`);
    expect(String(req.method).toUpperCase()).toBe('PUT');
    expect(req.data).toEqual({ ...record, save_if_busy: false, send_sms: false, attendance: -1 });

    ok(204);
    await call('yclients_delete_record', { company_id: 24699, record_id: 999 });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/record/24699/999`);
  });

  it('builds the client search, card and visit history bodies', async () => {
    ok();
    await call('yclients_search_clients', {
      company_id: 4564,
      filters: [{ type: 'quick_search', state: { value: 'Anna' } }],
      page_size: 10,
    });
    let req = sent();
    expect(req.url).toBe(`${BASE}/company/4564/clients/search`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.data).toEqual({
      page: 1,
      page_size: 10,
      fields: ['id', 'name', 'phone', 'email', 'visits_count', 'last_visit_date', 'sold_amount'],
      filters: [{ type: 'quick_search', state: { value: 'Anna' } }],
    });

    ok(201);
    await call('yclients_create_client', { company_id: 4564, name: 'Anna', phone: '79161234567', email: 'anna@example.test', categories: [3] });
    req = sent();
    expect(req.url).toBe(`${BASE}/clients/4564`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.data).toEqual({ name: 'Anna', phone: '79161234567', email: 'anna@example.test', categories: [3] });

    ok();
    await call('yclients_update_client', { company_id: 4564, client_id: 16, name: 'Anna', phone: '79161234567', discount: 10, labels: [3, 7] });
    req = sent();
    expect(req.url).toBe(`${BASE}/client/4564/16`);
    expect(String(req.method).toUpperCase()).toBe('PUT');
    expect(req.data).toEqual({ name: 'Anna', phone: '79161234567', discount: 10, labels: [3, 7] });

    // Every field of the visit search is required by the API and may be null.
    ok();
    await call('yclients_search_client_visits', { company_id: 4564, client_id: 16 });
    req = sent();
    expect(req.url).toBe(`${BASE}/company/4564/clients/visits/search`);
    expect(req.data).toEqual({ client_id: 16, client_phone: null, from: null, to: null, payment_statuses: [], attendance: null });

    ok();
    await call('yclients_search_client_visits', {
      company_id: 4564,
      client_phone: '79161234567',
      from: '2026-01-01',
      to: '2026-06-30',
      payment_statuses: ['paid_full'],
      attendance: 1,
    });
    expect(sent().data).toEqual({
      client_id: null,
      client_phone: '79161234567',
      from: '2026-01-01',
      to: '2026-06-30',
      payment_statuses: ['paid_full'],
      attendance: 1,
    });
  });
});

// Opt-in: RUN_YCLIENTS_LIVE=1. The refusal check needs no account; the read
// needs YCLIENTS_API_HOST, YCLIENTS_PARTNER_TOKEN and YCLIENTS_USER_TOKEN.
// Nothing is written.
const live = process.env.RUN_YCLIENTS_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('yclients: live', () => {
  it('refuses a call without tokens on every host, and routes the documented paths', async () => {
    for (const host of ['https://api.yclients.com', 'https://api.yclients.ru', 'https://api.alteg.io']) {
      for (const path of ['/companies', '/records/1', '/company/1/staff']) {
        const response = await liveFetch.get(`${host}/api/v1${path}`, { headers: { Accept: ACCEPT }, validateStatus: () => true });
        expect(response.status).toBe(401);
        expect(response.data).toMatchObject({ success: false, data: null });
      }
    }
  });

  it('lists the branches of the user', async () => {
    const host = process.env.YCLIENTS_API_HOST;
    const partner = process.env.YCLIENTS_PARTNER_TOKEN;
    const user = process.env.YCLIENTS_USER_TOKEN;
    if (!host || !partner || !user) throw new Error('Set YCLIENTS_API_HOST, YCLIENTS_PARTNER_TOKEN and YCLIENTS_USER_TOKEN for the live check');
    const response = await liveFetch.get(`${host}/api/v1/companies`, {
      headers: { Accept: ACCEPT, Authorization: `Bearer ${partner}, User ${user}` },
      params: { my: 1, count: 1 },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(Array.isArray(response.data.data)).toBe(true);
  });
});
