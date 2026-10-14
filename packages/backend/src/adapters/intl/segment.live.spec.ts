import axios from 'axios';
import * as adapter from './segment.json';
import { RestEngine, serializeRepeatedParams } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { checkBaseUrlValue } from '../../common/base-url-variable.util';
import { applyResponseTransform, hasTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Twilio Segment adapter:
 *
 *   1. Static: always runs. Pins the Public API token as Bearer on the
 *      region host variable (api.segmentapis.com or eu1.api.segmentapis.com),
 *      every tool's method, URL, query and body through the real RestEngine,
 *      checked against Segment's OpenAPI document (docs.segmentapis.com,
 *      version 73.6.0, fetched 14 Oct 2026): pagination.count and
 *      pagination.cursor, the indexed groupBy.0 and filter.* query names of
 *      Delivery Overview and event volume, PATCH bodies. Also that every write
 *      ships switched off and asks for confirmation, that credentials in
 *      destination and warehouse settings are dropped, and that every
 *      response mapping actually runs.
 *
 *   2. Live: skipped unless RUN_SEGMENT_LIVE=1. Without a token it checks that
 *      both hosts refuse a wrong one with 403. With SEGMENT_API_TOKEN (and
 *      SEGMENT_API_HOST for an EU workspace) it reads the workspace, one page
 *      of sources, destinations and warehouses, the audit trail and this
 *      month's usage, shaped by each tool's responseMapping like production
 *      does. RUN_SEGMENT_LIVE_WRITES=1 with SEGMENT_LIVE_SOURCE_ID renames that
 *      source and renames it back (nothing is deleted or disabled):
 *
 *        RUN_SEGMENT_LIVE=1 SEGMENT_API_TOKEN=... npx jest src/adapters/intl/segment.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
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

const HOST = 'https://api.segmentapis.com';
const EU_HOST = 'https://eu1.api.segmentapis.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'sgp_' + 'x'.repeat(40);
const ENV: Record<string, string> = { SEGMENT_API_HOST: `${HOST}/`, SEGMENT_API_TOKEN: FAKE_TOKEN };

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
// What production hands to the model: the body shaped by the tool's mapping.
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) =>
  applyResponseTransform(await call(name, params, env), tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => serializeRepeatedParams(sent().params ?? {});

const WRITES = ['segment_delete_destination', 'segment_delete_source', 'segment_update_destination', 'segment_update_source'];

describe('segment adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against vendor SDKs, specs and working clients on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the Public API token as Bearer to the region host', () => {
    expect(a.category).toBe('data');
    expect(a.icon).toBe('segment');
    expect(a.connector.baseUrl).toBe('{{SEGMENT_API_HOST}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SEGMENT_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/');
    expect(a.requiredEnvVars).toEqual(['SEGMENT_API_HOST', 'SEGMENT_API_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.SEGMENT_API_HOST).toMatchObject({ kind: 'address', required: true, secret: false });
    expect(meta.SEGMENT_API_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts the US and EU API hosts and refuses the app, the tracking API, paths and lookalikes', () => {
    const url = new RegExp(a.envVarMeta.SEGMENT_API_HOST.pattern!);
    for (const ok of [HOST, `${HOST}/`, EU_HOST, 'api.segmentapis.com', 'eu1.api.segmentapis.com']) expect(url.test(ok)).toBe(true);
    for (const bad of ['', 'https://app.segment.com', 'https://api.segment.io', `${HOST}/sources`, 'http://api.segmentapis.com', 'https://api.segmentapis.com.evil.example', 'https://eu2.api.segmentapis.com']) {
      expect(url.test(bad)).toBe(false);
    }
    expect(checkBaseUrlValue('eu1.api.segmentapis.com')).toEqual({ ok: true, value: EU_HOST });
  });

  it('probes with the workspace and explains wrong tokens and regions', () => {
    expect(a.probe).toEqual({ tool: 'segment_get_workspace' });
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['403']).toMatch(/eu1\.api\.segmentapis\.com/);
  });

  it('prefixes every tool with segment_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^segment_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('ships every write switched off, asks for confirmation, and marks the deletes destructive', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm/i);
    for (const name of ['segment_delete_source', 'segment_delete_destination']) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it('documents every tool, the limits, pagination and the regions, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bsegment_[a-z0-9_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bsegment_[a-z0-9_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/2 requests a minute/);
    expect(a.instructions).toMatch(/pagination\.next/);
    expect(a.instructions).toContain('https://eu1.api.segmentapis.com');
    expect(a.instructions).toMatch(/Tracking API/);
    expect(a.instructions).toMatch(/Out of scope/);
    expect(tool('segment_list_warehouse_syncs').description).toMatch(/2 calls a minute/);
    expect(tool('segment_get_event_volume').description).toMatch(/60 requests per minute/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings on every tool that really run (not maxBytes alone)', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET')) {
      expect(`${t.name}:${!!t.responseMapping}`).toBe(`${t.name}:true`);
      expect(validateTransform(t.responseMapping!.transform)).toBeNull();
      expect(`${t.name}:${hasTransform(t.responseMapping as any)}`).toBe(`${t.name}:true`);
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['segment_get_workspace', {}, 'GET', '/'],
    ['segment_list_sources', {}, 'GET', '/sources'],
    ['segment_get_source', { source_id: 'qQEHquLrjRDN9j1ByrChyn' }, 'GET', '/sources/qQEHquLrjRDN9j1ByrChyn'],
    ['segment_list_source_destinations', { source_id: 's1' }, 'GET', '/sources/s1/connected-destinations'],
    ['segment_list_source_warehouses', { source_id: 's1' }, 'GET', '/sources/s1/connected-warehouses'],
    ['segment_get_source_schema_settings', { source_id: 's1' }, 'GET', '/sources/s1/settings'],
    ['segment_list_destinations', {}, 'GET', '/destinations'],
    ['segment_get_destination', { destination_id: 'd1' }, 'GET', '/destinations/d1'],
    ['segment_list_destination_subscriptions', { destination_id: 'd1' }, 'GET', '/destinations/d1/subscriptions'],
    ['segment_get_destination_delivery_metrics', { destination_id: 'd1', source_id: 's1' }, 'GET', '/destinations/d1/delivery-metrics'],
    ['segment_list_warehouses', {}, 'GET', '/warehouses'],
    ['segment_get_warehouse', { warehouse_id: 'w1' }, 'GET', '/warehouses/w1'],
    ['segment_get_warehouse_connection_state', { warehouse_id: 'w1' }, 'GET', '/warehouses/w1/connection-state'],
    ['segment_list_warehouse_syncs', { warehouse_id: 'w1' }, 'GET', '/warehouses/w1/syncs'],
    ['segment_list_tracking_plans', {}, 'GET', '/tracking-plans'],
    ['segment_get_tracking_plan', { tracking_plan_id: 'tp_1' }, 'GET', '/tracking-plans/tp_1'],
    ['segment_list_tracking_plan_rules', { tracking_plan_id: 'tp_1' }, 'GET', '/tracking-plans/tp_1/rules'],
    ['segment_list_tracking_plan_sources', { tracking_plan_id: 'tp_1' }, 'GET', '/tracking-plans/tp_1/sources'],
    ['segment_list_functions', {}, 'GET', '/functions'],
    ['segment_get_function', { function_id: 'sfnc_1' }, 'GET', '/functions/sfnc_1'],
    ['segment_get_event_volume', { granularity: 'DAY', start_time: '2026-10-07T00:00:00Z', end_time: '2026-10-14T00:00:00Z' }, 'GET', '/events/volume'],
    ['segment_get_delivery_overview', { step: 'failed-delivery', source_id: 's1', destination_config_id: 'd1', start_time: '2026-10-13T00:00:00Z', end_time: '2026-10-14T00:00:00Z', granularity: 'HOUR' }, 'GET', '/delivery-overview/failed-delivery'],
    ['segment_get_daily_api_calls_usage', { period: '2026-10-01' }, 'GET', '/usage/api-calls/daily'],
    ['segment_get_daily_mtu_usage', { period: '2026-10-01' }, 'GET', '/usage/mtu/daily'],
    ['segment_list_audit_events', {}, 'GET', '/audit-events'],
    ['segment_update_source', { source_id: 's1', enabled: false }, 'PATCH', '/sources/s1'],
    ['segment_update_destination', { destination_id: 'd1', name: 'GA4 prod' }, 'PATCH', '/destinations/d1'],
    ['segment_delete_source', { source_id: 's1' }, 'DELETE', '/sources/s1'],
    ['segment_delete_destination', { destination_id: 'd1' }, 'DELETE', '/destinations/d1'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer token', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('goes to the EU host for EU workspaces', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('segment_get_workspace', {}, { ...ENV, SEGMENT_API_HOST: EU_HOST });
    expect(sent().url).toBe(`${EU_HOST}/`);
  });

  it('always sends pagination.count, and the cursor when given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('segment_list_destinations', {});
    expect(sent().params).toEqual({ 'pagination.count': 50 });
    mockedAxios.mockClear();
    await call('segment_list_sources', { count: 200, cursor: 'MA==' });
    expect(new URLSearchParams(query()).get('pagination.cursor')).toBe('MA==');
    expect(sent().params).toEqual({ 'pagination.count': 200, 'pagination.cursor': 'MA==' });
    mockedAxios.mockClear();
    await call('segment_list_functions', {});
    expect(sent().params).toEqual({ resourceType: 'SOURCE', 'pagination.count': 50 });
  });

  it('uses the indexed groupBy and filter query names of event volume and Delivery Overview', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('segment_get_event_volume', {
      granularity: 'HOUR',
      start_time: '2026-10-13T00:00:00Z',
      end_time: '2026-10-14T00:00:00Z',
      group_by: 'eventName',
      group_by_2: 'source',
      source_id: 's1',
      event_type: 'track',
    });
    expect(sent().params).toEqual({
      granularity: 'HOUR',
      startTime: '2026-10-13T00:00:00Z',
      endTime: '2026-10-14T00:00:00Z',
      'groupBy.0': 'eventName',
      'groupBy.1': 'source',
      'sourceId.0': 's1',
      'eventType.0': 'track',
      'pagination.count': 50,
    });
    mockedAxios.mockClear();
    await call('segment_get_delivery_overview', {
      step: 'successfully-received',
      source_id: 's1',
      start_time: '2026-10-13T00:00:00Z',
      end_time: '2026-10-14T00:00:00Z',
      granularity: 'DAY',
      group_by: 'eventName',
      filter_event_name: 'Order Completed,Signed Up',
    });
    expect(sent().params).toEqual({
      sourceId: 's1',
      startTime: '2026-10-13T00:00:00Z',
      endTime: '2026-10-14T00:00:00Z',
      granularity: 'DAY',
      'groupBy.0': 'eventName',
      'filter.eventName': 'Order Completed,Signed Up',
      'pagination.count': 50,
    });
    expect(query()).toContain('groupBy.0=eventName');
  });

  it('builds the delivery metrics query and the PATCH bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('segment_get_destination_delivery_metrics', { destination_id: 'd1', source_id: 's1', granularity: 'DAY', start_time: '2026-10-01T00:00:00Z' });
    expect(sent().params).toEqual({ sourceId: 's1', granularity: 'DAY', startTime: '2026-10-01T00:00:00Z' });
    mockedAxios.mockClear();
    await call('segment_update_source', { source_id: 's1', enabled: false });
    expect(sent().data).toEqual({ enabled: false });
    mockedAxios.mockClear();
    await call('segment_update_destination', { destination_id: 'd1', name: 'GA4 prod', enabled: true });
    expect(sent().data).toEqual({ name: 'GA4 prod', enabled: true });
  });

  it('keeps list answers small and drops credentials from settings', () => {
    const list = applyResponseTransform(
      {
        data: {
          sources: [
            {
              id: 's1', slug: 'web', name: 'Web', enabled: true, workspaceId: 'w', writeKeys: ['wk'], settings: { a: 1 }, labels: [],
              metadata: { id: 'm', name: 'Javascript', slug: 'javascript', categories: ['Website'], logos: { default: 'x' }, options: [{ big: true }] },
            },
          ],
          pagination: { current: 'MA==', next: 'MQ==', totalEntries: 2 },
        },
      },
      tool('segment_list_sources').responseMapping as any,
    );
    expect(list.value).toEqual({
      sources: [{ id: 's1', name: 'Web', slug: 'web', enabled: true, type: 'Javascript', categories: ['Website'], labels: [] }],
      pagination: { current: 'MA==', next: 'MQ==', totalEntries: 2 },
    });

    const dest = applyResponseTransform(
      {
        data: {
          destination: {
            id: 'd1', name: 'Amplitude', enabled: true, sourceId: 's1',
            metadata: { id: 'm2', name: 'Actions Amplitude', options: [] },
            settings: { apiKey: 'k', secretKey: 's', useBatchEndpoint: true },
          },
        },
      },
      tool('segment_get_destination').responseMapping as any,
    );
    expect(dest.value).toEqual({
      destination: { id: 'd1', name: 'Amplitude', enabled: true, type: 'Actions Amplitude', metadataId: 'm2', sourceId: 's1', settings: { useBatchEndpoint: true } },
    });

    const wh = applyResponseTransform(
      { data: { warehouse: { id: 'w1', enabled: true, metadata: { name: 'Postgres' }, settings: { name: 'prod', hostname: 'db', password: 'p', ciphertext: 'c' } } } },
      tool('segment_get_warehouse').responseMapping as any,
    );
    expect(wh.value).toEqual({ warehouse: { id: 'w1', enabled: true, type: 'Postgres', settings: { name: 'prod', hostname: 'db' } } });
  });
});

const live = process.env.RUN_SEGMENT_LIVE === '1' ? describe : describe.skip;
live('segment adapter: live', () => {
  const real = !!process.env.SEGMENT_API_TOKEN;
  const writes = real && process.env.RUN_SEGMENT_LIVE_WRITES === '1' && !!process.env.SEGMENT_LIVE_SOURCE_ID;
  const env = () => ({ SEGMENT_API_HOST: process.env.SEGMENT_API_HOST || HOST, SEGMENT_API_TOKEN: process.env.SEGMENT_API_TOKEN! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    [HOST, 'segment_get_workspace', {}],
    [EU_HOST, 'segment_get_workspace', {}],
    [HOST, 'segment_list_sources', {}],
    [HOST, 'segment_get_delivery_overview', { step: 'successfully-received', source_id: 's1', start_time: '2026-10-13T00:00:00Z', end_time: '2026-10-14T00:00:00Z', granularity: 'DAY' }],
  ])('%s %s reaches Segment and is refused with a wrong token (403)', async (host, name, params) => {
    await expect(call(name, params, { ...ENV, SEGMENT_API_HOST: host })).rejects.toMatchObject({ response: { status: 403 } });
  }, 30000);

  (real ? it : it.skip)('reads the workspace, sources, destinations, warehouses, audit trail and usage', async () => {
    const ws = await shaped('segment_get_workspace', {}, env());
    expect(ws.workspace.id).toBeTruthy();
    const sources = await shaped('segment_list_sources', { count: 5 }, env());
    expect(Array.isArray(sources.sources)).toBe(true);
    for (const s of sources.sources) expect(s.writeKeys).toBeUndefined();
    const dests = await shaped('segment_list_destinations', { count: 5 }, env());
    expect(Array.isArray(dests.destinations)).toBe(true);
    const whs = await shaped('segment_list_warehouses', { count: 5 }, env());
    expect(Array.isArray(whs.warehouses)).toBe(true);
    const audit = await shaped('segment_list_audit_events', { count: 5 }, env());
    expect(Array.isArray(audit.events)).toBe(true);
    const month = new Date().toISOString().slice(0, 8) + '01';
    const usage = await shaped('segment_get_daily_api_calls_usage', { period: month }, env());
    expect(usage).toBeDefined();
    if (sources.sources.length) {
      const one = await shaped('segment_get_source', { source_id: sources.sources[0].id }, env());
      expect(one.source.id).toBe(sources.sources[0].id);
    }
  }, 120000);

  (writes ? it : it.skip)('renames a test source and renames it back', async () => {
    const id = process.env.SEGMENT_LIVE_SOURCE_ID!;
    const before = await shaped('segment_get_source', { source_id: id }, env());
    await call('segment_update_source', { source_id: id, name: `${before.source.name} (AnythingMCP test)` }, env());
    await call('segment_update_source', { source_id: id, name: before.source.name }, env());
    const after = await shaped('segment_get_source', { source_id: id }, env());
    expect(after.source.name).toBe(before.source.name);
  }, 60000);
});
