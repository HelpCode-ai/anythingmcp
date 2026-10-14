import axios from 'axios';
import * as adapter from './iterable.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { checkBaseUrlValue } from '../../common/base-url-variable.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Iterable adapter:
 *
 *   1. Static: always runs. Pins the Api-Key header, the US / EU address
 *      variable, every tool's method, URL, query and body through the real
 *      RestEngine, checked against Iterable's Swagger document
 *      (api.iterable.com/api-docs, read 14 Oct 2026). Also which tools only
 *      read, that the email send asks for confirmation, that the deletes ship
 *      off, and that the CSV and text answers are capped.
 *
 *   2. Live: skipped unless RUN_ITERABLE_LIVE=1. Without credentials it checks
 *      that both data centers refuse a wrong key with 401. With
 *      ITERABLE_API_URL and ITERABLE_API_KEY it reads channels, message types,
 *      lists, a page of campaigns and templates, shaped by each tool's response
 *      mapping as production does. Nothing is written unless
 *      RUN_ITERABLE_LIVE_WRITES=1 and ITERABLE_TEST_EMAIL are set too: then
 *      one data field is merged into that test profile. No email is sent.
 *
 *        RUN_ITERABLE_LIVE=1 ITERABLE_API_URL=https://api.iterable.com \
 *          ITERABLE_API_KEY=... npx jest src/adapters/intl/iterable.live.spec.ts
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
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

const HOST = 'https://api.iterable.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'a' + '0'.repeat(31);
const ENV: Record<string, string> = { ITERABLE_API_URL: `${HOST}/`, ITERABLE_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
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
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) =>
  applyResponseTransform(await call(name, params, env), tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'iterable_delete_user_by_email',
  'iterable_delete_user_by_user_id',
  'iterable_send_email',
  'iterable_subscribe_to_list',
  'iterable_track_event',
  'iterable_unsubscribe_from_list',
  'iterable_update_user',
];
const DELETES = ['iterable_delete_user_by_email', 'iterable_delete_user_by_user_id'];

describe('iterable adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against vendor SDKs, specs and working clients on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the key in the Api-Key header on the project data center', () => {
    expect(a.category).toBe('marketing-automation');
    expect(a.icon).toBe('iterable');
    expect(a.connector.baseUrl).toBe('{{ITERABLE_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Api-Key', apiKey: '{{ITERABLE_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/api/channels');
    // No Accept header: metrics and list members come back as text/plain.
    expect(a.connector.headers.Accept).toBeUndefined();
    expect(a.requiredEnvVars).toEqual(['ITERABLE_API_URL', 'ITERABLE_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.ITERABLE_API_URL).toMatchObject({ kind: 'address', required: true });
    expect(meta.ITERABLE_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts the US and EU API hosts and refuses paths and other hosts', () => {
    const url = new RegExp(a.envVarMeta.ITERABLE_API_URL.pattern!);
    for (const ok of [HOST, `${HOST}/`, 'https://api.eu.iterable.com', 'api.eu.iterable.com']) expect(url.test(ok)).toBe(true);
    for (const bad of ['', `${HOST}/api`, 'https://app.iterable.com', 'http://api.iterable.com', 'https://api.iterable.com.evil.example']) {
      expect(url.test(bad)).toBe(false);
    }
    expect(checkBaseUrlValue('api.eu.iterable.com')).toEqual({ ok: true, value: 'https://api.eu.iterable.com' });
  });

  it('probes with the channel list and explains wrong keys and data centers', () => {
    expect(a.probe).toEqual({ tool: 'iterable_list_channels' });
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/api\.eu\.iterable\.com/);
  });

  it('prefixes every tool with iterable_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^iterable_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('confirms every write, demands it before a send and ships the deletes switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES.filter((n) => !DELETES.includes(n))) expect(tool(name).description).toMatch(/confirm/i);
    expect(tool('iterable_send_email').description).toMatch(/real email/);
    expect(tool('iterable_send_email').description).toMatch(/only after the user confirms/);
    expect(annotationsOf(tool('iterable_unsubscribe_from_list'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(DELETES);
    for (const name of DELETES) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tool(name).description).toMatch(/switched off/);
    }
  });

  it('only points the model at tools that exist, documents setup and limits, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\biterable_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\biterable_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('Server-side');
    expect(a.instructions).toMatch(/campaign metrics 10 a minute/);
    expect(a.instructions).toMatch(/CSV text/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('gives every tool a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['iterable_list_lists', {}, 'GET', '/api/lists'],
    ['iterable_get_list_size', { list_id: 12 }, 'GET', '/api/lists/12/size'],
    ['iterable_list_list_users', { list_id: 12 }, 'GET', '/api/lists/getUsers'],
    ['iterable_get_user_by_email', { email: 'ada@example.com' }, 'GET', '/api/users/getByEmail'],
    ['iterable_get_user_by_id', { user_id: 'u1' }, 'GET', '/api/users/byUserId'],
    ['iterable_get_user_events_by_email', { email: 'ada@example.com' }, 'GET', '/api/events/ada%40example.com'],
    ['iterable_get_user_events_by_user_id', { user_id: 'u/1' }, 'GET', '/api/events/byUserId/u%2F1'],
    ['iterable_get_sent_messages', { email: 'ada@example.com' }, 'GET', '/api/users/getSentMessages'],
    ['iterable_list_campaigns', {}, 'GET', '/api/campaigns'],
    ['iterable_get_campaign', { campaign_id: 99 }, 'GET', '/api/campaigns/99'],
    ['iterable_get_campaign_metrics', { campaign_ids: [99] }, 'GET', '/api/campaigns/metrics'],
    ['iterable_list_templates', {}, 'GET', '/api/templates'],
    ['iterable_list_channels', {}, 'GET', '/api/channels'],
    ['iterable_list_message_types', {}, 'GET', '/api/messageTypes'],
    ['iterable_list_catalogs', {}, 'GET', '/api/catalogs'],
    ['iterable_list_catalog_items', { catalog_name: 'products' }, 'GET', '/api/catalogs/products/items'],
    ['iterable_update_user', { email: 'ada@example.com', data_fields: { plan: 'pro' } }, 'POST', '/api/users/update'],
    ['iterable_track_event', { event_name: 'trial_started', email: 'ada@example.com' }, 'POST', '/api/events/track'],
    ['iterable_subscribe_to_list', { list_id: 12, subscribers: [{ email: 'ada@example.com' }] }, 'POST', '/api/lists/subscribe'],
    ['iterable_unsubscribe_from_list', { list_id: 12, subscribers: [{ email: 'ada@example.com' }] }, 'POST', '/api/lists/unsubscribe'],
    ['iterable_send_email', { campaign_id: 99, recipient_email: 'ada@example.com' }, 'POST', '/api/email/target'],
    ['iterable_delete_user_by_email', { email: 'ada+x@example.com' }, 'DELETE', '/api/users/ada%2Bx%40example.com'],
    ['iterable_delete_user_by_user_id', { user_id: 'u1' }, 'DELETE', '/api/users/byUserId/u1'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Api-Key header', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers['Api-Key']).toBe(FAKE_KEY);
  });

  it('pages campaigns and templates by default and repeats campaign ids for metrics', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('iterable_list_campaigns', { campaign_state: ['Running', 'Finished'] });
    expect(sent().params).toEqual({ page: 1, pageSize: 50, campaignState: ['Running', 'Finished'] });
    mockedAxios.mockClear();
    await call('iterable_list_templates', { message_medium: 'Email' });
    expect(sent().params).toEqual({ messageMedium: 'Email', page: 1, pageSize: 50 });
    mockedAxios.mockClear();
    await call('iterable_get_campaign_metrics', { campaign_ids: [1, 2], start_date_time: '2026-10-01' });
    expect(sent().params).toEqual({ campaignId: [1, 2], startDateTime: '2026-10-01' });
    // The engine serialises arrays as repeated keys, the form Iterable expects.
    expect(sent().paramsSerializer(sent().params)).toBe('campaignId=1&campaignId=2&startDateTime=2026-10-01');
  });

  it('builds the write bodies with Iterable field names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('iterable_update_user', { user_id: 'u1', data_fields: { plan: 'pro' }, merge_nested_objects: true });
    expect(sent().data).toEqual({ userId: 'u1', dataFields: { plan: 'pro' }, mergeNestedObjects: true });
    mockedAxios.mockClear();
    await call('iterable_track_event', { event_name: 'trial_started', user_id: 'u1', data_fields: { plan: 'pro' }, created_at: 1760400000 });
    expect(sent().data).toEqual({ eventName: 'trial_started', userId: 'u1', dataFields: { plan: 'pro' }, createdAt: 1760400000 });
    mockedAxios.mockClear();
    await call('iterable_unsubscribe_from_list', { list_id: 12, subscribers: [{ userId: 'u1' }], channel_unsubscribe: true });
    expect(sent().data).toEqual({ listId: 12, subscribers: [{ userId: 'u1' }], channelUnsubscribe: true });
    mockedAxios.mockClear();
    await call('iterable_send_email', { campaign_id: 99, recipient_user_id: 'u1', data_fields: { code: '1' }, send_at: '2026-10-20 09:00:00' });
    expect(sent().data).toEqual({ campaignId: 99, recipientUserId: 'u1', dataFields: { code: '1' }, sendAt: '2026-10-20 09:00:00' });
  });

  it('caps CSV metrics and list members, and unwraps catalog params', () => {
    const csv = 'id,Total Email Sends\n' + Array.from({ length: 20000 }, (_, i) => `${i},10`).join('\n');
    const out = applyResponseTransform(csv, tool('iterable_get_campaign_metrics').responseMapping as any);
    expect(out.truncated).toBe(true);
    expect((out.value as any).preview.startsWith('"id,Total Email Sends')).toBe(true);
    const small = 'id,Total Email Sends\n99,10';
    expect(applyResponseTransform(small, tool('iterable_get_campaign_metrics').responseMapping as any).value).toBe(small);
    expect(applyResponseTransform('ada@example.com\nbob@example.com', tool('iterable_list_list_users').responseMapping as any).value).toBe(
      'ada@example.com\nbob@example.com',
    );
    const wrapped = { msg: '', code: 'Success', params: { catalogNames: [{ name: 'products' }], totalCatalogsCount: 1 } };
    expect(applyResponseTransform(wrapped, tool('iterable_list_catalogs').responseMapping as any).value).toEqual(wrapped.params);
    const flat = { catalogNames: [{ name: 'products' }], totalCatalogsCount: 1 };
    expect(applyResponseTransform(flat, tool('iterable_list_catalogs').responseMapping as any).value).toEqual(flat);
  });
});

const live = process.env.RUN_ITERABLE_LIVE === '1' ? describe : describe.skip;
live('iterable adapter: live', () => {
  const real = !!(process.env.ITERABLE_API_URL && process.env.ITERABLE_API_KEY);
  const env = () => ({ ITERABLE_API_URL: process.env.ITERABLE_API_URL!, ITERABLE_API_KEY: process.env.ITERABLE_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['https://api.iterable.com', 'iterable_list_channels'],
    ['https://api.eu.iterable.com', 'iterable_list_channels'],
    ['https://api.iterable.com', 'iterable_list_lists'],
  ])('%s refuses a wrong key with 401 (%s)', async (host, name) => {
    await expect(call(name, {}, { ...ENV, ITERABLE_API_URL: host })).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads channels, message types, lists, campaigns and templates', async () => {
    const channels = await shaped('iterable_list_channels', {}, env());
    expect(Array.isArray(channels.channels)).toBe(true);
    const types = await shaped('iterable_list_message_types', {}, env());
    expect(Array.isArray(types.messageTypes)).toBe(true);
    const lists = await shaped('iterable_list_lists', {}, env());
    expect(Array.isArray(lists.lists)).toBe(true);
    const campaigns = await shaped('iterable_list_campaigns', { page_size: 5 }, env());
    expect(Array.isArray(campaigns.campaigns)).toBe(true);
    const templates = await shaped('iterable_list_templates', { page_size: 5 }, env());
    expect(Array.isArray(templates.templates)).toBe(true);
  }, 60000);

  const writes = real && process.env.RUN_ITERABLE_LIVE_WRITES === '1' && !!process.env.ITERABLE_TEST_EMAIL;
  (writes ? it : it.skip)('merges one data field into the test profile (no email is sent)', async () => {
    const out = await shaped('iterable_update_user', { email: process.env.ITERABLE_TEST_EMAIL, data_fields: { amcpLiveCheck: new Date().toISOString() } }, env());
    expect(out.code).toBe('Success');
  }, 30000);
});
