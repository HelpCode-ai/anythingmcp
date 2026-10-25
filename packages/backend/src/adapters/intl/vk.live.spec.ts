import axios from 'axios';
import * as adapter from './vk.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { ResponseBodyError, describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { assertNoUnresolvedPlaceholders } from '../../common/unresolved-placeholders.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the VK (VKontakte) adapter:
 *
 *   1. Static: always runs. Pins the token routing (the community access key
 *      in the connector's Authorization header; the tools VK only accepts with
 *      a user or service key override it with VK_USER_TOKEN), the API version
 *      on every call, each method name and its parameters through the real
 *      RestEngine, the errorWhen rules that turn VK's HTTP 200 error bodies
 *      into failed calls, the switched-off deletes, and the response mappings.
 *      Method names, parameters and accepted token types were checked against
 *      VK's official API schema (VKCOM/vk-api-schema, methods.json for 5.199)
 *      and the method pages of dev.vk.ru.
 *
 *   2. Live: skipped unless RUN_VK_LIVE=1.
 *      - Without tokens it calls every method with a made-up key: VK answers
 *        error 5 (authorization failed) for a method that exists and error 3
 *        for an unknown one, so this proves every method name.
 *          RUN_VK_LIVE=1 npx jest src/adapters/intl/vk.live.spec.ts
 *      - With VK_COMMUNITY_TOKEN it runs the community read tools; with
 *        VK_USER_TOKEN and VK_TEST_DOMAIN + VK_TEST_COMMUNITY_ID also the
 *        wall, comments and albums reads.
 *      - RUN_VK_LIVE_WRITES=1 with VK_TEST_PEER_ID sends one message from the
 *        community to that peer (use your own account).
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

type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
  bodyEncoding?: string;
  headers?: Record<string, string>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number }>; required?: string[] };
  endpointMapping: Mapping;
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  name: string;
  category: string;
  icon: string;
  region: string;
  instructions: string;
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig?: unknown; headers: Record<string, string>; healthcheckPath: string; config: { errorWhen: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.vk.ru/method';
const rules = a.connector.config.errorWhen;
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
let env: Record<string, string> = { VK_COMMUNITY_TOKEN: 'vk1.a.community-test-token', VK_USER_TOKEN: 'vk1.a.user-test-token' };

/** What the MCP layer does: resolve {{VAR}}, refuse leftovers, then call the engine. */
const run = async (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  assertNoUnresolvedPlaceholders(
    { baseUrl: config.baseUrl, path: endpointMapping.path, queryParams: endpointMapping.queryParams, headers: config.headers, body: { mapping: endpointMapping.bodyMapping, headers: endpointMapping.headers } },
    `the connector behind ${name}`,
  );
  const { body } = await engine().executeWithMeta(
    { baseUrl: config.baseUrl, authType: a.connector.authType, headers: config.headers, errorWhen: rules } as never,
    endpointMapping as never,
    applySchemaDefaults(tool(name).parameters, params),
  );
  return body as any;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);
const runShaped = async (name: string, params: Record<string, unknown>) => {
  const out = shape(name, await run(name, params));
  expect(out.error).toBeUndefined();
  return out.value as any;
};
const sent = () => mockedAxios.mock.calls[0][0];

// Accepted token types per method, from VKCOM/vk-api-schema methods.json
// (access_token_type) and the dev.vk.ru method pages, checked 15 Oct 2026.
const TOKEN_TYPES: Record<string, string[]> = {
  'groups.getTokenPermissions': ['group'],
  'groups.getById': ['user', 'group', 'service'],
  'messages.getConversations': ['user', 'group'],
  'messages.getHistory': ['user', 'group'],
  'messages.send': ['user', 'group'],
  'wall.createComment': ['user', 'group'],
  'wall.get': ['user', 'service'],
  'wall.getComments': ['user', 'service'],
  'photos.getAlbums': ['user', 'service'],
  'wall.post': ['user'],
  'stats.get': ['user'],
  'market.get': ['user'],
  'wall.delete': ['user'],
  'wall.deleteComment': ['user'],
};
const USER_TOOLS = [
  'vk_get_wall_posts',
  'vk_get_post_comments',
  'vk_list_photo_albums',
  'vk_publish_post',
  'vk_get_community_stats',
  'vk_list_market_products',
  'vk_delete_post',
  'vk_delete_comment',
];
const WRITES = ['vk_send_message', 'vk_create_comment', 'vk_publish_post', 'vk_delete_post', 'vk_delete_comment'];
const methodOf = (t: Tool) => t.endpointMapping.path.replace(/^\//, '');

// [tool, minimal arguments, HTTP method, VK method]
const TABLE: Array<[string, Record<string, unknown>, string, string]> = [
  ['vk_get_token_permissions', {}, 'GET', 'groups.getTokenPermissions'],
  ['vk_get_community', {}, 'GET', 'groups.getById'],
  ['vk_list_conversations', {}, 'GET', 'messages.getConversations'],
  ['vk_get_conversation_history', { peer_id: 12345 }, 'GET', 'messages.getHistory'],
  ['vk_send_message', { peer_id: 12345, message: 'Здравствуйте!', random_id: 482913377 }, 'POST', 'messages.send'],
  ['vk_create_comment', { community_id: 1, post_id: 10, message: 'Спасибо!' }, 'POST', 'wall.createComment'],
  ['vk_get_wall_posts', { domain: 'apiclub' }, 'GET', 'wall.get'],
  ['vk_get_post_comments', { community_id: 1, post_id: 10 }, 'GET', 'wall.getComments'],
  ['vk_list_photo_albums', { community_id: 1 }, 'GET', 'photos.getAlbums'],
  ['vk_publish_post', { community_id: 1, message: 'Новости' }, 'POST', 'wall.post'],
  ['vk_get_community_stats', { community_id: 1, timestamp_from: 1790000000 }, 'GET', 'stats.get'],
  ['vk_list_market_products', { community_id: 1 }, 'GET', 'market.get'],
  ['vk_delete_post', { community_id: 1, post_id: 10 }, 'POST', 'wall.delete'],
  ['vk_delete_comment', { community_id: 1, comment_id: 20 }, 'POST', 'wall.deleteComment'],
];

describe('vk adapter: static spec conformance', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    env = { VK_COMMUNITY_TOKEN: 'vk1.a.community-test-token', VK_USER_TOKEN: 'vk1.a.user-test-token' };
  });

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('vk');
    expect(a.name).toBe('VK (VKontakte)');
    expect(a.icon).toBe('vk');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('social');
  });

  it('sends the community key as a Bearer header, never in the URL', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    // NONE so that a tool's own Authorization header (the user key) is not overwritten by auth injection.
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.headers.Authorization).toBe('Bearer {{VK_COMMUNITY_TOKEN}}');
    expect(a.requiredEnvVars).toEqual(['VK_COMMUNITY_TOKEN']);
    expect(a.optionalEnvVars).toEqual(['VK_USER_TOKEN']);
    for (const v of ['VK_COMMUNITY_TOKEN', 'VK_USER_TOKEN']) expect(a.envVarMeta[v].secret).toBe(true);
    for (const t of a.tools) expect(JSON.stringify(t.endpointMapping)).not.toContain('access_token');
    expect(a.connector.healthcheckPath).not.toContain('access_token');
  });

  it('accepts real-looking keys and refuses pasted prefixes', () => {
    const re = new RegExp(a.envVarMeta.VK_COMMUNITY_TOKEN.pattern!);
    expect(re.test('vk1.a.' + 'A1b2_C3-d4'.repeat(8))).toBe(true);
    expect(re.test('a'.repeat(85))).toBe(true);
    for (const bad of ['Bearer vk1.a.' + 'x'.repeat(60), 'access_token=' + 'x'.repeat(60), 'short']) expect(re.test(bad)).toBe(false);
  });

  it('probes and health-checks with groups.getTokenPermissions, a community-token method', async () => {
    expect(a.probe.tool).toBe('vk_get_token_permissions');
    expect(a.connector.healthcheckPath).toBe('/groups.getTokenPermissions?v=5.199');
    mockedAxios.mockResolvedValue({ data: { response: { mask: 4096, permissions: [] } } });
    const { config } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, { method: 'GET', path: a.connector.healthcheckPath }, env);
    await engine().execute({ baseUrl: config.baseUrl, authType: 'NONE', headers: config.headers, errorWhen: rules } as never, { method: 'GET', path: a.connector.healthcheckPath } as never, {});
    expect(sent().url).toBe(`${BASE}/groups.getTokenPermissions?v=5.199`);
    expect(sent().headers.Authorization).toBe('Bearer vk1.a.community-test-token');
  });

  it('lists every tool in the URL table', () => {
    expect(TABLE.map(([n]) => n).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(TABLE)('%s calls %s %s with v=5.199 and the right key', async (name, params, http, method) => {
    mockedAxios.mockResolvedValue({ data: { response: {} } });
    await run(name, params);
    expect(sent().method).toBe(http);
    expect(sent().url).toBe(`${BASE}/${method}`);
    expect(sent().params.v).toBe('5.199');
    const user = USER_TOOLS.includes(name);
    expect(sent().headers.Authorization).toBe(user ? 'Bearer vk1.a.user-test-token' : 'Bearer vk1.a.community-test-token');
    if (http === 'POST') {
      expect(sent().headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(typeof sent().data).toBe('string');
    }
  });

  it('routes each method to a token type VK accepts for it', () => {
    for (const t of a.tools) {
      const accepted = TOKEN_TYPES[methodOf(t)];
      expect(`${t.name}:${Boolean(accepted)}`).toBe(`${t.name}:true`);
      if (USER_TOOLS.includes(t.name)) {
        expect(t.endpointMapping.headers).toEqual({ Authorization: 'Bearer {{VK_USER_TOKEN}}' });
        expect(`${t.name}:${accepted.includes('group')}`).toBe(`${t.name}:false`);
        expect(t.description).toMatch(/VK_USER_TOKEN/);
      } else {
        expect(t.endpointMapping.headers).toBeUndefined();
        expect(`${t.name}:${accepted.includes('group')}`).toBe(`${t.name}:true`);
      }
    }
  });

  it('a user-key tool without VK_USER_TOKEN stops before calling VK and names the variable', async () => {
    env = { VK_COMMUNITY_TOKEN: 'vk1.a.community-test-token' };
    mockedAxios.mockResolvedValue({ data: { response: {} } });
    await expect(run('vk_get_wall_posts', { domain: 'apiclub' })).rejects.toThrow(/VK_USER_TOKEN/);
    expect(mockedAxios).not.toHaveBeenCalled();
    await run('vk_get_community', {});
    expect(sent().headers.Authorization).toBe('Bearer vk1.a.community-test-token');
  });

  it('builds the parameters VK expects, with negative owner ids for the community', async () => {
    mockedAxios.mockResolvedValue({ data: { response: {} } });
    const call = async (name: string, params: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await run(name, params);
      return sent();
    };
    expect((await call('vk_get_community', {})).params).toEqual({ v: '5.199', fields: 'description,members_count,activity,site,status,verified,market,counters,can_message' });
    expect((await call('vk_list_conversations', {})).params).toEqual({ v: '5.199', filter: 'all', count: 20, extended: '1' });
    expect((await call('vk_get_conversation_history', { peer_id: 7 })).params).toEqual({ v: '5.199', peer_id: 7, count: 20 });
    expect((await call('vk_get_wall_posts', { domain: 'apiclub' })).params).toEqual({ v: '5.199', domain: 'apiclub', filter: 'all', count: 20 });
    expect((await call('vk_get_post_comments', { community_id: 1, post_id: 10 })).params).toEqual({
      v: '5.199', owner_id: '-1', post_id: 10, sort: 'desc', count: 20, need_likes: '1', preview_length: '0', extended: '1',
    });
    expect((await call('vk_list_photo_albums', { community_id: 22 })).params).toEqual({ v: '5.199', owner_id: '-22', count: 20, need_covers: '1' });
    expect((await call('vk_get_community_stats', { community_id: 22, timestamp_from: 1790000000 })).params).toEqual({
      v: '5.199', group_id: 22, timestamp_from: 1790000000, interval: 'day', extended: '0',
    });
    expect((await call('vk_list_market_products', { community_id: 22 })).params).toEqual({ v: '5.199', owner_id: '-22', count: 20 });

    const form = async (name: string, params: Record<string, unknown>) => Object.fromEntries(new URLSearchParams((await call(name, params)).data as string));
    expect(await form('vk_send_message', { peer_id: 12345, message: 'Здравствуйте!', random_id: 482913377 })).toEqual({ peer_id: '12345', message: 'Здравствуйте!', random_id: '482913377' });
    expect(await form('vk_create_comment', { community_id: 1, post_id: 10, message: 'Спасибо!', reply_to_comment: 5 })).toEqual({
      owner_id: '-1', from_group: '1', post_id: '10', message: 'Спасибо!', reply_to_comment: '5',
    });
    expect(await form('vk_publish_post', { community_id: 22, message: 'Новости', publish_date: 1793000000 })).toEqual({ owner_id: '-22', from_group: '1', message: 'Новости', publish_date: '1793000000' });
    expect(await form('vk_delete_post', { community_id: 22, post_id: 3 })).toEqual({ owner_id: '-22', post_id: '3' });
  });

  it('every tool is prefixed, unique, described, and every declared parameter reaches the request', () => {
    const names = new Set(a.tools.map((t) => t.name));
    expect(names.size).toBe(a.tools.length);
    for (const t of a.tools) {
      expect(t.name).toMatch(/^vk_[a-z_]+$/);
      expect(t.description.length).toBeGreaterThanOrEqual(80);
      const mapping = JSON.stringify(t.endpointMapping);
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        expect(`${t.name}:${p}:${mapping.includes(`"$${p}"`) || mapping.includes(`\${${p}}`)}`).toBe(`${t.name}:${p}:true`);
      }
    }
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(names.has(t.name)).toBe(false);
    }
  });

  it('reads are read-only GETs; writes are POSTs that ask for confirmation; deletes are off', () => {
    for (const t of a.tools) {
      const write = WRITES.includes(t.name);
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:${write ? 'POST' : 'GET'}`);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${!write}`);
      if (write) expect(t.description).toMatch(/confirm/i);
      expect(`${t.name}:${t.enabled === false}`).toBe(`${t.name}:${/^vk_delete_/.test(t.name)}`);
    }
    for (const name of ['vk_send_message', 'vk_create_comment', 'vk_publish_post']) expect(annotationsOf(tool(name)).destructiveHint).toBe(false);
    for (const name of ['vk_delete_post', 'vk_delete_comment']) expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    expect(tool('vk_publish_post').description).toMatch(/public/);
    expect(tool('vk_create_comment').description).toMatch(/public/);
  });

  it('small default pages within VK limits', () => {
    const caps: Record<string, number> = {
      vk_list_conversations: 200,
      vk_get_conversation_history: 200,
      vk_get_wall_posts: 100,
      vk_get_post_comments: 100,
      vk_list_photo_albums: 100,
      vk_list_market_products: 200,
    };
    for (const [name, max] of Object.entries(caps)) {
      expect(tool(name).parameters.properties!.count).toMatchObject({ default: 20, maximum: max });
    }
  });

  describe('errors inside HTTP 200 become failed calls', () => {
    const vkError = (code: number, msg: string) => ({ data: { error: { error_code: code, error_msg: msg, request_params: [{ key: 'v', value: '5.199' }] } } });
    it('has well-formed rules', () => expect(describeErrorWhenProblems(rules)).toEqual([]));
    it.each([
      [5, 'User authorization failed: invalid access_token (4).', 401],
      [15, 'Access denied: no access to call this method', 403],
      [27, 'Group authorization failed: method is unavailable with group auth.', 403],
      [901, "Can't send messages for users without permission", 403],
      [6, 'Too many requests per second', 429],
      [9, 'Flood control', 429],
      [100, 'One of the parameters specified was missing or invalid: peer_id is undefined', 400],
      [3, 'Unknown method passed', 400],
      [104, 'Not found', 404],
      [10, 'Internal server error', 502],
    ])('error %i -> status %i', async (code, msg, status) => {
      mockedAxios.mockResolvedValue(vkError(code, msg));
      const err = await run('vk_get_community', {}).catch((e) => e);
      expect(err).toBeInstanceOf(ResponseBodyError);
      expect((err as ResponseBodyError).status).toBe(status);
      expect((err as Error).message).toContain(msg);
    });
    it('a normal answer passes', async () => {
      mockedAxios.mockResolvedValue({ data: { response: { mask: 1, permissions: [{ name: 'manage', setting: 262144 }] } } });
      await expect(run('vk_get_token_permissions', {})).resolves.toEqual({ response: { mask: 1, permissions: [{ name: 'manage', setting: 262144 }] } });
    });
  });

  it('every tool has a valid responseMapping that selects', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${Boolean(tr && tr.select)}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${validateTransform(tr)}`).toBe(`${t.name}:null`);
    }
  });

  // Payloads shaped like VKCOM/vk-api-schema responses.json / objects.json for 5.199, trimmed.
  it('shapes community, permissions and conversations', () => {
    expect(shape('vk_get_token_permissions', { response: { mask: 274432, permissions: [{ name: 'manage', setting: 262144 }, { name: 'messages', setting: 4096 }] } }).value).toEqual({ mask: 274432, permissions: ['manage', 'messages'] });
    const g = shape('vk_get_community', { response: { groups: [{ id: 1, name: 'VK API', screen_name: 'apiclub', type: 'group', is_closed: 0, members_count: 1000, photo_50: 'x', photo_100: 'y', description: 'd' }], profiles: [] } }).value as any;
    expect(g.groups[0]).toEqual({ id: 1, name: 'VK API', screen_name: 'apiclub', type: 'group', is_closed: 0, members_count: 1000, description: 'd' });
    const c = shape('vk_list_conversations', {
      response: {
        count: 1, unread_count: 1,
        items: [{ conversation: { peer: { id: 5, type: 'user', local_id: 5 }, unread_count: 2, unanswered: true, can_write: { allowed: true }, push_settings: {} }, last_message: { id: 9, date: 1792000000, from_id: 5, out: 0, text: 'Добрый день', attachments: [], fwd_messages: [] } }],
        profiles: [{ id: 5, first_name: 'Анна', last_name: 'К.', photo_50: 'x', online: 1 }],
      },
    }).value as any;
    expect(c).toEqual({
      count: 1, unread_count: 1,
      items: [{ peer_id: 5, peer_type: 'user', unread_count: 2, unanswered: true, can_write: true, last_message_id: 9, last_message_date: 1792000000, last_message_from_id: 5, last_message_out: 0, last_message_text: 'Добрый день' }],
      profiles: [{ id: 5, first_name: 'Анна', last_name: 'К.' }],
    });
  });

  it('shapes history, wall posts, comments, stats and products', () => {
    const h = shape('vk_get_conversation_history', { response: { count: 1, items: [{ id: 9, conversation_message_id: 3, date: 1, from_id: 5, peer_id: 5, out: 0, text: 'Привет', attachments: [{ type: 'photo', photo: { sizes: [] } }], random_id: 0 }] } }).value as any;
    expect(h.items[0]).toEqual({ id: 9, conversation_message_id: 3, date: 1, from_id: 5, out: 0, text: 'Привет', attachment_types: ['photo'] });
    const w = shape('vk_get_wall_posts', { response: { count: 50, items: [{ id: 10, owner_id: -1, from_id: -1, date: 2, text: 'Пост', post_type: 'post', comments: { count: 3, can_post: 1 }, likes: { count: 7, user_likes: 0 }, reposts: { count: 1 }, views: { count: 900 }, attachments: [{ type: 'link', link: {} }], post_source: {} }] } }).value as any;
    expect(w).toEqual({ count: 50, items: [{ id: 10, owner_id: -1, from_id: -1, date: 2, text: 'Пост', post_type: 'post', comments: 3, likes: 7, reposts: 1, views: 900, attachment_types: ['link'] }] });
    const cm = shape('vk_get_post_comments', { response: { count: 1, items: [{ id: 20, from_id: 5, date: 3, text: 'Класс', thread: { count: 0, items: [] }, likes: { count: 2 } }], profiles: [{ id: 5, first_name: 'Анна', last_name: 'К.' }], groups: [{ id: 1, name: 'VK API', screen_name: 'apiclub' }] } }).value as any;
    expect(cm.items[0]).toEqual({ id: 20, from_id: 5, date: 3, text: 'Класс', thread_count: 0, likes: 2 });
    expect(cm.groups).toEqual([{ id: 1, name: 'VK API' }]);
    const s = shape('vk_get_community_stats', { response: [{ period_from: 1, period_to: 2, visitors: { views: 100, visitors: 40, mobile_views: 70, sex: [], age: [] }, reach: { reach: 300, reach_subscribers: 120, mobile_reach: 200, cities: [] }, activity: { likes: 5, comments: 1 } }] }).value as any;
    expect(s.periods[0]).toEqual({ period_from: 1, period_to: 2, views: 100, visitors: 40, mobile_views: 70, reach: 300, reach_subscribers: 120, mobile_reach: 200, activity: { likes: 5, comments: 1 } });
    const m = shape('vk_list_market_products', { response: { count: 1, items: [{ id: 3, title: 'Кружка', description: 'd', price: { amount: '99000', currency: { id: 643, name: 'RUB' }, text: '990 ₽' }, availability: 0, category: { id: 1, name: 'Посуда' }, thumb_photo: 'x', date: 4 }] } }).value as any;
    expect(m.items[0]).toEqual({ id: 3, title: 'Кружка', price: '990 ₽', price_amount: '99000', currency: 'RUB', availability: 0, category: 'Посуда', date: 4 });
    expect(shape('vk_send_message', { response: 777 }).value).toEqual({ message_id: 777 });
    expect(shape('vk_publish_post', { response: { post_id: 11 } }).value).toEqual({ post_id: 11 });
  });

  it('only points the model at tools that exist and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bvk_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bvk_[a-z_]+/g)])].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## VK (VKontakte)\n')).toBe(true);
    expect(a.instructions).toContain('**Out of scope**');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_VK_LIVE === '1' ? describe : describe.skip;
const liveCommunity = process.env.RUN_VK_LIVE === '1' && process.env.VK_COMMUNITY_TOKEN ? describe : describe.skip;
const liveUser =
  process.env.RUN_VK_LIVE === '1' && process.env.VK_USER_TOKEN && process.env.VK_TEST_DOMAIN && process.env.VK_TEST_COMMUNITY_ID ? describe : describe.skip;
const liveWrites =
  process.env.RUN_VK_LIVE === '1' && process.env.RUN_VK_LIVE_WRITES === '1' && process.env.VK_COMMUNITY_TOKEN && process.env.VK_TEST_PEER_ID ? describe : describe.skip;

live('vk adapter: live method names with a made-up key', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  beforeEach(() => {
    env = { VK_COMMUNITY_TOKEN: 'vk1.a.made-up-community-key', VK_USER_TOKEN: 'vk1.a.made-up-user-key' };
  });

  it.each(TABLE)('%s: %s exists (error 5, not 3) and fails as 401', async (name, params) => {
    const err = await run(name, params).catch((e) => e);
    expect(err).toBeInstanceOf(ResponseBodyError);
    expect((err as ResponseBodyError).status).toBe(401);
    expect((err as ResponseBodyError).responseBody).toMatchObject({ error: { error_code: 5 } });
  }, 30_000);

  it('an unknown method is error 3', async () => {
    const res = await mockedAxios.__actual.get(`${BASE}/no.suchMethod?v=5.199`, { headers: { Authorization: 'Bearer x' } });
    expect(res.data.error.error_code).toBe(3);
  }, 30_000);
});

liveCommunity('vk adapter: live community key', () => {
  beforeAll(() => {
    env = { VK_COMMUNITY_TOKEN: process.env.VK_COMMUNITY_TOKEN! };
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('reads the key rights, the community and its conversations', async () => {
    const perms = await runShaped('vk_get_token_permissions', {});
    expect(Array.isArray(perms.permissions)).toBe(true);
    const c = await runShaped('vk_get_community', {});
    expect(typeof c.groups[0].id).toBe('number');
    if (perms.permissions.includes('messages')) {
      const conv = await runShaped('vk_list_conversations', {});
      expect(typeof conv.count).toBe('number');
      if (conv.items.length) {
        const hist = await runShaped('vk_get_conversation_history', { peer_id: conv.items[0].peer_id, count: 5 });
        expect(hist.items.length).toBeLessThanOrEqual(5);
      }
    }
  }, 60_000);

  it('wall.get with the community key is refused as error 27 (why VK_USER_TOKEN exists)', async () => {
    const res = await mockedAxios.__actual.get(`${BASE}/wall.get?v=5.199&domain=apiclub&count=1`, { headers: { Authorization: `Bearer ${process.env.VK_COMMUNITY_TOKEN}` } });
    expect(res.data.error?.error_code).toBe(27);
  }, 30_000);
});

liveUser('vk adapter: live user or service key', () => {
  beforeAll(() => {
    env = { VK_COMMUNITY_TOKEN: process.env.VK_COMMUNITY_TOKEN ?? 'unused', VK_USER_TOKEN: process.env.VK_USER_TOKEN! };
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('reads wall posts, their comments and the photo albums', async () => {
    const id = Number(process.env.VK_TEST_COMMUNITY_ID);
    const wall = await runShaped('vk_get_wall_posts', { domain: process.env.VK_TEST_DOMAIN, count: 3 });
    expect(wall.items.length).toBeLessThanOrEqual(3);
    if (wall.items.length) {
      const comments = await runShaped('vk_get_post_comments', { community_id: id, post_id: wall.items[0].id, count: 5 });
      expect(typeof comments.count).toBe('number');
    }
    const albums = await runShaped('vk_list_photo_albums', { community_id: id });
    expect(typeof albums.count).toBe('number');
  }, 60_000);
});

liveWrites('vk adapter: live write (one message to VK_TEST_PEER_ID)', () => {
  beforeAll(() => {
    env = { VK_COMMUNITY_TOKEN: process.env.VK_COMMUNITY_TOKEN! };
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('sends a test message from the community', async () => {
    const out = await runShaped('vk_send_message', {
      peer_id: Number(process.env.VK_TEST_PEER_ID),
      message: 'AnythingMCP test message',
      random_id: Math.floor(Math.random() * 2_000_000_000) + 1,
    });
    expect(typeof out.message_id).toBe('number');
  }, 30_000);
});
