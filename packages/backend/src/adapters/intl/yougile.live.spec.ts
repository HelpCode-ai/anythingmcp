import axios from 'axios';
import * as adapter from './yougile.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * YouGile REST API v2 adapter.
 *
 * Static checks always run: the bearer key, every tool's method and path
 * against YouGile's published OpenAPI document (https://yougile.com/api-json),
 * the write bodies, the query filters of the list tools, and which tools
 * install switched off. Deleting is a PUT with deleted: true and stays off.
 * https://yougile.com/api-v2
 *
 * Live checks run only with RUN_YOUGILE_LIVE=1. Without a key they confirm
 * that the API refuses an anonymous call; with YOUGILE_API_KEY they read the
 * key owner. Reads only.
 *
 *   RUN_YOUGILE_LIVE=1 YOUGILE_API_KEY=... \
 *     npx jest src/adapters/intl/yougile.live.spec.ts
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
  YOUGILE_API_KEY: 'test-key-0123456789abcdefghijABCDEFGHIJ-0123456789_test',
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
  ['yougile_get_current_user', 'GET', '/users/me'],
  ['yougile_list_users', 'GET', '/users'],
  ['yougile_get_user', 'GET', '/users/{user_id}'],
  ['yougile_list_departments', 'GET', '/departments'],
  ['yougile_get_department', 'GET', '/departments/{department_id}'],
  ['yougile_list_projects', 'GET', '/projects'],
  ['yougile_get_project', 'GET', '/projects/{project_id}'],
  ['yougile_create_project', 'POST', '/projects'],
  ['yougile_update_project', 'PUT', '/projects/{project_id}'],
  ['yougile_list_boards', 'GET', '/boards'],
  ['yougile_get_board', 'GET', '/boards/{board_id}'],
  ['yougile_create_board', 'POST', '/boards'],
  ['yougile_update_board', 'PUT', '/boards/{board_id}'],
  ['yougile_list_columns', 'GET', '/columns'],
  ['yougile_get_column', 'GET', '/columns/{column_id}'],
  ['yougile_create_column', 'POST', '/columns'],
  ['yougile_update_column', 'PUT', '/columns/{column_id}'],
  ['yougile_list_tasks', 'GET', '/task-list'],
  ['yougile_get_task', 'GET', '/tasks/{task_id}'],
  ['yougile_create_task', 'POST', '/tasks'],
  ['yougile_update_task', 'PUT', '/tasks/{task_id}'],
  ['yougile_move_task', 'PUT', '/tasks/{task_id}'],
  ['yougile_delete_task', 'PUT', '/tasks/{task_id}'],
  ['yougile_list_task_messages', 'GET', '/chats/{chat_id}/messages'],
  ['yougile_send_task_message', 'POST', '/chats/{chat_id}/messages'],
  ['yougile_list_group_chats', 'GET', '/group-chats'],
  ['yougile_list_string_stickers', 'GET', '/string-stickers'],
  ['yougile_get_string_sticker', 'GET', '/string-stickers/{sticker_id}'],
  ['yougile_create_string_sticker', 'POST', '/string-stickers'],
  ['yougile_list_sprint_stickers', 'GET', '/sprint-stickers'],
  ['yougile_get_sprint_sticker', 'GET', '/sprint-stickers/{sticker_id}'],
  ['yougile_create_sprint_sticker', 'POST', '/sprint-stickers'],
  ['yougile_list_webhooks', 'GET', '/webhooks'],
];
const REQUIRED: Record<string, string[]> = {
  yougile_get_user: ['user_id'],
  yougile_get_department: ['department_id'],
  yougile_get_project: ['project_id'],
  yougile_create_project: ['title'],
  yougile_update_project: ['project_id'],
  yougile_get_board: ['board_id'],
  yougile_create_board: ['title', 'project_id'],
  yougile_update_board: ['board_id'],
  yougile_get_column: ['column_id'],
  yougile_create_column: ['title', 'board_id'],
  yougile_update_column: ['column_id'],
  yougile_get_task: ['task_id'],
  yougile_create_task: ['title'],
  yougile_update_task: ['task_id'],
  yougile_move_task: ['task_id', 'column_id'],
  yougile_delete_task: ['task_id'],
  yougile_list_task_messages: ['chat_id'],
  yougile_send_task_message: ['chat_id', 'text', 'text_html'],
  yougile_get_string_sticker: ['sticker_id'],
  yougile_create_string_sticker: ['name'],
  yougile_get_sprint_sticker: ['sticker_id'],
  yougile_create_sprint_sticker: ['name'],
};
const OFF: string[] = ['yougile_delete_task'];

describe('yougile adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('talks to yougile.com/api-v2 with the API key as a bearer token', () => {
    expect(a.slug).toBe('yougile');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('project-management');
    expect(a.icon).toBe('yougile');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://yougile.com/api-v2');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{YOUGILE_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['YOUGILE_API_KEY']);
    expect(a.envVarMeta.YOUGILE_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta.YOUGILE_API_KEY.pattern!);
    expect(pattern.test(ENV.YOUGILE_API_KEY)).toBe(true);
    for (const bad of ['', 'Bearer abc def ghi jkl mno pqr', 'short']) expect(pattern.test(bad)).toBe(false);
    expect(a.probe).toEqual({ tool: 'yougile_get_current_user', params: {} });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('covers the paths the block is built around', () => {
    const has = (method: string, path: string) => a.tools.some((entry) => entry.endpointMapping.method === method && entry.endpointMapping.path === path);
    for (const path of ['/projects', '/boards']) expect(has('GET', path)).toBe(true);
    for (const path of ['/projects', '/boards', '/columns', '/string-stickers', '/sprint-stickers']) expect(has('POST', path)).toBe(true);
    // No tool deletes through the key endpoints or removes an employee.
    for (const entry of a.tools) expect(entry.endpointMapping.method).not.toBe('DELETE');
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
    for (const name of mine) expect(name).toMatch(/^yougile_[a-z0-9_]+$/);
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

  it('lists the tasks of a column with paging and the bearer key', async () => {
    ok({ paging: { count: 0, limit: 50, offset: 0, next: false }, content: [] });
    await call('yougile_list_tasks', { column_id: 'fefbc00f-3870-4f52-807f-225ce2e4c701', assigned_to: 'u1,u2' });
    const req = sent();
    expect(req.url).toBe('https://yougile.com/api-v2/task-list');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.YOUGILE_API_KEY}`);
    expect(req.params).toEqual({ limit: 50, offset: 0, columnId: 'fefbc00f-3870-4f52-807f-225ce2e4c701', assignedTo: 'u1,u2' });
    expect(wire(req)).toBe('limit=50&offset=0&columnId=fefbc00f-3870-4f52-807f-225ce2e4c701&assignedTo=u1,u2');

    ok({ paging: {}, content: [] });
    await call('yougile_list_boards', { project_id: 'p1', limit: 1000, offset: 1000 });
    expect(sent().url).toBe('https://yougile.com/api-v2/boards');
    expect(sent().params).toEqual({ limit: 1000, offset: 1000, projectId: 'p1' });

    ok({ paging: {}, content: [] });
    await call('yougile_list_task_messages', { chat_id: 't1', since: 1795000000000 });
    expect(sent().url).toBe('https://yougile.com/api-v2/chats/t1/messages');
    expect(sent().params).toEqual({ limit: 50, offset: 0, since: 1795000000000 });
  });

  it('creates, changes, moves and deletes with the documented bodies', async () => {
    ok({ id: 't1' }, 201);
    await call('yougile_create_task', {
      title: 'Call the supplier',
      column_id: 'c1',
      assigned: ['u1'],
      deadline: { deadline: 1795000000000, withTime: false },
    });
    expect(sent().url).toBe('https://yougile.com/api-v2/tasks');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({
      title: 'Call the supplier',
      columnId: 'c1',
      assigned: ['u1'],
      deadline: { deadline: 1795000000000, withTime: false },
    });

    ok({ id: 't1' });
    await call('yougile_update_task', { task_id: 't1', completed: true, stickers: { s1: 'state1' } });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe('https://yougile.com/api-v2/tasks/t1');
    expect(sent().data).toEqual({ completed: true, stickers: { s1: 'state1' } });

    ok({ id: 't1' });
    await call('yougile_move_task', { task_id: 't1', column_id: 'c2' });
    expect(sent().url).toBe('https://yougile.com/api-v2/tasks/t1');
    expect(sent().data).toEqual({ columnId: 'c2' });

    ok({ id: 't1' });
    await call('yougile_delete_task', { task_id: 't1' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().data).toEqual({ deleted: true });

    ok({ id: 'p1' }, 201);
    await call('yougile_create_project', { title: 'Website', users: { u1: 'admin' } });
    expect(sent().url).toBe('https://yougile.com/api-v2/projects');
    expect(sent().data).toEqual({ title: 'Website', users: { u1: 'admin' } });

    ok({ id: 'c1' }, 201);
    await call('yougile_create_column', { title: 'To do', board_id: 'b1', color: 2 });
    expect(sent().data).toEqual({ title: 'To do', boardId: 'b1', color: 2 });

    ok({ id: 's1' }, 201);
    await call('yougile_create_sprint_sticker', { name: 'Sprints', states: [{ name: 'Sprint 1', begin: 1795000000, end: 1796000000 }] });
    expect(sent().url).toBe('https://yougile.com/api-v2/sprint-stickers');
    expect(sent().data).toEqual({ name: 'Sprints', states: [{ name: 'Sprint 1', begin: 1795000000, end: 1796000000 }] });

    ok({ id: 1795000000001 }, 201);
    await call('yougile_send_task_message', { chat_id: 't1', text: 'Done', text_html: '<p>Done</p>' });
    expect(sent().url).toBe('https://yougile.com/api-v2/chats/t1/messages');
    expect(sent().data).toEqual({ text: 'Done', textHtml: '<p>Done</p>' });
  });
});

// Opt-in: RUN_YOUGILE_LIVE=1. The refusal check needs no account; the read
// needs YOUGILE_API_KEY. Nothing is written.
const live = process.env.RUN_YOUGILE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('yougile: live', () => {
  it('refuses a call without a key', async () => {
    const response = await liveFetch.get('https://yougile.com/api-v2/projects', { validateStatus: () => true });
    expect(response.status).toBe(401);
  });

  it('reads the key owner', async () => {
    const key = process.env.YOUGILE_API_KEY;
    if (!key) return;
    const response = await liveFetch.get('https://yougile.com/api-v2/users/me', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(typeof response.data.id).toBe('string');
  });
});
