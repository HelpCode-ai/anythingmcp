import axios from 'axios';
import * as adapter from './timetrack.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * TimeTrack (TimeTrack Enterprise) API adapter.
 *
 * Static checks always run: the account host built from TIMETRACK_ACCOUNT,
 * the App Key and App Secret headers, every tool's method and path against
 * TimeTrack's API documentation, the query filters and write bodies, and
 * which tools install switched off (the three deletes).
 * https://www.timetrackapp.com/en/api/
 *
 * Live checks run only with RUN_TIMETRACK_LIVE=1. Without credentials they
 * confirm that an unknown account name answers 404; with TIMETRACK_ACCOUNT,
 * TIMETRACK_API_KEY and TIMETRACK_API_SECRET they read the absence types.
 * Reads only.
 *
 *   RUN_TIMETRACK_LIVE=1 TIMETRACK_ACCOUNT=... TIMETRACK_API_KEY=... TIMETRACK_API_SECRET=... \
 *     npx jest src/adapters/intl/timetrack.live.spec.ts
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
  TIMETRACK_ACCOUNT: 'acme',
  TIMETRACK_API_KEY: 'test-app-key-0123456789',
  TIMETRACK_API_SECRET: 'test-app-secret-0123456789',
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
  ['timetrack_list_users', 'GET', '/users'],
  ['timetrack_get_user', 'GET', '/users/{user_id}'],
  ['timetrack_list_clients', 'GET', '/clients'],
  ['timetrack_get_client', 'GET', '/clients/{client_id}'],
  ['timetrack_create_client', 'POST', '/clients'],
  ['timetrack_list_projects', 'GET', '/projects'],
  ['timetrack_get_project', 'GET', '/projects/{project_id}'],
  ['timetrack_create_project', 'POST', '/projects'],
  ['timetrack_update_project', 'PUT', '/projects/{project_id}'],
  ['timetrack_list_tasks', 'GET', '/tasks'],
  ['timetrack_list_project_time_entries', 'GET', '/project_time_entries'],
  ['timetrack_get_project_time_entry', 'GET', '/project_time_entries/{entry_id}'],
  ['timetrack_create_project_time_entry', 'POST', '/project_time_entries'],
  ['timetrack_update_project_time_entry', 'PUT', '/project_time_entries/{entry_id}'],
  ['timetrack_delete_project_time_entry', 'DELETE', '/project_time_entries/{entry_id}'],
  ['timetrack_list_attendances', 'GET', '/attendances'],
  ['timetrack_get_attendance', 'GET', '/attendances/{attendance_id}'],
  ['timetrack_create_attendance', 'POST', '/attendances'],
  ['timetrack_update_attendance', 'PUT', '/attendances/{attendance_id}'],
  ['timetrack_delete_attendance', 'DELETE', '/attendances/{attendance_id}'],
  ['timetrack_list_absence_types', 'GET', '/absence_types'],
  ['timetrack_list_absences', 'GET', '/absences'],
  ['timetrack_get_absence', 'GET', '/absences/{absence_id}'],
  ['timetrack_create_absence', 'POST', '/absences'],
  ['timetrack_update_absence', 'PUT', '/absences/{absence_id}'],
  ['timetrack_delete_absence', 'DELETE', '/absences/{absence_id}'],
  ['timetrack_list_expenses', 'GET', '/expenses'],
  ['timetrack_list_daily_reports', 'GET', '/work_reports'],
  ['timetrack_get_grouped_report', 'GET', '/work_reports/group'],
  ['timetrack_get_attendance_timer', 'GET', '/attendance_timer'],
  ['timetrack_start_attendance_timer', 'POST', '/attendance_timer/start'],
  ['timetrack_stop_attendance_timer', 'POST', '/attendance_timer/stop'],
  ['timetrack_get_project_timer', 'GET', '/timers/project_timer'],
  ['timetrack_start_project_timer', 'POST', '/timers/project_timer/start'],
  ['timetrack_stop_project_timer', 'POST', '/timers/project_timer/stop'],
];
const REQUIRED: Record<string, string[]> = {
  timetrack_get_user: ['user_id'],
  timetrack_get_client: ['client_id'],
  timetrack_create_client: ['name'],
  timetrack_get_project: ['project_id'],
  timetrack_create_project: ['project_name', 'client_name'],
  timetrack_update_project: ['project_id'],
  timetrack_get_project_time_entry: ['entry_id'],
  timetrack_create_project_time_entry: ['username', 'client_name', 'project_name', 'from', 'to'],
  timetrack_update_project_time_entry: ['entry_id'],
  timetrack_delete_project_time_entry: ['entry_id'],
  timetrack_get_attendance: ['attendance_id'],
  timetrack_create_attendance: ['username', 'from', 'to'],
  timetrack_update_attendance: ['attendance_id'],
  timetrack_delete_attendance: ['attendance_id'],
  timetrack_get_absence: ['absence_id'],
  timetrack_create_absence: ['username', 'absence_type', 'from', 'to'],
  timetrack_update_absence: ['absence_id', 'status'],
  timetrack_delete_absence: ['absence_id'],
  timetrack_list_daily_reports: ['username', 'from', 'to'],
  timetrack_get_grouped_report: ['username', 'from', 'to'],
  timetrack_get_attendance_timer: ['username', 'date'],
  timetrack_start_attendance_timer: ['username', 'date'],
  timetrack_stop_attendance_timer: ['username', 'date'],
  timetrack_get_project_timer: ['username', 'date'],
  timetrack_start_project_timer: ['username', 'client_name', 'project_name', 'date'],
  timetrack_stop_project_timer: ['username', 'date'],
};
const OFF: string[] = ['timetrack_delete_project_time_entry', 'timetrack_delete_attendance', 'timetrack_delete_absence'];

describe('timetrack adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('builds the account host and sends App Key and App Secret as headers', () => {
    expect(a.slug).toBe('timetrack');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('time-tracking');
    expect(a.icon).toBe('timetrack');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://{{TIMETRACK_ACCOUNT}}.timetrackenterprise.com/api/v2/ext');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'X-TimeTrack-Api-Key',
      apiKey: '{{TIMETRACK_API_KEY}}',
      extraHeaders: { 'X-TimeTrack-Api-Secret': '{{TIMETRACK_API_SECRET}}' },
    });
    expect(a.requiredEnvVars).toEqual(['TIMETRACK_ACCOUNT', 'TIMETRACK_API_KEY', 'TIMETRACK_API_SECRET']);
    expect(a.envVarMeta.TIMETRACK_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.TIMETRACK_API_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.TIMETRACK_ACCOUNT).toMatchObject({ kind: 'address' });
    const account = new RegExp(a.envVarMeta.TIMETRACK_ACCOUNT.pattern!);
    for (const good of ['acme', 'acme-gmbh', 'a1']) expect(account.test(good)).toBe(true);
    for (const bad of ['', 'Acme', 'https://acme.timetrackenterprise.com', 'acme.timetrackenterprise.com', '-acme']) expect(account.test(bad)).toBe(false);
    expect(a.probe).toEqual({ tool: 'timetrack_list_absence_types', params: {} });
    for (const key of ['401', '403', '404', '422', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('covers the absence and client paths the block is built around', () => {
    const has = (method: string, path: string) => a.tools.some((entry) => entry.endpointMapping.method === method && entry.endpointMapping.path === path);
    expect(has('GET', '/absence_types')).toBe(true);
    expect(has('GET', '/absences')).toBe(true);
    expect(has('GET', '/absences/{absence_id}')).toBe(true);
    expect(has('POST', '/absences')).toBe(true);
    expect(has('PUT', '/absences/{absence_id}')).toBe(true);
    expect(has('GET', '/clients')).toBe(true);
    // Every DELETE is installed switched off, and no tool manages users.
    for (const entry of a.tools) {
      if (entry.endpointMapping.method === 'DELETE') expect(entry.enabled).toBe(false);
      if (entry.endpointMapping.path.startsWith('/users')) expect(entry.endpointMapping.method).toBe('GET');
    }
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
    for (const name of mine) expect(name).toMatch(/^timetrack_[a-z0-9_]+$/);
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

  it('lists the absences of an employee on the account host with both headers', async () => {
    ok([]);
    await call('timetrack_list_absences', { username: 'tester', from: '2026-10-01', to: '2026-10-31' });
    const req = sent();
    expect(req.url).toBe('https://acme.timetrackenterprise.com/api/v2/ext/absences');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'X-TimeTrack-Api-Key')).toBe(ENV.TIMETRACK_API_KEY);
    expect(header(req, 'X-TimeTrack-Api-Secret')).toBe(ENV.TIMETRACK_API_SECRET);
    expect(wire(req)).toBe('username=tester&from=2026-10-01&to=2026-10-31&page_number=0&limit=50');

    ok([]);
    await call('timetrack_list_clients', { name: 'test', limit: 1000 });
    expect(sent().url).toBe('https://acme.timetrackenterprise.com/api/v2/ext/clients');
    expect(sent().params).toEqual({ name: 'test', page_number: 0, limit: 1000 });

    ok({});
    await call('timetrack_get_absence', { absence_id: 7 });
    expect(sent().url).toBe('https://acme.timetrackenterprise.com/api/v2/ext/absences/7');

    ok({});
    await call('timetrack_get_grouped_report', { username: 'tester', from: '2026-08-01T00:00:00Z', to: '2026-10-31T00:00:00Z' });
    expect(sent().url).toBe('https://acme.timetrackenterprise.com/api/v2/ext/work_reports/group');
    expect(sent().params).toEqual({ username: 'tester', from: '2026-08-01T00:00:00Z', to: '2026-10-31T00:00:00Z' });
  });

  it('files and approves an absence and books time with the documented bodies', async () => {
    ok({}, 201);
    await call('timetrack_create_absence', { username: 'tester', absence_type: 1, from: '2026-10-26', to: '2026-10-28' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe('https://acme.timetrackenterprise.com/api/v2/ext/absences');
    expect(sent().data).toEqual({ username: 'tester', absenceType: 1, from: '2026-10-26', to: '2026-10-28' });

    ok({});
    await call('timetrack_update_absence', { absence_id: 7, status: 1 });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe('https://acme.timetrackenterprise.com/api/v2/ext/absences/7');
    expect(sent().data).toEqual({ status: 1 });

    ok({}, 201);
    await call('timetrack_create_project_time_entry', {
      username: 'tester',
      client_name: 'Client 001',
      project_name: 'Project 006_1',
      from: '2026-10-20T10:00:00.000Z',
      to: '2026-10-20T14:00:00.000Z',
      task: 'Development',
      break_minutes: 15,
    });
    expect(sent().url).toBe('https://acme.timetrackenterprise.com/api/v2/ext/project_time_entries');
    expect(sent().data).toEqual({
      username: 'tester',
      clientName: 'Client 001',
      projectName: 'Project 006_1',
      from: '2026-10-20T10:00:00.000Z',
      to: '2026-10-20T14:00:00.000Z',
      task: 'Development',
      breakMinutes: 15,
    });

    // TimeTrack's attendance examples name the break minutesBreak, its field
    // table breakMinutes: the adapter sends both names with the same value.
    ok({}, 201);
    await call('timetrack_create_attendance', { username: 'tester', from: '2026-10-17T10:00:00.000Z', to: '2026-10-17T14:00:00.000Z', break_minutes: 15 });
    expect(sent().data).toEqual({
      username: 'tester',
      from: '2026-10-17T10:00:00.000Z',
      to: '2026-10-17T14:00:00.000Z',
      breakMinutes: 15,
      minutesBreak: 15,
    });

    ok({}, 201);
    await call('timetrack_stop_attendance_timer', { username: 'tester', date: '2026-10-23T15:00:00.000Z' });
    expect(sent().url).toBe('https://acme.timetrackenterprise.com/api/v2/ext/attendance_timer/stop');
    expect(sent().data).toEqual({ username: 'tester', date: '2026-10-23T15:00:00.000Z' });

    ok({});
    await call('timetrack_delete_absence', { absence_id: 7 });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe('https://acme.timetrackenterprise.com/api/v2/ext/absences/7');
  });
});

// Opt-in: RUN_TIMETRACK_LIVE=1. The first check needs no account; the read
// needs TIMETRACK_ACCOUNT, TIMETRACK_API_KEY and TIMETRACK_API_SECRET.
// Nothing is written.
const live = process.env.RUN_TIMETRACK_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('timetrack: live', () => {
  it('answers 404 for an account name that does not exist', async () => {
    const response = await liveFetch.get('https://b39-no-such-account.timetrackenterprise.com/api/v2/ext/absence_types', {
      validateStatus: () => true,
    });
    expect(response.status).toBe(404);
  });

  it('reads the absence types', async () => {
    const account = process.env.TIMETRACK_ACCOUNT;
    const key = process.env.TIMETRACK_API_KEY;
    const secret = process.env.TIMETRACK_API_SECRET;
    if (!account || !key || !secret) return;
    const response = await liveFetch.get(`https://${account}.timetrackenterprise.com/api/v2/ext/absence_types`, {
      headers: { 'X-TimeTrack-Api-Key': key, 'X-TimeTrack-Api-Secret': secret, 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
  });
});
