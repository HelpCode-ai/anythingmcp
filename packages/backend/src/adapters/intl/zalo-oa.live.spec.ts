import axios from 'axios';
import * as adapter from './zalo-oa.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Zalo Official Account Open API (developers.zalo.me/docs/official-account):
 * base https://openapi.zalo.me, the OA access token in an `access_token` header,
 * GET filters passed as one JSON object in the `data` query parameter, errors
 * reported with HTTP 200 and a negative `error` field.
 *
 * The token comes from API Explorer and lasts about 25 hours: Zalo's OAuth v4
 * refresh needs a `secret_key` header and an `app_id` form field and rotates the
 * refresh token, which the OAUTH2 engine does not send, so the adapter uses a
 * pasted token (API_KEY auth).
 *
 * Static checks run every request through the real RestEngine with axios mocked.
 * Live part (reads only: OA profile, tags, first users, recent chats, articles):
 *   RUN_ZALO_OA_LIVE=1 ZALO_OA_ACCESS_TOKEN=... npx jest src/adapters/intl/zalo-oa
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
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; config?: { errorWhen?: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations } as never);

// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

// Built at run time so no literal here looks like a real credential.
const TOKEN = ['zAbC1dEf2GhI3jKl', '4MnO5pQr6StU7vWx'].join('_');
const BASE = 'https://openapi.zalo.me';
const ENV = { ZALO_OA_ACCESS_TOKEN: TOKEN };
const UID = '4572947693969771653';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, schema defaults applied, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const c = interpolateDeep(a.connector, env) as typeof a.connector;
  return engine().execute(
    { baseUrl: c.baseUrl, authType: c.authType, authConfig: c.authConfig, headers: c.headers, errorWhen: c.config?.errorWhen } as never,
    interpolateDeep(tool(name).endpointMapping, env) as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown> = {}) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = ['zalo_oa_update_user', 'zalo_oa_tag_user', 'zalo_oa_untag_user', 'zalo_oa_delete_tag', 'zalo_oa_send_text', 'zalo_oa_send_image'];
const READ_POSTS = ['zalo_oa_get_quota', 'zalo_oa_get_user_quota'];

describe('zalo-oa adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is an intl messaging adapter with its own icon', () => {
    expect(a.slug).toBe('zalo-oa');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('zalo');
  });

  it('sends the pasted OA token in the access_token header to openapi.zalo.me', async () => {
    expect(a.requiredEnvVars).toEqual(['ZALO_OA_ACCESS_TOKEN']);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'access_token', apiKey: '{{ZALO_OA_ACCESS_TOKEN}}' });
    expect(a.envVarMeta.ZALO_OA_ACCESS_TOKEN.secret).toBe(true);
    const re = new RegExp(a.envVarMeta.ZALO_OA_ACCESS_TOKEN.pattern!);
    expect(re.test(TOKEN)).toBe(true);
    for (const bad of [`Bearer ${TOKEN}`, 'short', `"${TOKEN}"`]) expect(re.test(bad)).toBe(false);
    mockedAxios.mockResolvedValue({ data: { error: 0, message: 'Success', data: {} } });
    await call('zalo_oa_get_oa_info');
    expect(sent().headers.access_token).toBe(TOKEN);
    expect(sent().headers.Authorization).toBeUndefined();
  });

  it('says in the instructions that the token lasts about 25 hours', () => {
    expect(a.instructions).toMatch(/25 hours/);
    expect(a.instructions).toMatch(/API Explorer/);
  });

  // [tool, args, method, url]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['zalo_oa_get_oa_info', {}, 'GET', `${BASE}/v2.0/oa/getoa`],
    ['zalo_oa_get_quota', {}, 'POST', `${BASE}/v3.0/oa/quota/message`],
    ['zalo_oa_get_user_quota', { user_id: UID }, 'POST', `${BASE}/v3.0/oa/quota/message`],
    ['zalo_oa_list_users', {}, 'GET', `${BASE}/v3.0/oa/user/getlist`],
    ['zalo_oa_filter_users', { query: '{"offset":0,"count":5}' }, 'GET', `${BASE}/v3.0/oa/user/getlist`],
    ['zalo_oa_get_user', { user_id: UID }, 'GET', `${BASE}/v3.0/oa/user/detail`],
    ['zalo_oa_update_user', { user_id: UID, user_alias: 'A' }, 'POST', `${BASE}/v3.0/oa/user/update`],
    ['zalo_oa_list_tags', {}, 'GET', `${BASE}/v2.0/oa/tag/gettagsofoa`],
    ['zalo_oa_tag_user', { user_id: UID, tag_name: 'VIP' }, 'POST', `${BASE}/v2.0/oa/tag/tagfollower`],
    ['zalo_oa_untag_user', { user_id: UID, tag_name: 'VIP' }, 'POST', `${BASE}/v2.0/oa/tag/rmfollowerfromtag`],
    ['zalo_oa_delete_tag', { tag_name: 'VIP' }, 'POST', `${BASE}/v2.0/oa/tag/rmtag`],
    ['zalo_oa_list_recent_chats', {}, 'GET', `${BASE}/v2.0/oa/listrecentchat`],
    ['zalo_oa_get_conversation', { user_id: UID }, 'GET', `${BASE}/v2.0/oa/conversation`],
    ['zalo_oa_send_text', { user_id: UID, text: 'Hi' }, 'POST', `${BASE}/v3.0/oa/message/cs`],
    ['zalo_oa_send_image', { user_id: UID, image_url: 'https://example.com/a.jpg' }, 'POST', `${BASE}/v3.0/oa/message/cs`],
    ['zalo_oa_list_articles', {}, 'GET', `${BASE}/v2.0/article/getslice`],
    ['zalo_oa_get_article', { article_id: '39c07ccbe78e0ed0579f' }, 'GET', `${BASE}/v2.0/article/getdetail`],
  ];

  it('lists every tool in the URL table', () => {
    expect([...new Set(table.map(([name]) => name))].sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s %s', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: { error: 0, message: 'Success' } });
    await call(name, params);
    expect(sent().method.toUpperCase()).toBe(method);
    expect(sent().url).toBe(url);
  });

  it('passes GET filters as one JSON object in the data query parameter', async () => {
    mockedAxios.mockResolvedValue({ data: { error: 0, data: {} } });
    await call('zalo_oa_list_users');
    expect(JSON.parse(sent().params.data)).toEqual({ offset: 0, count: 50 });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: 0, data: {} } });
    await call('zalo_oa_get_user', { user_id: UID });
    expect(JSON.parse(sent().params.data)).toEqual({ user_id: UID });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: 0, data: [] } });
    await call('zalo_oa_get_conversation', { user_id: UID, offset: 10 });
    // user_id goes out as a JSON number, as in Zalo's example; parse the text, not the number.
    expect(sent().params.data).toBe(`{"user_id":${UID},"offset":10,"count":10}`);
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: 0, data: [] } });
    await call('zalo_oa_list_recent_chats', { count: 5 });
    expect(JSON.parse(sent().params.data)).toEqual({ offset: 0, count: 5 });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: 0, data: {} } });
    const q = '{"offset":0,"count":50,"tag_name":"VIP","is_follower":"true"}';
    await call('zalo_oa_filter_users', { query: q });
    expect(sent().params.data).toBe(q);
  });

  it('sends articles paging as plain query parameters', async () => {
    mockedAxios.mockResolvedValue({ data: { error: 0, data: {} } });
    await call('zalo_oa_list_articles', { type: 'video' });
    expect(sent().params).toEqual({ offset: 0, limit: 20, type: 'video' });
  });

  it('builds the consultation message bodies as documented', async () => {
    mockedAxios.mockResolvedValue({ data: { error: 0, data: {} } });
    await call('zalo_oa_send_text', { user_id: UID, text: 'Hello', quote_message_id: 'm1' });
    expect(sent().data).toEqual({ recipient: { user_id: UID }, message: { text: 'Hello', quote_message_id: 'm1' } });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: 0, data: {} } });
    await call('zalo_oa_send_image', { user_id: UID, image_url: 'https://example.com/a.jpg', text: 'Cap' });
    expect(sent().data).toEqual({
      recipient: { user_id: UID },
      message: { text: 'Cap', attachment: { type: 'template', payload: { template_type: 'media', elements: [{ media_type: 'image', url: 'https://example.com/a.jpg' }] } } },
    });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: 0 } });
    await call('zalo_oa_get_quota');
    expect(sent().data).toEqual({ quota_owner: 'OA' });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: 0 } });
    await call('zalo_oa_update_user', { user_id: UID, user_alias: 'A', phone: '0901' });
    expect(sent().data).toEqual({ user_id: UID, user_alias: 'A', shared_info: { phone: '0901' } });
  });

  it('turns a negative error in a 200 answer into a classified failure', async () => {
    mockedAxios.mockResolvedValue({ data: { error: -216, message: 'Access token is invalid' } });
    await expect(call('zalo_oa_get_oa_info')).rejects.toMatchObject({ status: 401 });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: -32, message: 'Your application reached limit call api' } });
    await expect(call('zalo_oa_list_tags')).rejects.toMatchObject({ status: 429 });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: -230, message: 'User has not interacted with the OA in the past 7 days' } });
    await expect(call('zalo_oa_send_text', { user_id: UID, text: 'x' })).rejects.toMatchObject({ status: 400 });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: 0, message: 'Success', data: ['VIP'] } });
    await expect(call('zalo_oa_list_tags')).resolves.toBeDefined();
  });

  it('drops avatar URLs from message lists', () => {
    const msg = { message_id: 'm', src: 1, time: 1, from_avatar: 'x', to_avatar: 'y', message: 'hi' };
    const out = applyResponseTransform({ error: 0, data: [msg] }, tool('zalo_oa_get_conversation').responseMapping as never).value;
    expect(out).toEqual({ error: 0, data: [{ message_id: 'm', src: 1, time: 1, message: 'hi' }] });
  });

  it('every tool is prefixed, every declared parameter reaches the request and vice versa', () => {
    for (const t of a.tools) {
      expect(t.name).toMatch(/^zalo_oa_[a-z0-9_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('marks reads read-only, writes as writes with a confirmation, and installs label deletion switched off', () => {
    for (const t of a.tools) {
      const read = t.endpointMapping.method === 'GET' || READ_POSTS.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${read}`);
    }
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const name of ['zalo_oa_send_text', 'zalo_oa_send_image', 'zalo_oa_delete_tag', 'zalo_oa_update_user']) {
      expect(`${name}:${/confirm|wait for a yes/i.test(tool(name).description)}`).toBe(`${name}:true`);
    }
    expect(annotationsOf(tool('zalo_oa_delete_tag')).destructiveHint).toBe(true);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['zalo_oa_delete_tag']);
  });

  it('probes with a read tool without required parameters and documents every tool', () => {
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bzalo_oa_[a-z0-9_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bzalo_oa_[a-z0-9_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const LIVE_TOKEN = process.env.ZALO_OA_ACCESS_TOKEN;
const live = process.env.RUN_ZALO_OA_LIVE === '1' && LIVE_TOKEN ? describe : describe.skip;

live('zalo-oa adapter: live API (reads only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as never));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, { ZALO_OA_ACCESS_TOKEN: LIVE_TOKEN as string }, params);

  it('reads the OA profile, tags, a page of users, recent chats and articles', async () => {
    const oa = await run('zalo_oa_get_oa_info');
    expect(oa.error).toBe(0);
    expect(typeof oa.data.oa_id === 'string' || typeof oa.data.oaid === 'string').toBe(true);
    expect((await run('zalo_oa_list_tags')).error).toBe(0);
    const users = await run('zalo_oa_list_users', { count: 5 });
    expect(Array.isArray(users.data.users)).toBe(true);
    if (users.data.users[0]) expect((await run('zalo_oa_get_user', { user_id: users.data.users[0].user_id })).error).toBe(0);
    expect((await run('zalo_oa_list_recent_chats', { count: 3 })).error).toBe(0);
    expect((await run('zalo_oa_list_articles', { limit: 3 })).error).toBe(0);
  }, 60_000);
});
