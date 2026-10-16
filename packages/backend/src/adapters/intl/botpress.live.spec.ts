import axios from 'axios';
import * as adapter from './botpress.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Botpress Cloud adapter:
 *
 *   1. Static: always runs. Pins the PAT Bearer auth with the x-workspace-id
 *      and x-bot-id headers (the way @botpress/client sets them), every
 *      tool's method, URL, query and body through the real RestEngine,
 *      checked against the OpenAPI document shipped in @botpress/api 1.129.0
 *      (src/gen/openapi.json, the source @botpress/client 2.8.0 is generated
 *      from): Admin API for workspaces, bots, logs, analytics and issues,
 *      Runtime API (/v1/chat) for conversations, messages, users and events,
 *      Tables API and Files API. Also the per-call bot override, the
 *      switched-off row delete and the response shaping.
 *
 *   2. Live: skipped unless RUN_BOTPRESS_LIVE=1. Without a token it checks
 *      that Botpress refuses a wrong token with 401 on every route and
 *      answers 404 outside the API's prefixes. Botpress authenticates before
 *      routing inside /v1/admin, /v1/chat, /v1/tables and /v1/files, so the
 *      401 alone does not prove a path exists there; the paths are proven by
 *      the OpenAPI document above. With BOTPRESS_TOKEN, BOTPRESS_WORKSPACE_ID
 *      and BOTPRESS_BOT_ID it reads workspaces, bots, conversations, tables
 *      and files. Row writes run only with RUN_BOTPRESS_LIVE_WRITE=1 and
 *      BOTPRESS_TEST_TABLE (a throwaway table): one row is added, updated
 *      and deleted again.
 *
 *        RUN_BOTPRESS_LIVE=1 BOTPRESS_TOKEN=bp_pat_... BOTPRESS_WORKSPACE_ID=wkspace_... \
 *          BOTPRESS_BOT_ID=... npx jest src/adapters/intl/botpress.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; headers?: Record<string, string>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
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

const BASE = 'https://api.botpress.cloud';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'bp_pat_' + 'x'.repeat(40);
const WORKSPACE = 'wkspace_01JWVP0X4KF1MNH0QK1B5KFD25';
const BOT = '00000000-0000-4000-8000-000000000000';
const ENV: Record<string, string> = { BOTPRESS_TOKEN: FAKE_TOKEN, BOTPRESS_WORKSPACE_ID: WORKSPACE, BOTPRESS_BOT_ID: BOT };

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
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const urlOf = (req: any) => (req.params && Object.keys(req.params).length ? `${req.url}?${new URLSearchParams(req.params).toString()}` : req.url);
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);

const WRITES = ['botpress_create_table_rows', 'botpress_delete_table_rows', 'botpress_update_table_rows'];
const ADMIN = ['botpress_get_bot', 'botpress_get_bot_analytics', 'botpress_get_bot_logs', 'botpress_list_bot_issues', 'botpress_list_bots', 'botpress_list_workspaces'];

describe('botpress adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor SDK and API spec on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('authenticates with a PAT as Bearer and sends the workspace and bot headers', () => {
    expect(a.category).toBe('support');
    expect(a.icon).toBe('botpress');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{BOTPRESS_TOKEN}}' });
    expect(a.connector.headers).toMatchObject({ 'x-workspace-id': '{{BOTPRESS_WORKSPACE_ID}}', 'x-bot-id': '{{BOTPRESS_BOT_ID}}' });
    expect(a.connector.healthcheckPath).toBe('/v1/admin/bots?pageSize=1');
    expect(a.requiredEnvVars).toEqual(['BOTPRESS_TOKEN', 'BOTPRESS_WORKSPACE_ID', 'BOTPRESS_BOT_ID']);
    const meta = describeAdapterEnvVars(a as never);
    expect(meta.find((m: any) => m.name === 'BOTPRESS_TOKEN')).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.find((m: any) => m.name === 'BOTPRESS_WORKSPACE_ID')).toMatchObject({ kind: 'setting', required: true });
    expect(meta.find((m: any) => m.name === 'BOTPRESS_BOT_ID')).toMatchObject({ kind: 'setting', required: true });
  });

  it('accepts the documented id formats and refuses pasted headers', () => {
    const pat = new RegExp(a.envVarMeta.BOTPRESS_TOKEN.pattern!);
    expect(pat.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, 'bp_bak_' + 'x'.repeat(40), `${FAKE_TOKEN} `]) expect(pat.test(bad)).toBe(false);
    const ws = new RegExp(a.envVarMeta.BOTPRESS_WORKSPACE_ID.pattern!);
    expect(ws.test(WORKSPACE)).toBe(true);
    expect(ws.test('01JWVP0X4KF1MNH0QK1B5KFD25')).toBe(false);
    const bot = new RegExp(a.envVarMeta.BOTPRESS_BOT_ID.pattern!);
    expect(bot.test('b6ddc57a-f17d-4c87-a19d-02ffcf677e47')).toBe(true);
    expect(bot.test(WORKSPACE)).toBe(false);
  });

  it('probes with a one-bot list and explains 401 as token or workspace', () => {
    expect(a.probe).toEqual({ tool: 'botpress_list_bots', params: { pageSize: 1 } });
    expect(a.verifyHints['401']).toMatch(/workspace/);
  });

  it('prefixes every tool with botpress_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^botpress_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks everything but the row writes read-only, asks to confirm writes and installs the delete switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(annotationsOf(tool('botpress_find_table_rows'))).toMatchObject({ readOnlyHint: true });
    expect(annotationsOf(tool('botpress_create_table_rows'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsOf(tool('botpress_update_table_rows'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsOf(tool('botpress_delete_table_rows'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const name of WRITES) expect(tool(name).description).toMatch(/[Cc]onfirm/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['botpress_delete_table_rows']);
    // Only ids: no filter and no deleteAllRows can reach the API.
    expect(Object.keys(tool('botpress_delete_table_rows').endpointMapping.bodyMapping!)).toEqual(['ids']);
  });

  it('lets every runtime, table and file tool switch bots per call, and every admin tool name its bot or workspace', () => {
    for (const t of a.tools) {
      if (ADMIN.includes(t.name)) continue;
      expect(`${t.name}:${t.endpointMapping.headers?.['x-bot-id']}`).toBe(`${t.name}:$bot_id`);
      expect(t.parameters.properties!.bot_id.description).toMatch(/configured bot/);
    }
    for (const name of ['botpress_get_bot', 'botpress_get_bot_logs', 'botpress_get_bot_analytics', 'botpress_list_bot_issues']) {
      expect(tool(name).parameters.required).toContain('bot_id');
      expect(tool(name).endpointMapping.path).toContain('{bot_id}');
    }
    expect(tool('botpress_list_bots').endpointMapping.headers).toEqual({ 'x-workspace-id': '$workspace_id' });
  });

  it('only points the model at tools that exist, explains the API choice and the ids, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bbotpress_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbotpress_[a-z_]+/g), ...JSON.stringify(t.parameters).matchAll(/\bbotpress_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    for (const part of ['Admin API', 'Runtime API', 'Tables API', 'Files API', 'Chat API', 'Personal Access Tokens', 'wkspace_']) {
      expect(a.instructions).toContain(part);
    }
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('carries valid response mappings, none of them a maxBytes-only no-op', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      if (!tr) continue;
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['botpress_list_workspaces', {}, 'GET', `${BASE}/v1/admin/workspaces?pageSize=20`],
    ['botpress_list_bots', { dev: true }, 'GET', `${BASE}/v1/admin/bots?dev=true&pageSize=20`],
    ['botpress_get_bot', { bot_id: 'b1' }, 'GET', `${BASE}/v1/admin/bots/b1`],
    ['botpress_get_bot_logs', { bot_id: 'b1', timeStart: '2026-10-14T00:00:00.000Z', level: 'error' }, 'GET', `${BASE}/v1/admin/bots/b1/logs?timeStart=2026-10-14T00%3A00%3A00.000Z&level=error`],
    ['botpress_get_bot_analytics', { bot_id: 'b1', startDate: '2026-10-01', endDate: '2026-10-14' }, 'GET', `${BASE}/v1/admin/bots/b1/analytics?startDate=2026-10-01&endDate=2026-10-14`],
    ['botpress_list_bot_issues', { bot_id: 'b1' }, 'GET', `${BASE}/v1/admin/bots/b1/issues?pageSize=20`],
    ['botpress_list_conversations', { integrationName: 'webchat' }, 'GET', `${BASE}/v1/chat/conversations?integrationName=webchat&pageSize=20`],
    ['botpress_get_conversation', { id: 'c1' }, 'GET', `${BASE}/v1/chat/conversations/c1`],
    ['botpress_list_messages', { conversationId: 'c1' }, 'GET', `${BASE}/v1/chat/messages?conversationId=c1&pageSize=50`],
    ['botpress_list_users', { conversationId: 'c1' }, 'GET', `${BASE}/v1/chat/users?conversationId=c1&pageSize=20`],
    ['botpress_get_user', { id: 'u1' }, 'GET', `${BASE}/v1/chat/users/u1`],
    ['botpress_list_events', { status: 'failed' }, 'GET', `${BASE}/v1/chat/events?status=failed&pageSize=20`],
    ['botpress_get_event', { id: 'e1' }, 'GET', `${BASE}/v1/chat/events/e1`],
    ['botpress_list_tables', {}, 'GET', `${BASE}/v1/tables`],
    ['botpress_get_table', { table: 'LeadsTable' }, 'GET', `${BASE}/v1/tables/LeadsTable`],
    ['botpress_find_table_rows', { table: 'LeadsTable' }, 'POST', `${BASE}/v1/tables/LeadsTable/rows/find`],
    ['botpress_create_table_rows', { table: 'LeadsTable', rows: [{ name: 'Ada' }] }, 'POST', `${BASE}/v1/tables/LeadsTable/rows`],
    ['botpress_update_table_rows', { table: 'LeadsTable', rows: [{ id: 1, name: 'Ada' }] }, 'PUT', `${BASE}/v1/tables/LeadsTable/rows`],
    ['botpress_delete_table_rows', { table: 'LeadsTable', ids: [1] }, 'POST', `${BASE}/v1/tables/LeadsTable/rows/delete`],
    ['botpress_list_files', {}, 'GET', `${BASE}/v1/files?pageSize=20`],
    ['botpress_search_files', { query: 'refund policy' }, 'GET', `${BASE}/v1/files/search?query=refund+policy&limit=5`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the PAT and both id headers', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(urlOf(req)).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req.headers['x-workspace-id']).toBe(WORKSPACE);
    expect(req.headers['x-bot-id']).toBe(BOT);
  });

  it('switches bot or workspace for one call when asked', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('botpress_list_conversations', { bot_id: 'other-bot' });
    expect(sent().headers['x-bot-id']).toBe('other-bot');
    mockedAxios.mockClear();
    await call('botpress_list_bots', { workspace_id: 'wkspace_OTHER0000000' });
    expect(sent().headers['x-workspace-id']).toBe('wkspace_OTHER0000000');
  });

  it('builds the table bodies with the field names of the Tables API', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('botpress_find_table_rows', { table: 'LeadsTable' });
    expect(sent().data).toEqual({ limit: 50 });
    mockedAxios.mockClear();
    await call('botpress_find_table_rows', {
      table: 'LeadsTable',
      filter: { status: { $eq: 'open' } },
      search: 'acme',
      select: ['name'],
      group: { status: 'key' },
      orderBy: 'createdAt',
      orderDirection: 'desc',
      limit: 10,
      offset: 20,
    });
    expect(sent().data).toEqual({
      filter: { status: { $eq: 'open' } },
      search: 'acme',
      select: ['name'],
      group: { status: 'key' },
      orderBy: 'createdAt',
      orderDirection: 'desc',
      limit: 10,
      offset: 20,
    });
    mockedAxios.mockClear();
    await call('botpress_create_table_rows', { table: 'LeadsTable', rows: [{ name: 'Ada' }], waitComputed: true });
    expect(sent().data).toEqual({ rows: [{ name: 'Ada' }], waitComputed: true });
    mockedAxios.mockClear();
    await call('botpress_update_table_rows', { table: 'LeadsTable', rows: [{ id: 3, name: 'Ada' }] });
    expect(sent().data).toEqual({ rows: [{ id: 3, name: 'Ada' }] });
    mockedAxios.mockClear();
    await call('botpress_delete_table_rows', { table: 'LeadsTable', ids: [3, 4] });
    expect(sent().data).toEqual({ ids: [3, 4] });
  });

  it('keeps the bot overview free of integration configuration and secrets', () => {
    const raw = {
      bot: {
        id: 'b1',
        name: 'Support bot',
        description: 'FAQ',
        status: 'active',
        type: 'studio',
        dev: false,
        alwaysAlive: false,
        deployedAt: '2026-10-01T00:00:00.000Z',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        tags: {},
        signingSecret: 'secret',
        secrets: { OPENAI_KEY: 'sk-x' },
        configuration: { data: { apiKey: 'x' } },
        integrations: {
          webchat: { id: 'i1', name: 'webchat', title: 'Webchat', version: '1.0.0', enabled: true, status: 'registered', statusReason: null, webhookUrl: 'https://webhook.botpress.cloud/x', configuration: { token: 'y' } },
        },
      },
    };
    const out = shape('botpress_get_bot', raw);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      id: 'b1',
      name: 'Support bot',
      description: 'FAQ',
      status: 'active',
      type: 'studio',
      dev: false,
      alwaysAlive: false,
      deployedAt: '2026-10-01T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      tags: {},
      integrations: [{ id: 'i1', name: 'webchat', title: 'Webchat', version: '1.0.0', enabled: true, status: 'registered', statusReason: null, webhookUrl: 'https://webhook.botpress.cloud/x' }],
    });
    expect(JSON.stringify(out.value)).not.toMatch(/secret|sk-x|token/);
  });

  it('shapes conversations, messages, logs, tables, files and passages', () => {
    expect(
      shape('botpress_list_messages', {
        messages: [{ id: 'm1', conversationId: 'c1', userId: 'u1', direction: 'incoming', type: 'text', payload: { text: 'hi' }, tags: {}, createdAt: 't', updatedAt: 't' }],
        meta: { nextToken: 'n2' },
      }).value,
    ).toEqual({ messages: [{ id: 'm1', conversationId: 'c1', userId: 'u1', direction: 'incoming', type: 'text', payload: { text: 'hi' }, createdAt: 't' }], meta: { nextToken: 'n2' } });
    expect(
      shape('botpress_list_conversations', {
        conversations: [{ id: 'c1', currentTaskId: 'x', channel: 'channel', integration: 'webchat', tags: {}, messageCount: 4, createdAt: 't', updatedAt: 't' }],
        meta: {},
      }).value,
    ).toEqual({ conversations: [{ id: 'c1', integration: 'webchat', channel: 'channel', messageCount: 4, tags: {}, createdAt: 't', updatedAt: 't' }], meta: {} });
    expect(shape('botpress_get_bot_logs', { logs: [{ timestamp: 't', level: 'error', message: 'boom', conversationId: 'c1' }], nextToken: 'n' }).value).toEqual({
      logs: [{ timestamp: 't', level: 'error', message: 'boom', conversationId: 'c1' }],
      nextToken: 'n',
    });
    expect(
      shape('botpress_get_table', {
        table: { id: 't1', name: 'LeadsTable', factor: 1, frozen: false, keyColumn: null, isComputeEnabled: false, schema: { $schema: 'x', type: 'object', properties: { name: { type: 'string' } } }, tags: {}, createdAt: 'c', updatedAt: 'u' },
        rows: 12,
        stale: 0,
        indexing: 0,
      }).value,
    ).toEqual({
      table: { id: 't1', name: 'LeadsTable', keyColumn: null, frozen: false, factor: 1, isComputeEnabled: false, columns: { name: { type: 'string' } }, tags: {}, createdAt: 'c', updatedAt: 'u' },
      rows: 12,
      stale: 0,
      indexing: 0,
    });
    expect(shape('botpress_find_table_rows', { rows: [{ id: 1, name: 'Ada', computed: {}, stale: [] }], hasMore: false, offset: 0, limit: 50 }).value).toEqual({
      rows: [{ id: 1, name: 'Ada' }],
      hasMore: false,
      offset: 0,
      limit: 50,
    });
    const files = shape('botpress_list_files', {
      files: [{ id: 'f1', botId: 'b1', key: 'faq.pdf', url: 'https://signed.example/faq.pdf?sig=1', size: 10, contentType: 'application/pdf', tags: {}, metadata: {}, createdAt: 'c', updatedAt: 'u', accessPolicies: [], index: true, status: 'indexing_completed' }],
      meta: {},
    }).value as any;
    expect(files.files[0]).toEqual({ id: 'f1', key: 'faq.pdf', contentType: 'application/pdf', size: 10, status: 'indexing_completed', index: true, tags: {}, createdAt: 'c', updatedAt: 'u' });
    expect(
      shape('botpress_search_files', {
        passages: [{ content: 'Refunds within 30 days', score: 0.9, meta: { type: 'chunk', pageNumber: 2 }, file: { id: 'f1', key: 'faq.pdf', contentType: 'application/pdf', metadata: {}, tags: {}, createdAt: 'c', updatedAt: 'u' } }],
      }).value,
    ).toEqual({ passages: [{ content: 'Refunds within 30 days', score: 0.9, pageNumber: 2, fileId: 'f1', fileKey: 'faq.pdf' }] });
  });
});

const live = process.env.RUN_BOTPRESS_LIVE === '1' ? describe : describe.skip;
live('botpress adapter: live', () => {
  const realEnv =
    process.env.BOTPRESS_TOKEN && process.env.BOTPRESS_WORKSPACE_ID && process.env.BOTPRESS_BOT_ID
      ? { BOTPRESS_TOKEN: process.env.BOTPRESS_TOKEN, BOTPRESS_WORKSPACE_ID: process.env.BOTPRESS_WORKSPACE_ID, BOTPRESS_BOT_ID: process.env.BOTPRESS_BOT_ID }
      : undefined;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each<[string, Record<string, unknown>]>([
    ['botpress_list_workspaces', {}],
    ['botpress_list_bots', {}],
    ['botpress_get_bot', { bot_id: BOT }],
    ['botpress_get_bot_logs', { bot_id: BOT, timeStart: '2026-10-14T00:00:00.000Z' }],
    ['botpress_get_bot_analytics', { bot_id: BOT, startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-10-02T00:00:00.000Z' }],
    ['botpress_list_bot_issues', { bot_id: BOT }],
    ['botpress_list_conversations', {}],
    ['botpress_get_conversation', { id: 'c1' }],
    ['botpress_list_messages', {}],
    ['botpress_list_users', {}],
    ['botpress_get_user', { id: 'u1' }],
    ['botpress_list_events', {}],
    ['botpress_get_event', { id: 'e1' }],
    ['botpress_list_tables', {}],
    ['botpress_get_table', { table: 'LeadsTable' }],
    ['botpress_find_table_rows', { table: 'LeadsTable' }],
    ['botpress_create_table_rows', { table: 'LeadsTable', rows: [{ name: 'x' }] }],
    ['botpress_update_table_rows', { table: 'LeadsTable', rows: [{ id: 1 }] }],
    ['botpress_delete_table_rows', { table: 'LeadsTable', ids: [1] }],
    ['botpress_list_files', {}],
    ['botpress_search_files', { query: 'refund policy' }],
  ])('%s is refused with 401 for a wrong token', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401, data: { type: 'Unauthorized' } } });
  }, 30000);

  it('answers 404 outside the API prefixes', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/v1/does-not-exist`, headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (realEnv ? it : it.skip)('reads workspaces, bots, conversations, tables and files with a real token', async () => {
    const ws = shape('botpress_list_workspaces', await call('botpress_list_workspaces', { pageSize: 5 }, realEnv)).value as any;
    expect(ws.workspaces.map((w: any) => w.id)).toContain(realEnv!.BOTPRESS_WORKSPACE_ID);
    const bots = shape('botpress_list_bots', await call('botpress_list_bots', { pageSize: 5 }, realEnv)).value as any;
    expect(Array.isArray(bots.bots)).toBe(true);
    const bot = shape('botpress_get_bot', await call('botpress_get_bot', { bot_id: realEnv!.BOTPRESS_BOT_ID }, realEnv));
    expect(bot.error).toBeUndefined();
    expect((bot.value as any).id).toBe(realEnv!.BOTPRESS_BOT_ID);
    const convs = shape('botpress_list_conversations', await call('botpress_list_conversations', { pageSize: 2 }, realEnv)).value as any;
    expect(Array.isArray(convs.conversations)).toBe(true);
    const tables = shape('botpress_list_tables', await call('botpress_list_tables', {}, realEnv)).value as any;
    expect(Array.isArray(tables.tables)).toBe(true);
    const files = shape('botpress_list_files', await call('botpress_list_files', { pageSize: 2 }, realEnv)).value as any;
    expect(Array.isArray(files.files)).toBe(true);
  }, 90000);

  (realEnv && process.env.RUN_BOTPRESS_LIVE_WRITE === '1' && process.env.BOTPRESS_TEST_TABLE ? it : it.skip)(
    'adds, updates and deletes one row in a throwaway table',
    async () => {
      const t = process.env.BOTPRESS_TEST_TABLE!;
      const created = await call('botpress_create_table_rows', { table: t, rows: [{}] }, realEnv);
      const id = created.rows[0].id;
      expect(typeof id).toBe('number');
      const updated = await call('botpress_update_table_rows', { table: t, rows: [{ id }] }, realEnv);
      expect(updated.rows[0].id).toBe(id);
      const deleted = await call('botpress_delete_table_rows', { table: t, ids: [id] }, realEnv);
      expect(deleted.deletedRows).toBe(1);
    },
    90000,
  );
});
