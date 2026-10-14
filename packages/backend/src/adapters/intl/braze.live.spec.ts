import axios from 'axios';
import * as adapter from './braze.json';
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
 * Two layers of verification for the Braze adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with the workspace REST API key,
 *      the per-instance REST endpoint variable, every tool's method, URL,
 *      query and body through the real RestEngine, checked against the Braze
 *      REST API reference (braze.com/docs/api, endpoint pages and their
 *      OpenAPI files, read 14 Oct 2026). Also which tools only read, that the
 *      sends demand an explicit confirmation and that the delete ships off.
 *
 *   2. Live: skipped unless RUN_BRAZE_LIVE=1. Without credentials it checks
 *      that Braze refuses a wrong key with 401 on the real routes. With
 *      BRAZE_REST_ENDPOINT and BRAZE_REST_API_KEY it reads campaigns,
 *      Canvases, segments, the DAU series and the custom event names, shaped
 *      by each tool's response mapping as production does. Nothing is written
 *      unless RUN_BRAZE_LIVE_WRITES=1 and BRAZE_TEST_EXTERNAL_ID are set too:
 *      then one custom attribute is recorded on that test profile. No message
 *      is ever sent by this spec.
 *
 *        RUN_BRAZE_LIVE=1 BRAZE_REST_ENDPOINT=https://rest.iad-01.braze.com \
 *          BRAZE_REST_API_KEY=... npx jest src/adapters/intl/braze.live.spec.ts
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

// An instance endpoint as Braze shows it, with the trailing slash people paste.
const HOST = 'https://rest.iad-01.braze.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'b' + '0'.repeat(7) + '-0000-4000-8000-' + '0'.repeat(12);
const ENV: Record<string, string> = { BRAZE_REST_ENDPOINT: `${HOST}/`, BRAZE_REST_API_KEY: FAKE_KEY };

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
// What the model receives: the raw answer shaped by the tool's response mapping.
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) =>
  applyResponseTransform(await call(name, params, env), tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = ['braze_delete_users', 'braze_send_campaign', 'braze_send_canvas', 'braze_track_users'];
const SENDS = ['braze_send_campaign', 'braze_send_canvas'];

describe('braze adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against vendor SDKs, specs and working clients on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('authenticates with the REST API key as a Bearer token on the instance endpoint', () => {
    expect(a.category).toBe('marketing-automation');
    expect(a.icon).toBe('braze');
    expect(a.connector.baseUrl).toBe('{{BRAZE_REST_ENDPOINT}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{BRAZE_REST_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/campaigns/list');
    expect(a.requiredEnvVars).toEqual(['BRAZE_REST_ENDPOINT', 'BRAZE_REST_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.BRAZE_REST_ENDPOINT).toMatchObject({ kind: 'address', required: true });
    expect(meta.BRAZE_REST_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts every documented REST endpoint and refuses dashboards, paths and other hosts', () => {
    const url = new RegExp(a.envVarMeta.BRAZE_REST_ENDPOINT.pattern!);
    const documented = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `https://rest.iad-0${n}.braze.com`),
      'https://rest.us-10.braze.com',
      'https://rest.fra-01.braze.eu',
      'https://rest.fra-02.braze.eu',
      'https://rest.au-01.braze.com',
      'https://rest.id-01.braze.com',
      'https://rest.jp-01.braze.com',
      'https://rest.kr-01.braze.com',
    ];
    for (const ok of [...documented, `${HOST}/`, 'rest.fra-01.braze.eu']) expect(url.test(ok)).toBe(true);
    for (const bad of ['', 'https://dashboard-01.braze.com', `${HOST}/users/track`, 'http://rest.iad-01.braze.com', 'https://rest.iad-01.braze.com.evil.example', 'https://braze.com']) {
      expect(url.test(bad)).toBe(false);
    }
    expect(checkBaseUrlValue('rest.fra-01.braze.eu')).toEqual({ ok: true, value: 'https://rest.fra-01.braze.eu' });
    for (const host of documented) expect(a.instructions).toContain(host);
  });

  it('probes with the campaign list and explains wrong keys, permissions and endpoints', () => {
    expect(a.probe).toEqual({ tool: 'braze_list_campaigns' });
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/REST endpoint/);
  });

  it('prefixes every tool with braze_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^braze_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks the POST profile export read-only, confirms every write and ships the delete switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(annotationsOf(tool('braze_export_users_by_ids'))).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(annotationsOf(tool('braze_delete_users'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const name of SENDS) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tool(name).description).toMatch(/real people/);
      expect(tool(name).description).toMatch(/only after the user confirms/);
      expect(tool(name).description).toContain('"yes, send"');
    }
    expect(tool('braze_track_users').description).toMatch(/confirm/i);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['braze_delete_users']);
    expect(tool('braze_delete_users').description).toMatch(/switched off/);
  });

  it('only points the model at tools that exist, documents setup and limits, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bbraze_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbraze_[a-z_]+/g)]),
    ]
      .map((m) => m[0])
      // Braze's own identifier fields, not tool names.
      .filter((n) => n !== 'braze_id' && n !== 'braze_ids');
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('APIs and Identifiers');
    expect(a.instructions).toMatch(/250,000 requests an hour/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('gives every tool a valid response mapping that does real work, except the sends', () => {
    for (const t of a.tools) {
      if (SENDS.includes(t.name) || t.name === 'braze_delete_users') continue;
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['braze_list_campaigns', {}, 'GET', '/campaigns/list'],
    ['braze_get_campaign', { campaign_id: 'c1' }, 'GET', '/campaigns/details'],
    ['braze_get_campaign_data_series', { campaign_id: 'c1' }, 'GET', '/campaigns/data_series'],
    ['braze_get_send_data_series', { campaign_id: 'c1', send_id: 's1' }, 'GET', '/sends/data_series'],
    ['braze_list_canvases', {}, 'GET', '/canvas/list'],
    ['braze_get_canvas', { canvas_id: 'k1' }, 'GET', '/canvas/details'],
    ['braze_get_canvas_data_summary', { canvas_id: 'k1', ending_at: '2026-10-14T00:00:00Z', length: 7 }, 'GET', '/canvas/data_summary'],
    ['braze_list_segments', {}, 'GET', '/segments/list'],
    ['braze_get_segment', { segment_id: 'g1' }, 'GET', '/segments/details'],
    ['braze_get_segment_size_series', { segment_id: 'g1' }, 'GET', '/segments/data_series'],
    ['braze_get_kpi_series', { metric: 'mau' }, 'GET', '/kpi/mau/data_series'],
    ['braze_list_custom_events', {}, 'GET', '/events/list'],
    ['braze_get_custom_event_series', { event: 'signup' }, 'GET', '/events/data_series'],
    ['braze_list_products', {}, 'GET', '/purchases/product_list'],
    ['braze_get_purchase_quantity_series', {}, 'GET', '/purchases/quantity_series'],
    ['braze_get_revenue_series', {}, 'GET', '/purchases/revenue_series'],
    ['braze_get_subscription_group_status', { subscription_group_id: 'sg', external_id: 'u1' }, 'GET', '/subscription/status/get'],
    ['braze_list_user_subscription_groups', { external_id: 'u1' }, 'GET', '/subscription/user/status'],
    ['braze_export_users_by_ids', { external_ids: ['u1'] }, 'POST', '/users/export/ids'],
    ['braze_track_users', { attributes: [{ external_id: 'u1', plan: 'pro' }] }, 'POST', '/users/track'],
    ['braze_send_campaign', { campaign_id: 'c1', recipients: [{ external_user_id: 'u1' }] }, 'POST', '/campaigns/trigger/send'],
    ['braze_send_canvas', { canvas_id: 'k1', recipients: [{ external_user_id: 'u1' }] }, 'POST', '/canvas/trigger/send'],
    ['braze_delete_users', { external_ids: ['u1'] }, 'POST', '/users/delete'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer key', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('sends the documented list filters, including last_edit.time[gt]', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('braze_list_campaigns', { page: 2, include_archived: true, sort_direction: 'desc', last_edited_after: '2026-09-01T00:00:00Z' });
    expect(sent().params).toEqual({ page: 2, include_archived: true, sort_direction: 'desc', 'last_edit.time[gt]': '2026-09-01T00:00:00Z' });
    mockedAxios.mockClear();
    await call('braze_list_canvases', { last_edited_after: '2026-09-01T00:00:00Z' });
    expect(sent().params).toEqual({ 'last_edit.time[gt]': '2026-09-01T00:00:00Z' });
  });

  it('defaults series to 30 days and passes the Canvas summary window', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('braze_get_campaign_data_series', { campaign_id: 'c1' });
    expect(sent().params).toEqual({ campaign_id: 'c1', length: 30 });
    mockedAxios.mockClear();
    await call('braze_get_custom_event_series', { event: 'signup', unit: 'hour', length: 24, segment_id: 'g1' });
    expect(sent().params).toEqual({ event: 'signup', unit: 'hour', length: 24, segment_id: 'g1' });
    mockedAxios.mockClear();
    await call('braze_get_canvas_data_summary', { canvas_id: 'k1', ending_at: '2026-10-14T00:00:00Z', starting_at: '2026-10-07T00:00:00Z', include_step_breakdown: true });
    expect(sent().params).toEqual({ canvas_id: 'k1', ending_at: '2026-10-14T00:00:00Z', starting_at: '2026-10-07T00:00:00Z', include_step_breakdown: true });
    expect(tool('braze_get_kpi_series').parameters.properties!.metric.enum).toEqual(['dau', 'mau', 'new_users', 'uninstalls']);
  });

  it('exports profiles with a compact default field set', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('braze_export_users_by_ids', { email_address: 'ada@example.com' });
    expect(sent().data).toEqual({
      email_address: 'ada@example.com',
      fields_to_export: tool('braze_export_users_by_ids').parameters.properties!.fields_to_export.default,
    });
    expect(sent().data.fields_to_export).not.toContain('push_tokens');
  });

  it('builds the track, trigger and delete bodies as documented', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const events = [{ external_id: 'u1', name: 'trial_started', time: '2026-10-14T10:00:00Z' }];
    await call('braze_track_users', { events });
    expect(sent().data).toEqual({ events });
    mockedAxios.mockClear();
    await call('braze_send_campaign', { campaign_id: 'c1', send_id: 's1', trigger_properties: { coupon: 'X' }, recipients: [{ external_user_id: 'u1' }] });
    expect(sent().data).toEqual({ campaign_id: 'c1', send_id: 's1', trigger_properties: { coupon: 'X' }, recipients: [{ external_user_id: 'u1' }] });
    mockedAxios.mockClear();
    await call('braze_send_canvas', { canvas_id: 'k1', broadcast: true, context: { a: 1 } });
    expect(sent().data).toEqual({ canvas_id: 'k1', broadcast: true, context: { a: 1 } });
    mockedAxios.mockClear();
    // Workspaces without Canvas Context still take the older entry properties.
    await call('braze_send_canvas', { canvas_id: 'k1', recipients: [{ external_user_id: 'u1' }], canvas_entry_properties: { a: 1 } });
    expect(sent().data).toEqual({ canvas_id: 'k1', recipients: [{ external_user_id: 'u1' }], canvas_entry_properties: { a: 1 } });
    mockedAxios.mockClear();
    await call('braze_delete_users', { braze_ids: ['b1'] });
    expect(sent().data).toEqual({ braze_ids: ['b1'] });
    mockedAxios.mockClear();
    // Email and phone identifiers are objects carrying a prioritization.
    const byEmail = [{ email: 'ada@example.com', prioritization: ['unidentified', 'most_recently_updated'] }];
    await call('braze_delete_users', { email_addresses: byEmail });
    expect(sent().data).toEqual({ email_addresses: byEmail });
    const props = tool('braze_delete_users').parameters.properties as Record<string, any>;
    expect(props.email_addresses.items.type).toBe('object');
    expect(props.phone_numbers.items.type).toBe('object');
  });

  it('looks up subscription states with the documented single-user query', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('braze_get_subscription_group_status', { subscription_group_id: 'sg', phone: '+4915112345678' });
    expect(sent().params).toEqual({ subscription_group_id: 'sg', phone: '+4915112345678' });
    mockedAxios.mockClear();
    await call('braze_list_user_subscription_groups', { external_id: 'u1', limit: 100, offset: 0 });
    expect(sent().params).toEqual({ external_id: 'u1', limit: 100, offset: 0 });
  });

  it('keeps push tokens out of exported profiles', () => {
    const raw = {
      message: 'success',
      invalid_user_ids: ['x'],
      users: [{ external_id: 'u1', email: 'ada@example.com', push_tokens: [{ token: 'secret-token' }], custom_attributes: { plan: 'pro' } }],
    };
    const out = applyResponseTransform(raw, tool('braze_export_users_by_ids').responseMapping as any).value as any;
    expect(out).toEqual({ message: 'success', invalid_user_ids: ['x'], users: [{ external_id: 'u1', email: 'ada@example.com', custom_attributes: { plan: 'pro' } }] });
  });

  it('keeps list and series shapes and caps campaign details', () => {
    const list = { message: 'success', campaigns: [{ id: 'c1', name: 'Welcome', is_api_campaign: false, tags: [], last_edited: '2026-10-01T00:00:00Z' }] };
    expect(applyResponseTransform(list, tool('braze_list_campaigns').responseMapping as any).value).toEqual(list);
    const series = { message: 'success', data: [{ time: '2026-10-01', dau: 12 }] };
    expect(applyResponseTransform(series, tool('braze_get_kpi_series').responseMapping as any).value).toEqual(series);
    const huge = { message: 'success', name: 'Big', messages: { v1: { channel: 'email', body: 'x'.repeat(200000) } } };
    const out = applyResponseTransform(huge, tool('braze_get_campaign').responseMapping as any);
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out.value).length).toBeLessThan(70000);
  });
});

const live = process.env.RUN_BRAZE_LIVE === '1' ? describe : describe.skip;
live('braze adapter: live', () => {
  const real = !!(process.env.BRAZE_REST_ENDPOINT && process.env.BRAZE_REST_API_KEY);
  const env = () => ({ BRAZE_REST_ENDPOINT: process.env.BRAZE_REST_ENDPOINT!, BRAZE_REST_API_KEY: process.env.BRAZE_REST_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['braze_list_campaigns', {}],
    ['braze_get_kpi_series', { metric: 'dau', length: 1 }],
    ['braze_export_users_by_ids', { external_ids: ['amcp-nobody'] }],
  ])('%s reaches Braze and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads campaigns, Canvases, segments, DAU and event names', async () => {
    const campaigns = await shaped('braze_list_campaigns', {}, env());
    expect(Array.isArray(campaigns.campaigns)).toBe(true);
    const canvases = await shaped('braze_list_canvases', {}, env());
    expect(Array.isArray(canvases.canvases)).toBe(true);
    const segments = await shaped('braze_list_segments', {}, env());
    expect(Array.isArray(segments.segments)).toBe(true);
    const dau = await shaped('braze_get_kpi_series', { metric: 'dau', length: 7 }, env());
    expect(Array.isArray(dau.data)).toBe(true);
    const events = await shaped('braze_list_custom_events', {}, env());
    expect(Array.isArray(events.events)).toBe(true);
    if (campaigns.campaigns[0]) {
      const details = await shaped('braze_get_campaign', { campaign_id: campaigns.campaigns[0].id }, env());
      expect(details.message).toBe('success');
    }
  }, 60000);

  const writes = real && process.env.RUN_BRAZE_LIVE_WRITES === '1' && !!process.env.BRAZE_TEST_EXTERNAL_ID;
  (writes ? it : it.skip)('records one custom attribute on the test profile (no message is sent)', async () => {
    const out = await shaped(
      'braze_track_users',
      { attributes: [{ external_id: process.env.BRAZE_TEST_EXTERNAL_ID, amcp_live_check: new Date().toISOString() }] },
      env(),
    );
    expect(out.attributes_processed).toBe(1);
  }, 30000);
});
