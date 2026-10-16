import axios from 'axios';
import * as adapter from './gusto.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Gusto adapter:
 *
 *   1. Static: always runs. Pins the OAuth settings (authorize and token on
 *      the host in GUSTO_API_URL, client credentials in the body, no scope
 *      parameter), the X-Gusto-API-Version header, every tool's method and URL
 *      through the real RestEngine (axios mocked), the paging defaults and
 *      headers, and that the only writes are the two department tools.
 *
 *   2. Live: skipped unless GUSTO_ACCESS_TOKEN is set, an access token of a
 *      Gusto application authorized for one company (it lasts two hours).
 *      GUSTO_API_URL defaults to the demo host https://api.gusto-demo.com:
 *
 *        GUSTO_ACCESS_TOKEN=... npx jest src/adapters/intl/gusto.live.spec.ts
 *
 *      Reads the token info for the company UUID, then every read tool,
 *      picking ids from list answers and skipping follow-up reads when the
 *      company has nothing to read. A demo company from the Developer Portal
 *      has employees, contractors and payrolls.
 *
 *      GUSTO_LIVE_WRITE=1 also creates a department "AnythingMCP live spec",
 *      renames it and deletes it again in `finally`. Use a demo company.
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

type Mapping = {
  method: string;
  path: string;
  encodePathParams?: boolean;
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
  exposeHeaders?: string[];
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: Mapping;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
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
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);

// Mirrors DynamicMcpTools: {{VAR}} interpolated everywhere, env vars also
// passed as params. The OAuth access token goes out as a bearer token, which
// is what OAUTH2 auth puts on the request too.
const prepare = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return [
    { baseUrl: config.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ] as const;
};
const execute = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) =>
  engine().execute(...prepare(name, env, token, params)) as Promise<any>;
const executeWithMeta = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) =>
  engine().executeWithMeta(...prepare(name, env, token, params));

const DEMO = 'https://api.gusto-demo.com';
const ENV = { GUSTO_API_URL: DEMO };
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, 'test-token', params);
const sent = () => mockedAxios.mock.calls[0][0];
const C = 'c0ffee00-0000-4000-8000-000000000001';

const WRITES = ['gusto_create_department', 'gusto_update_department'];

describe('gusto adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified against the official API spec on 12 Oct 2026)', () => { expect(a.unlisted).toBeUndefined(); });

  it('signs in with Gusto OAuth on the configured host, client credentials in the body, no scope parameter', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GUSTO_CLIENT_ID}}',
      clientSecret: '{{GUSTO_CLIENT_SECRET}}',
      authorizationUrl: '{{GUSTO_API_URL}}/oauth/authorize',
      tokenUrl: '{{GUSTO_API_URL}}/oauth/token',
      tokenAuthMethod: 'client_secret_post',
    });
    expect(needsBrowserAuthorization(a as never)).toBe(true);
    const resolved = interpolateDeep(a.connector.authConfig, { GUSTO_API_URL: 'https://api.gusto.com', GUSTO_CLIENT_ID: 'id', GUSTO_CLIENT_SECRET: 'secret' });
    expect(resolved.authorizationUrl).toBe('https://api.gusto.com/oauth/authorize');
    expect(resolved.tokenUrl).toBe('https://api.gusto.com/oauth/token');
    expect(a.requiredEnvVars).toEqual(['GUSTO_CLIENT_ID', 'GUSTO_CLIENT_SECRET', 'GUSTO_API_URL']);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'GUSTO_CLIENT_SECRET')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'GUSTO_API_URL')!.kind).toBe('address');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('https://dev.gusto.com');
  });

  it('pins the API version header and accepts only the demo and production hosts', () => {
    expect(a.connector.baseUrl).toBe('{{GUSTO_API_URL}}');
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'X-Gusto-API-Version': '2026-06-15', 'User-Agent': 'AnythingMCP' });
    expect(a.instructions).toContain('X-Gusto-API-Version: 2026-06-15');
    const host = new RegExp(a.envVarMeta.GUSTO_API_URL.pattern!);
    for (const ok of ['https://api.gusto.com', 'https://api.gusto-demo.com']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://api.gusto.com/', 'https://api.gusto.com/v1', 'http://api.gusto.com', 'https://gusto.com', 'https://api.gusto-demo.com.evil.io']) {
      expect(host.test(bad)).toBe(false);
    }
  });

  it('probes with the token info, which every application may read', () => {
    expect(a.probe).toEqual({ tool: 'gusto_get_token_info' });
    expect(a.connector.healthcheckPath).toBe('/v1/token_info');
  });

  it('prefixes every tool with gusto_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gusto_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('reads everything and writes only departments; payroll is never submitted', () => {
    for (const t of a.tools) {
      const readOnly = !WRITES.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${readOnly}`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['gusto_update_department']);
    expect(annotationsOf(tool('gusto_create_department')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('gusto_update_department')).destructiveHint).toBe(true);
    for (const t of a.tools) {
      expect(t.endpointMapping.path).not.toMatch(/submit|calculate|prepare|cancel|fund|rehire|terminations/);
      if (t.endpointMapping.method !== 'GET') expect(t.endpointMapping.path).toMatch(/departments/);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgusto_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgusto_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['gusto_get_token_info', {}, 'GET', '/v1/token_info'],
    ['gusto_get_company', { company_uuid: C }, 'GET', `/v1/companies/${C}`],
    ['gusto_list_locations', { company_uuid: C }, 'GET', `/v1/companies/${C}/locations`],
    ['gusto_list_company_admins', { company_uuid: C }, 'GET', `/v1/companies/${C}/admins`],
    ['gusto_list_employees', { company_uuid: C }, 'GET', `/v1/companies/${C}/employees`],
    ['gusto_get_employee', { employee_uuid: 'e1' }, 'GET', '/v1/employees/e1'],
    ['gusto_get_employment_history', { employee_uuid: 'e1' }, 'GET', '/v1/employees/e1/employment_history'],
    ['gusto_list_job_compensations', { job_uuid: 'j1' }, 'GET', '/v1/jobs/j1/compensations'],
    ['gusto_list_contractors', { company_uuid: C }, 'GET', `/v1/companies/${C}/contractors`],
    ['gusto_get_contractor', { contractor_uuid: 'k1' }, 'GET', '/v1/contractors/k1'],
    ['gusto_list_departments', { company_uuid: C }, 'GET', `/v1/companies/${C}/departments`],
    ['gusto_get_department', { department_uuid: 'd1' }, 'GET', '/v1/departments/d1'],
    ['gusto_create_department', { company_uuid: C, title: 'Ops' }, 'POST', `/v1/companies/${C}/departments`],
    ['gusto_update_department', { department_uuid: 'd1', title: 'Ops 2', version: 'v1' }, 'PUT', '/v1/departments/d1'],
    ['gusto_list_pay_schedules', { company_uuid: C }, 'GET', `/v1/companies/${C}/pay_schedules`],
    ['gusto_list_pay_periods', { company_uuid: C }, 'GET', `/v1/companies/${C}/pay_periods`],
    ['gusto_list_payrolls', { company_uuid: C }, 'GET', `/v1/companies/${C}/payrolls`],
    ['gusto_get_payroll', { company_uuid: C, payroll_uuid: 'p1' }, 'GET', `/v1/companies/${C}/payrolls/p1`],
    ['gusto_list_contractor_payments', { company_uuid: C, start_date: '2026-01-01', end_date: '2026-06-30' }, 'GET', `/v1/companies/${C}/contractor_payments`],
    ['gusto_get_contractor_payment', { company_uuid: C, contractor_payment_uuid: 'cp1' }, 'GET', `/v1/companies/${C}/contractor_payments/cp1`],
    ['gusto_list_time_off_policies', { company_uuid: C }, 'GET', `/v1/companies/${C}/time_off_policies`],
    ['gusto_get_time_off_policy', { time_off_policy_uuid: 't1' }, 'GET', '/v1/time_off_policies/t1'],
    ['gusto_list_time_off_requests', { company_uuid: C }, 'GET', `/v1/companies/${C}/time_off_requests`],
    ['gusto_list_earning_types', { company_uuid: C }, 'GET', `/v1/companies/${C}/earning_types`],
    ['gusto_list_company_benefits', { company_uuid: C }, 'GET', `/v1/companies/${C}/company_benefits`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${DEMO}${path}` }));
    expect(sent().headers).toEqual(expect.objectContaining({ Authorization: 'Bearer test-token', 'X-Gusto-API-Version': '2026-06-15' }));
  });

  it('encodes UUIDs into the path', async () => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await call('gusto_get_employee', { employee_uuid: '../companies/x' });
    expect(sent().url).toBe(`${DEMO}/v1/employees/..%2Fcompanies%2Fx`);
  });

  it('pages employees and contractors 100 at a time and returns the total headers', async () => {
    mockedAxios.mockResolvedValue({ data: [], headers: { 'x-total-count': '342', 'x-total-pages': '4', 'x-page': '1' } });
    const out = await executeWithMeta('gusto_list_employees', ENV, 'test-token', { company_uuid: C, terminated: false, search_term: 'Ann' });
    expect(sent().params).toEqual({ search_term: 'Ann', terminated: false, page: 1, per: 100 });
    expect(out.headers).toEqual({ 'x-total-count': '342', 'x-total-pages': '4' });
    mockedAxios.mockClear();
    await call('gusto_list_contractors', { company_uuid: C, page: 2 });
    expect(sent().params).toEqual({ page: 2, per: 100 });
  });

  it('sends payroll filters as Gusto\'s comma-separated values', async () => {
    mockedAxios.mockResolvedValue({ data: [], headers: {} });
    await call('gusto_list_payrolls', {
      company_uuid: C,
      processing_statuses: 'processed,unprocessed',
      payroll_types: 'regular,off_cycle',
      start_date: '2026-01-01',
      end_date: '2026-06-30',
      include: 'totals,taxes',
    });
    // Payrolls always come in pages since 2026-06-15; ask for the maximum.
    expect(sent().params).toEqual({
      processing_statuses: 'processed,unprocessed',
      payroll_types: 'regular,off_cycle',
      start_date: '2026-01-01',
      end_date: '2026-06-30',
      include: 'totals,taxes',
      page: 1,
      per: 100,
    });
  });

  it('creates and renames departments with Gusto\'s field names', async () => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await call('gusto_create_department', { company_uuid: C, title: 'Customer Success' });
    expect(sent().data).toEqual({ title: 'Customer Success' });
    mockedAxios.mockClear();
    await call('gusto_update_department', { department_uuid: 'd1', title: 'CS', version: 'abc123' });
    expect(sent().data).toEqual({ title: 'CS', version: 'abc123' });
  });
});

const TOKEN = process.env.GUSTO_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('gusto adapter: live REST API', () => {
  const write = process.env.GUSTO_LIVE_WRITE === '1';
  const env = { GUSTO_API_URL: process.env.GUSTO_API_URL || DEMO };
  let company = '';
  beforeAll(async () => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
    const info = await run('gusto_get_token_info');
    company = info.resource.uuid;
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, TOKEN as string, params);
  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 360 * 86_400_000).toISOString().slice(0, 10);

  it('reads the company, its people and its organisation', async () => {
    expect(company).toMatch(/^[0-9a-f-]{36}$/);
    expect((await run('gusto_get_company', { company_uuid: company })).uuid).toBe(company);
    expect(Array.isArray(await run('gusto_list_locations', { company_uuid: company }))).toBe(true);
    expect(Array.isArray(await run('gusto_list_company_admins', { company_uuid: company }))).toBe(true);

    const employees = await run('gusto_list_employees', { company_uuid: company, per: 5 });
    expect(Array.isArray(employees)).toBe(true);
    if (employees.length) {
      const employee = await run('gusto_get_employee', { employee_uuid: employees[0].uuid });
      expect(employee.uuid).toBe(employees[0].uuid);
      expect(await run('gusto_get_employment_history', { employee_uuid: employee.uuid })).toBeDefined();
      const job = (employee.jobs ?? [])[0];
      if (job) expect(Array.isArray(await run('gusto_list_job_compensations', { job_uuid: job.uuid }))).toBe(true);
    }

    const contractors = await run('gusto_list_contractors', { company_uuid: company, per: 5 });
    expect(Array.isArray(contractors)).toBe(true);
    if (contractors.length) {
      expect((await run('gusto_get_contractor', { contractor_uuid: contractors[0].uuid })).uuid).toBe(contractors[0].uuid);
    }

    const departments = await run('gusto_list_departments', { company_uuid: company });
    expect(Array.isArray(departments)).toBe(true);
    if (departments.length) {
      expect((await run('gusto_get_department', { department_uuid: departments[0].uuid })).uuid).toBe(departments[0].uuid);
    }
    expect(await run('gusto_list_earning_types', { company_uuid: company })).toBeDefined();
    expect(Array.isArray(await run('gusto_list_company_benefits', { company_uuid: company }))).toBe(true);
  }, 180_000);

  it('reads pay schedules, pay periods, payrolls, contractor payments and time off', async () => {
    expect(Array.isArray(await run('gusto_list_pay_schedules', { company_uuid: company }))).toBe(true);
    expect(Array.isArray(await run('gusto_list_pay_periods', { company_uuid: company }))).toBe(true);
    const payrolls = await run('gusto_list_payrolls', { company_uuid: company, include: 'totals', start_date: yearAgo, end_date: today });
    expect(Array.isArray(payrolls)).toBe(true);
    if (payrolls.length) {
      const id = payrolls[0].payroll_uuid ?? payrolls[0].uuid;
      expect((await run('gusto_get_payroll', { company_uuid: company, payroll_uuid: id, include: 'totals' })).payroll_uuid).toBe(id);
    }
    const payments = await run('gusto_list_contractor_payments', { company_uuid: company, start_date: yearAgo, end_date: today });
    expect(payments).toBeDefined();
    const first = payments.contractor_payments?.[0];
    if (first) {
      expect((await run('gusto_get_contractor_payment', { company_uuid: company, contractor_payment_uuid: first.uuid })).uuid).toBe(first.uuid);
    }
    const policies = await run('gusto_list_time_off_policies', { company_uuid: company });
    expect(Array.isArray(policies)).toBe(true);
    if (policies.length) {
      expect((await run('gusto_get_time_off_policy', { time_off_policy_uuid: policies[0].uuid })).uuid).toBe(policies[0].uuid);
    }
    expect(Array.isArray(await run('gusto_list_time_off_requests', { company_uuid: company, start_date: yearAgo }))).toBe(true);
  }, 180_000);

  (write ? it : it.skip)('creates, renames and deletes a test department', async () => {
    const created = await run('gusto_create_department', { company_uuid: company, title: 'AnythingMCP live spec' });
    try {
      const current = await run('gusto_get_department', { department_uuid: created.uuid });
      const renamed = await run('gusto_update_department', {
        department_uuid: created.uuid,
        title: 'AnythingMCP live spec (renamed)',
        version: current.version,
      });
      expect(renamed.title).toBe('AnythingMCP live spec (renamed)');
    } finally {
      // Clean-up only: the adapter ships no delete tool.
      await engine().execute(
        { baseUrl: env.GUSTO_API_URL, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN }, headers: a.connector.headers },
        { method: 'DELETE', path: `/v1/departments/${created.uuid}` },
        {},
      );
    }
  }, 120_000);
});
