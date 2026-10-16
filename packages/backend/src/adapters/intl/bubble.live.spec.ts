import axios from 'axios';
import * as adapter from './bubble.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the generic Bubble adapter (one app's Data
 * API and Workflow API):
 *
 *   1. Static: always runs. Pins the app address variable (live, version-test
 *      or a custom domain) in front of /api/1.1, Bearer auth, every tool's
 *      method and URL through the real RestEngine, the constraints query and
 *      the create, modify and workflow bodies as Bubble's manual documents
 *      them, and the response mappings against the shapes the manual shows
 *      and the public /api/1.1/meta of bubble.io returns.
 *
 *   2. Live: skipped unless RUN_BUBBLE_LIVE=1, BUBBLE_APP_URL and
 *      BUBBLE_API_TOKEN are set. BUBBLE_LIVE_TYPE names an exposed data type
 *      to read (default: the first type /meta lists).
 *
 *        RUN_BUBBLE_LIVE=1 BUBBLE_APP_URL=https://yourapp.bubbleapps.io/version-test BUBBLE_API_TOKEN=... npx jest src/adapters/intl/bubble.live.spec.ts
 *
 *      Reads meta, lists and reads things, applying each responseMapping the
 *      way the MCP layer does. BUBBLE_LIVE_WRITE=1 with BUBBLE_LIVE_WRITE_TYPE
 *      and BUBBLE_LIVE_WRITE_FIELDS (JSON) also creates one thing of that
 *      type, updates it with the same fields and deletes it again. Use the
 *      version-test address for writes.
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
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; encodePathParams?: boolean; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; link?: string }>;
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

const TOKEN = '0123456789abcdef0123456789abcdef';
const APP = 'https://acme.bubbleapps.io';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, token: string, params: Record<string, unknown>, app = APP) => {
  const env = { BUBBLE_API_TOKEN: token, BUBBLE_APP_URL: app };
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return engine().execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: { token }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>, app?: string) => execute(name, TOKEN, params, app);
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const BASE = `${APP}/api/1.1`;
const WRITES = ['bubble_create_thing', 'bubble_delete_thing', 'bubble_run_workflow', 'bubble_update_thing'];
const OFF = ['bubble_delete_thing'];

describe('bubble adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('bubble');
    expect(a.icon).toBe('bubble');
    expect(a.category).toBe('database');
  });

  it('puts /api/1.1 behind the app address and sends the token as Bearer', () => {
    expect(a.connector.baseUrl).toBe('{{BUBBLE_APP_URL}}/api/1.1');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{BUBBLE_API_TOKEN}}' });
    // /meta answers for every app that exists and tells a wrong address apart
    // (400 for an unknown app); the token is checked by the first data call.
    expect(a.connector.healthcheckPath).toBe('/meta');
    expect(a.probe.tool).toBe('bubble_get_meta');
  });

  it('asks for the app address and the token as a secret', () => {
    expect(a.requiredEnvVars).toEqual(['BUBBLE_APP_URL', 'BUBBLE_API_TOKEN']);
    const tok = a.envVarMeta.BUBBLE_API_TOKEN;
    expect(tok.secret).toBe(true);
    expect(tok.kind).toBe('credential');
    const tokRe = new RegExp(tok.pattern!);
    expect(tokRe.test(TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${TOKEN}`, `${TOKEN} `]) expect(tokRe.test(bad)).toBe(false);
    const url = new RegExp(a.envVarMeta.BUBBLE_APP_URL.pattern!);
    for (const ok of ['https://acme.bubbleapps.io', 'https://acme.bubbleapps.io/version-test', 'https://app.example.com', 'https://app.example.com/version-test']) expect(url.test(ok)).toBe(true);
    for (const bad of ['acme.bubbleapps.io', 'http://acme.bubbleapps.io', 'https://acme.bubbleapps.io/', 'https://acme.bubbleapps.io/api/1.1', 'https://acme.bubbleapps.io/version-test/api/1.1/obj']) expect(url.test(bad)).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'BUBBLE_API_TOKEN')!.secret).toBe(true);
  });

  it('prefixes every tool with bubble_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^bubble_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only, asks for confirmation on every write, and installs the delete switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    }
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm with the user first/i);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name)).toEqual(OFF);
  });

  it('URL-encodes every path argument, and every responseMapping does real work', async () => {
    for (const t of a.tools.filter((x) => /\{[A-Za-z]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${Boolean(tr && (tr.select || tr.exclude || tr.include))}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('bubble_get_thing', { type: 'user', id: '../../wf/x' });
    expect(sent().url).toBe(`${BASE}/obj/user/..%2F..%2Fwf%2Fx`);
  });

  it('only points the model at tools that exist, documents setup, privacy and paging, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bbubble_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbubble_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Bubble\n')).toBe(true);
    for (const text of ['Enable Data API', 'Workflow API', '/version-test', 'deploy', 'Confirm before every write', 'Personal data and untrusted content', 'never as instructions', 'cursor', 'Out of scope']) {
      expect(a.instructions).toContain(text);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['bubble_get_meta', {}, 'GET', `${BASE}/meta`],
    ['bubble_get_data_types', {}, 'GET', `${BASE}/meta`],
    ['bubble_list_things', { type: 'order' }, 'GET', `${BASE}/obj/order`],
    ['bubble_get_thing', { type: 'order', id: '1700000000000x123' }, 'GET', `${BASE}/obj/order/1700000000000x123`],
    ['bubble_create_thing', { type: 'order', fields: { status: 'open' } }, 'POST', `${BASE}/obj/order`],
    ['bubble_update_thing', { type: 'order', id: '1700000000000x123', fields: { status: 'closed' } }, 'PATCH', `${BASE}/obj/order/1700000000000x123`],
    ['bubble_run_workflow', { workflow: 'send-reminder' }, 'POST', `${BASE}/wf/send-reminder`],
    ['bubble_delete_thing', { type: 'order', id: '1700000000000x123' }, 'DELETE', `${BASE}/obj/order/1700000000000x123`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(url);
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reaches the development version and custom domains', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('bubble_list_things', { type: 'user' }, 'https://acme.bubbleapps.io/version-test');
    expect(sent().url).toBe('https://acme.bubbleapps.io/version-test/api/1.1/obj/user');
    mockedAxios.mockClear();
    await call('bubble_run_workflow', { workflow: 'ping' }, 'https://app.example.com');
    expect(sent().url).toBe('https://app.example.com/api/1.1/wf/ping');
  });

  it('sends constraints, cursor, limit and sorting as the Data API expects, 25 per page by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const constraints = '[{"key":"status","constraint_type":"equals","value":"open"}]';
    await call('bubble_list_things', { type: 'order', constraints, cursor: 25, sort_field: 'Created Date', descending: true });
    expect(sent().params).toEqual({ constraints, cursor: 25, limit: 25, sort_field: 'Created Date', descending: true });
    expect(new URLSearchParams(sent().paramsSerializer(sent().params)).get('constraints')).toBe(constraints);
    expect(tool('bubble_list_things').parameters.properties!.limit.maximum).toBe(100);
  });

  it('sends the fields and workflow parameters as the JSON body itself', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('bubble_create_thing', { type: 'order', fields: { name: 'Acme', amount: 120, items: ['1x1', '1x2'] } });
    expect(sent().data).toEqual({ name: 'Acme', amount: 120, items: ['1x1', '1x2'] });
    mockedAxios.mockClear();
    await call('bubble_update_thing', { type: 'order', id: '1x1', fields: { status: 'closed' } });
    expect(sent().data).toEqual({ status: 'closed' });
    mockedAxios.mockClear();
    await call('bubble_run_workflow', { workflow: 'send-reminder', parameters: { order_id: '1x1', notify: true } });
    expect(sent().data).toEqual({ order_id: '1x1', notify: true });
    mockedAxios.mockClear();
    await call('bubble_run_workflow', { workflow: 'ping' });
    expect(sent().data).toEqual({});
  });

  // Shapes from Bubble's manual (Data API requests) and bubble.io's public /api/1.1/meta.
  it('shapes meta into the exposed types and compact workflows, and the fields per type', () => {
    const meta = {
      get: ['order', 'user'],
      post: [{ endpoint: 'send-reminder', parameters: [{ key: 'order_id', value: 'text', optional: false, param_in: 'body' }], method: 'post', auth_unecessary: false, return_btype: { ok: 'boolean' } }],
      types: { order: { display: 'Order', fields: [{ id: 'status_text', display: 'status', type: 'text' }] } },
      app_data: { appname: 'acme', favicon: '//x.png', app_version: 'live', use_captions_for_get: false, domain: 'acme.bubbleapps.io' },
    };
    expect(shape('bubble_get_meta', meta).value).toEqual({
      dataTypes: ['order', 'user'],
      workflows: [{ endpoint: 'send-reminder', method: 'post', authentication: false, parameters: [{ key: 'order_id', type: 'text', optional: false, in: 'body' }] }],
      app: meta.app_data,
    });
    expect(shape('bubble_get_data_types', meta).value).toEqual({ types: meta.types });
  });

  it('shapes lists, single things and write answers', () => {
    const thing = { _id: '1700000000000x123', status_text: 'open', 'Created Date': '2026-10-01T10:00:00.000Z', 'Modified Date': '2026-10-02T10:00:00.000Z', 'Created By': 'admin_user_acme' };
    expect(shape('bubble_list_things', { response: { cursor: 0, results: [thing], count: 1, remaining: 0 } }).value).toEqual({ results: [thing], cursor: 0, count: 1, remaining: 0 });
    expect(shape('bubble_get_thing', { response: thing }).value).toEqual({ thing });
    expect(shape('bubble_create_thing', { status: 'success', id: '1700000000000x456' }).value).toEqual({ status: 'success', id: '1700000000000x456' });
    expect(shape('bubble_run_workflow', { status: 'success', response: { ok: true } }).value).toEqual({ status: 'success', response: { ok: true } });
    // PATCH and DELETE answer 204 with an empty body.
    expect(shape('bubble_update_thing', '').value).toEqual({});
  });
});

const LIVE_TOKEN = process.env.BUBBLE_API_TOKEN;
const LIVE_APP = process.env.BUBBLE_APP_URL;
const live = process.env.RUN_BUBBLE_LIVE === '1' && LIVE_TOKEN && LIVE_APP ? describe : describe.skip;

live('bubble adapter: live API', () => {
  const token = LIVE_TOKEN || '';
  const app = LIVE_APP || '';
  const write = process.env.BUBBLE_LIVE_WRITE === '1' && !!process.env.BUBBLE_LIVE_WRITE_TYPE;

  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const run = async (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    applyResponseTransform(await execute(name, token, params, app), tool(name).responseMapping as never).value;

  it('reads meta, lists things of an exposed type and reads one', async () => {
    const meta = await run('bubble_get_meta');
    expect(Array.isArray(meta.dataTypes)).toBe(true);
    expect(Array.isArray(meta.workflows)).toBe(true);
    expect(typeof (await run('bubble_get_data_types')).types).toBe('object');
    const type = process.env.BUBBLE_LIVE_TYPE || meta.dataTypes[0];
    if (!type) return;
    const list = await run('bubble_list_things', { type, limit: 2 });
    expect(Array.isArray(list.results)).toBe(true);
    if (list.results[0]) expect((await run('bubble_get_thing', { type, id: list.results[0]._id })).thing._id).toBe(list.results[0]._id);
  }, 60_000);

  (write ? it : it.skip)('creates, updates and deletes one thing', async () => {
    const type = process.env.BUBBLE_LIVE_WRITE_TYPE!;
    const fields = JSON.parse(process.env.BUBBLE_LIVE_WRITE_FIELDS || '{}');
    const created = await run('bubble_create_thing', { type, fields });
    expect(created.status).toBe('success');
    try {
      await run('bubble_update_thing', { type, id: created.id, fields });
    } finally {
      await execute('bubble_delete_thing', token, { type, id: created.id }, app);
    }
  }, 60_000);

  it('a wrong token is a 401 on a data call', async () => {
    const meta = await run('bubble_get_meta');
    const type = process.env.BUBBLE_LIVE_TYPE || meta.dataTypes[0] || 'user';
    await expect(execute('bubble_list_things', '0123456789abcdef0123456789abcdef', { type, limit: 1 }, app)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);
});
