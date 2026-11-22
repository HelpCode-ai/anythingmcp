import axios from 'axios';
import * as adapter from './waha.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * WAHA (WhatsApp HTTP API, self-hosted) adapter.
 *
 * Static checks always run: the API key in the X-Api-Key header, the server
 * address from a variable, the optional session variable that fills the
 * "session" argument (default "default"), every tool's method and path against
 * WAHA's OpenAPI document (waha.devlike.pro/swagger/openapi.json), the send
 * bodies, percent-encoded chat and message ids in paths, and which tools
 * install switched off. The instructions must say that WAHA is an unofficial
 * gateway and name the official WhatsApp Business Cloud API connector.
 * https://waha.devlike.pro/docs/overview/introduction/
 *
 * The live check needs your own WAHA server (WAHA_URL and WAHA_API_KEY) and
 * reads the sessions.
 *
 * Live checks run only with RUN_WAHA_LIVE=1 and never write.
 *
 *   RUN_WAHA_LIVE=1 WAHA_URL=... WAHA_API_KEY=... \
 *     npx jest src/adapters/intl/waha.live.spec.ts
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
  WAHA_URL: 'https://waha.example.com',
  WAHA_API_KEY: 'test-waha-api-key-0123456789',
};

// name, method, path, required parameters: as the vendor documents them.
const TOOLS: Array<[string, string, string, string]> = [
  ['waha_list_sessions', 'GET', '/api/sessions', ''],
  ['waha_get_session', 'GET', '/api/sessions/{session}', ''],
  ['waha_get_account', 'GET', '/api/sessions/{session}/me', ''],
  ['waha_list_chats', 'GET', '/api/{session}/chats', ''],
  ['waha_get_chats_overview', 'GET', '/api/{session}/chats/overview', ''],
  ['waha_list_chat_messages', 'GET', '/api/{session}/chats/{chat_id}/messages', 'chat_id'],
  ['waha_get_message', 'GET', '/api/{session}/chats/{chat_id}/messages/{message_id}', 'chat_id,message_id'],
  ['waha_send_text', 'POST', '/api/sendText', 'chat_id,text'],
  ['waha_send_image', 'POST', '/api/sendImage', 'chat_id,file_url'],
  ['waha_send_file', 'POST', '/api/sendFile', 'chat_id,file_url,mimetype'],
  ['waha_send_seen', 'POST', '/api/sendSeen', 'chat_id'],
  ['waha_start_typing', 'POST', '/api/startTyping', 'chat_id'],
  ['waha_stop_typing', 'POST', '/api/stopTyping', 'chat_id'],
  ['waha_react_to_message', 'PUT', '/api/reaction', 'message_id,reaction'],
  ['waha_edit_message', 'PUT', '/api/{session}/chats/{chat_id}/messages/{message_id}', 'chat_id,message_id,text'],
  ['waha_delete_message', 'DELETE', '/api/{session}/chats/{chat_id}/messages/{message_id}', 'chat_id,message_id'],
  ['waha_list_contacts', 'GET', '/api/contacts/all', ''],
  ['waha_get_contact', 'GET', '/api/contacts', 'contact_id'],
  ['waha_check_number_exists', 'GET', '/api/contacts/check-exists', 'phone'],
  ['waha_list_groups', 'GET', '/api/{session}/groups', ''],
  ['waha_get_group', 'GET', '/api/{session}/groups/{group_id}', 'group_id'],
  ['waha_list_group_participants', 'GET', '/api/{session}/groups/{group_id}/participants', 'group_id'],
];
const SWITCHED_OFF = ['waha_delete_message'];
const READ_ONLY = new Set(['waha_list_sessions','waha_get_session','waha_get_account','waha_list_chats','waha_get_chats_overview','waha_list_chat_messages','waha_get_message','waha_list_contacts','waha_get_contact','waha_check_number_exists','waha_list_groups','waha_get_group','waha_list_group_participants']);

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

describe('waha adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the expected envelope, variables, probe and hints', () => {
    expect(a.slug).toBe('waha');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('waha');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{WAHA_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.requiredEnvVars).toEqual(['WAHA_URL','WAHA_API_KEY']);
    expect(a.optionalEnvVars ?? []).toEqual(['WAHA_SESSION']);
    expect(a.probe.tool).toBe('waha_list_sessions');
    for (const key of ['401','404','422','unreachable']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) expect(a.envVarMeta[name]).toBeTruthy();
    expect(a.prerequisites.length).toBeGreaterThan(40);
  });

  it('sends the API key in X-Api-Key to the configured server and defaults the session', async () => {
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Api-Key', apiKey: '{{WAHA_API_KEY}}' });
    expect(a.envVarMeta.WAHA_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.WAHA_SESSION).toMatchObject({ kind: 'setting' });
    const url = new RegExp(a.envVarMeta.WAHA_URL.pattern!);
    for (const good of ['https://waha.example.com', 'http://192.168.1.10:3000']) expect(url.test(good)).toBe(true);
    for (const bad of ['waha.example.com', 'https://waha.example.com/', 'https://waha.example.com/api']) expect(url.test(bad)).toBe(false);
    // The key is a required variable, so the header is never sent as a literal placeholder.
    expect(a.requiredEnvVars).toContain('WAHA_API_KEY');
    expect(JSON.stringify(a.connector.headers)).not.toContain('{{');

    ok([]);
    await call('waha_list_sessions');
    const req = sent();
    expect(req.url).toBe('https://waha.example.com/api/sessions');
    expect(header(req, 'X-Api-Key')).toBe(ENV.WAHA_API_KEY);

    for (const entry of a.tools) {
      if (!entry.parameters.properties?.session) continue;
      expect(entry.parameters.properties.session.default).toBe('default');
      expect(entry.endpointMapping.envDefaults).toEqual({ session: 'WAHA_SESSION' });
    }
  });

  it('is unlisted and points to the official WhatsApp connector', () => {
    expect((a as { unlisted?: boolean }).unlisted).toBe(true);
    expect(a.instructions).toMatch(/taken out of the store/);
    expect(a.instructions).toMatch(/whatsapp-business/);
  });

  it('says it is an unofficial gateway and names the official connector', () => {
    expect(a.instructions).toMatch(/Unofficial gateway/);
    expect(a.instructions).toContain('WhatsApp Business Cloud API');
    expect(a.description).toContain('WhatsApp Business Cloud API');
    expect(a.prerequisites).toContain('WhatsApp Business Cloud API');
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
      expect(entry.name).toMatch(/^waha_[a-z0-9_]+$/);
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
    expect(tool('waha_delete_message').endpointMapping.method).toBe('DELETE');
    // No session, group or contact management, and no pairing.
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).not.toMatch(/\/(start|stop|logout|restart|auth|keys|block|leave)(\/|$)/);
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

  it('sends text, images and files with the session in the body', async () => {
    ok();
    await call('waha_send_text', { chat_id: '4915112345678@c.us', text: 'Hello' });
    expect(sent().url).toBe('https://waha.example.com/api/sendText');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ session: 'default', chatId: '4915112345678@c.us', text: 'Hello' });

    ok();
    await call('waha_send_image', { chat_id: '4915112345678@c.us', file_url: 'https://example.com/a.jpg', caption: 'Look' });
    expect(sent().url).toBe('https://waha.example.com/api/sendImage');
    expect(sent().data).toEqual({ session: 'default', chatId: '4915112345678@c.us', file: { mimetype: 'image/jpeg', url: 'https://example.com/a.jpg' }, caption: 'Look' });

    ok();
    await call('waha_send_file', { session: 'sales', chat_id: '120363001234567890@g.us', file_url: 'https://example.com/offer.pdf', mimetype: 'application/pdf', filename: 'offer.pdf' });
    expect(sent().url).toBe('https://waha.example.com/api/sendFile');
    expect(sent().data).toEqual({ session: 'sales', chatId: '120363001234567890@g.us', file: { mimetype: 'application/pdf', filename: 'offer.pdf', url: 'https://example.com/offer.pdf' } });
  });

  it('reads chats and messages with percent-encoded ids in the path', async () => {
    ok([]);
    await call('waha_list_chat_messages', { chat_id: '4915112345678@c.us', from_timestamp: 1767225600 });
    expect(sent().url).toBe('https://waha.example.com/api/default/chats/4915112345678%40c.us/messages');
    expect(sent().params).toEqual({ limit: 20, 'filter.timestamp.gte': 1767225600, downloadMedia: false });

    ok([]);
    await call('waha_get_chats_overview', { session: 'sales' });
    expect(sent().url).toBe('https://waha.example.com/api/sales/chats/overview');
    expect(sent().params).toEqual({ limit: 20 });

    ok();
    await call('waha_edit_message', { chat_id: '4915112345678@c.us', message_id: 'true_4915112345678@c.us_3EB0A1B2', text: 'Fixed' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe('https://waha.example.com/api/default/chats/4915112345678%40c.us/messages/true_4915112345678%40c.us_3EB0A1B2');
    expect(sent().data).toEqual({ text: 'Fixed' });
  });

  it('checks numbers and reads contacts and groups on the documented paths', async () => {
    ok({ numberExists: true, chatId: '4915112345678@c.us' });
    await call('waha_check_number_exists', { phone: '4915112345678' });
    expect(sent().url).toBe('https://waha.example.com/api/contacts/check-exists');
    expect(sent().params).toEqual({ session: 'default', phone: '4915112345678' });

    ok([]);
    await call('waha_list_contacts');
    expect(sent().url).toBe('https://waha.example.com/api/contacts/all');
    expect(sent().params).toEqual({ session: 'default', limit: 100 });

    ok([]);
    await call('waha_list_group_participants', { group_id: '120363001234567890@g.us' });
    expect(sent().url).toBe('https://waha.example.com/api/default/groups/120363001234567890%40g.us/participants');

    ok();
    await call('waha_send_seen', { chat_id: '4915112345678@c.us' });
    expect(sent().url).toBe('https://waha.example.com/api/sendSeen');
    expect(sent().data).toEqual({ session: 'default', chatId: '4915112345678@c.us' });
  });
});

// Opt-in: RUN_WAHA_LIVE=1. Reads only; nothing is sent or changed.
const live = process.env.RUN_WAHA_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('waha: live', () => {
  it('reads the sessions of your WAHA server', async () => {
    const base = process.env.WAHA_URL;
    const key = process.env.WAHA_API_KEY;
    if (!base || !key) throw new Error('Set WAHA_URL and WAHA_API_KEY for the live check');
    const refused = await liveFetch.get(base + '/api/sessions', { headers: { 'X-Api-Key': 'wrong-key' }, validateStatus: () => true });
    expect(refused.status).toBe(401);
    const sessions = await liveFetch.get(base + '/api/sessions', { headers: { 'X-Api-Key': key }, params: { all: true }, validateStatus: () => true });
    expect(sessions.status).toBe(200);
    expect(Array.isArray(sessions.data)).toBe(true);
  });
});
