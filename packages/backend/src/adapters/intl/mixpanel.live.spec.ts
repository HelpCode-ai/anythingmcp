import axios from 'axios';
import * as adapter from './mixpanel.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Mixpanel adapter:
 *
 *   1. Static: always runs. Pins HTTP Basic auth with the service account,
 *      the data residency host (US, EU, India only), the project id on every
 *      Query API call and in the App API annotation path, the optional data
 *      view id, every tool's method and URL through the real RestEngine, the
 *      form-urlencoded profile query, the annotation bodies, the read-only
 *      and destructive hints and the response caps.
 *
 *   2. Live: skipped unless MIXPANEL_SERVICE_ACCOUNT_USERNAME,
 *      MIXPANEL_SERVICE_ACCOUNT_SECRET and MIXPANEL_PROJECT_ID are set.
 *      MIXPANEL_API_HOST defaults to https://mixpanel.com (use
 *      https://eu.mixpanel.com or https://in.mixpanel.com for those regions);
 *      MIXPANEL_WORKSPACE_ID is passed on when set:
 *
 *        MIXPANEL_SERVICE_ACCOUNT_USERNAME=me.abc.mp-service-account \
 *        MIXPANEL_SERVICE_ACCOUNT_SECRET=... MIXPANEL_PROJECT_ID=3123456 \
 *          npx jest src/adapters/intl/mixpanel.live.spec.ts
 *
 *      Runs every read tool once (about 20 Query API calls of the project's
 *      60 per hour). Empty projects are fine. MIXPANEL_FUNNEL_ID and
 *      MIXPANEL_BOOKMARK_ID pick the funnel and Insights report to query;
 *      without them the first saved funnel is used and the Insights call is
 *      skipped.
 *
 *      MIXPANEL_LIVE_WRITE=1 (needs the Analyst role) also creates an
 *      annotation "AnythingMCP live spec (safe to delete)", reads it, updates
 *      it and deletes it in `finally`.
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
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    bodyEncoding?: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
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

const HOST = 'https://eu.mixpanel.com';
const PROJECT = '3123456';
// Built at runtime so no literal looks like a real credential.
const FAKE_SECRET = 's' + '0'.repeat(31);
const ENV: Record<string, string> = {
  MIXPANEL_API_HOST: HOST,
  MIXPANEL_SERVICE_ACCOUNT_USERNAME: 'anythingmcp.test.mp-service-account',
  MIXPANEL_SERVICE_ACCOUNT_SECRET: FAKE_SECRET,
  MIXPANEL_PROJECT_ID: PROJECT,
};
const Q = `${HOST}/api/query`;
const ANN = `${HOST}/api/app/projects/${PROJECT}/annotations`;

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; env vars also fill in params of the same name.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
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
    },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const QUERY_TOOLS = a.tools.filter((t) => t.endpointMapping.path.startsWith('/api/query/')).map((t) => t.name);
const READ_ONLY = [
  'mixpanel_get_annotation',
  'mixpanel_get_event_counts',
  'mixpanel_get_event_property_counts',
  'mixpanel_get_top_event_properties',
  'mixpanel_get_top_events',
  'mixpanel_get_top_property_values',
  'mixpanel_list_annotation_tags',
  'mixpanel_list_annotations',
  'mixpanel_list_cohorts',
  'mixpanel_list_event_names',
  'mixpanel_list_funnels',
  'mixpanel_query_frequency',
  'mixpanel_query_funnel',
  'mixpanel_query_insights_report',
  'mixpanel_query_profiles',
  'mixpanel_query_retention',
  'mixpanel_query_segmentation',
  'mixpanel_query_segmentation_average',
  'mixpanel_query_segmentation_numeric',
  'mixpanel_query_segmentation_sum',
];

describe('mixpanel adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified against the official API spec on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('signs in with the service account over HTTP Basic, on the data residency host', () => {
    expect(a.category).toBe('analytics');
    expect(a.connector.baseUrl).toBe('{{MIXPANEL_API_HOST}}');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({
      username: '{{MIXPANEL_SERVICE_ACCOUNT_USERNAME}}',
      password: '{{MIXPANEL_SERVICE_ACCOUNT_SECRET}}',
    });
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    expect(a.connector.healthcheckPath).toBe('/api/app/me');
    expect(a.requiredEnvVars).toEqual([
      'MIXPANEL_API_HOST',
      'MIXPANEL_SERVICE_ACCOUNT_USERNAME',
      'MIXPANEL_SERVICE_ACCOUNT_SECRET',
      'MIXPANEL_PROJECT_ID',
    ]);
    expect(a.optionalEnvVars).toEqual(['MIXPANEL_WORKSPACE_ID']);
    const described = describeAdapterEnvVars(a as never);
    const by = (n: string) => described.find((d) => d.name === n)!;
    expect(by('MIXPANEL_API_HOST').kind).toBe('address');
    expect(by('MIXPANEL_SERVICE_ACCOUNT_USERNAME')).toMatchObject({ kind: 'credential', secret: false });
    expect(by('MIXPANEL_SERVICE_ACCOUNT_SECRET')).toMatchObject({ kind: 'credential', secret: true });
    expect(by('MIXPANEL_PROJECT_ID')).toMatchObject({ kind: 'setting', secret: false });
    expect(by('MIXPANEL_WORKSPACE_ID').required).toBe(false);
  });

  it('accepts exactly the US, EU and India hosts', () => {
    const host = new RegExp(a.envVarMeta.MIXPANEL_API_HOST.pattern!);
    for (const ok of ['https://mixpanel.com', 'https://eu.mixpanel.com', 'https://in.mixpanel.com']) {
      expect(host.test(ok)).toBe(true);
    }
    for (const bad of [
      'https://mixpanel.com/',
      'https://mixpanel.com/api/query',
      'https://mixpanel.com.evil.example',
      'https://evil.example/mixpanel.com',
      'http://mixpanel.com',
      'mixpanel.com',
      'https://api.mixpanel.com',
      'https://api-eu.mixpanel.com',
      'https://data.mixpanel.com',
      'https://data-eu.mixpanel.com',
      'https://us.mixpanel.com',
    ]) {
      expect(`${bad}:${host.test(bad)}`).toBe(`${bad}:false`);
    }
    const project = new RegExp(a.envVarMeta.MIXPANEL_PROJECT_ID.pattern!);
    expect(project.test(PROJECT)).toBe(true);
    for (const bad of ['', 'abc', '3123456 ', 'https://mixpanel.com/project/3123456']) expect(project.test(bad)).toBe(false);
    const workspace = new RegExp(a.envVarMeta.MIXPANEL_WORKSPACE_ID.pattern!);
    expect(workspace.test('')).toBe(true);
    expect(workspace.test('3654321')).toBe(true);
    expect(workspace.test('view-1')).toBe(false);
  });

  it('probes with a short list of event names', () => {
    expect(a.probe).toEqual({ tool: 'mixpanel_list_event_names', params: { limit: 5 } });
    expect(tool('mixpanel_list_event_names').parameters.required).toBeUndefined();
  });

  it('prefixes every tool with mixpanel_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^mixpanel_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only (POST queries included), annotation changes as writes, and installs delete switched off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(READ_ONLY);
    for (const name of ['mixpanel_list_cohorts', 'mixpanel_query_profiles']) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(tool(name).annotations).toEqual({ readOnlyHint: true });
      expect(tool(name).description).toMatch(/read-only although/i);
    }
    const writes = a.tools.filter((t) => !READ_ONLY.includes(t.name)).map((t) => t.name).sort();
    expect(writes).toEqual(['mixpanel_create_annotation', 'mixpanel_delete_annotation', 'mixpanel_update_annotation']);
    expect(annotationsOf(tool('mixpanel_create_annotation')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('mixpanel_delete_annotation')).destructiveHint).toBe(true);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['mixpanel_delete_annotation']);
    for (const name of writes) expect(tool(name).description).toMatch(/confirm/i);
    for (const name of [...writes, 'mixpanel_list_annotation_tags']) expect(tool(name).description).toMatch(/Analyst/);
  });

  it('only points the model at tools that exist, documents setup and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmixpanel_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmixpanel_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(15);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('https://mixpanel.com/settings/org#serviceaccounts');
    expect(a.instructions).toContain('https://eu.mixpanel.com');
    expect(a.instructions).toContain('https://in.mixpanel.com');
    expect(a.instructions).toMatch(/60 queries per hour/);
    expect(a.instructions).toMatch(/Out of scope/);
    expect(a.instructions).toMatch(/JQL/);
    expect(a.prerequisites).toMatch(/Growth or Enterprise/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof (schema as { description?: string }).description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('caps the answers that can grow large', () => {
    for (const name of [
      'mixpanel_get_event_counts',
      'mixpanel_get_event_property_counts',
      'mixpanel_query_segmentation',
      'mixpanel_query_segmentation_numeric',
      'mixpanel_query_segmentation_sum',
      'mixpanel_query_segmentation_average',
      'mixpanel_query_funnel',
      'mixpanel_query_retention',
      'mixpanel_query_frequency',
      'mixpanel_query_insights_report',
      'mixpanel_query_profiles',
    ]) {
      expect(tool(name).responseMapping).toMatchObject({ transform: { maxBytes: 200000 } });
    }
  });

  const D = { from_date: '2026-09-01', to_date: '2026-09-30' };
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['mixpanel_list_event_names', {}, 'GET', `${Q}/events/names`],
    ['mixpanel_get_top_events', {}, 'GET', `${Q}/events/top`],
    ['mixpanel_get_event_counts', { events: '["Sign Up"]', ...D }, 'GET', `${Q}/events`],
    ['mixpanel_get_top_event_properties', { event: 'Sign Up' }, 'GET', `${Q}/events/properties/top`],
    ['mixpanel_get_top_property_values', { event: 'Sign Up', name: 'plan' }, 'GET', `${Q}/events/properties/values`],
    ['mixpanel_get_event_property_counts', { event: 'Sign Up', name: 'plan', ...D }, 'GET', `${Q}/events/properties`],
    ['mixpanel_query_segmentation', { event: 'Sign Up', ...D }, 'GET', `${Q}/segmentation`],
    ['mixpanel_query_segmentation_numeric', { event: 'Purchase', on: 'number(properties["amount"])', ...D }, 'GET', `${Q}/segmentation/numeric`],
    ['mixpanel_query_segmentation_sum', { event: 'Purchase', on: 'properties["amount"]', ...D }, 'GET', `${Q}/segmentation/sum`],
    ['mixpanel_query_segmentation_average', { event: 'Purchase', on: 'properties["amount"]', ...D }, 'GET', `${Q}/segmentation/average`],
    ['mixpanel_list_funnels', {}, 'GET', `${Q}/funnels/list`],
    ['mixpanel_query_funnel', { funnel_id: 7509, ...D }, 'GET', `${Q}/funnels`],
    ['mixpanel_query_retention', D, 'GET', `${Q}/retention`],
    ['mixpanel_query_frequency', { ...D, unit: 'week', addiction_unit: 'day' }, 'GET', `${Q}/retention/addiction`],
    ['mixpanel_query_insights_report', { bookmark_id: 12345 }, 'GET', `${Q}/insights`],
    ['mixpanel_list_cohorts', {}, 'POST', `${Q}/cohorts/list`],
    ['mixpanel_query_profiles', { where: 'defined(user["$email"])' }, 'POST', `${Q}/engage`],
    ['mixpanel_list_annotations', {}, 'GET', ANN],
    ['mixpanel_get_annotation', { annotation_id: 42 }, 'GET', `${ANN}/42`],
    ['mixpanel_list_annotation_tags', {}, 'GET', `${ANN}/tags`],
    ['mixpanel_create_annotation', { date: '2026-10-01 09:00:00', description: 'Launch' }, 'POST', ANN],
    ['mixpanel_update_annotation', { annotation_id: 42, description: 'Launch v2' }, 'PATCH', `${ANN}/42`],
    ['mixpanel_delete_annotation', { annotation_id: 42 }, 'DELETE', `${ANN}/42`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the service account', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.auth).toEqual({ username: ENV.MIXPANEL_SERVICE_ACCOUNT_USERNAME, password: FAKE_SECRET });
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
    if (QUERY_TOOLS.includes(name)) {
      expect(req.params.project_id).toBe(PROJECT);
      // No data view configured: no workspace_id at all, not an empty one.
      expect(req.params).not.toHaveProperty('workspace_id');
    } else {
      expect(req.params?.project_id).toBeUndefined();
    }
  });

  it('puts the project id on every Query API tool and the data view id when one is set', async () => {
    expect(QUERY_TOOLS).toHaveLength(17);
    for (const name of QUERY_TOOLS) {
      expect(tool(name).endpointMapping.queryParams).toMatchObject({
        project_id: '{{MIXPANEL_PROJECT_ID}}',
        workspace_id: '${MIXPANEL_WORKSPACE_ID}',
      });
    }
    mockedAxios.mockResolvedValue({ data: [] });
    await execute('mixpanel_list_funnels', { ...ENV, MIXPANEL_WORKSPACE_ID: '3654321' }, {});
    expect(sent().params).toEqual({ project_id: PROJECT, workspace_id: '3654321' });
    mockedAxios.mockClear();
    await execute('mixpanel_list_funnels', { ...ENV, MIXPANEL_WORKSPACE_ID: '' }, {});
    expect(sent().params).toEqual({ project_id: PROJECT });
  });

  it('sends the documented query parameters, with general counts by default', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('mixpanel_list_event_names', { limit: 5 });
    expect(sent().params).toEqual({ project_id: PROJECT, type: 'general', limit: 5 });
    mockedAxios.mockClear();
    await call('mixpanel_get_event_counts', { events: '["Sign Up","Purchase"]', type: 'unique', unit: 'week', ...D });
    expect(sent().params).toEqual({ project_id: PROJECT, event: '["Sign Up","Purchase"]', type: 'unique', unit: 'week', ...D });
    mockedAxios.mockClear();
    await call('mixpanel_query_segmentation', {
      event: 'Purchase',
      ...D,
      on: 'properties["$country_code"]',
      where: 'properties["plan"] == "pro"',
      unit: 'month',
      limit: 20,
    });
    expect(sent().params).toEqual({
      project_id: PROJECT,
      event: 'Purchase',
      ...D,
      on: 'properties["$country_code"]',
      where: 'properties["plan"] == "pro"',
      unit: 'month',
      type: 'general',
      limit: 20,
    });
    mockedAxios.mockClear();
    await call('mixpanel_query_retention', { ...D, born_event: 'Sign Up', event: 'Purchase', unit: 'week', interval_count: 8, unbounded_retention: true });
    expect(sent().params).toEqual({ project_id: PROJECT, ...D, born_event: 'Sign Up', event: 'Purchase', unit: 'week', interval_count: 8, unbounded_retention: true });
    mockedAxios.mockClear();
    await call('mixpanel_list_annotations', D);
    expect(sent().params).toEqual({ fromDate: D.from_date, toDate: D.to_date });
  });

  it('queries profiles as a form-urlencoded POST with JSON-encoded list fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mixpanel_query_profiles', {
      where: 'user["plan"] == "pro"',
      output_properties: '["$email","plan"]',
      filter_by_cohort: '{"id":12345}',
      include_all_users: false,
      session_id: '1234567890-EXAMPL',
      page: 1,
    });
    const req = sent();
    expect(req.params).toEqual({ project_id: PROJECT });
    expect(req.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(req.data))).toEqual({
      where: 'user["plan"] == "pro"',
      output_properties: '["$email","plan"]',
      filter_by_cohort: '{"id":12345}',
      include_all_users: 'false',
      session_id: '1234567890-EXAMPL',
      page: '1',
    });
  });

  it('keeps the paging fields ahead of a truncated profile page', () => {
    const results = Array.from({ length: 1000 }, (_, i) => ({ $distinct_id: `u-${i}`, $properties: { note: 'x'.repeat(400) } }));
    const raw = { page: 0, page_size: 1000, results, session_id: 'S-1', status: 'ok', total: 1000 };
    const out = applyResponseTransform(raw, tool('mixpanel_query_profiles').responseMapping);
    expect(out.truncated).toBe(true);
    const preview = String((out.value as { preview: string }).preview);
    expect(preview.indexOf('"session_id":"S-1"')).toBeGreaterThan(-1);
    expect(preview.indexOf('"session_id"')).toBeLessThan(preview.indexOf('"results"'));
    const small = applyResponseTransform({ ...raw, results: results.slice(0, 2) }, tool('mixpanel_query_profiles').responseMapping);
    expect(small.value).toMatchObject({ page: 0, session_id: 'S-1', total: 1000 });
  });

  it('lists cohorts with a POST that carries no body', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('mixpanel_list_cohorts', {});
    expect(sent().data).toBeUndefined();
  });

  it('creates and updates annotations with the documented JSON bodies, and deletes without one', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mixpanel_create_annotation', { date: '2026-10-01 09:00:00', description: 'Launch', tags: [3, 4] });
    expect(sent().data).toEqual({ date: '2026-10-01 09:00:00', description: 'Launch', tags: [3, 4] });
    mockedAxios.mockClear();
    await call('mixpanel_update_annotation', { annotation_id: 42, description: 'Launch v2' });
    expect(sent().data).toEqual({ description: 'Launch v2' });
    mockedAxios.mockClear();
    await call('mixpanel_delete_annotation', { annotation_id: 42 });
    expect(sent().data).toBeUndefined();
    for (const name of ['mixpanel_get_annotation', 'mixpanel_update_annotation', 'mixpanel_delete_annotation']) {
      expect(tool(name).endpointMapping.encodePathParams).toBe(true);
    }
  });
});

const USER = process.env.MIXPANEL_SERVICE_ACCOUNT_USERNAME;
const SECRET = process.env.MIXPANEL_SERVICE_ACCOUNT_SECRET;
const PROJECT_ID = process.env.MIXPANEL_PROJECT_ID;
const live = USER && SECRET && PROJECT_ID ? describe : describe.skip;

live('mixpanel adapter: live Query and App API', () => {
  const env: Record<string, string> = {
    MIXPANEL_API_HOST: process.env.MIXPANEL_API_HOST || 'https://mixpanel.com',
    MIXPANEL_SERVICE_ACCOUNT_USERNAME: USER as string,
    MIXPANEL_SERVICE_ACCOUNT_SECRET: SECRET as string,
    MIXPANEL_PROJECT_ID: PROJECT_ID as string,
    MIXPANEL_WORKSPACE_ID: process.env.MIXPANEL_WORKSPACE_ID || '',
  };
  const write = process.env.MIXPANEL_LIVE_WRITE === '1';
  const day = (offset: number) => new Date(Date.now() - offset * 86400_000).toISOString().slice(0, 10);
  const range = { from_date: day(8), to_date: day(1) };
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);
  // An answer from Mixpanel (e.g. 400 for an expression the data cannot
  // satisfy, 403 for a role that is too low) rather than a crash.
  const answered = (e: { response?: { status: number } }) => {
    expect(e.response?.status).toBeGreaterThanOrEqual(400);
  };

  // The Free plan has no Query API: every report answers 402. Those tests then
  // only check that the refusal is that 402 and stop.
  let queryApi = true;
  beforeAll(async () => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
    try {
      await run('mixpanel_list_event_names', { limit: 1 });
    } catch (e) {
      if ((e as { response?: { status?: number } }).response?.status === 402) queryApi = false;
    }
  });

  it('refuses a wrong secret with 401', async () => {
    const wrong = { ...env, MIXPANEL_SERVICE_ACCOUNT_SECRET: 'x' + '0'.repeat(31) };
    await expect(execute('mixpanel_list_funnels', wrong, {})).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);

  it('reads events, properties and segmentation (empty projects included)', async () => {
    if (!queryApi) return;
    const names = await run('mixpanel_list_event_names', { limit: 10 });
    expect(Array.isArray(names)).toBe(true);
    const top = await run('mixpanel_get_top_events', { limit: 5 });
    expect(Array.isArray(top.events)).toBe(true);
    const event: string = names[0] ?? 'AnythingMCP live spec';
    const props = await run('mixpanel_get_top_event_properties', { event, limit: 5 });
    expect(typeof props).toBe('object');
    const prop = Object.keys(props)[0] ?? '$browser';
    const values = await run('mixpanel_get_top_property_values', { event, name: prop, limit: 5 });
    expect(Array.isArray(values)).toBe(true);
    const counts = await run('mixpanel_get_event_counts', { events: JSON.stringify([event]), ...range });
    expect(counts.data).toBeDefined();
    const byProp = await run('mixpanel_get_event_property_counts', { event, name: prop, ...range, limit: 5 });
    expect(byProp.data).toBeDefined();
    const seg = await run('mixpanel_query_segmentation', { event, ...range, on: `properties["${prop}"]`, limit: 5 });
    expect(seg.data).toBeDefined();
    const sum = await run('mixpanel_query_segmentation_sum', { event, ...range, on: '1' });
    expect(sum.results ?? sum).toBeDefined();
    const avg = await run('mixpanel_query_segmentation_average', { event, ...range, on: '1' });
    expect(avg.results ?? avg).toBeDefined();
    await run('mixpanel_query_segmentation_numeric', { event, ...range, on: '1' })
      .then((r) => expect(r.data ?? r).toBeDefined())
      .catch(answered);
  }, 120_000);

  it('reads funnels, retention, frequency and Insights', async () => {
    if (!queryApi) return;
    const funnels = await run('mixpanel_list_funnels');
    expect(Array.isArray(funnels)).toBe(true);
    const funnelId = Number(process.env.MIXPANEL_FUNNEL_ID || funnels[0]?.funnel_id || 0);
    if (funnelId) {
      const funnel = await run('mixpanel_query_funnel', { funnel_id: funnelId, ...range });
      expect(funnel.meta ?? funnel.data).toBeDefined();
    }
    const retention = await run('mixpanel_query_retention', { ...range, retention_type: 'compounded', interval_count: 3 });
    expect(typeof retention).toBe('object');
    const frequency = await run('mixpanel_query_frequency', { ...range, unit: 'week', addiction_unit: 'day' });
    expect(typeof frequency).toBe('object');
    if (process.env.MIXPANEL_BOOKMARK_ID) {
      const report = await run('mixpanel_query_insights_report', { bookmark_id: Number(process.env.MIXPANEL_BOOKMARK_ID) });
      expect(report.series ?? report).toBeDefined();
    }
  }, 120_000);

  it('reads cohorts and profiles', async () => {
    if (!queryApi) return;
    const cohorts = await run('mixpanel_list_cohorts');
    expect(Array.isArray(cohorts)).toBe(true);
    const profiles = await run('mixpanel_query_profiles', { output_properties: '["$email","$name"]' });
    expect(Array.isArray(profiles.results)).toBe(true);
    if (cohorts[0]) {
      const members = await run('mixpanel_query_profiles', { filter_by_cohort: JSON.stringify({ id: cohorts[0].id }), output_properties: '["$email"]' });
      expect(Array.isArray(members.results)).toBe(true);
    }
  }, 120_000);

  it('reads annotations and their tags', async () => {
    const list = await run('mixpanel_list_annotations', { from_date: day(365), to_date: day(0) });
    expect(Array.isArray(list.results)).toBe(true);
    if (list.results[0]) {
      const one = await run('mixpanel_get_annotation', { annotation_id: list.results[0].id });
      expect(one.results.id).toBe(list.results[0].id);
    }
    // Tags need the Analyst role; a Consumer account gets 403.
    await run('mixpanel_list_annotation_tags')
      .then((tags) => expect(Array.isArray(tags.results ?? tags)).toBe(true))
      .catch(answered);
  }, 60_000);

  (write ? it : it.skip)('creates, reads, updates and deletes an annotation', async () => {
    const created = await run('mixpanel_create_annotation', {
      date: `${day(1)} 12:00:00`,
      description: 'AnythingMCP live spec (safe to delete)',
    });
    const id = created.results.id;
    expect(id).toBeDefined();
    try {
      const read = await run('mixpanel_get_annotation', { annotation_id: id });
      expect(read.results.description).toBe('AnythingMCP live spec (safe to delete)');
      const updated = await run('mixpanel_update_annotation', { annotation_id: id, description: 'AnythingMCP live spec, updated (safe to delete)' });
      expect(updated.results.description).toBe('AnythingMCP live spec, updated (safe to delete)');
    } finally {
      const deleted = await run('mixpanel_delete_annotation', { annotation_id: id });
      expect(deleted.results.id).toBe(id);
    }
  }, 60_000);
});
