import axios from 'axios';
import * as adapter from './vk-teams.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { assertNoResponseBodyError, ResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * VK Teams Bot API adapter (VK WorkSpace, cloud and on-premise).
 *
 * Static checks always run: the bot token as the "token" query parameter of
 * every call, the Bot API address taken from a variable (cloud default
 * https://myteam.mail.ru/bot/v1), every tool's method and path against the
 * published specification (teams.vk.com/botapi/api.yaml), the write hints on
 * the methods the API exposes as GET, the multipart upload, the mapping of
 * "ok: false" answers to errors, and which tools install switched off.
 * https://teams.vk.com/botapi/
 *
 * Without a token the live check confirms the cloud API refuses an invalid
 * token inside an HTTP 200 answer; with VK_TEAMS_BOT_TOKEN it reads the bot.
 *
 * Live checks run only with RUN_VK_TEAMS_LIVE=1 and never write.
 *
 *   RUN_VK_TEAMS_LIVE=1 [VK_TEAMS_BOT_TOKEN=... VK_TEAMS_API_URL=...] \
 *     npx jest src/adapters/intl/vk-teams.live.spec.ts
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
  VK_TEAMS_API_URL: 'https://myteam.mail.ru/bot/v1',
  VK_TEAMS_BOT_TOKEN: '001.0000000000.0000000000:700000001',
};

// name, method, path, required parameters: as the vendor documents them.
const TOOLS: Array<[string, string, string, string]> = [
  ['vk_teams_get_self', 'GET', '/self/get', ''],
  ['vk_teams_get_events', 'GET', '/events/get', ''],
  ['vk_teams_send_text', 'GET', '/messages/sendText', 'chat_id,text'],
  ['vk_teams_send_file', 'GET', '/messages/sendFile', 'chat_id,file_id'],
  ['vk_teams_upload_file', 'POST', '/messages/sendFile', 'chat_id,file_url'],
  ['vk_teams_edit_text', 'GET', '/messages/editText', 'chat_id,msg_id,text'],
  ['vk_teams_delete_messages', 'GET', '/messages/deleteMessages', 'chat_id,msg_ids'],
  ['vk_teams_answer_callback_query', 'GET', '/messages/answerCallbackQuery', 'query_id'],
  ['vk_teams_send_chat_actions', 'GET', '/chats/sendActions', 'chat_id,actions'],
  ['vk_teams_get_chat_info', 'GET', '/chats/getInfo', 'chat_id'],
  ['vk_teams_list_chat_admins', 'GET', '/chats/getAdmins', 'chat_id'],
  ['vk_teams_list_chat_members', 'GET', '/chats/getMembers', 'chat_id'],
  ['vk_teams_list_blocked_users', 'GET', '/chats/getBlockedUsers', 'chat_id'],
  ['vk_teams_list_pending_users', 'GET', '/chats/getPendingUsers', 'chat_id'],
  ['vk_teams_pin_message', 'GET', '/chats/pinMessage', 'chat_id,msg_id'],
  ['vk_teams_unpin_message', 'GET', '/chats/unpinMessage', 'chat_id,msg_id'],
  ['vk_teams_set_chat_title', 'GET', '/chats/setTitle', 'chat_id,title'],
  ['vk_teams_set_chat_about', 'GET', '/chats/setAbout', 'chat_id,about'],
  ['vk_teams_get_file_info', 'GET', '/files/getInfo', 'file_id'],
];
const SWITCHED_OFF = ['vk_teams_delete_messages'];
const READ_ONLY = new Set(['vk_teams_get_self','vk_teams_get_events','vk_teams_get_chat_info','vk_teams_list_chat_admins','vk_teams_list_chat_members','vk_teams_list_blocked_users','vk_teams_list_pending_users','vk_teams_get_file_info']);

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
const bodyErrorStatus = (body: unknown) => {
  try {
    assertNoResponseBodyError(body, a.connector.config?.errorWhen);
  } catch (e) {
    return (e as ResponseBodyError).status;
  }
  return 200;
};

describe('vk-teams adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the expected envelope, variables, probe and hints', () => {
    expect(a.slug).toBe('vk-teams');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('vk-teams');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{VK_TEAMS_API_URL}}');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.requiredEnvVars).toEqual(['VK_TEAMS_API_URL','VK_TEAMS_BOT_TOKEN']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.probe.tool).toBe('vk_teams_get_self');
    for (const key of ['401','403','404','unreachable']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) expect(a.envVarMeta[name]).toBeTruthy();
    expect(a.prerequisites.length).toBeGreaterThan(40);
  });

  it('sends the bot token as the token query parameter to the configured address', async () => {
    expect(a.connector.authConfig).toEqual({ token: '{{VK_TEAMS_BOT_TOKEN}}' });
    expect(a.envVarMeta.VK_TEAMS_BOT_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    const url = new RegExp(a.envVarMeta.VK_TEAMS_API_URL.pattern!);
    for (const good of ['https://myteam.mail.ru/bot/v1', 'https://api.teams.example.com/bot/v1']) expect(url.test(good)).toBe(true);
    for (const bad of ['myteam.mail.ru/bot/v1', 'http://myteam.mail.ru/bot/v1', 'https://myteam.mail.ru/bot/v1/']) expect(url.test(bad)).toBe(false);
    expect(a.connector.config?.largeIntegers).toBe('string');

    ok({ ok: true, userId: '700000001', nick: 'test_bot' });
    await call('vk_teams_get_self');
    const req = sent();
    expect(req.url).toBe('https://myteam.mail.ru/bot/v1/self/get');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.params).toEqual({ token: ENV.VK_TEAMS_BOT_TOKEN });
  });

  it('keeps every tool on its documented method and path', () => {
    expect(a.tools.map((t) => [t.name, t.endpointMapping.method, t.endpointMapping.path, (t.parameters.required ?? []).join(',')])).toEqual(TOOLS);
    expect(a.tools).toHaveLength(19);
  });

  it('prefixes every tool and declares every argument it reads', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    expect(names.size).toBe(a.tools.length);
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      expect(entry.name).toMatch(/^vk_teams_[a-z0-9_]+$/);
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
    // The API exposes its writes as GET requests: the hints must say so.
    for (const name of ['vk_teams_send_text', 'vk_teams_send_file', 'vk_teams_edit_text', 'vk_teams_delete_messages', 'vk_teams_pin_message', 'vk_teams_set_chat_title']) {
      expect(tool(name).endpointMapping.method).toBe('GET');
      expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
    }
    expect(annotationsOf(tool('vk_teams_delete_messages')).destructiveHint).toBe(true);
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

  it('sends and edits text with the documented query names', async () => {
    ok({ ok: true, msgId: '7052918839419764865' });
    await call('vk_teams_send_text', { chat_id: '681869378@chat.agent', text: 'Hello', parse_mode: 'HTML', reply_msg_id: '7052918839419764865' });
    expect(sent().url).toBe('https://myteam.mail.ru/bot/v1/messages/sendText');
    expect(sent().params).toEqual({ token: ENV.VK_TEAMS_BOT_TOKEN, chatId: '681869378@chat.agent', text: 'Hello', parseMode: 'HTML', replyMsgId: '7052918839419764865' });

    ok({ ok: true });
    await call('vk_teams_edit_text', { chat_id: '681869378@chat.agent', msg_id: '7052918839419764865', text: 'Fixed' });
    expect(sent().url).toBe('https://myteam.mail.ru/bot/v1/messages/editText');
    expect(sent().params).toEqual({ token: ENV.VK_TEAMS_BOT_TOKEN, chatId: '681869378@chat.agent', msgId: '7052918839419764865', text: 'Fixed' });
  });

  it('deletes several messages with a repeated msgId and reads events from id 0', async () => {
    ok({ ok: true });
    await call('vk_teams_delete_messages', { chat_id: '681869378@chat.agent', msg_ids: ['7052918839419764865', '7052918839419764866'] });
    expect(sent().url).toBe('https://myteam.mail.ru/bot/v1/messages/deleteMessages');
    expect(sent().params).toEqual({ token: ENV.VK_TEAMS_BOT_TOKEN, chatId: '681869378@chat.agent', msgId: ['7052918839419764865', '7052918839419764866'] });

    ok({ ok: true, events: [] });
    await call('vk_teams_get_events');
    expect(sent().url).toBe('https://myteam.mail.ru/bot/v1/events/get');
    expect(sent().params).toEqual({ token: ENV.VK_TEAMS_BOT_TOKEN, lastEventId: 0, pollTime: 0 });
    expect(tool('vk_teams_get_events').parameters.properties!.poll_time).toMatchObject({ maximum: 25 });
  });

  it('uploads a file as multipart and reads chats on the documented paths', async () => {
    const upload = tool('vk_teams_upload_file').endpointMapping;
    expect(upload.method).toBe('POST');
    expect(upload.bodyEncoding).toBe('form-data');
    expect(upload.bodyMapping).toEqual({ file: { __file: '$file_url' } });
    expect(upload.queryParams).toMatchObject({ chatId: '$chat_id', caption: '$caption' });

    ok({ ok: true, type: 'group', title: 'Team' });
    await call('vk_teams_get_chat_info', { chat_id: '681869378@chat.agent' });
    expect(sent().url).toBe('https://myteam.mail.ru/bot/v1/chats/getInfo');
    expect(sent().params).toEqual({ token: ENV.VK_TEAMS_BOT_TOKEN, chatId: '681869378@chat.agent' });

    ok({ ok: true, members: [] });
    await call('vk_teams_list_chat_members', { chat_id: '681869378@chat.agent', cursor: 'abc' });
    expect(sent().url).toBe('https://myteam.mail.ru/bot/v1/chats/getMembers');
    expect(sent().params).toEqual({ token: ENV.VK_TEAMS_BOT_TOKEN, chatId: '681869378@chat.agent', cursor: 'abc' });
  });

  it('turns an "ok: false" answer into an error', async () => {
    expect(bodyErrorStatus({ ok: false, description: 'Invalid token' })).toBe(401);
    expect(bodyErrorStatus({ ok: false, description: 'Permission denied' })).toBe(403);
    expect(bodyErrorStatus({ ok: false, description: 'Required parameter not found' })).toBe(400);
    expect(bodyErrorStatus({ ok: true, msgId: '1' })).toBe(200);

    ok({ ok: false, description: 'Invalid token' });
    await expect(call('vk_teams_get_self')).rejects.toThrow(/Invalid token/);
  });
});

// Opt-in: RUN_VK_TEAMS_LIVE=1. Reads only; nothing is sent or changed.
const live = process.env.RUN_VK_TEAMS_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('vk-teams: live', () => {
  it('refuses an invalid token inside an HTTP 200 answer', async () => {
    const response = await liveFetch.get('https://myteam.mail.ru/bot/v1/self/get', { params: { token: 'invalid' }, validateStatus: () => true });
    expect(response.status).toBe(200);
    expect(response.data.ok).toBe(false);
    expect(bodyErrorStatus(response.data)).toBe(401);
  });

  it('reads the bot', async () => {
    const token = process.env.VK_TEAMS_BOT_TOKEN;
    if (!token) throw new Error('Set VK_TEAMS_BOT_TOKEN for the live check');
    const base = process.env.VK_TEAMS_API_URL ?? 'https://myteam.mail.ru/bot/v1';
    const self = await liveFetch.get(base + '/self/get', { params: { token }, validateStatus: () => true });
    expect(self.status).toBe(200);
    expect(self.data.ok).toBe(true);
    expect(typeof self.data.userId).toBe('string');
  });
});
