import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as adapter from './pancake.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';

/**
 * Two layers of verification for the Pancake adapter (pages.fm public API):
 *
 *   1. Static: always runs. Pins the page access token as the
 *      page_access_token query parameter added by QUERY_AUTH, the page id
 *      taken from PANCAKE_PAGE_ID, every tool's method, URL, query and body
 *      through the real RestEngine, which tools write and which are switched
 *      off, the errors Pancake reports inside HTTP 200, and the response
 *      shaping. Checked on 18 Oct 2026 against Pancake's OpenAPI document
 *      (developer.pancake.biz/openapi/openapi.yaml): conversations are listed
 *      on public_api/v2, everything else on public_api/v1.
 *
 *   2. Live: skipped unless RUN_PANCAKE_LIVE=1. It checks that the routes
 *      exist: a made-up token gets Pancake's JSON "Invalid access_token"
 *      (error 102) while a made-up route gets the web app's HTML page. With
 *      PANCAKE_PAGE_ID and PANCAKE_PAGE_ACCESS_TOKEN it also runs the reads on
 *      that page. Nothing is ever written or sent:
 *
 *        RUN_PANCAKE_LIVE=1 PANCAKE_PAGE_ID=... PANCAKE_PAGE_ACCESS_TOKEN=... npx jest src/adapters/intl/pancake.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  aliases: string[];
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const HOST = 'https://pages.fm/api';
const PAGE = '256469571178082';
// Built at run time so no literal looks like a real credential.
const fakeToken = () => ['amcp', Math.random().toString(36).slice(2, 12), Math.random().toString(36).slice(2, 12), 'test'].join('');
const FAKE_TOKEN = fakeToken();
const ENV: Record<string, string> = { PANCAKE_PAGE_ID: PAGE, PANCAKE_PAGE_ACCESS_TOKEN: FAKE_TOKEN };

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
      errorWhen: a.connector.config.errorWhen,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const query = () =>
  Object.fromEntries(
    Object.entries((sent().params ?? {}) as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const V1 = `/public_api/v1/pages/${PAGE}`;
const CONV = '256469571178082_5460527857372996';
const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['pancake_list_conversations', {}, 'GET', `/public_api/v2/pages/${PAGE}/conversations`],
  ['pancake_get_messages', { conversation_id: CONV }, 'GET', `${V1}/conversations/${CONV}/messages`],
  ['pancake_tag_conversation', { conversation_id: CONV, action: 'add', tag_id: '3' }, 'POST', `${V1}/conversations/${CONV}/tags`],
  ['pancake_assign_conversation', { conversation_id: CONV, assignee_ids: ['c4bafd84-7b96-4f28-b59a-031f17c32ddf'] }, 'POST', `${V1}/conversations/${CONV}/assign`],
  ['pancake_mark_conversation_read', { conversation_id: CONV }, 'POST', `${V1}/conversations/${CONV}/read`],
  ['pancake_mark_conversation_unread', { conversation_id: CONV }, 'POST', `${V1}/conversations/${CONV}/unread`],
  ['pancake_send_message', { conversation_id: CONV, message: 'Hello' }, 'POST', `${V1}/conversations/${CONV}/messages`],
  ['pancake_reply_comment', { conversation_id: CONV, message_id: 'm1', message: 'Thanks' }, 'POST', `${V1}/conversations/${CONV}/messages`],
  ['pancake_send_private_reply', { conversation_id: CONV, post_id: 'p1', message_id: 'm1', from_id: 'f1', message: 'Hi' }, 'POST', `${V1}/conversations/${CONV}/messages`],
  ['pancake_list_tags', {}, 'GET', `${V1}/tags`],
  ['pancake_list_staff', {}, 'GET', `${V1}/users`],
  ['pancake_list_customers', { since: 1759276800, until: 1760745600 }, 'GET', `${V1}/page_customers`],
  ['pancake_update_customer', { page_customer_id: 'b8f1c9e0-0000-4000-8000-000000000001', name: 'Lan' }, 'PUT', `${V1}/page_customers/b8f1c9e0-0000-4000-8000-000000000001`],
  ['pancake_add_customer_note', { page_customer_id: 'b8f1c9e0-0000-4000-8000-000000000001', message: 'Wants size M' }, 'POST', `${V1}/page_customers/b8f1c9e0-0000-4000-8000-000000000001/notes`],
  ['pancake_list_posts', { since: 1759276800, until: 1760745600 }, 'GET', `${V1}/posts`],
  ['pancake_page_statistics', { since: 1759276800, until: 1760745600 }, 'GET', `${V1}/statistics/pages`],
  ['pancake_staff_statistics', { date_range: '01/10/2026 00:00:00 - 07/10/2026 23:59:59' }, 'GET', `${V1}/statistics/users`],
  ['pancake_tag_statistics', { since: 1759276800, until: 1760745600 }, 'GET', `${V1}/statistics/tags`],
];
const SENDS = ['pancake_send_message', 'pancake_reply_comment', 'pancake_send_private_reply'];
const CONFIRM = ['pancake_update_customer', ...SENDS];
const INBOX_WRITES = [
  'pancake_tag_conversation',
  'pancake_assign_conversation',
  'pancake_mark_conversation_read',
  'pancake_mark_conversation_unread',
  'pancake_add_customer_note',
];

describe('pancake adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed in messaging with its own logo and search aliases', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('messaging');
    expect(a.icon).toBe('pancake');
    expect(a.aliases).toEqual(expect.arrayContaining(['pages.fm', 'Pancake Chat']));
    for (const alias of a.aliases) expect(alias.length).toBeLessThanOrEqual(40);
  });

  it('sends the page token as page_access_token to pages.fm and checks it on the tag list', () => {
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ page_access_token: '{{PANCAKE_PAGE_ACCESS_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/public_api/v1/pages/{{PANCAKE_PAGE_ID}}/tags');
    expect(a.probe).toEqual({ tool: 'pancake_list_tags', params: {} });
    expect(a.requiredEnvVars).toEqual(['PANCAKE_PAGE_ID', 'PANCAKE_PAGE_ACCESS_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.PANCAKE_PAGE_ACCESS_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.PANCAKE_PAGE_ID).toMatchObject({ kind: 'setting', secret: false, required: true });
    const token = new RegExp(a.envVarMeta.PANCAKE_PAGE_ACCESS_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', 'short', `page_access_token=${FAKE_TOKEN}`, `${FAKE_TOKEN} x`]) expect(token.test(bad)).toBe(false);
    const page = new RegExp(a.envVarMeta.PANCAKE_PAGE_ID.pattern!);
    for (const good of [PAGE, 'waba_102952029333366']) expect(page.test(good)).toBe(true);
    for (const bad of ['', 'https://pages.fm/256469571178082', '256 469']) expect(page.test(bad)).toBe(false);
    for (const key of ['401', '403', '429']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool with pancake_ and shares no tool name with another adapter file', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^pancake_[a-z_]+$/);
    const root = path.join(__dirname, '..');
    for (const region of fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory())) {
      for (const file of fs.readdirSync(path.join(root, region)).filter((f) => f.endsWith('.json') && f !== 'pancake.json')) {
        const other = JSON.parse(fs.readFileSync(path.join(root, region, file), 'utf8'));
        for (const t of other.tools ?? []) expect(`${file}:${mine.has(t.name)}`).toBe(`${file}:false`);
      }
    }
  });

  it('installs the three tools that write to the customer switched off and marks the reads read-only', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(SENDS);
    for (const name of CONFIRM) expect(tool(name).description).toMatch(/confirm with the user first/);
    for (const name of SENDS) expect(tool(name).description).toMatch(/Installed switched off\./);
    for (const name of [...CONFIRM, ...INBOX_WRITES]) expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
    for (const t of a.tools.filter((x) => ![...CONFIRM, ...INBOX_WRITES].includes(x.name))) {
      expect(`${t.name}:${t.endpointMapping.method}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:GET:true`);
      expect(t.description).toMatch(/Read-only\./);
    }
  });

  it('explains setup, ids, times and confirmations, names only real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bpancake_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bpancake_[a-z_]+/g)]),
      ...a.tools.flatMap((t) => Object.values(t.parameters.properties ?? {}).flatMap((p) => [...String(p.description).matchAll(/\bpancake_[a-z_]+/g)])),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/Writes need a yes/);
    expect(a.instructions).toMatch(/Settings, Tools/);
    expect(a.instructions).toMatch(/seconds/);
    expect(a.instructions).toMatch(/page's own time zone/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
  });

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the page token in the query', async (name, params, method, p) => {
    mockedAxios.mockResolvedValue({ data: { success: true } });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${p}`);
    expect(query().page_access_token).toBe(FAKE_TOKEN);
    expect(req.headers.Authorization).toBeUndefined();
  });

  it('builds the tag, assign, note, customer and message bodies with Pancake field names', async () => {
    mockedAxios.mockResolvedValue({ data: { success: true } });
    await call('pancake_tag_conversation', { conversation_id: CONV, action: 'remove', tag_id: '7' });
    expect(sent().data).toEqual({ action: 'remove', tag_id: '7' });
    mockedAxios.mockClear();
    await call('pancake_assign_conversation', { conversation_id: CONV, assignee_ids: ['u1', 'u2'] });
    expect(sent().data).toEqual({ assignee_ids: ['u1', 'u2'] });
    mockedAxios.mockClear();
    await call('pancake_add_customer_note', { page_customer_id: 'c1', message: 'Call back Monday' });
    expect(sent().data).toEqual({ message: 'Call back Monday' });
    mockedAxios.mockClear();
    await call('pancake_update_customer', { page_customer_id: 'c1', gender: 'female', phone_numbers: ['0901234567'] });
    expect(sent().data).toEqual({ changes: { gender: 'female', phone_numbers: ['0901234567'] } });
    mockedAxios.mockClear();
    await call('pancake_send_message', { conversation_id: CONV, message: 'Hello', reply_message_id: 'm9' });
    expect(sent().data).toEqual({ action: 'reply_inbox', message: 'Hello', reply_message_id: 'm9' });
    mockedAxios.mockClear();
    await call('pancake_reply_comment', { conversation_id: CONV, message_id: 'm1', message: 'Thanks' });
    expect(sent().data).toEqual({ action: 'reply_comment', message_id: 'm1', message: 'Thanks' });
    mockedAxios.mockClear();
    await call('pancake_send_private_reply', { conversation_id: CONV, post_id: 'p1', message_id: 'm1', from_id: 'f1', message: 'Hi' });
    expect(sent().data).toEqual({ action: 'private_replies', post_id: 'p1', message_id: 'm1', from_id: 'f1', message: 'Hi' });
  });

  it('maps list filters and the documented defaults to Pancake query names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('pancake_list_conversations', { tags: '3,7', type: 'INBOX', since: 1759276800, until: 1760745600, unread_first: true, order_by: 'updated_at', last_conversation_id: CONV });
    expect(query()).toEqual({
      page_access_token: FAKE_TOKEN,
      tags: '3,7',
      type: 'INBOX',
      since: '1759276800',
      until: '1760745600',
      unread_first: 'true',
      order_by: 'updated_at',
      last_conversation_id: CONV,
    });
    mockedAxios.mockClear();
    await call('pancake_list_customers', { since: 1, until: 2 });
    expect(query()).toEqual({ page_access_token: FAKE_TOKEN, since: '1', until: '2', page_number: '1', page_size: '50' });
    mockedAxios.mockClear();
    await call('pancake_list_posts', { since: 1, until: 2, type: 'video' });
    expect(query()).toEqual({ page_access_token: FAKE_TOKEN, since: '1', until: '2', page_number: '1', page_size: '30', type: 'video' });
    mockedAxios.mockClear();
    await call('pancake_staff_statistics', { date_range: '01/10/2026 00:00:00 - 07/10/2026 23:59:59' });
    expect(query()).toEqual({ page_access_token: FAKE_TOKEN, date_range: '01/10/2026 00:00:00 - 07/10/2026 23:59:59' });
    mockedAxios.mockClear();
    await call('pancake_get_messages', { conversation_id: CONV, current_count: 30 });
    expect(query()).toEqual({ page_access_token: FAKE_TOKEN, current_count: '30' });
  });

  it('turns the errors Pancake reports inside HTTP 200 into failures', async () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    mockedAxios.mockResolvedValue({ data: { message: 'Invalid access_token', success: false, error_code: 102 } });
    await expect(call('pancake_list_tags', {})).rejects.toMatchObject({ message: expect.stringMatching(/Invalid access_token/) });
    mockedAxios.mockResolvedValue({ data: { success: false, message_code: 'invalid_upload_fb_attachments_result' } });
    await expect(call('pancake_send_message', { conversation_id: CONV, message: 'x' })).rejects.toMatchObject({
      message: expect.stringMatching(/invalid_upload_fb_attachments_result/),
    });
    mockedAxios.mockResolvedValue({ data: { tags: [{ id: 1, text: 'VIP', color: '#4b5577' }] } });
    await expect(call('pancake_list_tags', {})).resolves.toBeDefined();
  });

  it('shapes conversations, messages and staff to the fields the inbox needs', () => {
    // One conversation as the real API returns it: 24 keys, with histories, ads and the page customer.
    const raw = {
      id: CONV,
      type: 'INBOX',
      page_id: PAGE,
      post_id: null,
      snippet: 'Con size M khong shop?',
      seen: false,
      message_count: 4,
      has_phone: true,
      inserted_at: '2026-10-16T02:00:00',
      updated_at: '2026-10-17T03:00:00',
      from: { id: '5460527857372996', name: 'Lan Nguyen', email: null },
      last_sent_by: { id: 'p', name: 'Shop', admin_name: 'Anh' },
      tags: [3],
      tag_histories: [{ tag: 3, inserted_at: '2026-10-16T02:00:00' }],
      assignee_ids: ['u1'],
      assignee_group_id: null,
      current_assign_users: [{ id: 'u1' }],
      assignee_histories: [{ user: 'u1' }],
      customer_id: 'cust-1',
      customers: [{ id: 'cust-1', name: 'Lan Nguyen' }],
      recent_phone_numbers: [{ phone_number: '0901234567' }],
      ad_ids: ['120200000000000001'],
      ads: [{ id: '120200000000000001', name: 'October sale' }],
      page_customer: { id: 'pc-1', name: 'Lan Nguyen', notes: [{ id: 'n1' }], recent_orders: [] },
    };
    expect(Object.keys(raw)).toHaveLength(24);
    const conversations = shape('pancake_list_conversations', { success: true, conversations: [raw] });
    expect(conversations).toEqual({
      success: true,
      conversations: [
        {
          id: CONV,
          type: 'INBOX',
          tags: [3],
          seen: false,
          from: { id: '5460527857372996', name: 'Lan Nguyen', email: null },
          snippet: 'Con size M khong shop?',
          inserted_at: '2026-10-16T02:00:00',
          updated_at: '2026-10-17T03:00:00',
          message_count: 4,
          assignee_ids: ['u1'],
          customer_id: 'cust-1',
          last_sent_by: { id: 'p', name: 'Shop', admin_name: 'Anh' },
          has_phone: true,
          recent_phone_numbers: [{ phone_number: '0901234567' }],
          post_id: null,
        },
      ],
    });
    // A full page of 60 stays well under the cap instead of the 199 KB the API sends.
    const page = shape('pancake_list_conversations', { success: true, conversations: Array.from({ length: 60 }, () => raw) });
    expect(page.conversations).toHaveLength(60);
    expect(JSON.stringify(page).length).toBeLessThan(tool('pancake_list_conversations').responseMapping!.transform.maxBytes);
    expect(tool('pancake_list_conversations').description).toMatch(/pancake_get_messages/);
    const messages = shape('pancake_get_messages', {
      success: true,
      conversation_id: CONV,
      messages: [
        { id: 'm1', type: 'INBOX', message: '<div>Hi</div>', original_message: 'Hi', from: { id: 'f1', name: 'Lan Nguyen' }, inserted_at: '2026-10-17T03:00:00', seen: true, is_removed: false, attachments: [], can_like: true },
      ],
      customers: [{ id: 'c1', name: 'Lan Nguyen', recent_phone_numbers: [{ phone_number: '0901234567' }], order_count: 2, personal_info: { job: 'x' } }],
      notes: [{ id: 'n1' }],
    });
    expect(messages).toEqual({
      conversationId: CONV,
      messages: [{ id: 'm1', type: 'INBOX', text: 'Hi', fromId: 'f1', fromName: 'Lan Nguyen', insertedAt: '2026-10-17T03:00:00', seen: true, isRemoved: false, attachments: [] }],
      customers: [{ id: 'c1', name: 'Lan Nguyen', phones: [{ phone_number: '0901234567' }], orderCount: 2 }],
    });
    const staff = shape('pancake_list_staff', {
      success: true,
      users: [{ id: 'u1', name: 'Anh', status: 'available', fb_id: '1', page_permissions: { permissions: [100] }, status_in_page: 'active', is_online: true }],
      disabled_users: [{ id: 'u9' }],
      round_robin_users: { inbox: ['u1'], comment: [] },
    });
    expect(staff).toEqual({ users: [{ id: 'u1', name: 'Anh', status: 'available', isOnline: true, statusInPage: 'active' }], roundRobinUsers: { inbox: ['u1'], comment: [] } });
  });
});

const live = process.env.RUN_PANCAKE_LIVE === '1' ? describe : describe.skip;
live('pancake adapter: live', () => {
  const real = !!process.env.PANCAKE_PAGE_ACCESS_TOKEN && !!process.env.PANCAKE_PAGE_ID;
  const env = () => ({ PANCAKE_PAGE_ID: process.env.PANCAKE_PAGE_ID!, PANCAKE_PAGE_ACCESS_TOKEN: process.env.PANCAKE_PAGE_ACCESS_TOKEN! });
  const run = async (name: string, params: Record<string, unknown> = {}) => {
    await sleep(300); // 5 requests per second per page
    return shape(name, await call(name, params, env()));
  };
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  // Reads only: a made-up token never reaches a write, but keep it that way.
  const probes = table.filter(([name]) => !SENDS.includes(name) && tool(name).endpointMapping.method === 'GET');
  it.each(probes)('%s reaches a real route and is refused with a made-up token (error 102)', async (name, params) => {
    await sleep(500);
    await expect(call(name, params, { PANCAKE_PAGE_ID: '123', PANCAKE_PAGE_ACCESS_TOKEN: fakeToken() })).rejects.toMatchObject({
      message: expect.stringMatching(/Invalid access_token/),
    });
  }, 30000);

  it('answers a made-up route with the web app instead of JSON, which makes the 102s above meaningful', async () => {
    const res = await (mockedAxios.__actual as any).request({
      method: 'GET',
      url: `${HOST}/public_api/v1/pages/123/no_such_route`,
      params: { page_access_token: fakeToken() },
      validateStatus: () => true,
    });
    expect(String(res.headers['content-type'])).toMatch(/text\/html/);
  }, 30000);

  (real ? it : it.skip)('runs the reads on the page', async () => {
    const tags = await run('pancake_list_tags');
    expect(Array.isArray(tags.tags)).toBe(true);
    const staff = await run('pancake_list_staff');
    expect(Array.isArray(staff.users)).toBe(true);
    const list = await run('pancake_list_conversations');
    expect(Array.isArray(list.conversations)).toBe(true);
    if (list.conversations[0]) {
      const msgs = await run('pancake_get_messages', { conversation_id: list.conversations[0].id });
      expect(Array.isArray(msgs.messages)).toBe(true);
    }
    const until = Math.floor(Date.now() / 1000);
    const since = until - 7 * 86400;
    await run('pancake_list_customers', { since, until, page_size: 5 });
    await run('pancake_list_posts', { since, until, page_size: 5 });
    await run('pancake_page_statistics', { since, until });
    await run('pancake_tag_statistics', { since, until });
    const fmt = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    await run('pancake_staff_statistics', { date_range: `${fmt(new Date(since * 1000))} 00:00:00 - ${fmt(new Date())} 23:59:59` });
  }, 120000);
});
