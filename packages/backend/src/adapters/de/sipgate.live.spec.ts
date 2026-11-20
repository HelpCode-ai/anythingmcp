import axios from 'axios';
import * as adapter from './sipgate.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * sipgate REST API v2 adapter (personal access token).
 *
 * Static checks always run: Token ID and token as HTTP Basic credentials, every
 * tool's method and path against sipgate's published specification
 * (api.sipgate.com/v2/swagger.json), the repeated query parameters of the
 * history filter, the contact and history bodies, and which tools install
 * switched off: sending an SMS and starting a call both cost money.
 * https://api.sipgate.com/v2/doc
 *
 * Without a token the live check confirms the API refuses the call with 401;
 * with SIPGATE_TOKEN_ID and SIPGATE_TOKEN it reads the token owner and one page
 * of the history.
 *
 * Live checks run only with RUN_SIPGATE_LIVE=1 and never write.
 *
 *   RUN_SIPGATE_LIVE=1 [SIPGATE_TOKEN_ID=... SIPGATE_TOKEN=...] \
 *     npx jest src/adapters/de/sipgate.live.spec.ts
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
  SIPGATE_TOKEN_ID: 'token-AB12CD',
  SIPGATE_TOKEN: '00000000-0000-4000-8000-000000000000',
};

// name, method, path, required parameters: as the vendor documents them.
const TOOLS: Array<[string, string, string, string]> = [
  ['sipgate_get_user_info', 'GET', '/authorization/userinfo', ''],
  ['sipgate_get_account', 'GET', '/account', ''],
  ['sipgate_get_balance', 'GET', '/balance', ''],
  ['sipgate_list_users', 'GET', '/users', ''],
  ['sipgate_get_user', 'GET', '/users/{user_id}', 'user_id'],
  ['sipgate_list_devices', 'GET', '/{user_id}/devices', 'user_id'],
  ['sipgate_get_device', 'GET', '/devices/{device_id}', 'device_id'],
  ['sipgate_list_numbers', 'GET', '/numbers', ''],
  ['sipgate_list_user_numbers', 'GET', '/{user_id}/numbers', 'user_id'],
  ['sipgate_list_phonelines', 'GET', '/{user_id}/phonelines', 'user_id'],
  ['sipgate_list_forwardings', 'GET', '/{user_id}/phonelines/{phoneline_id}/forwardings', 'user_id,phoneline_id'],
  ['sipgate_list_history', 'GET', '/history', ''],
  ['sipgate_get_history_entry', 'GET', '/history/{entry_id}', 'entry_id'],
  ['sipgate_update_history_entry', 'PUT', '/history/{entry_id}', 'entry_id'],
  ['sipgate_list_contacts', 'GET', '/contacts', ''],
  ['sipgate_get_contact', 'GET', '/contacts/{contact_id}', 'contact_id'],
  ['sipgate_create_contact', 'POST', '/contacts', 'name'],
  ['sipgate_list_voicemails', 'GET', '/voicemails', ''],
  ['sipgate_list_blocklist', 'GET', '/blacklist/incoming', ''],
  ['sipgate_list_groups', 'GET', '/groups', ''],
  ['sipgate_list_group_users', 'GET', '/groups/{group_id}/users', 'group_id'],
  ['sipgate_list_active_calls', 'GET', '/calls', ''],
  ['sipgate_list_sms_extensions', 'GET', '/{user_id}/sms', 'user_id'],
  ['sipgate_send_sms', 'POST', '/sessions/sms', 'sms_id,recipient,message'],
  ['sipgate_start_call', 'POST', '/sessions/calls', 'caller,callee'],
];
const SWITCHED_OFF = ['sipgate_send_sms','sipgate_start_call'];
const READ_ONLY = new Set(['sipgate_get_user_info','sipgate_get_account','sipgate_get_balance','sipgate_list_users','sipgate_get_user','sipgate_list_devices','sipgate_get_device','sipgate_list_numbers','sipgate_list_user_numbers','sipgate_list_phonelines','sipgate_list_forwardings','sipgate_list_history','sipgate_get_history_entry','sipgate_list_contacts','sipgate_get_contact','sipgate_list_voicemails','sipgate_list_blocklist','sipgate_list_groups','sipgate_list_group_users','sipgate_list_active_calls','sipgate_list_sms_extensions']);

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

describe('sipgate adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the expected envelope, variables, probe and hints', () => {
    expect(a.slug).toBe('sipgate');
    expect(a.region).toBe('de');
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('sipgate');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.sipgate.com/v2');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.requiredEnvVars).toEqual(['SIPGATE_TOKEN_ID','SIPGATE_TOKEN']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.probe.tool).toBe('sipgate_get_user_info');
    for (const key of ['401','402','403','404','rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) expect(a.envVarMeta[name]).toBeTruthy();
    expect(a.prerequisites.length).toBeGreaterThan(40);
  });

  it('sends Token ID and token as HTTP Basic credentials', async () => {
    expect(a.connector.authConfig).toEqual({ username: '{{SIPGATE_TOKEN_ID}}', password: '{{SIPGATE_TOKEN}}' });
    expect(a.envVarMeta.SIPGATE_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(new RegExp(a.envVarMeta.SIPGATE_TOKEN_ID.pattern!).test(ENV.SIPGATE_TOKEN_ID)).toBe(true);
    expect(new RegExp(a.envVarMeta.SIPGATE_TOKEN_ID.pattern!).test(ENV.SIPGATE_TOKEN)).toBe(false);
    expect(new RegExp(a.envVarMeta.SIPGATE_TOKEN.pattern!).test(ENV.SIPGATE_TOKEN)).toBe(true);

    ok({ sub: 'w0', domain: 'sipgate.de' });
    await call('sipgate_get_user_info');
    const req = sent();
    expect(req.url).toBe('https://api.sipgate.com/v2/authorization/userinfo');
    expect(req.auth).toEqual({ username: ENV.SIPGATE_TOKEN_ID, password: ENV.SIPGATE_TOKEN });
  });

  it('keeps every tool on its documented method and path', () => {
    expect(a.tools.map((t) => [t.name, t.endpointMapping.method, t.endpointMapping.path, (t.parameters.required ?? []).join(',')])).toEqual(TOOLS);
    expect(a.tools).toHaveLength(25);
  });

  it('prefixes every tool and declares every argument it reads', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    expect(names.size).toBe(a.tools.length);
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      expect(entry.name).toMatch(/^sipgate_[a-z0-9_]+$/);
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
    // The two tools that cost money, and nothing that changes the phone system.
    expect(tool('sipgate_send_sms').endpointMapping).toMatchObject({ method: 'POST', path: '/sessions/sms' });
    expect(tool('sipgate_start_call').endpointMapping).toMatchObject({ method: 'POST', path: '/sessions/calls' });
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).not.toBe('DELETE');
      expect(entry.endpointMapping.path).not.toMatch(/sessions\/fax|portings|credentials|sim/);
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

  it('filters the history with repeated query parameters', async () => {
    ok({ items: [], totalCount: 0 });
    await call('sipgate_list_history', { types: ['CALL', 'VOICEMAIL'], directions: ['MISSED_INCOMING'], from: '2026-11-01T00:00:00Z', include_all_users: true });
    expect(sent().url).toBe('https://api.sipgate.com/v2/history');
    expect(sent().params).toEqual({ types: ['CALL', 'VOICEMAIL'], directions: ['MISSED_INCOMING'], from: '2026-11-01T00:00:00Z', includeAllUsers: true, offset: 0, limit: 20 });

    ok();
    await call('sipgate_update_history_entry', { entry_id: '100001234', note: 'Called back', read: true });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe('https://api.sipgate.com/v2/history/100001234');
    expect(sent().data).toEqual({ note: 'Called back', read: true });
  });

  it('reads the per-user resources under the user id', async () => {
    ok({ items: [] });
    await call('sipgate_list_devices', { user_id: 'w0' });
    expect(sent().url).toBe('https://api.sipgate.com/v2/w0/devices');

    ok({ items: [] });
    await call('sipgate_list_forwardings', { user_id: 'w0', phoneline_id: 'p0' });
    expect(sent().url).toBe('https://api.sipgate.com/v2/w0/phonelines/p0/forwardings');

    ok({ items: [] });
    await call('sipgate_list_sms_extensions', { user_id: 'w1' });
    expect(sent().url).toBe('https://api.sipgate.com/v2/w1/sms');

    ok({ items: [] });
    await call('sipgate_list_groups', { user_id: 'w0' });
    expect(sent().url).toBe('https://api.sipgate.com/v2/groups');
    expect(sent().params).toEqual({ userId: 'w0' });
  });

  it('builds the contact, SMS and call bodies as sipgate documents them', async () => {
    ok({}, 201);
    await call('sipgate_create_contact', { name: 'Ada Lovelace', given: 'Ada', family: 'Lovelace', numbers: [{ number: '+4915799912345', type: ['cell'] }] });
    expect(sent().url).toBe('https://api.sipgate.com/v2/contacts');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ name: 'Ada Lovelace', given: 'Ada', family: 'Lovelace', numbers: [{ number: '+4915799912345', type: ['cell'] }], scope: 'SHARED' });

    ok({}, 204);
    await call('sipgate_send_sms', { sms_id: 's0', recipient: '+4915799912345', message: 'Hello' });
    expect(sent().url).toBe('https://api.sipgate.com/v2/sessions/sms');
    expect(sent().data).toEqual({ smsId: 's0', recipient: '+4915799912345', message: 'Hello' });

    ok({ sessionId: 'abc' });
    await call('sipgate_start_call', { caller: 'e0', callee: '+4915799912345' });
    expect(sent().url).toBe('https://api.sipgate.com/v2/sessions/calls');
    expect(sent().data).toEqual({ caller: 'e0', callee: '+4915799912345' });

    ok({ items: [] });
    await call('sipgate_list_contacts', { scopes: ['SHARED'] });
    expect(sent().url).toBe('https://api.sipgate.com/v2/contacts');
    expect(sent().params).toEqual({ scopes: ['SHARED'], limit: 100 });
  });
});

// Opt-in: RUN_SIPGATE_LIVE=1. Reads only; nothing is sent or changed.
const live = process.env.RUN_SIPGATE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('sipgate: live', () => {
  it('refuses a call without credentials', async () => {
    const response = await liveFetch.get('https://api.sipgate.com/v2/account', { validateStatus: () => true });
    expect(response.status).toBe(401);
  });

  it('reads the token owner and one page of the history', async () => {
    const id = process.env.SIPGATE_TOKEN_ID;
    const token = process.env.SIPGATE_TOKEN;
    if (!id || !token) throw new Error('Set SIPGATE_TOKEN_ID and SIPGATE_TOKEN for the live check');
    const auth = { username: id, password: token };
    const info = await liveFetch.get('https://api.sipgate.com/v2/authorization/userinfo', { auth, validateStatus: () => true });
    expect(info.status).toBe(200);
    expect(info.data.sub).toMatch(/^w[0-9]+$/);
    const history = await liveFetch.get('https://api.sipgate.com/v2/history', { auth, params: { limit: 5 }, validateStatus: () => true });
    expect([200, 403]).toContain(history.status);
  });
});
