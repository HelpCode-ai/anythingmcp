import axios from 'axios';
import * as adapter from './grafana.json';
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
 * Two layers of verification for the Grafana adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with a service account token on
 *      the instance URL the user enters, and every tool's method, URL, query
 *      and body through the real RestEngine, checked against Grafana's OpenAPI
 *      documents (grafana/grafana: public/openapi3.json for the HTTP API and
 *      pkg/services/ngalert/api/tooling/post.json for alerting), its alerting
 *      authorization rules and Grafana's own MCP server source (read 15 Oct
 *      2026). Also that the only write asks for confirmation and that contact
 *      point settings and data source secrets never come back.
 *
 *   2. Live: skipped unless RUN_GRAFANA_LIVE=1.
 *      - A wrong token is refused with 401 on a Grafana Cloud stack
 *        (GRAFANA_URL, default https://grafana.grafana.net), which checks the
 *        token before routing.
 *      - Without GRAFANA_SERVICE_ACCOUNT_TOKEN the read tools run against
 *        https://play.grafana.org, Grafana's public demo with anonymous Viewer
 *        access, shaped by each tool's response mapping as production does.
 *      - With GRAFANA_URL and GRAFANA_SERVICE_ACCOUNT_TOKEN they run against
 *        that instance instead (GRAFANA_TEST_PROMETHEUS_UID picks the data
 *        source for the query check). RUN_GRAFANA_LIVE_WRITES=1 then also adds one
 *        annotation tagged anythingmcp-test.
 *
 *        RUN_GRAFANA_LIVE=1 npx jest src/adapters/intl/grafana.live.spec.ts
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
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'glsa_' + 'x'.repeat(32) + '_' + '0'.repeat(8);
const ENV: Record<string, string> = { GRAFANA_URL: 'https://acme.grafana.net', GRAFANA_SERVICE_ACCOUNT_TOKEN: FAKE_TOKEN };
const API = 'https://acme.grafana.net/api';

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; connector variables and schema defaults merged into params.
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
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) => shape(name, await call(name, params, env));
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => {
  const req = sent();
  return req.paramsSerializer ? decodeURIComponent(req.paramsSerializer(req.params)) : '';
};

describe('grafana adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the service account token as Bearer to the instance URL', () => {
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('grafana');
    expect(a.connector.baseUrl).toBe('{{GRAFANA_URL}}/api');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{GRAFANA_SERVICE_ACCOUNT_TOKEN}}' });
    // /api/health answers without a token, so the check uses /api/org.
    expect(a.connector.healthcheckPath).toBe('/org');
    expect(a.probe.tool).toBe('grafana_get_current_org');
    expect(a.requiredEnvVars).toEqual(['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.GRAFANA_URL).toMatchObject({ kind: 'address', secret: false });
    expect(meta.GRAFANA_SERVICE_ACCOUNT_TOKEN).toMatchObject({ kind: 'credential', secret: true });
  });

  it('accepts Cloud, self-hosted and sub-path URLs without a trailing slash, and a bare token', () => {
    const url = new RegExp(a.envVarMeta.GRAFANA_URL.pattern!);
    for (const ok of ['https://acme.grafana.net', 'https://grafana.example.com', 'https://example.com/grafana', 'http://grafana.local:3000']) expect(url.test(ok)).toBe(true);
    for (const bad of ['acme.grafana.net', 'https://acme.grafana.net/', 'https://acme.grafana.net/api/']) expect(url.test(bad)).toBe(false);
    const token = new RegExp(a.envVarMeta.GRAFANA_SERVICE_ACCOUNT_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, 'glsa_short']) expect(token.test(bad)).toBe(false);
  });

  it('explains wrong tokens, roles and a wrong URL', () => {
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['403']).toMatch(/Viewer/);
  });

  it('prefixes every tool with grafana_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^grafana_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('has one write, the annotation, which asks for confirmation; the query POST is read-only', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name);
    expect(writes).toEqual(['grafana_create_annotation']);
    expect(tool('grafana_create_annotation').description).toMatch(/wait for their yes/);
    expect(tool('grafana_create_annotation').description).toMatch(/Editor/);
    expect(annotationsOf(tool('grafana_query_datasource'))).toMatchObject({ readOnlyHint: true });
    expect(a.tools.some((t) => ['DELETE', 'PUT', 'PATCH'].includes(t.endpointMapping.method))).toBe(false);
  });

  it('only points the model at tools that exist, explains token and role, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgrafana_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgrafana_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('Service accounts');
    expect(a.instructions).toContain('**Viewer**');
    expect(a.instructions).toMatch(/Prometheus/);
    expect(a.instructions).toMatch(/Loki/);
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
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['grafana_get_health', {}, 'GET', '/health'],
    ['grafana_get_current_org', {}, 'GET', '/org'],
    ['grafana_search', {}, 'GET', '/search'],
    ['grafana_list_folders', {}, 'GET', '/folders'],
    ['grafana_get_dashboard', { uid: 'abc123' }, 'GET', '/dashboards/uid/abc123'],
    ['grafana_list_datasources', {}, 'GET', '/datasources'],
    ['grafana_get_datasource', { uid: 'prom1' }, 'GET', '/datasources/uid/prom1'],
    ['grafana_query_datasource', { datasource_uid: 'prom1', expr: 'up' }, 'POST', '/ds/query'],
    ['grafana_list_alert_rules', {}, 'GET', '/v1/provisioning/alert-rules'],
    ['grafana_get_alert_rule', { uid: 'rule1' }, 'GET', '/v1/provisioning/alert-rules/rule1'],
    ['grafana_list_firing_alerts', {}, 'GET', '/alertmanager/grafana/api/v2/alerts'],
    ['grafana_list_annotations', {}, 'GET', '/annotations'],
    ['grafana_create_annotation', { text: 'Deploy v1.2' }, 'POST', '/annotations'],
    ['grafana_list_org_users', {}, 'GET', '/org/users'],
    ['grafana_search_teams', {}, 'GET', '/teams/search'],
    ['grafana_list_contact_points', {}, 'GET', '/v1/provisioning/contact-points'],
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
    expect(req.url).toBe(`${API}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('keeps a sub-path instance URL', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('grafana_search', {}, { ...ENV, GRAFANA_URL: 'https://example.com/grafana' });
    expect(sent().url).toBe('https://example.com/grafana/api/search');
  });

  it('writes search, alert and annotation filters the way the API documents', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('grafana_search', { query: 'api', type: 'dash-db', tag: ['prod', 'team-a'], folder_uids: ['f1'] });
    expect(query()).toBe('query=api&type=dash-db&tag=prod&tag=team-a&folderUIDs=f1&limit=50');
    mockedAxios.mockClear();
    await call('grafana_list_firing_alerts', { filter: ['severity=critical', 'team=~pay.*'], silenced: false });
    expect(query()).toBe('active=true&silenced=false&filter=severity=critical&filter=team=~pay.*');
    mockedAxios.mockClear();
    await call('grafana_list_annotations', { from: 1760486400000, to: 1760490000000, tags: ['deploy'], type: 'annotation' });
    expect(query()).toBe('from=1760486400000&to=1760490000000&tags=deploy&type=annotation&limit=100');
  });

  it('builds a Prometheus, Loki and SQL query and an annotation with only the given fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const body = async (name: string, params: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await call(name, params);
      return sent().data;
    };
    expect(await body('grafana_query_datasource', { datasource_uid: 'prom1', expr: 'sum(up)', instant: true })).toEqual({
      from: 'now-1h',
      to: 'now',
      queries: [{ refId: 'A', datasource: { uid: 'prom1' }, expr: 'sum(up)', instant: true, maxLines: 100, maxDataPoints: 200 }],
    });
    expect(await body('grafana_query_datasource', { datasource_uid: 'loki1', expr: '{app="api"} |= "error"', from: 'now-15m', max_lines: 20 })).toEqual({
      from: 'now-15m',
      to: 'now',
      queries: [{ refId: 'A', datasource: { uid: 'loki1' }, expr: '{app="api"} |= "error"', maxLines: 20, maxDataPoints: 200 }],
    });
    expect(await body('grafana_query_datasource', { datasource_uid: 'pg1', raw_sql: 'SELECT 1', format: 'table' })).toEqual({
      from: 'now-1h',
      to: 'now',
      queries: [{ refId: 'A', datasource: { uid: 'pg1' }, rawSql: 'SELECT 1', format: 'table', maxLines: 100, maxDataPoints: 200 }],
    });
    expect(await body('grafana_create_annotation', { text: 'Deploy v1.2', tags: ['deploy'], time: 1760486400000, dashboard_uid: 'abc123' })).toEqual({
      text: 'Deploy v1.2',
      time: 1760486400000,
      tags: ['deploy'],
      dashboardUID: 'abc123',
    });
  });

  it('never returns contact point settings or data source secrets', () => {
    const cps = shape('grafana_list_contact_points', [
      { uid: 'c1', name: 'Ops Slack', type: 'slack', settings: { url: 'https://hooks.slack.com/services/T0/B0/secret' }, disableResolveMessage: false },
    ]);
    expect(cps).toEqual({ contact_points: [{ uid: 'c1', name: 'Ops Slack', type: 'slack', disableResolveMessage: false }] });
    const ds = shape('grafana_get_datasource', {
      uid: 'pg1',
      name: 'Postgres',
      type: 'postgres',
      url: 'db:5432',
      user: 'grafana',
      basicAuthUser: 'admin',
      password: 'legacy-plain',
      secureJsonFields: { password: true },
      jsonData: { sslmode: 'require' },
    });
    expect(ds).toEqual({ uid: 'pg1', name: 'Postgres', type: 'postgres', url: 'db:5432', jsonData: { sslmode: 'require' } });
  });

  it('shapes a dashboard to its panels and queries, rows included', () => {
    const out = shape('grafana_get_dashboard', {
      meta: { folderUid: 'f1', folderTitle: 'Ops', url: '/d/abc123/api', updated: '2026-10-14T10:00:00Z' },
      dashboard: {
        uid: 'abc123',
        title: 'API',
        tags: ['prod'],
        time: { from: 'now-6h', to: 'now' },
        templating: { list: [{ name: 'job', type: 'query', current: { text: 'api', value: 'api' }, options: [{ text: 'big' }] }] },
        panels: [
          { id: 1, title: 'Requests', type: 'timeseries', gridPos: { h: 8 }, fieldConfig: { defaults: {} }, datasource: { uid: 'prom1', type: 'prometheus' }, targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total[5m]))' }] },
          { id: 2, title: 'Errors', type: 'row', collapsed: true, panels: [{ id: 3, title: 'Logs', type: 'logs', datasource: { uid: 'loki1' }, targets: [{ refId: 'A', expr: '{app="api"}' }] }] },
        ],
      },
    });
    expect(out.panels[0]).toEqual({ id: 1, title: 'Requests', type: 'timeseries', datasource: 'prom1', queries: [{ refId: 'A', expr: 'sum(rate(http_requests_total[5m]))' }] });
    expect(out.panels[1].rowPanels).toEqual([{ id: 3, title: 'Logs', type: 'logs', datasource: 'loki1', queries: [{ refId: 'A', expr: '{app="api"}' }] }]);
    expect(out.variables).toEqual([{ name: 'job', type: 'query', current: 'api' }]);
    expect(JSON.stringify(out)).not.toContain('gridPos');
  });

  it('keeps whole alert rules and alerts when a long list is cut, and says how many were left out', () => {
    const rule = (i: number) => ({ uid: `r${i}`, title: `Rule ${i}`, folderUID: 'f1', ruleGroup: 'g', for: '5m', labels: { team: 'ops' }, annotations: { summary: 'x'.repeat(500) }, data: [{ model: { expr: 'y'.repeat(2000) } }] });
    const out = shape('grafana_list_alert_rules', Array.from({ length: 200 }, (_, i) => rule(i)));
    expect(out._truncated).toBe(true);
    expect(out._note).toMatch(/kept \d+ of 200 items/);
    expect(out.items[0]).toMatchObject({ uid: 'r0', title: 'Rule 0', for: '5m', labels: { team: 'ops' } });
    expect(JSON.stringify(out)).not.toContain('yyyy');
    const alerts = shape('grafana_list_firing_alerts', [
      { labels: { alertname: 'HighCPU', severity: 'critical' }, annotations: { summary: 'CPU high', __values__: '{}' }, status: { state: 'active', silencedBy: [], inhibitedBy: [] }, receivers: [{ name: 'ops' }], startsAt: '2026-10-15T06:00:00Z' },
    ]);
    expect(alerts[0]).toMatchObject({ alertname: 'HighCPU', summary: 'CPU high', state: 'active', receivers: ['ops'] });
  });

  it('drops query statistics and type details from query frames', () => {
    const out = shape('grafana_query_datasource', {
      results: {
        A: {
          status: 200,
          frames: [
            {
              schema: { refId: 'A', meta: { type: 'numeric-multi', stats: [{ displayName: 'x', value: 1 }] }, fields: [{ name: 'Time', type: 'time', typeInfo: { frame: 'time.Time' }, config: { interval: 60000 } }, { name: 'up', type: 'number', labels: { job: 'api' } }] },
              data: { values: [[1760486400000], [1]] },
            },
          ],
        },
      },
    });
    const frame = out.results.A.frames[0];
    expect(frame.schema.meta).toEqual({ type: 'numeric-multi' });
    expect(frame.schema.fields).toEqual([{ name: 'Time', type: 'time' }, { name: 'up', type: 'number', labels: { job: 'api' } }]);
    expect(frame.data.values).toEqual([[1760486400000], [1]]);
  });
});

const live = process.env.RUN_GRAFANA_LIVE === '1' ? describe : describe.skip;
live('grafana adapter: live', () => {
  const real = !!process.env.GRAFANA_URL && !!process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  const PLAY = 'https://play.grafana.org';
  // Without a token the reads go to Grafana's public demo, where anonymous
  // visitors are Viewers; the fake token is ignored there.
  const readEnv = () =>
    real
      ? { GRAFANA_URL: process.env.GRAFANA_URL!, GRAFANA_SERVICE_ACCOUNT_TOKEN: process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN! }
      : { GRAFANA_URL: PLAY, GRAFANA_SERVICE_ACCOUNT_TOKEN: FAKE_TOKEN };
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['grafana_get_current_org', {}],
    ['grafana_search', {}],
    ['grafana_list_datasources', {}],
    ['grafana_list_firing_alerts', {}],
  ])('%s reaches a Grafana Cloud stack and is refused with a wrong token (401)', async (name, params) => {
    const env = { GRAFANA_URL: process.env.GRAFANA_URL || 'https://grafana.grafana.net', GRAFANA_SERVICE_ACCOUNT_TOKEN: FAKE_TOKEN };
    await expect(call(name, params, env)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('reads health, org, dashboards, folders, data sources, alerting, annotations and contact points', async () => {
    const env = readEnv();
    expect(typeof (await shaped('grafana_get_health', {}, env)).version).toBe('string');
    expect(typeof (await shaped('grafana_get_current_org', {}, env)).name).toBe('string');
    const dashboards = await shaped('grafana_search', { type: 'dash-db', limit: 5 }, env);
    expect(Array.isArray(dashboards.results)).toBe(true);
    if (dashboards.results[0]) {
      const dash = await shaped('grafana_get_dashboard', { uid: dashboards.results[0].uid }, env);
      expect(dash.uid).toBe(dashboards.results[0].uid);
      expect(JSON.stringify(dash)).not.toContain('gridPos');
    }
    expect(Array.isArray((await shaped('grafana_list_folders', { limit: 5 }, env)).folders)).toBe(true);
    const ds = await shaped('grafana_list_datasources', {}, env);
    expect(Array.isArray(ds.datasources)).toBe(true);
    // On the demo, the first Prometheus data sources are synthetic ones without an up metric.
    const promUid = process.env.GRAFANA_TEST_PROMETHEUS_UID || (real ? undefined : 'grafanacloud-prom');
    const prom = ds.datasources.find((d: { type: string; uid: string }) => d.type === 'prometheus' && (!promUid || d.uid === promUid));
    if (prom) {
      const out = await shaped('grafana_query_datasource', { datasource_uid: prom.uid, expr: 'count(up)', instant: true, from: 'now-5m' }, env);
      expect(out.results.A.status).toBe(200);
      expect(JSON.stringify(out)).not.toContain('typeInfo');
    }
    const rules = await shaped('grafana_list_alert_rules', {}, env);
    // A list, or the first rules with a note when the answer is over 60 KB.
    expect(Array.isArray(rules) || Array.isArray(rules.items)).toBe(true);
    const firing = await shaped('grafana_list_firing_alerts', {}, env);
    expect(Array.isArray(firing) || Array.isArray(firing.items)).toBe(true);
    expect(Array.isArray((await shaped('grafana_list_annotations', { limit: 5 }, env)).annotations)).toBe(true);
    const cps = await shaped('grafana_list_contact_points', {}, env);
    expect(Array.isArray(cps.contact_points)).toBe(true);
    expect(JSON.stringify(cps)).not.toContain('settings');
  }, 120000);

  const writes = real && process.env.RUN_GRAFANA_LIVE_WRITES === '1';
  (writes ? it : it.skip)('adds one organization annotation tagged anythingmcp-test', async () => {
    const out = await shaped('grafana_create_annotation', { text: `AnythingMCP live check ${Date.now()}`, tags: ['anythingmcp-test'] }, readEnv());
    expect(out.id).toBeTruthy();
  }, 60000);
});
