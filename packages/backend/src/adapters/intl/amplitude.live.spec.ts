import axios from 'axios';
import * as adapter from './amplitude.json';
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
 * Two layers of verification for the Amplitude adapter:
 *
 *   1. Static: always runs. Pins HTTP Basic with the project API key and
 *      secret key, the data-center host variable (amplitude.com or
 *      analytics.eu.amplitude.com), every tool's method, URL and query
 *      through the real RestEngine, checked against Amplitude's docs
 *      (amplitude.com/docs/apis/analytics: dashboard-rest, taxonomy,
 *      behavioral-cohorts, chart-annotations; fetched 14 Oct 2026): event
 *      JSON in `e`, one repeated `e` per funnel step, YYYYMMDD dates, the
 *      encoded event type in the taxonomy path. Also which tools only read,
 *      that the annotation delete ships switched off, and that every response
 *      mapping actually runs (a transform with only maxBytes would be skipped).
 *
 *   2. Live: skipped unless RUN_AMPLITUDE_LIVE=1. Without credentials it
 *      checks that both hosts refuse wrong ones with 403 "Invalid API Key".
 *      With AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY (and AMPLITUDE_API_HOST
 *      for an EU project) it reads the event list, the taxonomy, active users
 *      of the last 7 days and real-time users, shaped by each tool's
 *      responseMapping like production does. RUN_AMPLITUDE_LIVE_WRITES=1 also
 *      creates an annotation and deletes it again:
 *
 *        RUN_AMPLITUDE_LIVE=1 AMPLITUDE_API_KEY=... AMPLITUDE_SECRET_KEY=... \
 *          npx jest src/adapters/intl/amplitude.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[]; pattern?: string }>; required?: string[] };
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

const HOST = 'https://amplitude.com';
const EU_HOST = 'https://analytics.eu.amplitude.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'a'.repeat(32);
const FAKE_SECRET = 'b'.repeat(32);
const ENV: Record<string, string> = { AMPLITUDE_API_HOST: `${HOST}/`, AMPLITUDE_API_KEY: FAKE_KEY, AMPLITUDE_SECRET_KEY: FAKE_SECRET };

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

const WRITES = ['amplitude_create_annotation', 'amplitude_delete_annotation'];

describe('amplitude adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against vendor SDKs, specs and working clients on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('authenticates with API key and secret key as HTTP Basic on the data-center host', () => {
    expect(a.category).toBe('analytics');
    expect(a.icon).toBe('amplitude');
    expect(a.connector.baseUrl).toBe('{{AMPLITUDE_API_HOST}}');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{AMPLITUDE_API_KEY}}', password: '{{AMPLITUDE_SECRET_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/api/2/events/list');
    expect(a.requiredEnvVars).toEqual(['AMPLITUDE_API_HOST', 'AMPLITUDE_API_KEY', 'AMPLITUDE_SECRET_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.AMPLITUDE_API_HOST).toMatchObject({ kind: 'address', required: true, secret: false });
    expect(meta.AMPLITUDE_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.AMPLITUDE_SECRET_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts the US and EU API hosts and refuses the web app, paths and lookalikes', () => {
    const url = new RegExp(a.envVarMeta.AMPLITUDE_API_HOST.pattern!);
    for (const ok of [HOST, `${HOST}/`, EU_HOST, `${EU_HOST}/`, 'amplitude.com', 'analytics.eu.amplitude.com']) expect(url.test(ok)).toBe(true);
    for (const bad of ['', 'https://analytics.amplitude.com', 'https://app.amplitude.com', `${HOST}/api/2`, 'http://amplitude.com', 'https://amplitude.com.evil.example', 'https://eu.amplitude.com']) {
      expect(url.test(bad)).toBe(false);
    }
    expect(checkBaseUrlValue('analytics.eu.amplitude.com')).toEqual({ ok: true, value: EU_HOST });
  });

  it('probes with the event list and explains wrong keys and the wrong data center', () => {
    expect(a.probe).toEqual({ tool: 'amplitude_list_events' });
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['403']).toMatch(/analytics\.eu\.amplitude\.com/);
  });

  it('prefixes every tool with amplitude_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^amplitude_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('only writes annotations, asks for confirmation, and ships the delete switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(annotationsOf(tool('amplitude_create_annotation'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsOf(tool('amplitude_delete_annotation'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['amplitude_delete_annotation']);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm/i);
  });

  it('documents every tool, the limits and the two hosts, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bamplitude_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bamplitude_[a-z_]+/g)]),
    ]
      .map((m) => m[0])
      // amplitude_id is Amplitude's own user id field, not a tool.
      .filter((m) => m !== 'amplitude_id');
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/5 requests at the same time/);
    expect(a.instructions).toMatch(/1,000 per 5 minutes and 108,000 per hour/);
    expect(a.instructions).toMatch(/360 per hour/);
    expect(a.instructions).toContain('https://analytics.eu.amplitude.com');
    expect(a.instructions).toMatch(/Out of scope/);
    for (const name of ['amplitude_get_event_segmentation', 'amplitude_get_funnel', 'amplitude_get_retention']) {
      expect(tool(name).description).toMatch(/108,000 per hour/);
    }
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings that really run (not maxBytes alone)', () => {
    for (const t of a.tools) {
      if (!t.responseMapping) continue;
      expect(validateTransform(t.responseMapping.transform)).toBeNull();
      expect(`${t.name}:${hasTransform(t.responseMapping as any)}`).toBe(`${t.name}:true`);
    }
  });

  const range = { start: '20261001', end: '20261007' };
  const ev = '{"event_type":"Sign Up"}';
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['amplitude_list_events', {}, 'GET', '/api/2/events/list'],
    ['amplitude_get_event_segmentation', { event: ev, ...range }, 'GET', '/api/2/events/segmentation'],
    ['amplitude_get_funnel', { events: [ev, '{"event_type":"Purchase"}'], ...range }, 'GET', '/api/2/funnels'],
    ['amplitude_get_retention', { start_event: '{"event_type":"_new"}', return_event: '{"event_type":"_active"}', ...range }, 'GET', '/api/2/retention'],
    ['amplitude_get_active_users', range, 'GET', '/api/2/users'],
    ['amplitude_get_realtime_active_users', {}, 'GET', '/api/2/realtime'],
    ['amplitude_get_revenue_ltv', range, 'GET', '/api/2/revenue/ltv'],
    ['amplitude_get_session_length_distribution', range, 'GET', '/api/2/sessions/length'],
    ['amplitude_get_average_session_length', range, 'GET', '/api/2/sessions/average'],
    ['amplitude_get_sessions_per_user', range, 'GET', '/api/2/sessions/peruser'],
    ['amplitude_get_user_composition', { ...range, property: 'country' }, 'GET', '/api/2/composition'],
    ['amplitude_get_chart_results', { chart_id: 'abc123' }, 'GET', '/api/3/chart/abc123/csv'],
    ['amplitude_list_cohorts', {}, 'GET', '/api/3/cohorts'],
    ['amplitude_search_users', { user: 'jane@example.com' }, 'GET', '/api/2/usersearch'],
    ['amplitude_get_user_activity', { amplitude_id: '356893043036' }, 'GET', '/api/2/useractivity'],
    ['amplitude_list_event_types', {}, 'GET', '/api/2/taxonomy/event'],
    ['amplitude_get_event_type', { event_type: 'Play Song' }, 'GET', '/api/2/taxonomy/event/Play%20Song'],
    ['amplitude_list_event_properties', { event_type: 'Sign Up' }, 'GET', '/api/2/taxonomy/event-property'],
    ['amplitude_list_user_properties', {}, 'GET', '/api/2/taxonomy/user-property'],
    ['amplitude_list_event_categories', {}, 'GET', '/api/2/taxonomy/category'],
    ['amplitude_list_annotations', {}, 'GET', '/api/3/annotations'],
    ['amplitude_create_annotation', { label: 'Release 4.2', start: '2026-10-14T09:00:00+00:00' }, 'POST', '/api/3/annotations'],
    ['amplitude_delete_annotation', { annotation_id: 12345 }, 'DELETE', '/api/3/annotations/12345'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with Basic credentials', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.auth).toEqual({ username: FAKE_KEY, password: FAKE_SECRET });
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('goes to the EU host for EU projects', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('amplitude_list_events', {}, { ...ENV, AMPLITUDE_API_HOST: EU_HOST });
    expect(sent().url).toBe(`${EU_HOST}/api/2/events/list`);
  });

  it('sends segmentation with the documented short query names and the event as JSON text', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('amplitude_get_event_segmentation', {
      event: ev,
      second_event: '{"event_type":"Purchase"}',
      ...range,
      metric: 'formula',
      formula: 'UNIQUES(B)/UNIQUES(A)',
      interval: 7,
      segments: '[{"prop":"country","op":"is","values":["Germany"]}]',
      group_by: 'platform',
      limit: 10,
    });
    expect(sent().params).toEqual({
      e: ev,
      e2: '{"event_type":"Purchase"}',
      start: '20261001',
      end: '20261007',
      m: 'formula',
      formula: 'UNIQUES(B)/UNIQUES(A)',
      i: 7,
      s: '[{"prop":"country","op":"is","values":["Germany"]}]',
      g: 'platform',
      limit: 10,
    });
    expect(new URLSearchParams(query()).get('e')).toBe(ev);
  });

  it('repeats e once per funnel step, in order', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('amplitude_get_funnel', { events: [ev, '{"event_type":"Purchase"}'], ...range, mode: 'unordered', conversion_window_seconds: 86400 });
    const q = new URLSearchParams(query());
    expect(q.getAll('e')).toEqual([ev, '{"event_type":"Purchase"}']);
    expect(q.get('mode')).toBe('unordered');
    expect(q.get('cs')).toBe('86400');
    expect(q.has('e[]')).toBe(false);
  });

  it('maps retention, user, taxonomy and annotation parameters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('amplitude_get_retention', { start_event: '{"event_type":"_new"}', return_event: '{"event_type":"_all"}', ...range, retention_mode: 'bracket', brackets: '[[0,5]]', interval: 7 });
    expect(sent().params).toEqual({ se: '{"event_type":"_new"}', re: '{"event_type":"_all"}', start: '20261001', end: '20261007', rm: 'bracket', rb: '[[0,5]]', i: 7 });
    mockedAxios.mockClear();
    await call('amplitude_get_user_activity', { amplitude_id: '356893043036' });
    expect(sent().params).toEqual({ user: '356893043036', limit: 50 });
    mockedAxios.mockClear();
    await call('amplitude_list_event_properties', { event_type: 'Sign Up' });
    expect(sent().params).toEqual({ event_type: 'Sign Up' });
    mockedAxios.mockClear();
    await call('amplitude_get_session_length_distribution', { ...range, bin_unit: 'minutes', bin_min: 0, bin_max: 10, bin_size: 1 });
    expect(sent().params).toEqual({
      start: '20261001',
      end: '20261007',
      timeHistogramConfigBinTimeUnit: 'minutes',
      timeHistogramConfigBinMin: 0,
      timeHistogramConfigBinMax: 10,
      timeHistogramConfigBinSize: 1,
    });
    mockedAxios.mockClear();
    await call('amplitude_create_annotation', { label: 'Release 4.2', start: '2026-10-14T09:00:00+00:00', category: 'Releases' });
    expect(sent().data).toEqual({ label: 'Release 4.2', start: '2026-10-14T09:00:00+00:00', category: 'Releases' });
  });

  it('shapes the event list, funnel and user activity answers', () => {
    const list = applyResponseTransform(
      {
        data: [
          { value: 'Sign Up', display: 'Sign Up', totals: 120, deleted: false, hidden: false, non_active: false, flow_hidden: false },
          { value: 'Old', display: 'Old', totals: 0, deleted: true, hidden: false, non_active: true, flow_hidden: false },
        ],
      },
      tool('amplitude_list_events').responseMapping as any,
    );
    expect(list.value).toEqual({ events: [{ event_type: 'Sign Up', display: 'Sign Up', weekly_totals: 120, hidden: false, non_active: false }] });

    const funnel = applyResponseTransform(
      { data: [{ events: ['A', 'B'], cumulativeRaw: [10, 4], stepTransTimeDistribution: { bins: [] }, dayAvgTransTimes: { series: [] } }] },
      tool('amplitude_get_funnel').responseMapping as any,
    );
    expect(funnel.value).toEqual({ data: [{ events: ['A', 'B'], cumulativeRaw: [10, 4] }] });

    const activity = applyResponseTransform(
      {
        userData: { user_id: 'u1', num_events: 2 },
        events: [{ event_type: 'Sign Up', event_time: '2026-10-01 10:00:00', session_id: 1, event_properties: { plan: 'pro' }, user_properties: { big: 'x' }, $insert_id: 'i' }],
      },
      tool('amplitude_get_user_activity').responseMapping as any,
    );
    expect(activity.value).toEqual({
      userData: { user_id: 'u1', num_events: 2 },
      events: [{ event_type: 'Sign Up', event_time: '2026-10-01 10:00:00', session_id: 1, event_properties: { plan: 'pro' } }],
    });
  });
});

const live = process.env.RUN_AMPLITUDE_LIVE === '1' ? describe : describe.skip;
live('amplitude adapter: live', () => {
  const real = process.env.AMPLITUDE_API_KEY && process.env.AMPLITUDE_SECRET_KEY;
  const writes = real && process.env.RUN_AMPLITUDE_LIVE_WRITES === '1';
  const env = () => ({
    AMPLITUDE_API_HOST: process.env.AMPLITUDE_API_HOST || HOST,
    AMPLITUDE_API_KEY: process.env.AMPLITUDE_API_KEY!,
    AMPLITUDE_SECRET_KEY: process.env.AMPLITUDE_SECRET_KEY!,
  });
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    [HOST, 'amplitude_list_events', {}],
    [EU_HOST, 'amplitude_list_events', {}],
    [HOST, 'amplitude_list_event_types', {}],
    [HOST, 'amplitude_get_chart_results', { chart_id: 'abc123' }],
    [HOST, 'amplitude_list_annotations', {}],
  ])('%s %s reaches Amplitude and is refused with wrong credentials (403)', async (host, name, params) => {
    await expect(call(name, params, { ...ENV, AMPLITUDE_API_HOST: host })).rejects.toMatchObject({ response: { status: 403 } });
  }, 30000);

  (real ? it : it.skip)('reads events, taxonomy, active users of the last 7 days and real-time users', async () => {
    const events = await shaped('amplitude_list_events', {}, env());
    expect(Array.isArray(events.events)).toBe(true);
    const types = await shaped('amplitude_list_event_types', {}, env());
    expect(Array.isArray(types.event_types)).toBe(true);
    const userProps = await shaped('amplitude_list_user_properties', {}, env());
    expect(Array.isArray(userProps.user_properties)).toBe(true);
    const end = new Date();
    const start = new Date(end.getTime() - 6 * 86400000);
    const users = await shaped('amplitude_get_active_users', { start: ymd(start), end: ymd(end) }, env());
    expect(Array.isArray(users.data.xValues)).toBe(true);
    const rt = await shaped('amplitude_get_realtime_active_users', {}, env());
    expect(Array.isArray(rt.data.series)).toBe(true);
    if (events.events.length) {
      const seg = await shaped('amplitude_get_event_segmentation', { event: JSON.stringify({ event_type: events.events[0].event_type }), start: ymd(end), end: ymd(end) }, env());
      expect(seg.data).toBeDefined();
    }
  }, 120000);

  (writes ? it : it.skip)('creates an annotation and deletes it again', async () => {
    const created = await call('amplitude_create_annotation', { label: `AnythingMCP live test ${Date.now()}`, start: new Date().toISOString().replace('Z', '+00:00') }, env());
    expect(created.data.id).toBeDefined();
    const listed = await shaped('amplitude_list_annotations', {}, env());
    expect(listed.annotations.some((x: any) => x.id === created.data.id)).toBe(true);
    await call('amplitude_delete_annotation', { annotation_id: created.data.id }, env());
  }, 60000);
});
