import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as adapter from './everhour.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';

/**
 * Two layers of verification for the Everhour adapter (api.everhour.com):
 *
 *   1. Static: always runs. Pins the X-Api-Key header, every tool's method,
 *      URL, query and body through the real RestEngine, which tools write, and
 *      the response shaping. Checked on 15 Oct 2026 against Everhour's
 *      OpenAPI document (developers.everhour.com/openapi.json) and its older
 *      API Blueprint (everhour.docs.apiary.io, API version 1.2).
 *
 *   2. Live: skipped unless RUN_EVERHOUR_LIVE=1. It checks that the routes
 *      exist (403 Access denied with a made-up key, while a made-up route
 *      answers 404). Everhour stops answering an address that sends many
 *      refused keys (everything turns 404 for a while), so the checks are
 *      paced and use a fresh made-up key each time. With EVERHOUR_API_KEY it
 *      also runs every read on that account. RUN_EVERHOUR_LIVE_WRITES=1 with
 *      EVERHOUR_TEST_TASK_ID (a task of a test project, e.g. ev:123) adds one
 *      minute of time, changes it, deletes it again, and starts and stops a
 *      timer on that task:
 *
 *        RUN_EVERHOUR_LIVE=1 EVERHOUR_API_KEY=... npx jest src/adapters/intl/everhour.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params: Record<string, unknown> };
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

const HOST = 'https://api.everhour.com';
// Built at run time so no literal looks like a real credential.
const fakeKey = () => ['a1b2', 'c3d4', Math.random().toString(16).slice(2, 8), Math.random().toString(16).slice(2, 8), 'e5f6a7b8'].join('-');
const FAKE_KEY = fakeKey();
const ENV: Record<string, string> = { EVERHOUR_API_KEY: FAKE_KEY };

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
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
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => new URLSearchParams(sent().paramsSerializer(sent().params));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['everhour_get_me', {}, 'GET', '/users/me'],
  ['everhour_list_users', {}, 'GET', '/team/users'],
  ['everhour_list_projects', { query: 'Website' }, 'GET', '/projects'],
  ['everhour_get_project', { project_id: 'ev:1234567890' }, 'GET', '/projects/ev:1234567890'],
  ['everhour_list_project_tasks', { project_id: 'ev:1234567890' }, 'GET', '/projects/ev:1234567890/tasks'],
  ['everhour_search_tasks', { query: 'design' }, 'GET', '/tasks/search'],
  ['everhour_get_task', { task_id: 'ev:3000010034' }, 'GET', '/tasks/ev:3000010034'],
  ['everhour_list_clients', {}, 'GET', '/clients'],
  ['everhour_list_time_records', { from: '2026-10-01', to: '2026-10-15' }, 'GET', '/team/time'],
  ['everhour_list_user_time_records', { user_id: 1304 }, 'GET', '/users/1304/time'],
  ['everhour_list_project_time_records', { project_id: 'as:13456788' }, 'GET', '/projects/as:13456788/time'],
  ['everhour_add_time', { task_id: 'ev:3000010034', date: '2026-10-15', time: 3600 }, 'POST', '/time'],
  ['everhour_update_time_record', { time_id: 8006001, date: '2026-10-15', time: 1800 }, 'PUT', '/time/8006001'],
  ['everhour_delete_time_record', { time_id: 8006001 }, 'DELETE', '/time/8006001'],
  ['everhour_get_running_timer', {}, 'GET', '/timers/current'],
  ['everhour_list_team_timers', {}, 'GET', '/team/timers'],
  ['everhour_start_timer', { task_id: 'ev:3000010034' }, 'POST', '/timers'],
  ['everhour_stop_timer', {}, 'DELETE', '/timers/current'],
  ['everhour_list_invoices', {}, 'GET', '/invoices'],
  ['everhour_get_invoice', { invoice_id: 11903 }, 'GET', '/invoices/11903'],
  ['everhour_list_expenses', {}, 'GET', '/expenses'],
  ['everhour_list_schedule', {}, 'GET', '/resource-planner/assignments'],
  ['everhour_projects_report', {}, 'GET', '/dashboards/projects'],
  ['everhour_users_report', {}, 'GET', '/dashboards/users'],
];
const WRITES = ['everhour_add_time', 'everhour_update_time_record', 'everhour_start_timer', 'everhour_stop_timer'];
const OFF = ['everhour_delete_time_record'];

describe('everhour adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('time-tracking');
    expect(a.icon).toBe('everhour');
  });

  it('sends the API key as X-Api-Key to api.everhour.com and checks it on /users/me', () => {
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Api-Key', apiKey: '{{EVERHOUR_API_KEY}}' });
    expect(a.connector.headers['X-Accept-Version']).toBe('1.2');
    expect(a.connector.healthcheckPath).toBe('/users/me');
    expect(a.probe).toEqual({ tool: 'everhour_get_me', params: {} });
    expect(a.requiredEnvVars).toEqual(['EVERHOUR_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.EVERHOUR_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.EVERHOUR_API_KEY.pattern!);
    for (const good of [FAKE_KEY, 'abcd-efgh-1234567-7890ab-cdefgh12']) expect(pattern.test(good)).toBe(true);
    for (const bad of ['', 'short', 'X-Api-Key: abcd-efgh-1234567-7890ab']) expect(pattern.test(bad)).toBe(false);
    for (const key of ['401', '403', '429']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool with everhour_ and shares no tool name with another adapter file', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^everhour_[a-z_]+$/);
    const root = path.join(__dirname, '..');
    for (const region of fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory())) {
      for (const file of fs.readdirSync(path.join(root, region)).filter((f) => f.endsWith('.json') && f !== 'everhour.json')) {
        const other = JSON.parse(fs.readFileSync(path.join(root, region, file), 'utf8'));
        for (const t of other.tools ?? []) expect(`${file}:${mine.has(t.name)}`).toBe(`${file}:false`);
      }
    }
  });

  it('asks for confirmation on every write, installs the delete switched off and marks the rest read-only', () => {
    for (const name of [...WRITES, ...OFF]) {
      expect(tool(name).description).toMatch(/confirm with the user first/);
      expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    // Stopping a timer saves time; it does not remove anything.
    expect(annotationsOf(tool('everhour_stop_timer'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsOf(tool('everhour_delete_time_record'))).toMatchObject({ destructiveHint: true });
    for (const t of a.tools.filter((x) => ![...WRITES, ...OFF].includes(x.name))) {
      expect(`${t.name}:${t.endpointMapping.method}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:GET:true`);
      expect(t.description).toMatch(/Read-only\./);
    }
  });

  it('explains units, ids, setup and confirmations, names only real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\beverhour_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\beverhour_[a-z_]+/g)]),
      ...a.tools.flatMap((t) => Object.values(t.parameters.properties ?? {}).flatMap((p) => [...String(p.description).matchAll(/\beverhour_[a-z_]+/g)])),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/seconds/);
    expect(a.instructions).toMatch(/cents/);
    expect(a.instructions).toMatch(/Writes need a yes/);
    expect(a.instructions).toMatch(/My Profile/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('gives every tool a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
  });

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the X-Api-Key header', async (name, params, method, p) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${p}`);
    expect(req.headers['X-Api-Key']).toBe(FAKE_KEY);
  });

  it('builds the time and timer bodies with Everhour field names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('everhour_add_time', { task_id: 'ev:3000010034', date: '2026-10-15', time: 5400, user_id: 1304, comment: 'Design review' });
    expect(sent().data).toEqual({ task: 'ev:3000010034', date: '2026-10-15', time: 5400, user: 1304, comment: 'Design review' });
    mockedAxios.mockClear();
    await call('everhour_update_time_record', { time_id: 8006001, time: 1800, comment: 'Fixed' });
    expect(sent().data).toEqual({ time: 1800, comment: 'Fixed' });
    mockedAxios.mockClear();
    await call('everhour_start_timer', { task_id: 'ev:3000010034', user_date: '2026-10-15', comment: 'Call' });
    expect(sent().data).toEqual({ task: 'ev:3000010034', userDate: '2026-10-15', comment: 'Call' });
  });

  it('maps the list and report filters to Everhour query names', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('everhour_list_time_records', { from: '2026-10-01', to: '2026-10-15', page: 2 });
    expect(Object.fromEntries(query())).toEqual({ from: '2026-10-01', to: '2026-10-15', limit: '500', page: '2' });
    mockedAxios.mockClear();
    await call('everhour_list_project_tasks', { project_id: 'ev:1', exclude_closed: true });
    expect(Object.fromEntries(query())).toEqual({ 'exclude-closed': 'true', limit: '100' });
    mockedAxios.mockClear();
    await call('everhour_search_tasks', { query: 'design', search_in_closed: true });
    expect(Object.fromEntries(query())).toEqual({ query: 'design', limit: '20', searchInClosed: 'true' });
    mockedAxios.mockClear();
    await call('everhour_projects_report', { date_from: '2026-01-01', date_to: '2026-03-31', client_id: 12345 });
    expect(Object.fromEntries(query())).toEqual({ 'date.gte': '2026-01-01', 'date.lte': '2026-03-31', clientId: '12345' });
    mockedAxios.mockClear();
    await call('everhour_list_schedule', { type: 'time-off', project_id: 'ev:3456780034', from: '2026-11-01' });
    expect(Object.fromEntries(query())).toEqual({ type: 'time-off', project: 'ev:3456780034', from: '2026-11-01' });
  });

  it('shapes time records without the edit history and keeps the task', () => {
    const shaped = shape('everhour_list_time_records', [
      {
        id: 2660155,
        time: 3600,
        user: 1304,
        date: '2026-10-14',
        comment: 'notes',
        isLocked: false,
        isInvoiced: false,
        task: { id: 'ev:9876543210', name: 'Task Name', projects: ['ev:1234567890'], attributes: { Client: 'x' }, metrics: { efforts: 42 } },
        history: [{ id: 4622379, createdBy: 1304, time: 3600, previousTime: 0, action: 'TIMER' }],
      },
    ]);
    expect(shaped).toEqual({
      timeRecords: [
        { id: 2660155, date: '2026-10-14', time: 3600, user: 1304, comment: 'notes', taskId: 'ev:9876543210', taskName: 'Task Name', projects: ['ev:1234567890'], isLocked: false, isInvoiced: false },
      ],
    });
    const timer = shape('everhour_get_running_timer', { status: 'active', duration: 16, startedAt: '2026-10-15 12:42:59', task: { id: 'ev:1', name: 'T', attributes: {} }, user: { id: 1304, name: 'Chris', avatarUrl: 'x' } });
    expect(timer).toEqual({ status: 'active', duration: 16, startedAt: '2026-10-15 12:42:59', taskId: 'ev:1', taskName: 'T', userId: 1304, userName: 'Chris' });
    const stopped = shape('everhour_stop_timer', { status: 'stopped', taskTime: { id: 8006001, time: 960, date: '2026-10-15', user: 1304, task: { id: 'ev:1', name: 'T' }, comment: 'Call' }, timecard: null });
    expect(stopped).toEqual({ status: 'stopped', savedTimeRecordId: 8006001, savedTime: 960, date: '2026-10-15', taskId: 'ev:1', taskName: 'T', comment: 'Call' });
    const report = shape('everhour_users_report', [{ memberId: 1, memberName: 'A', memberAvatarUrl: 'x', time: 7200, billableTime: 3600, costsTimeOff: 5 }]);
    expect(report).toEqual({ users: [{ memberId: 1, memberName: 'A', time: 7200, billableTime: 3600 }] });
  });
});

const live = process.env.RUN_EVERHOUR_LIVE === '1' ? describe : describe.skip;
live('everhour adapter: live', () => {
  const real = !!process.env.EVERHOUR_API_KEY;
  const writes = real && process.env.RUN_EVERHOUR_LIVE_WRITES === '1' && !!process.env.EVERHOUR_TEST_TASK_ID;
  const env = () => ({ EVERHOUR_API_KEY: process.env.EVERHOUR_API_KEY! });
  const run = async (name: string, params: Record<string, unknown> = {}) => {
    await sleep(700); // about 20 requests per 10 seconds per key
    return shape(name, await call(name, params, env()));
  };
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  const probes = table.filter(([name]) => ['everhour_get_me', 'everhour_list_projects', 'everhour_get_task', 'everhour_list_time_records', 'everhour_list_invoices', 'everhour_list_schedule'].includes(name));
  it.each(probes)('%s reaches a real route and is refused with a made-up key (403)', async (name, params) => {
    await sleep(2000);
    await expect(call(name, params, { EVERHOUR_API_KEY: fakeKey() })).rejects.toMatchObject({ response: { status: 403 } });
  }, 30000);

  it('answers a made-up route with 404, which makes the 403s above meaningful', async () => {
    await sleep(2000);
    await expect(
      (mockedAxios.__actual as any).request({ method: 'GET', url: `${HOST}/no-such-route`, headers: { 'X-Api-Key': fakeKey() } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (real ? it : it.skip)('runs every read on the account', async () => {
    const me = await run('everhour_get_me');
    expect(typeof me.id).toBe('number');
    const users = await run('everhour_list_users');
    expect(Array.isArray(users.users)).toBe(true);
    const projects = await run('everhour_list_projects', { limit: 5 });
    expect(Array.isArray(projects.projects)).toBe(true);
    const project = projects.projects[0];
    if (project) {
      expect((await run('everhour_get_project', { project_id: project.id })).id).toBe(project.id);
      const tasks = await run('everhour_list_project_tasks', { project_id: project.id, limit: 5 });
      if (tasks.tasks[0]) expect((await run('everhour_get_task', { task_id: tasks.tasks[0].id })).id).toBe(tasks.tasks[0].id);
      await run('everhour_list_project_time_records', { project_id: project.id, limit: 5 });
    }
    await run('everhour_search_tasks', { query: 'a', limit: 3 });
    await run('everhour_list_clients');
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
    const records = await run('everhour_list_time_records', { from, to, limit: 10 });
    expect(Array.isArray(records.timeRecords)).toBe(true);
    await run('everhour_list_user_time_records', { user_id: me.id, from, to, limit: 10 });
    await run('everhour_get_running_timer');
    await run('everhour_list_team_timers');
    const invoices = await run('everhour_list_invoices');
    if (invoices.invoices[0]) await run('everhour_get_invoice', { invoice_id: invoices.invoices[0].id });
    await run('everhour_list_expenses');
    await run('everhour_list_schedule', { from, to });
    await run('everhour_projects_report', { date_from: from, date_to: to });
    await run('everhour_users_report', { date_from: from, date_to: to });
  }, 180000);

  (writes ? it : it.skip)('adds, changes and deletes one minute, and starts and stops a timer on the test task', async () => {
    const task = process.env.EVERHOUR_TEST_TASK_ID!;
    const date = new Date().toISOString().slice(0, 10);
    const added = await run('everhour_add_time', { task_id: task, date, time: 60, comment: 'AnythingMCP live test' });
    expect(added.taskId).toBe(task);
    const changed = await run('everhour_update_time_record', { time_id: added.id, date, time: 120, task_id: task });
    expect(changed.time).toBe(120);
    await run('everhour_delete_time_record', { time_id: added.id });
    const started = await run('everhour_start_timer', { task_id: task, comment: 'AnythingMCP live test' });
    expect(started.status).toBe('active');
    const stopped = await run('everhour_stop_timer');
    expect(stopped.status).toBe('stopped');
    expect(stopped.taskId).toBe(task);
  }, 120000);
});
