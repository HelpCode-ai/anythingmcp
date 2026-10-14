import axios from 'axios';
import * as adapter from './microsoft-todo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Microsoft To Do (Microsoft Graph) adapter:
 *
 *   1. Static: always runs. Pins the Entra OAuth setup shared with the other
 *      Microsoft connectors (tenant in both endpoints, offline_access,
 *      Tasks.ReadWrite), the task bodies Graph documents (dateTimeTimeZone
 *      objects passed through whole, fields the caller leaves out never
 *      sent), the fixed `completed` status of the complete tool, and that the
 *      deletes install switched off.
 *
 *   2. Live: skipped unless MS_GRAPH_ACCESS_TOKEN is set (a delegated Graph
 *      token with Tasks.ReadWrite, e.g. from Graph Explorer):
 *
 *        MS_GRAPH_ACCESS_TOKEN=eyJ... npx jest src/adapters/intl/microsoft-todo.live.spec.ts
 *
 *      With TODO_LIVE_WRITE=1 as well, an "AnythingMCP test" list is created
 *      with a task, a checklist step and a link; the task is updated and
 *      completed, and the list is deleted in `finally`.
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
  parameters: { properties?: Record<string, { default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  appRegistrationUrl: string;
  requiredEnvVars: string[];
  probe: { tool: string };
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
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping as any, annotations: t.annotations });

const BASE = 'https://graph.microsoft.com/v1.0';
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
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping as any, applySchemaDefaults(tool(name).parameters as any, params));
const sent = () => mockedAxios.mock.calls[0][0];

// Graph ids of To Do are base64 and may end in "=".
const LIST = 'AAMkADIyAAAEFTTrJAAA=';
const TASK = 'AlMKXwbQAAAJws6wcAAAA=';
const L = encodeURIComponent(LIST);
const T = encodeURIComponent(TASK);

describe('microsoft-todo adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: verified on a live account on 14 Oct 2026, and says up front that it needs an Entra app', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.prerequisites).toMatch(/Entra/);
    expect(a.prerequisites).toMatch(/Outlook connector can be reused/);
    expect(a.appRegistrationUrl).toMatch(/^https:\/\/entra\.microsoft\.com\//);
  });

  it('signs in against the configured tenant with the shared Microsoft variables and asks for a refresh token', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID']);
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MICROSOFT_CLIENT_ID}}',
      clientSecret: '{{MICROSOFT_CLIENT_SECRET}}',
      authorizationUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/token',
      scopes: 'offline_access User.Read Tasks.ReadWrite',
    });
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/One Entra app for all Microsoft connectors/);
    expect(a.instructions).toMatch(/read-only setup[^\n]*Tasks\.Read`/);
  });

  it('probes with the task lists, which need no arguments', () => {
    expect(a.probe.tool).toBe('microsoft_todo_list_lists');
    expect(tool('microsoft_todo_list_lists').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/me/todo/lists');
  });

  it('prefixes every tool with microsoft_todo_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^microsoft_todo_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('percent-encodes every id in the path', () => {
    for (const t of a.tools) {
      if (/\{\w+\}/.test(t.endpointMapping.path)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('installs the deletes switched off, and asks the model to confirm every write', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([
      'microsoft_todo_delete_list',
      'microsoft_todo_delete_task',
    ]);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `microsoft_todo_delete_task` and `microsoft_todo_delete_list`/);
    for (const t of a.tools.filter((x) => x.endpointMapping.method !== 'GET')) {
      expect(`${t.name}: ${t.description}`).toMatch(/Confirm with the user before calling\.$/);
    }
  });

  it('marks reads read-only, deletes destructive, and completing or ticking as harmless', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'microsoft_todo_get_task',
      'microsoft_todo_list_checklist_items',
      'microsoft_todo_list_linked_resources',
      'microsoft_todo_list_lists',
      'microsoft_todo_list_tasks',
    ]);
    expect(annotationsOf(tool('microsoft_todo_delete_task')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('microsoft_todo_delete_list')).destructiveHint).toBe(true);
    for (const name of ['microsoft_todo_complete_task', 'microsoft_todo_update_checklist_item', 'microsoft_todo_rename_list']) {
      expect(annotationsOf(tool(name))).toMatchObject({ destructiveHint: false, idempotentHint: true });
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmicrosoft_todo_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmicrosoft_todo_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['microsoft_todo_list_lists', {}, 'GET', '/me/todo/lists'],
    ['microsoft_todo_create_list', { display_name: 'L' }, 'POST', '/me/todo/lists'],
    ['microsoft_todo_rename_list', { list_id: LIST, display_name: 'L' }, 'PATCH', `/me/todo/lists/${L}`],
    ['microsoft_todo_delete_list', { list_id: LIST }, 'DELETE', `/me/todo/lists/${L}`],
    ['microsoft_todo_list_tasks', { list_id: LIST }, 'GET', `/me/todo/lists/${L}/tasks`],
    ['microsoft_todo_get_task', { list_id: LIST, task_id: TASK }, 'GET', `/me/todo/lists/${L}/tasks/${T}`],
    ['microsoft_todo_create_task', { list_id: LIST, title: 'X' }, 'POST', `/me/todo/lists/${L}/tasks`],
    ['microsoft_todo_update_task', { list_id: LIST, task_id: TASK, title: 'X' }, 'PATCH', `/me/todo/lists/${L}/tasks/${T}`],
    ['microsoft_todo_complete_task', { list_id: LIST, task_id: TASK }, 'PATCH', `/me/todo/lists/${L}/tasks/${T}`],
    ['microsoft_todo_delete_task', { list_id: LIST, task_id: TASK }, 'DELETE', `/me/todo/lists/${L}/tasks/${T}`],
    ['microsoft_todo_list_checklist_items', { list_id: LIST, task_id: TASK }, 'GET', `/me/todo/lists/${L}/tasks/${T}/checklistItems`],
    ['microsoft_todo_add_checklist_item', { list_id: LIST, task_id: TASK, display_name: 'S' }, 'POST', `/me/todo/lists/${L}/tasks/${T}/checklistItems`],
    ['microsoft_todo_update_checklist_item', { list_id: LIST, task_id: TASK, checklist_item_id: 'e3a2', is_checked: true }, 'PATCH', `/me/todo/lists/${L}/tasks/${T}/checklistItems/e3a2`],
    ['microsoft_todo_list_linked_resources', { list_id: LIST, task_id: TASK }, 'GET', `/me/todo/lists/${L}/tasks/${T}/linkedResources`],
    ['microsoft_todo_add_linked_resource', { list_id: LIST, task_id: TASK, web_url: 'https://x.test/1', application_name: 'X' }, 'POST', `/me/todo/lists/${L}/tasks/${T}/linkedResources`],
  ])('%s sends %s to the right Graph URL', async (name, params, method, path) => {
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

  it('filters open tasks and pages with OData options', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    await call('microsoft_todo_list_tasks', { list_id: LIST, filter: "status ne 'completed'", top: 50, skip: 50 });
    expect(sent().params).toEqual({ $filter: "status ne 'completed'", $top: 50, $skip: 50 });
  });

  it('creates a task with the dateTimeTimeZone objects, note and categories Graph documents', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('microsoft_todo_create_task', {
      list_id: LIST,
      title: 'Send the Q4 report',
      body: { content: 'Attach the PDF', contentType: 'text' },
      importance: 'high',
      due: { dateTime: '2026-10-31T00:00:00', timeZone: 'Europe/Berlin' },
      reminder: { dateTime: '2026-10-30T09:00:00', timeZone: 'Europe/Berlin' },
      is_reminder_on: true,
      categories: ['Red category'],
    });
    expect(sent().data).toEqual({
      title: 'Send the Q4 report',
      body: { content: 'Attach the PDF', contentType: 'text' },
      importance: 'high',
      dueDateTime: { dateTime: '2026-10-31T00:00:00', timeZone: 'Europe/Berlin' },
      reminderDateTime: { dateTime: '2026-10-30T09:00:00', timeZone: 'Europe/Berlin' },
      isReminderOn: true,
      categories: ['Red category'],
    });
  });

  it('sends only the fields an update names, keeps false, and completes with a fixed status', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('microsoft_todo_update_task', { list_id: LIST, task_id: TASK, status: 'inProgress', is_reminder_on: false });
    expect(sent().data).toEqual({ status: 'inProgress', isReminderOn: false });
    mockedAxios.mockClear();
    await call('microsoft_todo_complete_task', { list_id: LIST, task_id: TASK });
    expect(sent().data).toEqual({ status: 'completed' });
    mockedAxios.mockClear();
    await call('microsoft_todo_update_checklist_item', { list_id: LIST, task_id: TASK, checklist_item_id: 'e3a2', is_checked: false });
    expect(sent().data).toEqual({ isChecked: false });
  });

  it('builds checklist and linked resource bodies with Graph field names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('microsoft_todo_add_checklist_item', { list_id: LIST, task_id: TASK, display_name: 'Sign-off' });
    expect(sent().data).toEqual({ displayName: 'Sign-off' });
    mockedAxios.mockClear();
    await call('microsoft_todo_add_linked_resource', {
      list_id: LIST,
      task_id: TASK,
      web_url: 'https://example.atlassian.net/browse/OPS-42',
      application_name: 'Jira',
      display_name: 'OPS-42',
      external_id: 'OPS-42',
    });
    expect(sent().data).toEqual({
      webUrl: 'https://example.atlassian.net/browse/OPS-42',
      applicationName: 'Jira',
      displayName: 'OPS-42',
      externalId: 'OPS-42',
    });
  });
});

const TOKEN = process.env.MS_GRAPH_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('microsoft-todo adapter: live Graph API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService)
      .execute(
        { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
        tool(name).endpointMapping as any,
        applySchemaDefaults(tool(name).parameters as any, params),
      )
      .then((raw) => applyResponseTransform(raw, tool(name).responseMapping).value);

  it('reads the lists and the open tasks of the default list', async () => {
    const lists = await run('microsoft_todo_list_lists');
    expect(Array.isArray(lists.value)).toBe(true);
    const def = lists.value.find((l: { wellknownListName: string }) => l.wellknownListName === 'defaultList') ?? lists.value[0];
    if (def) {
      const open = await run('microsoft_todo_list_tasks', { list_id: def.id, filter: "status ne 'completed'", top: 5 });
      expect(Array.isArray(open.value)).toBe(true);
      for (const t of open.value) expect(t.status).not.toBe('completed');
    }
  }, 60_000);

  (process.env.TODO_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a list with a task, a step and a link, updates and completes the task, then deletes the list',
    async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const list = await run('microsoft_todo_create_list', { display_name: `AnythingMCP test ${stamp}` });
      try {
        await run('microsoft_todo_rename_list', { list_id: list.id, display_name: `AnythingMCP test renamed ${stamp}` });
        const task = await run('microsoft_todo_create_task', {
          list_id: list.id,
          title: 'AnythingMCP test task',
          body: { content: 'Grüße, perché', contentType: 'text' },
          due: { dateTime: '2030-01-15T00:00:00', timeZone: 'UTC' },
          importance: 'high',
        });
        expect(task.dueDateTime.dateTime).toMatch(/^2030-01-15/);
        const step = await run('microsoft_todo_add_checklist_item', { list_id: list.id, task_id: task.id, display_name: 'Step 1' });
        const ticked = await run('microsoft_todo_update_checklist_item', { list_id: list.id, task_id: task.id, checklist_item_id: step.id, is_checked: true });
        expect(ticked.isChecked).toBe(true);
        const steps = await run('microsoft_todo_list_checklist_items', { list_id: list.id, task_id: task.id });
        expect(steps.value).toHaveLength(1);
        await run('microsoft_todo_add_linked_resource', { list_id: list.id, task_id: task.id, web_url: 'https://example.com/ticket/1', application_name: 'AnythingMCP test', display_name: 'Ticket 1' });
        const links = await run('microsoft_todo_list_linked_resources', { list_id: list.id, task_id: task.id });
        expect(links.value[0].webUrl).toBe('https://example.com/ticket/1');
        const updated = await run('microsoft_todo_update_task', { list_id: list.id, task_id: task.id, title: 'AnythingMCP test task (updated)' });
        expect(updated.title).toBe('AnythingMCP test task (updated)');
        const done = await run('microsoft_todo_complete_task', { list_id: list.id, task_id: task.id });
        expect(done.status).toBe('completed');
        const open = await run('microsoft_todo_list_tasks', { list_id: list.id, filter: "status ne 'completed'" });
        expect(open.value).toHaveLength(0);
        await run('microsoft_todo_delete_task', { list_id: list.id, task_id: task.id });
      } finally {
        await run('microsoft_todo_delete_list', { list_id: list.id });
      }
    },
    120_000,
  );
});
