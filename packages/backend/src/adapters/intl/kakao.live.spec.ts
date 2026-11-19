import axios from 'axios';
import * as adapter from './kakao.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Kakao Developers REST API adapter (https://kapi.kakao.com), signed in with
 * Kakao Login (OAuth 2.0 authorization code at kauth.kakao.com) through the
 * user's own Kakao app: REST API key as client id, client secret in the token
 * request body, consent items chosen with KAKAO_SCOPES (comma-separated, as
 * Kakao wants them).
 *
 * Static checks always run: the OAuth settings, every tool's method and path
 * against the Kakao docs (Kakao Login, Kakao Talk Message, Kakao Talk Social,
 * Talk Calendar REST API pages), which tools install switched off, and requests
 * through the real RestEngine: the message and calendar tools send a
 * form-urlencoded body whose template_object, receiver_uuids and event fields
 * are JSON text, as the API requires.
 * https://developers.kakao.com/docs/latest/en/kakaotalk-message/rest-api
 *
 * Live checks run only with RUN_KAKAO_LIVE=1: without a token they confirm
 * the API refuses the call with code -401; with KAKAO_ACCESS_TOKEN they read
 * the token information. Reads only, no message is sent.
 *
 *   RUN_KAKAO_LIVE=1 KAKAO_ACCESS_TOKEN=... npx jest src/adapters/intl/kakao.live.spec.ts
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
jest.mock('../../common/ssrf.util', () => ({
  ...jest.requireActual('../../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: {
    properties?: Record<string, { type?: string; description?: string; default?: unknown; enum?: unknown[]; pattern?: string }>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  aliases?: string[];
  instructions: string;
  prerequisites?: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<
    string,
    { label?: string; kind?: string; secret?: boolean; pattern?: string; options?: Array<{ value: string; label: string }> }
  >;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: Record<string, unknown>;
  };
  tools: Tool[];
};
const tool = (name: string): Tool => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
/** Tool arguments a mapping reads: {x} in the path, "$x" and "${x}" in query, body and headers. */
const used = (entry: Tool): Set<string> => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown): void => {
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
/** Text outside `code spans`: the website renders descriptions and instructions as MDX. */
const outsideCode = (text: string): string => text.replace(/`[^`]*`/g, '');

// name, HTTP method, path below the base URL
const TOOLS: Array<[string, string, string]> = [
  ['kakao_get_token_info', 'GET', '/v1/user/access_token_info'],
  ['kakao_get_user', 'GET', '/v2/user/me'],
  ['kakao_list_consents', 'GET', '/v2/user/scopes'],
  ['kakao_get_talk_profile', 'GET', '/v1/api/talk/profile'],
  ['kakao_send_text_to_me', 'POST', '/v2/api/talk/memo/default/send'],
  ['kakao_send_template_to_me', 'POST', '/v2/api/talk/memo/default/send'],
  ['kakao_send_custom_template_to_me', 'POST', '/v2/api/talk/memo/send'],
  ['kakao_send_link_preview_to_me', 'POST', '/v2/api/talk/memo/scrap/send'],
  ['kakao_list_friends', 'GET', '/v1/api/talk/friends'],
  ['kakao_send_text_to_friends', 'POST', '/v1/api/talk/friends/message/default/send'],
  ['kakao_send_template_to_friends', 'POST', '/v1/api/talk/friends/message/default/send'],
  ['kakao_send_custom_template_to_friends', 'POST', '/v1/api/talk/friends/message/send'],
  ['kakao_list_calendars', 'GET', '/v2/api/calendar/calendars'],
  ['kakao_list_events', 'GET', '/v2/api/calendar/events'],
  ['kakao_get_event', 'GET', '/v2/api/calendar/event'],
  ['kakao_create_event', 'POST', '/v2/api/calendar/create/event'],
  ['kakao_update_event', 'POST', '/v2/api/calendar/update/event/host'],
  ['kakao_delete_event', 'DELETE', '/v2/api/calendar/delete/event'],
];
const REQUIRED: Record<string, string[]> = {
  kakao_send_text_to_me: ['text'],
  kakao_send_template_to_me: ['template_object'],
  kakao_send_custom_template_to_me: ['template_id'],
  kakao_send_link_preview_to_me: ['request_url'],
  kakao_send_text_to_friends: ['receiver_uuids', 'text'],
  kakao_send_template_to_friends: ['receiver_uuids', 'template_object'],
  kakao_send_custom_template_to_friends: ['receiver_uuids', 'template_id'],
  kakao_get_event: ['event_id'],
  kakao_create_event: ['title', 'start_at', 'end_at'],
  kakao_update_event: ['event_id'],
  kakao_delete_event: ['event_id'],
};
const SWITCHED_OFF: string[] = ['kakao_delete_event'];

describe('kakao adapter: static contract', () => {
  it('is filed where the catalog expects it', () => {
    expect(a.slug).toBe('kakao');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('kakao');
    expect(a.docsUrl).toBe('https://developers.kakao.com/docs/latest/en/kakaotalk-message/rest-api');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://kapi.kakao.com');
  });

  it('authenticates as the vendor documents', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      'clientId': '{{KAKAO_REST_API_KEY}}',
      'clientSecret': '{{KAKAO_CLIENT_SECRET}}',
      'authorizationUrl': 'https://kauth.kakao.com/oauth/authorize',
      'tokenUrl': 'https://kauth.kakao.com/oauth/token',
      'tokenAuthMethod': 'client_secret_post',
      'scopes': '{{KAKAO_SCOPES}}'
    });
    expect(a.requiredEnvVars).toEqual(['KAKAO_REST_API_KEY', 'KAKAO_CLIENT_SECRET', 'KAKAO_SCOPES']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[name]?.label).toBeTruthy();
    }
    for (const name of ['KAKAO_CLIENT_SECRET']) {
      expect(a.envVarMeta[name]).toMatchObject({ kind: 'credential', secret: true });
    }
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(TOOLS.map(([name]) => name));
    for (const [name, method, path] of TOOLS) {
      const m = tool(name).endpointMapping;
      expect(`${name}: ${m.method} ${m.path}`).toBe(`${name}: ${method} ${path}`);
    }
  });

  it('prefixes every tool, declares every argument it reads and requires what the API requires', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    expect(names.size).toBe(a.tools.length);
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      expect(entry.name).toMatch(/^kakao_[a-z0-9_]+$/);
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect([entry.name, entry.parameters.required ?? []]).toEqual([entry.name, REQUIRED[entry.name] ?? []]);
      for (const [param, schema] of Object.entries(entry.parameters.properties ?? {})) {
        expect([entry.name, param, Boolean(schema.description)]).toEqual([entry.name, param, true]);
      }
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('installs the risky tools switched off and marks every GET read-only', () => {
    const offNow = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(offNow.sort()).toEqual(SWITCHED_OFF);
    for (const entry of a.tools) {
      const method = entry.endpointMapping.method;
      if (method === 'GET') expect([entry.name, entry.annotations?.readOnlyHint]).toEqual([entry.name, true]);
      if (method === 'DELETE') expect([entry.name, entry.enabled]).toEqual([entry.name, false]);
    }
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    expect(a.instructions.startsWith('## ')).toBe(true);
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    const texts = [a.instructions, a.prerequisites ?? '', ...a.tools.map((entry) => entry.description)];
    for (const entry of a.tools) {
      for (const schema of Object.values(entry.parameters.properties ?? {})) texts.push(schema.description ?? '');
    }
    for (const text of texts) {
      expect(outsideCode(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/\u2014/);
    }
  });

  it('probes with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({
      'tool': 'kakao_get_token_info',
      'params': {}
    });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['400', '401', '403', 'rate_limited', 'invalid_scope', 'invalid_client', 'invalid_grant']) expect(a.verifyHints[key]).toBeTruthy();
  });


  const ENV: Record<string, string> = {
    KAKAO_REST_API_KEY: '0123456789abcdef0123456789abcdef',
    KAKAO_CLIENT_SECRET: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    KAKAO_SCOPES: 'talk_message,profile_nickname,profile_image,talk_calendar',
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
        authConfig: interpolateDeep(a.connector.authConfig ?? {}, ENV),
        headers: cfg.headers,
      } as never,
      endpointMapping,
      { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
    );
  };
  const sent = () => mockedAxios.mock.calls.at(-1)![0];
  const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: { result_code: 0 }, headers: {} });
  const header = (req: { headers: Record<string, string> }, name: string) =>
    Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const formOf = (req: { data: unknown }) => new URLSearchParams(String(req.data));

  beforeEach(() => mockedAxios.mockReset());

  it('offers the consent items as comma-separated choices that always include talk_message', () => {
    const options = a.envVarMeta.KAKAO_SCOPES.options ?? [];
    expect(options.length).toBeGreaterThanOrEqual(2);
    for (const option of options) {
      expect(option.value).toMatch(/^[a-z_]+(,[a-z_]+)*$/);
      expect(option.value.split(',')).toContain('talk_message');
    }
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
    expect(new RegExp(a.envVarMeta.KAKAO_REST_API_KEY.pattern!).test(ENV.KAKAO_REST_API_KEY)).toBe(true);
    expect(JSON.stringify(a)).not.toMatch(/KakaoAK|ADMIN_KEY/);
  });

  it('sends every write as a form-urlencoded body in UTF-8', () => {
    for (const entry of a.tools) {
      const m = entry.endpointMapping;
      if (m.method !== 'POST') continue;
      expect([entry.name, m.bodyEncoding]).toEqual([entry.name, 'form-urlencoded']);
      expect(m.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' });
    }
  });

  it('sends a text memo to the user as template_object JSON in a form field', async () => {
    ok();
    await call('kakao_send_text_to_me', { text: 'Stand-up at 10:00 & demo', web_url: 'https://example.org/agenda' });
    const req = sent();
    expect(req.url).toBe('https://kapi.kakao.com/v2/api/talk/memo/default/send');
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
    expect(header(req, 'Content-Type')).toBe('application/x-www-form-urlencoded;charset=utf-8');
    expect(typeof req.data).toBe('string');
    const form = formOf(req);
    expect([...form.keys()]).toEqual(['template_object']);
    expect(JSON.parse(form.get('template_object')!)).toEqual({
      object_type: 'text',
      text: 'Stand-up at 10:00 & demo',
      link: { web_url: 'https://example.org/agenda', mobile_web_url: 'https://example.org/agenda' },
    });
  });

  it('passes a whole default template and a custom template through', async () => {
    const feed = {
      object_type: 'feed',
      content: { title: 'Report', description: 'Weekly numbers', link: { web_url: 'https://example.org' } },
    };
    ok();
    await call('kakao_send_template_to_me', { template_object: feed });
    expect(JSON.parse(formOf(sent()).get('template_object')!)).toEqual(feed);

    ok();
    await call('kakao_send_custom_template_to_me', { template_id: 12345, template_args: '{"TITLE":"Hello"}' });
    expect(sent().url).toBe('https://kapi.kakao.com/v2/api/talk/memo/send');
    expect(Object.fromEntries(formOf(sent()))).toEqual({ template_id: '12345', template_args: '{"TITLE":"Hello"}' });

    ok();
    await call('kakao_send_link_preview_to_me', { request_url: 'https://example.org/post?id=1' });
    expect(sent().url).toBe('https://kapi.kakao.com/v2/api/talk/memo/scrap/send');
    expect(Object.fromEntries(formOf(sent()))).toEqual({ request_url: 'https://example.org/post?id=1' });
  });

  it('sends to friends with receiver_uuids as a JSON list', async () => {
    ok();
    await call('kakao_send_text_to_friends', { receiver_uuids: ['abcdefg0001', 'abcdefg0002'], text: 'Hello' });
    const req = sent();
    expect(req.url).toBe('https://kapi.kakao.com/v1/api/talk/friends/message/default/send');
    const form = formOf(req);
    expect(JSON.parse(form.get('receiver_uuids')!)).toEqual(['abcdefg0001', 'abcdefg0002']);
    expect(JSON.parse(form.get('template_object')!)).toMatchObject({ object_type: 'text', text: 'Hello' });
    expect(tool('kakao_send_text_to_friends').parameters.properties?.receiver_uuids).toMatchObject({ maxItems: 5 });
  });

  it('creates a calendar event with the event as JSON text and reads events with query parameters', async () => {
    ok();
    await call('kakao_create_event', {
      title: 'Team lunch',
      start_at: '2026-11-27T03:00:00Z',
      end_at: '2026-11-27T04:00:00Z',
      reminders: [15, 30],
      color: 'RED',
    });
    expect(sent().url).toBe('https://kapi.kakao.com/v2/api/calendar/create/event');
    const form = formOf(sent());
    expect(form.get('calendar_id')).toBeNull();
    expect(JSON.parse(form.get('event')!)).toEqual({
      title: 'Team lunch',
      time: { start_at: '2026-11-27T03:00:00Z', end_at: '2026-11-27T04:00:00Z', time_zone: 'Asia/Seoul', all_day: false },
      reminders: [15, 30],
      color: 'RED',
    });

    ok();
    await call('kakao_list_events', { preset: 'THIS_WEEK' });
    expect(sent().url).toBe('https://kapi.kakao.com/v2/api/calendar/events');
    expect(String(sent().method).toUpperCase()).toBe('GET');
    expect(sent().params).toEqual({ preset: 'THIS_WEEK' });

    ok();
    await call('kakao_get_user', {});
    expect(sent().url).toBe('https://kapi.kakao.com/v2/user/me');
    expect(sent().params).toEqual({ secure_resource: true });
  });

  it('deletes an event with query parameters and only when switched on', async () => {
    expect(tool('kakao_delete_event').enabled).toBe(false);
    ok();
    await call('kakao_delete_event', { event_id: '63630c44d89d8b4150bbb716' });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe('https://kapi.kakao.com/v2/api/calendar/delete/event');
    expect(sent().params).toEqual({ event_id: '63630c44d89d8b4150bbb716' });
  });
});


// Opt-in: RUN_KAKAO_LIVE=1. The refusal check needs no account; the read
// needs KAKAO_ACCESS_TOKEN (a user access token of your Kakao app). No message
// is sent and nothing is written.
const live = process.env.RUN_KAKAO_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('kakao: live', () => {
  it('refuses an invalid access token with code -401', async () => {
    const response = await liveFetch.get(`${a.connector.baseUrl}/v1/user/access_token_info`, {
      headers: { Authorization: 'Bearer not-a-token' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
    expect(response.data).toMatchObject({ code: -401 });
  });

  it('reads the token information', async () => {
    const token = process.env.KAKAO_ACCESS_TOKEN;
    if (!token) throw new Error('Set KAKAO_ACCESS_TOKEN for the live check');
    const response = await liveFetch.get(`${a.connector.baseUrl}/v1/user/access_token_info`, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(typeof response.data.id).toBe('number');
  });
});
