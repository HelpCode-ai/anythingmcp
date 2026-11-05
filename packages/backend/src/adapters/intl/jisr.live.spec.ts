import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './jisr.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { assertNoResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Jisr Open API.
 *
 * Static checks always run. They pin the session login of Jisr's published
 * OpenAPI document (https://openapi.jisr.net/, servers: apis.jisr.net/api):
 * POST /openapi/v1/auth with the slug, api-key, secret and api-version headers,
 * the JWT read from `data`, then sent as Access-Token with slug and
 * api-version on every call, and the paths and query names of
 *   GET  /openapi/v1/employees                 (listEmployees)
 *   GET  /openapi/v1/employees/basic_info      (show, ?id=)
 *   GET  /openapi/v1/attendance/summary        (getAttendanceSummary)
 *   GET  /openapi/v1/attendance_logs           (listAttendanceLogs)
 *   POST /openapi/v1/attendance_logs           (createAttendanceLogs, off at install)
 *   GET  /openapi/v1/employee_leaves/summary   (getEmployeeLeavesSummary)
 *   GET  /openapi/v1/lookups/{lookup}
 *
 * Live checks run only with RUN_JISR_LIVE=1. Without credentials they confirm
 * that the session endpoint refuses an unknown organization. With JISR_SLUG,
 * JISR_API_KEY and JISR_API_SECRET they sign in and read one employee page and
 * this month's attendance summary:
 *
 *   RUN_JISR_LIVE=1 JISR_SLUG=... JISR_API_KEY=... JISR_API_SECRET=... \
 *     npx jest src/adapters/intl/jisr.live.spec.ts
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
    headers?: Record<string, string>;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers: Record<string, string>;
    config: { errorWhen: unknown[] };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({
    name: entry.name,
    connectorType: 'REST',
    endpointMapping: entry.endpointMapping,
    annotations: entry.annotations,
  });
// Every argument a mapping reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
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
const statusOf = (body: unknown): number | undefined => {
  try {
    assertNoResponseBodyError(body, a.connector.config.errorWhen as never);
    return undefined;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

const ENV: Record<string, string> = {
  JISR_SLUG: 'acme',
  JISR_API_KEY: 'jisr_key_0a1b2c3d4e5f',
  JISR_API_SECRET: 'jisr-secret-9f8e7d6c5b4a',
};
const FAKE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.jisr-session.sig';
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
const fakeBundle = async () => ({ token: FAKE_TOKEN, expiresAt: Date.now() + 86_400_000 });
const stubLogin = { getToken: fakeBundle, forceRelogin: fakeBundle } as unknown as LoginTokenService;

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, stubLogin).execute(
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
const ok = { status: 200, data: { success: true, data: {} }, headers: {} };
const expectJisrHeaders = () => {
  const headers = sent().headers;
  expect(headers['Access-Token']).toBe(FAKE_TOKEN);
  expect(headers.slug).toBe('acme');
  expect(headers['api-version']).toBe('1');
  expect(headers.Authorization).toBeUndefined();
};

describe('jisr adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in at /openapi/v1/auth with header credentials and sends Access-Token', () => {
    expect(a.slug).toBe('jisr');
    expect(a.category).toBe('hr');
    expect(a.icon).toBe('jisr');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://apis.jisr.net/api');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.requiredEnvVars).toEqual(['JISR_SLUG', 'JISR_API_KEY', 'JISR_API_SECRET']);
    const auth = a.connector.authConfig;
    expect(auth.loginUrl).toBe('https://apis.jisr.net/api/openapi/v1/auth');
    expect(auth.loginMethod).toBe('POST');
    expect(auth.loginHeaders).toMatchObject({
      slug: '{{JISR_SLUG}}',
      'api-key': '{{JISR_API_KEY}}',
      secret: '{{JISR_API_SECRET}}',
      'api-version': '1',
      source: 'open_api',
    });
    expect(auth.tokenJsonPath).toBe('data');
    expect(auth.refreshOn401).toBe(true);
    expect(auth.headerName).toBe('Access-Token');
    expect(auth.headerTemplate).toBe('${token}');
    expect(a.connector.headers).toMatchObject({ slug: '{{JISR_SLUG}}', 'api-version': '1' });
    const described = describeAdapterEnvVars(a as never);
    expect(described.map((entry) => entry.name)).toEqual(a.requiredEnvVars);
    expect(described.find((entry) => entry.name === 'JISR_API_SECRET')).toMatchObject({ kind: 'credential', secret: true });
    expect(described.find((entry) => entry.name === 'JISR_API_KEY')?.secret).toBe(true);
  });

  it('accepts a bare slug and refuses a full address', () => {
    const slug = new RegExp(a.envVarMeta.JISR_SLUG.pattern!);
    for (const good of ['acme', 'acme-ksa', 'abcd1']) expect(slug.test(good)).toBe(true);
    for (const bad of ['', 'https://acme.jisr.net', 'acme.jisr.net', 'Acme Co']) expect(slug.test(bad)).toBe(false);
    const secret = new RegExp(a.envVarMeta.JISR_API_SECRET.pattern!);
    expect(secret.test(ENV.JISR_API_SECRET)).toBe(true);
    expect(secret.test('has a space')).toBe(false);
  });

  it('logs in with the credentials in headers only and reads the JWT from data', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as never;
    mockedAxios.mockResolvedValueOnce({
      data: { success: true, message: 'Logged in successfully', data: FAKE_TOKEN },
      headers: {},
    });
    const bundle = await new LoginTokenService({} as never, config).getToken(auth);
    const login = sent();
    expect(String(login.method).toUpperCase()).toBe('POST');
    expect(login.url).toBe('https://apis.jisr.net/api/openapi/v1/auth');
    expect(login.headers).toMatchObject({
      slug: 'acme',
      'api-key': ENV.JISR_API_KEY,
      secret: ENV.JISR_API_SECRET,
      'api-version': '1',
      source: 'open_api',
    });
    expect(login.data).toEqual({});
    expect(bundle.token).toBe(FAKE_TOKEN);
  });

  it('probes with one employee and explains refusals', () => {
    expect(a.probe).toEqual({ tool: 'jisr_list_employees', params: { rpp: 1 } });
    expect(tool('jisr_list_employees').parameters.required ?? []).toEqual([]);
    for (const status of ['401', '403']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('turns success:false envelopes into failed calls', () => {
    expect(statusOf({ success: true, data: { employees: [] } })).toBeUndefined();
    expect(statusOf({ success: false, error: 'This call requires login' })).toBe(401);
    expect(statusOf({ success: false, error: 'Organization not found with given subdomain' })).toBe(401);
    expect(statusOf({ success: false, error: 'Parameter status is required', status_code: 400 })).toBe(400);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^jisr_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(80);
    }
  });

  it('keeps reads read-only and installs the punch upload switched off', () => {
    for (const entry of a.tools) {
      if (entry.name === 'jisr_create_attendance_logs') continue;
      expect(entry.endpointMapping.method).toBe('GET');
      expect(entry.enabled).not.toBe(false);
      expect(annotationsOf(entry).readOnlyHint).toBe(true);
    }
    const create = tool('jisr_create_attendance_logs');
    expect(create.enabled).toBe(false);
    expect(create.endpointMapping).toMatchObject({ method: 'POST', path: '/openapi/v1/attendance_logs', bodyMapping: { data: '$punches' } });
    expect(annotationsOf(create).readOnlyHint).toBe(false);
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists employees with the bracketed date filters and drops bank details', async () => {
    mockedAxios.mockResolvedValueOnce(ok);
    await call('jisr_list_employees', { status: 'active', joining_from: '2026-01-01', terminated_to: '2026-10-31' });
    expect(sent().url).toBe('https://apis.jisr.net/api/openapi/v1/employees');
    expect(String(sent().method).toUpperCase()).toBe('GET');
    expect(sent().params).toEqual({
      status: 'active',
      'joining_date[from]': '2026-01-01',
      'terminate_date[to]': '2026-10-31',
      page: 1,
      rpp: 100,
    });
    expectJisrHeaders();
    const body = {
      success: true,
      data: {
        employees: [{ id: 'f664cdf1-5911-4f67-bf40-244ef23040a9', code: 43, bank: { iban: 'SA0380000000608010167519' } }],
        pagination: { current_page: 1, total_pages: 1 },
      },
    };
    const shaped = applyResponseTransform(body, tool('jisr_list_employees').responseMapping as never).value as {
      data: { employees: Array<Record<string, unknown>> };
    };
    expect(shaped.data.employees[0]).toEqual({ id: 'f664cdf1-5911-4f67-bf40-244ef23040a9', code: 43 });
  });

  it('reads one employee, the attendance summary, failed punches and leave balances', async () => {
    mockedAxios.mockResolvedValueOnce(ok);
    await call('jisr_get_employee', { employee_id: 'bab6cd98-7246-4cfc-a576-19bc00391792' });
    expect(sent().url).toBe('https://apis.jisr.net/api/openapi/v1/employees/basic_info');
    expect(sent().params).toEqual({ id: 'bab6cd98-7246-4cfc-a576-19bc00391792' });
    expectJisrHeaders();

    mockedAxios.mockResolvedValueOnce(ok);
    await call('jisr_get_attendance_summary', { from: '2026-10-01', to: '2026-10-31' });
    expect(sent().url).toBe('https://apis.jisr.net/api/openapi/v1/attendance/summary');
    expect(sent().params).toEqual({ from: '2026-10-01', to: '2026-10-31', status: 'active', page: 1, rpp: 100 });
    expectJisrHeaders();

    mockedAxios.mockResolvedValueOnce(ok);
    await call('jisr_list_attendance_logs', { status: 'failed', from: '2026-11-01T00:00:00' });
    expect(sent().url).toBe('https://apis.jisr.net/api/openapi/v1/attendance_logs');
    expect(sent().params).toEqual({ status: 'failed', from: '2026-11-01T00:00:00', page: 1, limit: 100 });

    mockedAxios.mockResolvedValueOnce(ok);
    await call('jisr_get_annual_leave_summary', { employee_codes: ['43', '77'] });
    expect(sent().url).toBe('https://apis.jisr.net/api/openapi/v1/employee_leaves/summary');
    expect(sent().params).toEqual({ leave_type: 'annual', employee_codes: ['43', '77'], page: 1, limit: 100 });
    expect(sent().paramsSerializer(sent().params)).toBe('leave_type=annual&employee_codes=43&employee_codes=77&page=1&limit=100');

    mockedAxios.mockResolvedValueOnce(ok);
    await call('jisr_list_lookup', { lookup: 'departments' });
    expect(sent().url).toBe('https://apis.jisr.net/api/openapi/v1/lookups/departments');
    expectJisrHeaders();
  });

  it('submits punches as the data array', async () => {
    mockedAxios.mockResolvedValueOnce(ok);
    const punches = [{ emp_code: '199', punch_time: '2026-11-05T08:01:00', terminal_sn: 'ZKT-001', id: 5467897 }];
    await call('jisr_create_attendance_logs', { punches });
    expect(sent().url).toBe('https://apis.jisr.net/api/openapi/v1/attendance_logs');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ data: punches });
    expectJisrHeaders();
  });
});

// Opt-in: RUN_JISR_LIVE=1. The refusal check needs no account; the reads need
// JISR_SLUG, JISR_API_KEY and JISR_API_SECRET. Reads only.
const live = process.env.RUN_JISR_LIVE === '1';
const liveFetch = mockedAxios.__actual;
const BASE = 'https://apis.jisr.net/api/openapi/v1';
(live ? describe : describe.skip)('Jisr: live', () => {
  it('refuses an unknown organization at the session endpoint', async () => {
    const response = await liveFetch.post(
      `${BASE}/auth`,
      {},
      {
        headers: { slug: 'no-such-org-anythingmcp', 'api-key': 'not-a-key', secret: 'not-a-secret', 'api-version': '1' },
        validateStatus: () => true,
      },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.data).toMatchObject({ success: false });
  });

  it('signs in and reads one employee page and the attendance summary', async () => {
    const env = process.env;
    const missing = ['JISR_SLUG', 'JISR_API_KEY', 'JISR_API_SECRET'].filter((name) => !env[name]);
    if (missing.length) throw new Error(`Set ${missing.join(', ')} for the authenticated live check`);
    const login = await liveFetch.post(
      `${BASE}/auth`,
      {},
      {
        headers: {
          slug: env.JISR_SLUG!,
          'api-key': env.JISR_API_KEY!,
          secret: env.JISR_API_SECRET!,
          'api-version': '1',
          source: 'open_api',
        },
        validateStatus: () => true,
      },
    );
    expect(login.status).toBe(200);
    const token = (login.data as { data?: string }).data;
    expect(token).toBeTruthy();
    const headers = { 'Access-Token': token!, slug: env.JISR_SLUG!, 'api-version': '1', Accept: 'application/json' };

    const employees = await liveFetch.get(`${BASE}/employees`, { headers, params: { rpp: 1 }, validateStatus: () => true });
    expect(employees.status).toBe(200);
    expect(employees.data.success).toBe(true);
    expect(Array.isArray(employees.data.data.employees)).toBe(true);

    const summary = await liveFetch.get(`${BASE}/attendance/summary`, { headers, params: { rpp: 1 }, validateStatus: () => true });
    expect([200, 403]).toContain(summary.status);
  });
});
