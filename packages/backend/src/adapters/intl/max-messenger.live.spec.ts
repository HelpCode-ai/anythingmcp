import axios from 'axios';
import * as adapter from './max-messenger.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { assertNoResponseBodyError, ResponseBodyError } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * MAX Bot API adapter (MAX messenger, platform-api.max.ru).
 *
 * Static checks always run: the bot token sent raw in the Authorization header
 * (MAX no longer takes it as a query parameter), the two API hosts offered as a
 * fixed choice, every tool's method and path against the published OpenAPI
 * schema (github.com/max-messenger/api-schema) and dev.max.ru/docs-api, the
 * send, edit, pin and callback bodies, the mapping of "success: false" answers
 * to errors, and which tools install switched off.
 * https://dev.max.ru/docs-api
 *
 * Without a token the live check confirms the API refuses the call with 401;
 * with MAX_BOT_TOKEN it reads the bot and its webhook subscriptions.
 *
 * Live checks run only with RUN_MAX_MESSENGER_LIVE=1 and never write.
 *
 *   RUN_MAX_MESSENGER_LIVE=1 [MAX_BOT_TOKEN=...] \
 *     npx jest src/adapters/intl/max-messenger.live.spec.ts
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
  MAX_API_URL: 'https://platform-api.max.ru',
  MAX_BOT_TOKEN: 'test-max-bot-token-0123456789abcdef',
};

// name, method, path, required parameters: as the vendor documents them.
const TOOLS: Array<[string, string, string, string]> = [
  ['max_messenger_get_me', 'GET', '/me', ''],
  ['max_messenger_get_chat', 'GET', '/chats/{chat_id}', 'chat_id'],
  ['max_messenger_get_bot_membership', 'GET', '/chats/{chat_id}/members/me', 'chat_id'],
  ['max_messenger_list_chat_members', 'GET', '/chats/{chat_id}/members', 'chat_id'],
  ['max_messenger_list_chat_admins', 'GET', '/chats/{chat_id}/members/admins', 'chat_id'],
  ['max_messenger_get_pinned_message', 'GET', '/chats/{chat_id}/pin', 'chat_id'],
  ['max_messenger_pin_message', 'PUT', '/chats/{chat_id}/pin', 'chat_id,message_id'],
  ['max_messenger_unpin_message', 'DELETE', '/chats/{chat_id}/pin', 'chat_id'],
  ['max_messenger_send_chat_action', 'POST', '/chats/{chat_id}/actions', 'chat_id,action'],
  ['max_messenger_list_messages', 'GET', '/messages', ''],
  ['max_messenger_get_message', 'GET', '/messages/{message_id}', 'message_id'],
  ['max_messenger_send_message', 'POST', '/messages', ''],
  ['max_messenger_send_image', 'POST', '/messages', 'image_url'],
  ['max_messenger_edit_message', 'PUT', '/messages', 'message_id'],
  ['max_messenger_delete_message', 'DELETE', '/messages', 'message_id'],
  ['max_messenger_answer_callback', 'POST', '/answers', 'callback_id'],
  ['max_messenger_get_updates', 'GET', '/updates', ''],
  ['max_messenger_list_subscriptions', 'GET', '/subscriptions', ''],
  ['max_messenger_get_video_details', 'GET', '/videos/{video_token}', 'video_token'],
  ['max_messenger_list_comments', 'GET', '/messages/{message_id}/comments', 'message_id'],
  ['max_messenger_post_comment', 'POST', '/messages/{message_id}/comments', 'message_id,text'],
  ['max_messenger_leave_chat', 'DELETE', '/chats/{chat_id}/members/me', 'chat_id'],
];
const SWITCHED_OFF = ['max_messenger_delete_message','max_messenger_leave_chat'];
const READ_ONLY = new Set(['max_messenger_get_me','max_messenger_get_chat','max_messenger_get_bot_membership','max_messenger_list_chat_members','max_messenger_list_chat_admins','max_messenger_get_pinned_message','max_messenger_list_messages','max_messenger_get_message','max_messenger_get_updates','max_messenger_list_subscriptions','max_messenger_get_video_details','max_messenger_list_comments']);

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

describe('max-messenger adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the expected envelope, variables, probe and hints', () => {
    expect(a.slug).toBe('max-messenger');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('max-messenger');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{MAX_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.requiredEnvVars).toEqual(['MAX_API_URL','MAX_BOT_TOKEN']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.probe.tool).toBe('max_messenger_get_me');
    for (const key of ['401','403','404','rate_limited','unreachable']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) expect(a.envVarMeta[name]).toBeTruthy();
    expect(a.prerequisites.length).toBeGreaterThan(40);
  });

  it('sends the bot token raw in the Authorization header and offers both API hosts', async () => {
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{MAX_BOT_TOKEN}}' });
    expect(a.envVarMeta.MAX_BOT_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(new RegExp(a.envVarMeta.MAX_BOT_TOKEN.pattern!).test(ENV.MAX_BOT_TOKEN)).toBe(true);
    expect(new RegExp(a.envVarMeta.MAX_BOT_TOKEN.pattern!).test('Bearer ' + ENV.MAX_BOT_TOKEN)).toBe(false);
    expect(a.envVarMeta.MAX_API_URL.options!.map((o) => o.value)).toEqual(['https://platform-api.max.ru', 'https://platform-api2.max.ru']);
    expect(a.envVarMeta.MAX_API_URL.secret).toBeUndefined();
    expect(a.connector.config?.largeIntegers).toBe('string');

    ok();
    await call('max_messenger_get_me');
    const req = sent();
    expect(req.url).toBe('https://platform-api.max.ru/me');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe(ENV.MAX_BOT_TOKEN);
  });

  it('keeps every tool on its documented method and path', () => {
    expect(a.tools.map((t) => [t.name, t.endpointMapping.method, t.endpointMapping.path, (t.parameters.required ?? []).join(',')])).toEqual(TOOLS);
    expect(a.tools).toHaveLength(22);
  });

  it('prefixes every tool and declares every argument it reads', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    expect(names.size).toBe(a.tools.length);
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      expect(entry.name).toMatch(/^max_messenger_[a-z0-9_]+$/);
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
    expect(tool('max_messenger_delete_message').endpointMapping.method).toBe('DELETE');
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).not.toContain('/subscriptions/');
      if (entry.endpointMapping.path === '/subscriptions') expect(entry.endpointMapping.method).toBe('GET');
      expect(entry.endpointMapping.path).not.toContain('/uploads');
    }
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

  it('sends a message with the recipient in the query and the text in the body', async () => {
    ok();
    await call('max_messenger_send_message', { chat_id: '-70977112345678', text: 'Hello', format: 'markdown', notify: false });
    expect(sent().url).toBe('https://platform-api.max.ru/messages');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().params).toEqual({ chat_id: '-70977112345678' });
    expect(sent().data).toEqual({ text: 'Hello', format: 'markdown', notify: false });

    ok();
    await call('max_messenger_send_image', { user_id: '12345678', image_url: 'https://example.com/a.png', text: 'Look' });
    expect(sent().params).toEqual({ user_id: '12345678' });
    expect(sent().data).toEqual({ text: 'Look', attachments: [{ type: 'image', payload: { url: 'https://example.com/a.png' } }] });
  });

  it('edits, deletes, pins and answers on the documented parameters', async () => {
    ok();
    await call('max_messenger_edit_message', { message_id: 'mid.0001', text: 'Fixed' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe('https://platform-api.max.ru/messages');
    expect(sent().params).toEqual({ message_id: 'mid.0001' });
    expect(sent().data).toEqual({ text: 'Fixed' });

    ok();
    await call('max_messenger_delete_message', { message_id: 'mid.0001' });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().params).toEqual({ message_id: 'mid.0001' });

    ok();
    await call('max_messenger_pin_message', { chat_id: '-70977112345678', message_id: 'mid.0001' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe('https://platform-api.max.ru/chats/-70977112345678/pin');
    expect(sent().data).toEqual({ message_id: 'mid.0001' });

    ok();
    await call('max_messenger_answer_callback', { callback_id: 'cb-1', notification: 'Saved' });
    expect(sent().url).toBe('https://platform-api.max.ru/answers');
    expect(sent().params).toEqual({ callback_id: 'cb-1' });
    expect(sent().data).toEqual({ notification: 'Saved' });
  });

  it('reads messages, members and updates with the documented query names', async () => {
    ok();
    await call('max_messenger_list_messages', { chat_id: '-70977112345678', count: 20 });
    expect(sent().url).toBe('https://platform-api.max.ru/messages');
    expect(sent().params).toEqual({ chat_id: '-70977112345678', count: 20 });

    ok();
    await call('max_messenger_list_chat_members', { chat_id: '-70977112345678', user_ids: '1,2' });
    expect(sent().url).toBe('https://platform-api.max.ru/chats/-70977112345678/members');
    expect(sent().params).toEqual({ user_ids: '1,2' });

    ok();
    await call('max_messenger_get_updates', { types: 'message_created,bot_added' });
    expect(sent().url).toBe('https://platform-api.max.ru/updates');
    expect(sent().params).toEqual({ timeout: 0, types: 'message_created,bot_added' });
    expect(tool('max_messenger_get_updates').parameters.properties!.timeout).toMatchObject({ maximum: 25 });
  });

  it('turns a "success: false" answer into an error and leaves normal answers alone', () => {
    expect(bodyErrorStatus({ success: false, code: 'chat.denied', message: 'Access denied' })).toBe(403);
    expect(bodyErrorStatus({ success: false, code: 'not.found', message: 'Resource not found' })).toBe(404);
    expect(bodyErrorStatus({ success: false, code: 'proto.payload', message: 'Bad payload' })).toBe(400);
    expect(bodyErrorStatus({ success: true })).toBe(200);
    expect(bodyErrorStatus({ user_id: 1, name: 'My Bot', is_bot: true })).toBe(200);
  });
});

// Opt-in: RUN_MAX_MESSENGER_LIVE=1. Reads only; nothing is sent or changed.
const live = process.env.RUN_MAX_MESSENGER_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('max-messenger: live', () => {
  it('refuses a call without a token', async () => {
    const response = await liveFetch.get('https://platform-api.max.ru/me', { validateStatus: () => true });
    expect(response.status).toBe(401);
  });

  it('reads the bot and its subscriptions', async () => {
    const token = process.env.MAX_BOT_TOKEN;
    if (!token) throw new Error('Set MAX_BOT_TOKEN for the live check');
    const base = process.env.MAX_API_URL ?? 'https://platform-api.max.ru';
    const me = await liveFetch.get(base + '/me', { headers: { Authorization: token }, validateStatus: () => true });
    expect(me.status).toBe(200);
    expect(me.data.is_bot).toBe(true);
    const subs = await liveFetch.get(base + '/subscriptions', { headers: { Authorization: token }, validateStatus: () => true });
    expect(subs.status).toBe(200);
  });
});
