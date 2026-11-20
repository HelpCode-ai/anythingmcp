import axios from 'axios';
import * as adapter from './lark.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { assertNoResponseBodyError, ResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Lark / Feishu Open Platform adapter (custom app, tenant access token).
 *
 * Static checks always run: the host offered as a fixed choice (Lark or
 * Feishu), the LOGIN_TOKEN exchange of App ID and App Secret at
 * /open-apis/auth/v3/tenant_access_token/internal (token of about 2 hours,
 * renewed early and after a refusal reported in the body), every tool's method
 * and path against the Open Platform reference, the message content built as
 * JSON text, the mapping of Lark's non-zero "code" answers to errors, the
 * read-only hints on the POST searches, and which tools install switched off.
 * https://open.larksuite.com/document/home/index
 *
 * Without credentials the live check confirms both hosts refuse wrong
 * credentials and an invalid token; with LARK_APP_ID and LARK_APP_SECRET it
 * fetches a token and reads the bot.
 *
 * Live checks run only with RUN_LARK_LIVE=1 and never write.
 *
 *   RUN_LARK_LIVE=1 [LARK_APP_ID=... LARK_APP_SECRET=... LARK_BASE_URL=...] \
 *     npx jest src/adapters/intl/lark.live.spec.ts
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
    envDefaults?: Record<string, string>;
    encodePathParams?: boolean;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: { errorWhen?: unknown; largeIntegers?: string };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error('missing tool ' + name);
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
// Text outside `code` must not carry characters the website reads as MDX.
const plain = (text: string) => text.replace(/`[^`]*`/g, '');

// Placeholders, not credentials.
const ENV: Record<string, string> = {
  LARK_BASE_URL: 'https://open.larksuite.com',
  LARK_APP_ID: 'cli_a1b2c3d4e5f6g7h8',
  LARK_APP_SECRET: 'test-lark-app-secret-0123456789ab',
};

// name, method, path, required parameters: as the vendor documents them.
const TOOLS: Array<[string, string, string, string]> = [
  ['lark_get_bot_info', 'GET', '/open-apis/bot/v3/info', ''],
  ['lark_list_chats', 'GET', '/open-apis/im/v1/chats', ''],
  ['lark_get_chat', 'GET', '/open-apis/im/v1/chats/{chat_id}', 'chat_id'],
  ['lark_list_chat_members', 'GET', '/open-apis/im/v1/chats/{chat_id}/members', 'chat_id'],
  ['lark_list_messages', 'GET', '/open-apis/im/v1/messages', 'container_id'],
  ['lark_get_message', 'GET', '/open-apis/im/v1/messages/{message_id}', 'message_id'],
  ['lark_send_text_message', 'POST', '/open-apis/im/v1/messages', 'receive_id_type,receive_id,text'],
  ['lark_send_message', 'POST', '/open-apis/im/v1/messages', 'receive_id_type,receive_id,msg_type,content'],
  ['lark_reply_to_message', 'POST', '/open-apis/im/v1/messages/{message_id}/reply', 'message_id,text'],
  ['lark_edit_message', 'PUT', '/open-apis/im/v1/messages/{message_id}', 'message_id,text'],
  ['lark_recall_message', 'DELETE', '/open-apis/im/v1/messages/{message_id}', 'message_id'],
  ['lark_list_department_users', 'GET', '/open-apis/contact/v3/users/find_by_department', 'department_id'],
  ['lark_get_user', 'GET', '/open-apis/contact/v3/users/{user_id}', 'user_id'],
  ['lark_lookup_user_ids', 'POST', '/open-apis/contact/v3/users/batch_get_id', ''],
  ['lark_list_child_departments', 'GET', '/open-apis/contact/v3/departments/{department_id}/children', 'department_id'],
  ['lark_list_drive_files', 'GET', '/open-apis/drive/v1/files', ''],
  ['lark_get_document_content', 'GET', '/open-apis/docx/v1/documents/{document_id}/raw_content', 'document_id'],
  ['lark_get_wiki_node', 'GET', '/open-apis/wiki/v2/spaces/get_node', 'token'],
  ['lark_list_bitable_tables', 'GET', '/open-apis/bitable/v1/apps/{app_token}/tables', 'app_token'],
  ['lark_list_bitable_fields', 'GET', '/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields', 'app_token,table_id'],
  ['lark_search_bitable_records', 'POST', '/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/search', 'app_token,table_id'],
  ['lark_create_bitable_record', 'POST', '/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records', 'app_token,table_id,fields'],
  ['lark_update_bitable_record', 'PUT', '/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}', 'app_token,table_id,record_id,fields'],
  ['lark_delete_bitable_record', 'DELETE', '/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}', 'app_token,table_id,record_id'],
  ['lark_list_calendars', 'GET', '/open-apis/calendar/v4/calendars', ''],
  ['lark_list_calendar_events', 'GET', '/open-apis/calendar/v4/calendars/{calendar_id}/events', 'calendar_id'],
  ['lark_get_calendar_event', 'GET', '/open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}', 'calendar_id,event_id'],
  ['lark_create_calendar_event', 'POST', '/open-apis/calendar/v4/calendars/{calendar_id}/events', 'calendar_id,summary,start_timestamp,end_timestamp'],
  ['lark_add_event_attendees', 'POST', '/open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}/attendees', 'calendar_id,event_id,attendees'],
  ['lark_list_tasklists', 'GET', '/open-apis/task/v2/tasklists', ''],
  ['lark_list_tasklist_tasks', 'GET', '/open-apis/task/v2/tasklists/{tasklist_guid}/tasks', 'tasklist_guid'],
  ['lark_get_task', 'GET', '/open-apis/task/v2/tasks/{task_guid}', 'task_guid'],
  ['lark_create_task', 'POST', '/open-apis/task/v2/tasks', 'summary'],
  ['lark_list_approval_instances', 'GET', '/open-apis/approval/v4/instances', 'approval_code,start_time,end_time'],
  ['lark_get_approval_instance', 'GET', '/open-apis/approval/v4/instances/{instance_id}', 'instance_id'],
];
const SWITCHED_OFF = ['lark_delete_bitable_record','lark_recall_message'];
const READ_ONLY = new Set(['lark_get_bot_info','lark_list_chats','lark_get_chat','lark_list_chat_members','lark_list_messages','lark_get_message','lark_list_department_users','lark_get_user','lark_lookup_user_ids','lark_list_child_departments','lark_list_drive_files','lark_get_document_content','lark_get_wiki_node','lark_list_bitable_tables','lark_list_bitable_fields','lark_search_bitable_records','lark_list_calendars','lark_list_calendar_events','lark_get_calendar_event','lark_list_tasklists','lark_list_tasklist_tasks','lark_get_task','lark_list_approval_instances','lark_get_approval_instance']);

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown> = {}) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  const bundle = async () => ({ token: 'test-login-token', expiresAt: Date.now() + 900_000 });
  const login = { getToken: bundle, forceRelogin: bundle } as unknown as LoginTokenService;
  return new RestEngine(tokens, login).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
      errorWhen: a.connector.config?.errorWhen,
      largeIntegers: a.connector.config?.largeIntegers,
    } as never,
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const bodyErrorStatus = (body: unknown) => {
  try {
    assertNoResponseBodyError(body, a.connector.config?.errorWhen);
  } catch (e) {
    return (e as ResponseBodyError).status;
  }
  return 200;
};

describe('lark adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the expected envelope, variables, probe and hints', () => {
    expect(a.slug).toBe('lark');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('lark');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{LARK_BASE_URL}}');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.requiredEnvVars).toEqual(['LARK_BASE_URL','LARK_APP_ID','LARK_APP_SECRET']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.probe.tool).toBe('lark_get_bot_info');
    for (const key of ['400','401','403','404','auth_failed','rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) expect(a.envVarMeta[name]).toBeTruthy();
    expect(a.prerequisites.length).toBeGreaterThan(40);
  });

  it('exchanges App ID and App Secret for a tenant access token on the chosen host', async () => {
    expect(a.envVarMeta.LARK_BASE_URL.options!.map((o) => o.value)).toEqual(['https://open.larksuite.com', 'https://open.feishu.cn']);
    expect(a.envVarMeta.LARK_APP_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(new RegExp(a.envVarMeta.LARK_APP_ID.pattern!).test(ENV.LARK_APP_ID)).toBe(true);
    expect(new RegExp(a.envVarMeta.LARK_APP_ID.pattern!).test('a1b2c3d4e5f6g7h8')).toBe(false);
    expect(a.connector.authConfig).toEqual({
      loginUrl: '{{LARK_BASE_URL}}/open-apis/auth/v3/tenant_access_token/internal',
      loginMethod: 'POST',
      loginHeaders: { 'Content-Type': 'application/json; charset=utf-8' },
      loginBody: { app_id: '${username}', app_secret: '${password}' },
      username: '{{LARK_APP_ID}}',
      password: '{{LARK_APP_SECRET}}',
      tokenJsonPath: 'tenant_access_token',
      expiryJsonPath: 'expire',
      expiryFormat: 'ttl_seconds',
      tokenTTLSeconds: 7200,
      proactiveRefreshSeconds: 600,
      refreshOn401: true,
      refreshOnBody401: true,
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
    });
    // The token lives 2 hours: the early renewal must be shorter than that.
    expect(Number(a.connector.authConfig.proactiveRefreshSeconds)).toBeLessThan(Number(a.connector.authConfig.tokenTTLSeconds));

    ok({ code: 0, msg: 'ok', bot: { app_name: 'Test', open_id: 'ou_x' } });
    await call('lark_get_bot_info');
    const req = sent();
    expect(req.url).toBe('https://open.larksuite.com/open-apis/bot/v3/info');
    expect(header(req, 'Authorization')).toBe('Bearer test-login-token');
    for (const entry of a.tools) expect(entry.endpointMapping.path.startsWith('/open-apis/')).toBe(true);
  });

  it('keeps every tool on its documented method and path', () => {
    expect(a.tools.map((t) => [t.name, t.endpointMapping.method, t.endpointMapping.path, (t.parameters.required ?? []).join(',')])).toEqual(TOOLS);
    expect(a.tools).toHaveLength(35);
  });

  it('prefixes every tool and declares every argument it reads', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    expect(names.size).toBe(a.tools.length);
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      expect(entry.name).toMatch(/^lark_[a-z0-9_]+$/);
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, variable] of Object.entries(entry.endpointMapping.envDefaults ?? {})) {
        expect(declared.has(param)).toBe(true);
        expect(entry.parameters.required ?? []).not.toContain(param);
        expect(a.optionalEnvVars ?? []).toContain(variable);
      }
      for (const def of Object.values(entry.parameters.properties ?? {})) expect(def.description).toBeTruthy();
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('marks reads read-only and installs the risky tools switched off', () => {
    for (const entry of a.tools) {
      expect(entry.name + ':' + String(annotationsOf(entry).readOnlyHint)).toBe(entry.name + ':' + String(READ_ONLY.has(entry.name)));
    }
    expect(a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name).sort()).toEqual(SWITCHED_OFF);
    expect(tool('lark_recall_message').endpointMapping.method).toBe('DELETE');
    expect(tool('lark_delete_bitable_record').endpointMapping.method).toBe('DELETE');
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    for (const entry of a.tools) {
      expect(a.instructions).toContain(entry.name);
      expect(plain(entry.description)).not.toMatch(/[{}<]/);
      for (const def of Object.values(entry.parameters.properties ?? {})) expect(plain(def.description ?? '')).not.toMatch(/[{}<]/);
    }
    expect(plain(a.instructions)).not.toMatch(/[{}<]/);
    expect(plain(a.description)).not.toMatch(/[{}<]/);
    expect(a.instructions).not.toMatch(/\u2014/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('builds the message content as JSON text', async () => {
    ok({ code: 0, data: { message_id: 'om_1' } });
    await call('lark_send_text_message', { receive_id_type: 'chat_id', receive_id: 'oc_a0553eda9014c201e6969b478895c230', text: 'Hello "team"' });
    expect(sent().url).toBe('https://open.larksuite.com/open-apis/im/v1/messages');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().params).toEqual({ receive_id_type: 'chat_id' });
    expect(sent().data).toEqual({ receive_id: 'oc_a0553eda9014c201e6969b478895c230', msg_type: 'text', content: JSON.stringify({ text: 'Hello "team"' }) });

    ok({ code: 0, data: {} });
    await call('lark_reply_to_message', { message_id: 'om_dc13264520392913993dd051dba21dcf', text: 'Done', reply_in_thread: true });
    expect(sent().url).toBe('https://open.larksuite.com/open-apis/im/v1/messages/om_dc13264520392913993dd051dba21dcf/reply');
    expect(sent().data).toEqual({ msg_type: 'text', content: JSON.stringify({ text: 'Done' }), reply_in_thread: true });

    ok({ code: 0, data: {} });
    await call('lark_send_message', { receive_id_type: 'open_id', receive_id: 'ou_x', msg_type: 'share_chat', content: '{"chat_id":"oc_y"}' });
    expect(sent().data).toEqual({ receive_id: 'ou_x', msg_type: 'share_chat', content: '{"chat_id":"oc_y"}' });

    ok({ code: 0, data: {} });
    await call('lark_edit_message', { message_id: 'om_1', text: 'Fixed' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().data).toEqual({ msg_type: 'text', content: JSON.stringify({ text: 'Fixed' }) });
  });

  it('reads history, the directory and documents on the documented paths', async () => {
    ok({ code: 0, data: { items: [] } });
    await call('lark_list_messages', { container_id: 'oc_1', start_time: '1767225600', page_size: 50 });
    expect(sent().url).toBe('https://open.larksuite.com/open-apis/im/v1/messages');
    expect(sent().params).toEqual({ container_id_type: 'chat', container_id: 'oc_1', start_time: '1767225600', page_size: 50 });

    ok({ code: 0, data: { items: [] } });
    await call('lark_list_department_users', { department_id: '0' });
    expect(sent().url).toBe('https://open.larksuite.com/open-apis/contact/v3/users/find_by_department');
    expect(sent().params).toEqual({ department_id: '0' });

    ok({ code: 0, data: { user_list: [] } });
    await call('lark_lookup_user_ids', { emails: ['jane@example.com'] });
    expect(sent().url).toBe('https://open.larksuite.com/open-apis/contact/v3/users/batch_get_id');
    expect(sent().data).toEqual({ emails: ['jane@example.com'] });

    ok({ code: 0, data: { content: 'text' } });
    await call('lark_get_document_content', { document_id: 'doxbcmEtbFrbbq10nPNu8gO1F3b' });
    expect(sent().url).toBe('https://open.larksuite.com/open-apis/docx/v1/documents/doxbcmEtbFrbbq10nPNu8gO1F3b/raw_content');

    ok({ code: 0, data: { node: {} } });
    await call('lark_get_wiki_node', { token: 'wikcnKQ1k3pcuo5uSK4t8VN6kVf' });
    expect(sent().url).toBe('https://open.larksuite.com/open-apis/wiki/v2/spaces/get_node');
    expect(sent().params).toEqual({ token: 'wikcnKQ1k3pcuo5uSK4t8VN6kVf' });
  });

  it('searches and writes Base records, and creates events and tasks', async () => {
    const filter = { conjunction: 'and', conditions: [{ field_name: 'Status', operator: 'is', value: ['Open'] }] };
    ok({ code: 0, data: { items: [] } });
    await call('lark_search_bitable_records', { app_token: 'bascnAbc', table_id: 'tblXyz', filter, page_size: 100 });
    expect(sent().url).toBe('https://open.larksuite.com/open-apis/bitable/v1/apps/bascnAbc/tables/tblXyz/records/search');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().params).toEqual({ page_size: 100 });
    expect(sent().data).toEqual({ filter });

    ok({ code: 0, data: {} });
    await call('lark_update_bitable_record', { app_token: 'bascnAbc', table_id: 'tblXyz', record_id: 'recPGfZZ13', fields: { Status: 'Done' } });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe('https://open.larksuite.com/open-apis/bitable/v1/apps/bascnAbc/tables/tblXyz/records/recPGfZZ13');
    expect(sent().data).toEqual({ fields: { Status: 'Done' } });

    ok({ code: 0, data: {} });
    await call('lark_create_calendar_event', { calendar_id: 'feishu.cn_abc@group.calendar.feishu.cn', summary: 'Review', start_timestamp: '1767258000', end_timestamp: '1767261600', timezone: 'Europe/Berlin' });
    expect(sent().url).toBe('https://open.larksuite.com/open-apis/calendar/v4/calendars/feishu.cn_abc@group.calendar.feishu.cn/events');
    expect(sent().data).toEqual({
      summary: 'Review',
      start_time: { timestamp: '1767258000', timezone: 'Europe/Berlin' },
      end_time: { timestamp: '1767261600', timezone: 'Europe/Berlin' },
    });

    ok({ code: 0, data: {} });
    await call('lark_create_task', { summary: 'Call supplier', members: [{ id: 'ou_x', type: 'user', role: 'assignee' }] });
    expect(sent().url).toBe('https://open.larksuite.com/open-apis/task/v2/tasks');
    expect(sent().data).toEqual({ summary: 'Call supplier', members: [{ id: 'ou_x', type: 'user', role: 'assignee' }] });
  });

  it('turns a non-zero code into an error of the right kind', async () => {
    expect(bodyErrorStatus({ code: 0, msg: 'success', data: {} })).toBe(200);
    expect(bodyErrorStatus({ code: 99991663, msg: 'Invalid access token for authorization.' })).toBe(401);
    expect(bodyErrorStatus({ code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:chat].' })).toBe(403);
    expect(bodyErrorStatus({ code: 99991400, msg: 'request trigger frequency limit' })).toBe(429);
    expect(bodyErrorStatus({ code: 230002, msg: 'Bot/User can NOT be out of the chat.' })).toBe(400);

    ok({ code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:chat].' });
    await expect(call('lark_list_chats')).rejects.toThrow(/scopes is required/);
  });
});

// Opt-in: RUN_LARK_LIVE=1. Reads only; nothing is sent or changed.
const live = process.env.RUN_LARK_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('lark: live', () => {
  it('refuses wrong credentials and an invalid token on both hosts', async () => {
    for (const base of ['https://open.larksuite.com', 'https://open.feishu.cn']) {
      const login = await liveFetch.post(
        base + '/open-apis/auth/v3/tenant_access_token/internal',
        { app_id: 'cli_0000000000000000', app_secret: 'not-a-secret' },
        { validateStatus: () => true },
      );
      expect(login.data.code).not.toBe(0);
      expect(login.data.tenant_access_token).toBeUndefined();
      const chats = await liveFetch.get(base + '/open-apis/im/v1/chats', { headers: { Authorization: 'Bearer t-invalid' }, validateStatus: () => true });
      expect(bodyErrorStatus(chats.data)).toBe(401);
    }
  });

  it('fetches a token and reads the bot', async () => {
    const id = process.env.LARK_APP_ID;
    const secret = process.env.LARK_APP_SECRET;
    if (!id || !secret) throw new Error('Set LARK_APP_ID and LARK_APP_SECRET for the live check');
    const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com';
    const login = await liveFetch.post(base + '/open-apis/auth/v3/tenant_access_token/internal', { app_id: id, app_secret: secret });
    expect(login.data.code).toBe(0);
    expect(login.data.expire).toBeLessThanOrEqual(7200);
    const bot = await liveFetch.get(base + '/open-apis/bot/v3/info', { headers: { Authorization: 'Bearer ' + login.data.tenant_access_token }, validateStatus: () => true });
    expect(bot.status).toBe(200);
    expect(bot.data.code).toBe(0);
  });
});
