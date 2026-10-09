import axios from 'axios';
import * as adapter from './google-tasks.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google Tasks adapter:
 *
 *   1. Static: always runs. Pins the OAuth setup shared by the Google
 *      adapters, the @me / @default aliases, the PATCH bodies that update and
 *      complete a task, the move parameters, and that deleting installs
 *      switched off.
 *
 *   2. Live: skipped unless GOOGLE_ACCESS_TOKEN is set (tasks.readonly for
 *      reads, tasks for the write round-trip):
 *
 *        GOOGLE_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/google-tasks.live.spec.ts
 *
 *      With GOOGLE_LIVE_WRITE=1 as well, an "AnythingMCP test list" is
 *      created with a task and a subtask, which are updated, completed,
 *      moved and deleted; the list itself is deleted in `finally`.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    // The outbound helper also calls axios.getUri, getAdapter and friends:
    // keep every real static, only the call itself is mocked.
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
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

const BASE = 'https://tasks.googleapis.com/tasks/v1';
const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
});
// Arguments as DynamicMcpTools hands them to the engine: schema defaults filled in.
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
const sent = () => mockedAxios.mock.calls[0][0];

describe('google-tasks adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified live on 9 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('signs in with the shared Google OAuth client and the tasks scope', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/tasks',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/read-only setup[^\n]*tasks\.readonly/);
  });

  it('probes by listing task lists, which needs no arguments', () => {
    expect(a.probe.tool).toBe('gtasks_list_tasklists');
    expect(tool('gtasks_list_tasklists').endpointMapping.method).toBe('GET');
    expect(tool('gtasks_list_tasklists').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/users/@me/lists?maxResults=1');
  });

  it('prefixes every tool with gtasks_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gtasks_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('percent-encodes ids placed in the path', () => {
    for (const t of a.tools) {
      if (/\{\w+\}/.test(t.endpointMapping.path)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('installs only the delete tool switched off, and says so', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['gtasks_delete_task']);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `gtasks_delete_task`/);
    expect(annotationsOf(tool('gtasks_delete_task')).destructiveHint).toBe(true);
  });

  it('marks reads read-only and completing or editing a task as non-destructive', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(['gtasks_get_task', 'gtasks_list_tasklists', 'gtasks_list_tasks']);
    expect(annotationsOf(tool('gtasks_complete_task'))).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(annotationsOf(tool('gtasks_update_task')).destructiveHint).toBe(false);
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgtasks_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgtasks_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['gtasks_list_tasklists', {}, 'GET', '/users/@me/lists'],
    ['gtasks_create_tasklist', { title: 'L' }, 'POST', '/users/@me/lists'],
    ['gtasks_list_tasks', { tasklist_id: '@default' }, 'GET', '/lists/%40default/tasks'],
    ['gtasks_get_task', { tasklist_id: 'L1', task_id: 'T1' }, 'GET', '/lists/L1/tasks/T1'],
    ['gtasks_create_task', { tasklist_id: 'L1', title: 'x' }, 'POST', '/lists/L1/tasks'],
    ['gtasks_update_task', { tasklist_id: 'L1', task_id: 'T1', title: 'y' }, 'PATCH', '/lists/L1/tasks/T1'],
    ['gtasks_complete_task', { tasklist_id: 'L1', task_id: 'T1' }, 'PATCH', '/lists/L1/tasks/T1'],
    ['gtasks_move_task', { tasklist_id: 'L1', task_id: 'T1' }, 'POST', '/lists/L1/tasks/T1/move'],
    ['gtasks_delete_task', { tasklist_id: 'L1', task_id: 'T1' }, 'DELETE', '/lists/L1/tasks/T1'],
  ])('%s sends %s to the right Tasks URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url: `${BASE}${path}`,
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('filters tasks by due date and completion', async () => {
    mockedAxios.mockResolvedValue({ data: { items: [] } });
    await call('gtasks_list_tasks', {
      tasklist_id: '@default',
      show_completed: true,
      show_hidden: true,
      due_max: '2026-10-31T00:00:00Z',
      max_results: 100,
    });
    expect(sent().params).toEqual({ showCompleted: true, showHidden: true, dueMax: '2026-10-31T00:00:00Z', maxResults: 100 });
  });

  it('creates subtasks through query parameters and completes with a fixed body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gtasks_create_task', { tasklist_id: 'L1', title: 'Call Ana', due: '2026-10-15T00:00:00.000Z', parent: 'P1' });
    expect(sent().params).toEqual({ parent: 'P1' });
    expect(sent().data).toEqual({ title: 'Call Ana', due: '2026-10-15T00:00:00.000Z' });
    mockedAxios.mockClear();
    await call('gtasks_complete_task', { tasklist_id: 'L1', task_id: 'T1' });
    expect(sent().data).toEqual({ status: 'completed' });
    mockedAxios.mockClear();
    await call('gtasks_update_task', { tasklist_id: 'L1', task_id: 'T1', status: 'needsAction' });
    expect(sent().data).toEqual({ status: 'needsAction' });
    mockedAxios.mockClear();
    await call('gtasks_move_task', { tasklist_id: 'L1', task_id: 'T1', destination_tasklist_id: 'L2' });
    expect(sent().params).toEqual({ destinationTasklist: 'L2' });
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('google-tasks adapter: live Tasks API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const bearer = () => ({
    baseUrl: a.connector.baseUrl,
    authType: 'BEARER_TOKEN',
    authConfig: { token: TOKEN as string },
    headers: a.connector.headers,
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(bearer(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));

  it('runs the probe and lists the default list', async () => {
    const lists = await run(a.probe.tool, a.probe.params);
    expect(Array.isArray(lists.items)).toBe(true);
    const tasks = await run('gtasks_list_tasks', { tasklist_id: '@default', max_results: 5 });
    expect(tasks.kind).toBe('tasks#tasks');
    if (tasks.items?.length) {
      const one = await run('gtasks_get_task', { tasklist_id: '@default', task_id: tasks.items[0].id });
      expect(one.id).toBe(tasks.items[0].id);
    }
  }, 30_000);

  (process.env.GOOGLE_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a test list with a task and a subtask, edits, completes, moves and deletes them',
    async () => {
      const list = await run('gtasks_create_tasklist', { title: `AnythingMCP test list ${new Date().toISOString()}` });
      try {
        const parent = await run('gtasks_create_task', {
          tasklist_id: list.id,
          title: 'AnythingMCP test task',
          notes: 'Grüße, perché 👋',
          due: '2030-01-15T00:00:00.000Z',
        });
        expect(parent.due).toBe('2030-01-15T00:00:00.000Z');
        const child = await run('gtasks_create_task', { tasklist_id: list.id, title: 'AnythingMCP test subtask', parent: parent.id });
        expect(child.parent).toBe(parent.id);
        const updated = await run('gtasks_update_task', { tasklist_id: list.id, task_id: parent.id, title: 'AnythingMCP test task (renamed)' });
        expect(updated.title).toBe('AnythingMCP test task (renamed)');
        const done = await run('gtasks_complete_task', { tasklist_id: list.id, task_id: child.id });
        expect(done.status).toBe('completed');
        const moved = await run('gtasks_move_task', { tasklist_id: list.id, task_id: child.id });
        expect(moved.parent).toBeUndefined();
        const all = await run('gtasks_list_tasks', { tasklist_id: list.id, show_completed: true, show_hidden: true });
        expect(all.items).toHaveLength(2);
        await run('gtasks_delete_task', { tasklist_id: list.id, task_id: child.id });
      } finally {
        await engine().execute(bearer(), { method: 'DELETE', path: '/users/@me/lists/{id}', encodePathParams: true }, { id: list.id });
      }
    },
    90_000,
  );
});
