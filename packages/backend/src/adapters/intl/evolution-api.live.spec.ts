import axios from 'axios';
import * as adapter from './evolution-api.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Evolution API v2 (self-hosted WhatsApp gateway) adapter.
 *
 * Static checks always run: the key in the "apikey" header, the server address
 * and the instance name from variables (the instance is the last path segment
 * of every instance call), every tool's method and path against the v2 OpenAPI
 * document (github.com/EvolutionAPI/docs-evolution) and the v2 request schemas
 * of the server (src/validate), the send and find bodies, the read-only hints
 * on the POST searches, and which tools install switched off. The instructions
 * must say that it is an unofficial gateway and name the official WhatsApp
 * Business Cloud API connector.
 * https://doc.evolution-api.com/v2
 *
 * The live check needs your own server (EVOLUTION_API_URL, EVOLUTION_API_KEY,
 * EVOLUTION_INSTANCE) and reads the connection state.
 *
 * Live checks run only with RUN_EVOLUTION_API_LIVE=1 and never write.
 *
 *   RUN_EVOLUTION_API_LIVE=1 EVOLUTION_API_URL=... EVOLUTION_API_KEY=... EVOLUTION_INSTANCE=... \
 *     npx jest src/adapters/intl/evolution-api.live.spec.ts
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
  EVOLUTION_API_URL: 'https://evolution.example.com',
  EVOLUTION_API_KEY: 'test-evolution-key-0123456789',
  EVOLUTION_INSTANCE: 'my-whatsapp',
};

// name, method, path, required parameters: as the vendor documents them.
const TOOLS: Array<[string, string, string, string]> = [
  ['evolution_api_get_server_info', 'GET', '/', ''],
  ['evolution_api_list_instances', 'GET', '/instance/fetchInstances', ''],
  ['evolution_api_get_connection_state', 'GET', '/instance/connectionState/{{EVOLUTION_INSTANCE}}', ''],
  ['evolution_api_get_settings', 'GET', '/settings/find/{{EVOLUTION_INSTANCE}}', ''],
  ['evolution_api_get_webhook', 'GET', '/webhook/find/{{EVOLUTION_INSTANCE}}', ''],
  ['evolution_api_send_text', 'POST', '/message/sendText/{{EVOLUTION_INSTANCE}}', 'number,text'],
  ['evolution_api_send_media', 'POST', '/message/sendMedia/{{EVOLUTION_INSTANCE}}', 'number,mediatype,media_url'],
  ['evolution_api_send_audio', 'POST', '/message/sendWhatsAppAudio/{{EVOLUTION_INSTANCE}}', 'number,audio_url'],
  ['evolution_api_send_location', 'POST', '/message/sendLocation/{{EVOLUTION_INSTANCE}}', 'number,latitude,longitude,name,address'],
  ['evolution_api_send_reaction', 'POST', '/message/sendReaction/{{EVOLUTION_INSTANCE}}', 'remote_jid,message_id,from_me,reaction'],
  ['evolution_api_send_presence', 'POST', '/chat/sendPresence/{{EVOLUTION_INSTANCE}}', 'number,presence'],
  ['evolution_api_mark_messages_read', 'POST', '/chat/markMessageAsRead/{{EVOLUTION_INSTANCE}}', 'read_messages'],
  ['evolution_api_update_message', 'POST', '/chat/updateMessage/{{EVOLUTION_INSTANCE}}', 'number,remote_jid,message_id,text'],
  ['evolution_api_delete_message', 'DELETE', '/chat/deleteMessageForEveryone/{{EVOLUTION_INSTANCE}}', 'remote_jid,message_id,from_me'],
  ['evolution_api_check_whatsapp_numbers', 'POST', '/chat/whatsappNumbers/{{EVOLUTION_INSTANCE}}', 'numbers'],
  ['evolution_api_find_chats', 'POST', '/chat/findChats/{{EVOLUTION_INSTANCE}}', ''],
  ['evolution_api_find_messages', 'POST', '/chat/findMessages/{{EVOLUTION_INSTANCE}}', ''],
  ['evolution_api_find_contacts', 'POST', '/chat/findContacts/{{EVOLUTION_INSTANCE}}', ''],
  ['evolution_api_fetch_profile', 'POST', '/chat/fetchProfile/{{EVOLUTION_INSTANCE}}', 'number'],
  ['evolution_api_list_groups', 'GET', '/group/fetchAllGroups/{{EVOLUTION_INSTANCE}}', ''],
  ['evolution_api_get_group', 'GET', '/group/findGroupInfos/{{EVOLUTION_INSTANCE}}', 'group_jid'],
  ['evolution_api_list_group_participants', 'GET', '/group/participants/{{EVOLUTION_INSTANCE}}', 'group_jid'],
];
const SWITCHED_OFF = ['evolution_api_delete_message'];
const READ_ONLY = new Set(['evolution_api_get_server_info','evolution_api_list_instances','evolution_api_get_connection_state','evolution_api_get_settings','evolution_api_get_webhook','evolution_api_check_whatsapp_numbers','evolution_api_find_chats','evolution_api_find_messages','evolution_api_find_contacts','evolution_api_fetch_profile','evolution_api_list_groups','evolution_api_get_group','evolution_api_list_group_participants']);

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

describe('evolution-api adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the expected envelope, variables, probe and hints', () => {
    expect(a.slug).toBe('evolution-api');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('evolution-api');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{EVOLUTION_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.requiredEnvVars).toEqual(['EVOLUTION_API_URL','EVOLUTION_API_KEY','EVOLUTION_INSTANCE']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.probe.tool).toBe('evolution_api_get_connection_state');
    for (const key of ['400','401','403','404','unreachable']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) expect(a.envVarMeta[name]).toBeTruthy();
    expect(a.prerequisites.length).toBeGreaterThan(40);
  });

  it('sends the key in the apikey header and puts the instance in the path', async () => {
    expect(a.connector.authConfig).toEqual({ headerName: 'apikey', apiKey: '{{EVOLUTION_API_KEY}}' });
    expect(a.envVarMeta.EVOLUTION_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.EVOLUTION_INSTANCE).toMatchObject({ kind: 'setting' });
    const url = new RegExp(a.envVarMeta.EVOLUTION_API_URL.pattern!);
    for (const good of ['https://evolution.example.com', 'http://10.0.0.5:8080']) expect(url.test(good)).toBe(true);
    for (const bad of ['evolution.example.com', 'https://evolution.example.com/', 'https://evolution.example.com/manager']) expect(url.test(bad)).toBe(false);
    expect(new RegExp(a.envVarMeta.EVOLUTION_INSTANCE.pattern!).test('my whatsapp')).toBe(false);

    ok({ instance: { instanceName: 'my-whatsapp', state: 'open' } });
    await call('evolution_api_get_connection_state');
    const req = sent();
    expect(req.url).toBe('https://evolution.example.com/instance/connectionState/my-whatsapp');
    expect(header(req, 'apikey')).toBe(ENV.EVOLUTION_API_KEY);

    const perInstance = a.tools.filter((entry) => !['evolution_api_get_server_info', 'evolution_api_list_instances'].includes(entry.name));
    for (const entry of perInstance) expect(entry.endpointMapping.path.endsWith('/{{EVOLUTION_INSTANCE}}')).toBe(true);
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
      expect(entry.name).toMatch(/^evolution_api_[a-z0-9_]+$/);
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
    expect(tool('evolution_api_delete_message').endpointMapping.method).toBe('DELETE');
    // No instance management (create, restart, logout, delete) and no group changes.
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).not.toMatch(/\/instance\/(create|restart|logout|delete|connect\/)/);
      if (entry.endpointMapping.path.startsWith('/group/')) expect(entry.endpointMapping.method).toBe('GET');
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

  it('sends text and media with the v2 body fields', async () => {
    ok();
    await call('evolution_api_send_text', { number: '5511999998888', text: 'Hello', delay: 1200 });
    expect(sent().url).toBe('https://evolution.example.com/message/sendText/my-whatsapp');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ number: '5511999998888', text: 'Hello', delay: 1200 });

    ok();
    await call('evolution_api_send_media', { number: '5511999998888', mediatype: 'document', media_url: 'https://example.com/offer.pdf', mimetype: 'application/pdf', file_name: 'offer.pdf', caption: 'Offer' });
    expect(sent().url).toBe('https://evolution.example.com/message/sendMedia/my-whatsapp');
    expect(sent().data).toEqual({ number: '5511999998888', mediatype: 'document', media: 'https://example.com/offer.pdf', mimetype: 'application/pdf', fileName: 'offer.pdf', caption: 'Offer' });

    ok();
    await call('evolution_api_send_presence', { number: '5511999998888', presence: 'composing' });
    expect(sent().url).toBe('https://evolution.example.com/chat/sendPresence/my-whatsapp');
    expect(sent().data).toEqual({ number: '5511999998888', presence: 'composing', delay: 3000 });
  });

  it('searches messages, chats and contacts with where, page and offset', async () => {
    ok();
    await call('evolution_api_find_messages', { remote_jid: '5511999998888@s.whatsapp.net', page_size: 20 });
    expect(sent().url).toBe('https://evolution.example.com/chat/findMessages/my-whatsapp');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ where: { key: { remoteJid: '5511999998888@s.whatsapp.net' }, messageTimestamp: {} }, page: 1, offset: 20 });

    ok();
    await call('evolution_api_find_chats');
    expect(sent().url).toBe('https://evolution.example.com/chat/findChats/my-whatsapp');
    expect(sent().data).toEqual({ where: {}, take: 50 });

    ok();
    await call('evolution_api_find_contacts', { remote_jid: '5511999998888@s.whatsapp.net' });
    expect(sent().data).toEqual({ where: { remoteJid: '5511999998888@s.whatsapp.net' } });

    ok();
    await call('evolution_api_check_whatsapp_numbers', { numbers: ['5511999998888'] });
    expect(sent().url).toBe('https://evolution.example.com/chat/whatsappNumbers/my-whatsapp');
    expect(sent().data).toEqual({ numbers: ['5511999998888'] });
  });

  it('addresses a message by its key and reads groups by groupJid', async () => {
    ok();
    await call('evolution_api_send_reaction', { remote_jid: '5511999998888@s.whatsapp.net', message_id: '3EB0A1B2', from_me: false, reaction: '👍' });
    expect(sent().data).toEqual({ key: { remoteJid: '5511999998888@s.whatsapp.net', fromMe: false, id: '3EB0A1B2' }, reaction: '👍' });

    ok();
    await call('evolution_api_delete_message', { remote_jid: '5511999998888@s.whatsapp.net', message_id: '3EB0A1B2', from_me: true });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe('https://evolution.example.com/chat/deleteMessageForEveryone/my-whatsapp');
    expect(sent().data).toEqual({ id: '3EB0A1B2', remoteJid: '5511999998888@s.whatsapp.net', fromMe: true });

    ok();
    await call('evolution_api_list_groups');
    expect(sent().url).toBe('https://evolution.example.com/group/fetchAllGroups/my-whatsapp');
    expect(sent().params).toEqual({ getParticipants: false });

    ok();
    await call('evolution_api_list_group_participants', { group_jid: '120363001234567890@g.us' });
    expect(sent().url).toBe('https://evolution.example.com/group/participants/my-whatsapp');
    expect(sent().params).toEqual({ groupJid: '120363001234567890@g.us' });
  });
});

// Opt-in: RUN_EVOLUTION_API_LIVE=1. Reads only; nothing is sent or changed.
const live = process.env.RUN_EVOLUTION_API_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('evolution-api: live', () => {
  it('reads the connection state of your instance', async () => {
    const base = process.env.EVOLUTION_API_URL;
    const key = process.env.EVOLUTION_API_KEY;
    const instance = process.env.EVOLUTION_INSTANCE;
    if (!base || !key || !instance) throw new Error('Set EVOLUTION_API_URL, EVOLUTION_API_KEY and EVOLUTION_INSTANCE for the live check');
    const refused = await liveFetch.get(base + '/instance/connectionState/' + instance, { headers: { apikey: 'wrong-key' }, validateStatus: () => true });
    expect([401, 403]).toContain(refused.status);
    const state = await liveFetch.get(base + '/instance/connectionState/' + instance, { headers: { apikey: key }, validateStatus: () => true });
    expect(state.status).toBe(200);
    expect(['open', 'connecting', 'close']).toContain(state.data.instance.state);
  });
});
