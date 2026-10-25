import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './avito.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Avito adapter:
 *
 *   1. Static: always runs. Pins the client-credentials token request
 *      (client_id and client_secret as form fields at api.avito.ru/token, as
 *      Avito's auth docs show), every tool's method, URL, query and body
 *      through the real RestEngine, checked against Avito's published OpenAPI
 *      files (developers.avito.ru/web/1/openapi/info/{user,item,autoload,
 *      messenger,auth}, read 18 Oct 2026 from a mirror because the portal
 *      refuses non-Russian IPs). Also that the writes which reach buyers or
 *      change autoload ship switched off, that read-only POSTs are marked
 *      read-only, and that the response mappings keep the fields that matter.
 *
 *   2. Live: skipped unless RUN_AVITO_LIVE=1. Without credentials it checks
 *      that api.avito.ru knows every route (JSON 401/403 for a made-up token,
 *      where a made-up route answers 404 "no Route matched") and that the
 *      token endpoint refuses made-up client credentials. With
 *      AVITO_CLIENT_ID and AVITO_CLIENT_SECRET it gets a token and reads the
 *      account, its ads, the autoload profile and uploads, and the chats.
 *      Nothing is ever written by this spec.
 *
 *        RUN_AVITO_LIVE=1 [AVITO_CLIENT_ID=... AVITO_CLIENT_SECRET=...] \
 *          npx jest src/adapters/intl/avito.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; maximum?: number; maxLength?: number; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  region: string;
  category: string;
  icon: string;
  aliases: string[];
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.avito.ru';
const ENV: Record<string, string> = { AVITO_CLIENT_ID: 'amcp-client-id', AVITO_CLIENT_SECRET: 'amcp-client-secret' };
const FAKE_TOKEN = 'amcp0'.repeat(8);

// Mirrors DynamicMcpTools: {{VAR}} interpolated, schema defaults applied, and
// the OAuth2 token supplied by the token service (stubbed here).
const run = (mapping: Tool['endpointMapping'], params: Record<string, unknown>, opts: { token?: string; schema?: Tool['parameters'] } = {}) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, mapping, ENV);
  return new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue(opts.token ?? FAKE_TOKEN) } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  ).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: config.headers } as any,
    endpointMapping,
    applySchemaDefaults((opts.schema ?? {}) as any, params),
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>, opts: { token?: string } = {}) =>
  run(tool(name).endpointMapping, params, { ...opts, schema: tool(name).parameters });
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

const OFF = ['avito_mark_chat_read', 'avito_send_message', 'avito_start_autoload_upload', 'avito_update_autoload_profile'];
const WRITES = [...OFF, 'avito_update_item_price'];
const READ_POSTS = ['avito_get_calls_stats', 'avito_get_item_stats', 'avito_get_operations_history'];

describe('avito adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed under e-commerce in intl, with Russian aliases', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('avito');
    expect(a.aliases).toContain('Авито');
  });

  it('gets its token with the client-credentials grant, client id and secret as form fields', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{AVITO_CLIENT_ID}}',
      clientSecret: '{{AVITO_CLIENT_SECRET}}',
      tokenUrl: `${BASE}/token`,
      tokenAuthMethod: 'client_secret_post',
    });
    expect(a.connector.healthcheckPath).toBe('/core/v1/accounts/self');
    expect(a.probe).toEqual({ tool: 'avito_get_self' });
    expect(tool('avito_get_self').parameters.required).toBeUndefined();
  });

  it('posts grant_type, client_id and client_secret to /token and no Basic header', async () => {
    const service = new OAuth2TokenService({} as PrismaService, { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService);
    const post = jest.spyOn(mockedAxios as any, 'post').mockResolvedValue({ data: { access_token: FAKE_TOKEN, expires_in: 86400, token_type: 'Bearer' } });
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).resolves.toBe(FAKE_TOKEN);
    const [url, body, options] = post.mock.calls[0] as unknown as [string, string, { headers: Record<string, string> }];
    expect(url).toBe(`${BASE}/token`);
    const form = new URLSearchParams(String(body));
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('amcp-client-id');
    expect(form.get('client_secret')).toBe('amcp-client-secret');
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    post.mockRestore();
  });

  it('describes both credentials, marks the secret as secret and explains the failures', () => {
    expect(a.requiredEnvVars).toEqual(['AVITO_CLIENT_ID', 'AVITO_CLIENT_SECRET']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.AVITO_CLIENT_ID).toMatchObject({ kind: 'credential', required: true });
    expect(meta.AVITO_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true, required: true });
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(JSON.stringify(adapter)).not.toMatch(/"client_secret":\s*"[^{$]/);
  });

  it('prefixes every tool with avito_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^avito_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('ships the writes that reach buyers or change autoload switched off, and keeps the price change on', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...OFF].sort());
    expect(tool('avito_update_item_price').enabled).toBeUndefined();
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    for (const name of OFF) {
      expect(tool(name).description).toMatch(/Switched off at install/);
      expect(tool(name).description).toMatch(/confirm/i);
      expect(a.instructions).toContain(`\`${name}\``);
    }
    expect(tool('avito_update_item_price').description).toMatch(/confirmation/);
    expect(annotationsOf(tool('avito_update_item_price'))).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(annotationsOf(tool('avito_update_autoload_profile'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsOf(tool('avito_send_message'))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(annotationsOf(tool('avito_mark_chat_read'))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    // Search-like POSTs that only read.
    for (const name of READ_POSTS) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(tool('avito_send_message').parameters.properties!.text.maxLength).toBe(1000);
  });

  it('says where user_id comes from, what needs a tariff, and writes no em dashes', () => {
    expect(a.instructions).toMatch(/\*\*user_id\*\*: call `avito_get_self` first/);
    for (const t of a.tools.filter((x) => x.parameters.properties?.user_id)) {
      expect(t.parameters.properties!.user_id.description).toMatch(/avito_get_self/);
      expect(t.parameters.required).toContain('user_id');
    }
    expect(a.instructions).toMatch(/Максимальный/);
    expect(a.instructions).toContain('https://www.avito.ru/professionals/api');
    expect(a.instructions).toMatch(/25 requests a minute, price changes 150 a minute/);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bavito_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bavito_[a-z_]+/g)]),
    ].map((m) => m[0]);
    // avito_id, avito_status and avito_date_end are response fields, not tools.
    for (const name of mentioned.filter((n) => !/^avito_(id|status|date_end)$/.test(n))) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      expect(t.description).not.toMatch(/[А-Яа-я]{6,}/); // English descriptions
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
      for (const p of t.endpointMapping.path.match(/\{(\w+)\}/g) ?? []) expect(t.parameters.required).toContain(p.slice(1, -1));
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool a valid response mapping, except the two writes Avito answers with an empty 200', () => {
    const empty = ['avito_start_autoload_upload', 'avito_update_autoload_profile'];
    for (const name of empty) expect(tool(name).responseMapping).toBeUndefined();
    for (const t of a.tools.filter((x) => !empty.includes(x.name))) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['avito_get_self', {}, 'GET', '/core/v1/accounts/self'],
    ['avito_get_balance', { user_id: 42 }, 'GET', '/core/v1/accounts/42/balance/'],
    ['avito_get_operations_history', { dateTimeFrom: '2026-10-01T00:00:00', dateTimeTo: '2026-10-07T00:00:00' }, 'POST', '/core/v1/accounts/operations_history/'],
    ['avito_list_items', {}, 'GET', '/core/v1/items'],
    ['avito_get_item', { user_id: 42, item_id: 7 }, 'GET', '/core/v1/accounts/42/items/7/'],
    ['avito_update_item_price', { item_id: 7, price: 15000 }, 'POST', '/core/v1/items/7/update_price'],
    ['avito_get_item_stats', { user_id: 42, itemIds: [7], dateFrom: '2026-10-01', dateTo: '2026-10-07' }, 'POST', '/stats/v1/accounts/42/items'],
    ['avito_get_calls_stats', { user_id: 42, dateFrom: '2026-10-01', dateTo: '2026-10-07' }, 'POST', '/core/v1/accounts/42/calls/stats/'],
    ['avito_get_autoload_profile', {}, 'GET', '/autoload/v2/profile'],
    ['avito_update_autoload_profile', { autoload_enabled: true, feeds_data: [{ feed_name: 'main', feed_url: 'https://shop.example/feed.xml' }], report_email: 'ops@shop.example', schedule: [{ rate: 100, time_slots: [9], weekdays: [0] }] }, 'POST', '/autoload/v2/profile'],
    ['avito_start_autoload_upload', {}, 'POST', '/autoload/v1/upload'],
    ['avito_list_autoload_uploads', {}, 'GET', '/autoload/v4/uploads'],
    ['avito_get_current_autoload_upload', {}, 'GET', '/autoload/v4/uploads/current'],
    ['avito_list_current_autoload_upload_items', {}, 'GET', '/autoload/v4/uploads/current/items'],
    ['avito_get_last_successful_autoload_upload', {}, 'GET', '/autoload/v4/uploads/last_successful'],
    ['avito_list_last_successful_autoload_upload_items', {}, 'GET', '/autoload/v4/uploads/last_successful/items'],
    ['avito_get_autoload_category_tree', {}, 'GET', '/autoload/v1/user-docs/tree'],
    ['avito_get_autoload_category_fields', { node_slug: 'odezhda' }, 'GET', '/autoload/v1/user-docs/node/odezhda/fields'],
    ['avito_get_feed_ids_by_avito_ids', { query: '2841234567' }, 'GET', '/autoload/v2/items/ad_ids'],
    ['avito_get_avito_ids_by_feed_ids', { query: 'sku-1' }, 'GET', '/autoload/v2/items/avito_ids'],
    ['avito_list_chats', { user_id: 42 }, 'GET', '/messenger/v2/accounts/42/chats'],
    ['avito_get_chat', { user_id: 42, chat_id: 'u2i-abc' }, 'GET', '/messenger/v2/accounts/42/chats/u2i-abc'],
    ['avito_list_messages', { user_id: 42, chat_id: 'u2i-abc' }, 'GET', '/messenger/v3/accounts/42/chats/u2i-abc/messages/'],
    ['avito_mark_chat_read', { user_id: 42, chat_id: 'u2i-abc' }, 'POST', '/messenger/v1/accounts/42/chats/u2i-abc/read'],
    ['avito_send_message', { user_id: 42, chat_id: 'u2i-abc', text: 'Hello' }, 'POST', '/messenger/v1/accounts/42/chats/u2i-abc/messages'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the documented URL with the OAuth2 token', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('lists active ads by default and passes the documented filters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('avito_list_items', {});
    expect(sent().params).toEqual({ per_page: 25, status: 'active' });
    mockedAxios.mockClear();
    await call('avito_list_items', { status: 'active,old', category: 9, updatedAtFrom: '2026-10-01', per_page: 50, page: 2 });
    expect(sent().params).toEqual({ per_page: 50, page: 2, status: 'active,old', updatedAtFrom: '2026-10-01', category: 9 });
    expect(sent().paramsSerializer(sent().params)).toBe('per_page=50&page=2&status=active,old&updatedAtFrom=2026-10-01&category=9');
  });

  it('sends exactly the documented bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const bodyOf = async (name: string, params: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await call(name, params);
      return sent().data;
    };
    expect(await bodyOf('avito_update_item_price', { item_id: 7, price: 15000 })).toEqual({ price: 15000 });
    expect(await bodyOf('avito_get_item_stats', { user_id: 42, itemIds: [7, 8], dateFrom: '2026-10-01', dateTo: '2026-10-07', periodGrouping: 'week' })).toEqual({
      itemIds: [7, 8], dateFrom: '2026-10-01', dateTo: '2026-10-07', fields: ['uniqViews', 'uniqContacts', 'uniqFavorites'], periodGrouping: 'week',
    });
    expect(await bodyOf('avito_get_calls_stats', { user_id: 42, dateFrom: '2026-10-01', dateTo: '2026-10-07' })).toEqual({ dateFrom: '2026-10-01', dateTo: '2026-10-07' });
    expect(await bodyOf('avito_get_operations_history', { dateTimeFrom: '2026-10-01T00:00:00', dateTimeTo: '2026-10-07T00:00:00' })).toEqual({
      dateTimeFrom: '2026-10-01T00:00:00', dateTimeTo: '2026-10-07T00:00:00',
    });
    expect(await bodyOf('avito_send_message', { user_id: 42, chat_id: 'u2i-abc', text: 'Добрый день!' })).toEqual({ message: { text: 'Добрый день!' }, type: 'text' });
    const profile = { autoload_enabled: false, feeds_data: [{ feed_name: 'main', feed_url: 'https://shop.example/feed.xml' }], report_email: 'ops@shop.example', schedule: [{ rate: 100, time_slots: [9, 10], weekdays: [0, 1] }] };
    expect(await bodyOf('avito_update_autoload_profile', profile)).toEqual(profile);
  });

  it('sends the documented chat filters and page sizes', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('avito_list_chats', { user_id: 42, unread_only: true, item_ids: '7,8', chat_types: 'u2i,u2u' });
    expect(sent().params).toEqual({ item_ids: '7,8', unread_only: true, chat_types: 'u2i,u2u', limit: 20 });
    mockedAxios.mockClear();
    await call('avito_list_messages', { user_id: 42, chat_id: 'u2i-abc', offset: 50 });
    expect(sent().params).toEqual({ limit: 50, offset: 50 });
    mockedAxios.mockClear();
    await call('avito_list_current_autoload_upload_items', { query: 'sku-1|sku-2', perPage: 100 });
    expect(sent().params).toEqual({ query: 'sku-1|sku-2', perPage: 100 });
    mockedAxios.mockClear();
    await call('avito_list_autoload_uploads', { dateFrom: '2026-10-01T00:00:00Z' });
    expect(sent().params).toEqual({ perPage: 10, dateFrom: '2026-10-01T00:00:00Z' });
  });

  it('accepts the documented id and status formats and refuses others', () => {
    const status = new RegExp(tool('avito_list_items').parameters.properties!.status.pattern!);
    for (const ok of ['active', 'active,old,removed', 'blocked,rejected']) expect(status.test(ok)).toBe(true);
    for (const bad of ['Active', 'active,', 'all', 'active;old']) expect(status.test(bad)).toBe(false);
    const ids = new RegExp(tool('avito_get_feed_ids_by_avito_ids').parameters.properties!.query.pattern!);
    for (const ok of ['2841234567', '1,2,3', '1|2']) expect(ids.test(ok)).toBe(true);
    for (const bad of ['abc', '1,,2', '']) expect(ids.test(bad)).toBe(false);
    const slug = new RegExp(tool('avito_get_autoload_category_fields').parameters.properties!.node_slug.pattern!);
    expect(slug.test('../../core/v1/accounts/self')).toBe(false);
    expect(tool('avito_list_items').parameters.properties!.per_page.maximum).toBe(99);
  });

  // Shapes taken from Avito's OpenAPI examples and from integrations that use the API.
  it('keeps the account id and drops the phone numbers', () => {
    const self = { id: 94235311, name: 'Петр', email: 'example@domain.com', phone: '71112223344', phones: ['71112223344'], profile_url: 'https://avito.ru/user/7d04/profile' };
    expect(shape('avito_get_self', self)).toEqual({ id: 94235311, name: 'Петр', email: 'example@domain.com', profile_url: 'https://avito.ru/user/7d04/profile' });
  });

  it('shapes ads, price result, stats and balance', () => {
    const items = {
      meta: { page: 1, per_page: 25 },
      resources: [{ address: 'Москва, Лесная улица 7', category: { id: 111, name: 'Вакансии' }, id: 24122231, price: 35000, status: 'active', title: 'Продавец-кассир', url: 'https://www.avito.ru/rostov-na-donu/vakansii/prodavets_magazina_2142', extra: 'x' }],
    };
    const { extra: _dropped, ...ad } = items.resources[0];
    expect(shape('avito_list_items', items)).toEqual({ meta: items.meta, resources: [ad] });
    expect(shape('avito_update_item_price', { result: { success: true } })).toEqual({ success: true });
    const stats = { result: { items: [{ itemId: 7, stats: [{ date: '2020-06-11', uniqContacts: 1, uniqFavorites: 0, uniqViews: 10 }] }] } };
    expect(shape('avito_get_item_stats', stats)).toEqual({ items: stats.result.items });
    expect(shape('avito_get_balance', { real: 1500.5, bonus: 200 })).toEqual({ real: 1500.5, bonus: 200 });
    const calls = { result: { items: [{ days: [{ answered: 0, calls: 0, date: '2020-04-01', new: 0, newAnswered: 0 }], employeeId: 0, itemId: 1853257996 }] } };
    expect(shape('avito_get_calls_stats', calls)).toEqual({ items: calls.result.items });
  });

  it('reads messages whether Avito wraps them in messages or not', () => {
    const msg = { id: 'm1', author_id: 94235311, created: 1571654040, direction: 'in', type: 'text', is_read: false, content: { text: 'Ещё продаёте?' }, quote: { content: { text: 'Цена?' } } };
    const want = [{ id: 'm1', author_id: 94235311, direction: 'in', type: 'text', created: 1571654040, is_read: false, read: null, content: { text: 'Ещё продаёте?' }, quote: 'Цена?' }];
    expect(shape('avito_list_messages', { messages: [msg], meta: {} })).toEqual(want);
    expect(shape('avito_list_messages', [msg])).toEqual(want);
  });

  it('flattens a chat list to what a reply needs', () => {
    const chats = {
      chats: [{
        id: 'u2i-abc', created: 1571654040, updated: 1571654100,
        context: { type: 'item', value: { id: 7, title: 'Велосипед', price_string: '15 000 ₽', url: 'https://avito.ru/7', status_id: 10, images: { main: { '140x105': 'x' } } } },
        last_message: { id: 'm1', author_id: 1, created: 1571654100, direction: 'in', type: 'text', content: { text: 'Здравствуйте' } },
        users: [{ id: 1, name: 'Иван', public_user_profile: { avatar: {}, url: 'https://avito.ru/user/1' } }],
      }],
    };
    expect(shape('avito_list_chats', chats)).toEqual([{
      id: 'u2i-abc', created: 1571654040, updated: 1571654100, context_type: 'item', item_id: 7, item_title: 'Велосипед', item_price: '15 000 ₽', item_url: 'https://avito.ru/7',
      users: [{ id: 1, name: 'Иван' }], last_message: { id: 'm1', author_id: 1, direction: 'in', type: 'text', created: 1571654100, text: 'Здравствуйте' },
    }]);
  });

  it('keeps upload reports and per-ad messages', () => {
    const upload = { upload_id: 5, status: 'success_warning', source: 'Url', started_at: '2026-10-01T09:00:00Z', feed_urls: [{ name: 'main', url: 'https://x/f.xml' }], events: [], stats: { count: 3, slug: 'all', title: 'Все', sections: [] } };
    expect(shape('avito_get_current_autoload_upload', upload)).toEqual(upload);
    const items = { items: [{ ad_id: 'sku-1', avito_id: 7, avito_status: 'active', url: 'https://avito.ru/7', feed_name: 'main', section: { slug: 'published', title: 'Опубликовано' }, messages: [{ code: 1, type: 'warning', title: 't', description: 'd', updated_at: '2026-10-01T09:00:00Z' }] }], meta: { page: 1, pages: 1, perPage: 20, total: 1 } };
    expect(shape('avito_list_last_successful_autoload_upload_items', items)).toEqual(items);
  });
});

const live = process.env.RUN_AVITO_LIVE === '1' ? describe : describe.skip;
live('avito adapter: live', () => {
  const real = !!(process.env.AVITO_CLIENT_ID && process.env.AVITO_CLIENT_SECRET);
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  // Reading routes only: nothing is written even with a made-up token.
  const reads = table_reads();
  it.each(reads)('%s reaches a known Avito route and is refused with a made-up token', async (name, params) => {
    const err = await call(name, params, { token: 'amcp-made-up-token' }).catch((e) => e);
    expect([401, 403]).toContain(err.response?.status);
    expect(err.response.data.result).toMatchObject({ status: false });
  }, 30000);

  it('answers 404 "no Route matched" on a made-up route', async () => {
    const err = await run({ method: 'GET', path: '/core/v1/amcp_no_such_route' }, {}, { token: 'amcp-made-up-token' }).catch((e) => e);
    expect(err.response.status).toBe(404);
    expect(err.response.data.message).toMatch(/no Route matched/);
  }, 30000);

  it('refuses made-up client credentials at the token endpoint (HTTP 200 with an OAuth error)', async () => {
    const res = await mockedAxios.__actual.post(`${BASE}/token`, 'grant_type=client_credentials&client_id=amcp_fake&client_secret=amcp_fake', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
    });
    expect(res.data.access_token).toBeUndefined();
    expect(res.data.error).toBeTruthy();
  }, 30000);

  (real ? it : it.skip)('reads the account, ads, autoload and chats with real credentials', async () => {
    const service = new OAuth2TokenService({} as PrismaService, { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService);
    const env = { AVITO_CLIENT_ID: process.env.AVITO_CLIENT_ID!, AVITO_CLIENT_SECRET: process.env.AVITO_CLIENT_SECRET! };
    const token = (await service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, env)))!;
    expect(token).toBeTruthy();
    const self = shape('avito_get_self', await call('avito_get_self', {}, { token }));
    expect(self.id).toBeGreaterThan(0);
    const items = shape('avito_list_items', await call('avito_list_items', { per_page: 5 }, { token }));
    expect(Array.isArray(items.resources)).toBe(true);
    expect(shape('avito_get_balance', await call('avito_get_balance', { user_id: self.id }, { token }))).toHaveProperty('real');
    await call('avito_get_autoload_profile', {}, { token }).catch((e) => expect([403, 404]).toContain(e.response?.status));
    await call('avito_list_chats', { user_id: self.id, limit: 3 }, { token }).catch((e) => expect(e.response?.status).toBe(403));
  }, 60000);
});

function table_reads(): Array<[string, Record<string, unknown>]> {
  return [
    ['avito_get_self', {}],
    ['avito_get_balance', { user_id: 1 }],
    ['avito_list_items', {}],
    ['avito_get_item', { user_id: 1, item_id: 1 }],
    ['avito_get_autoload_profile', {}],
    ['avito_list_autoload_uploads', {}],
    ['avito_get_last_successful_autoload_upload', {}],
    ['avito_get_autoload_category_tree', {}],
    ['avito_get_feed_ids_by_avito_ids', { query: '1' }],
    ['avito_list_chats', { user_id: 1 }],
  ];
}
