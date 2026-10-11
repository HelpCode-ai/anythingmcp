import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as adapterJson from './posthog.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Static part (always runs): pins the personal API key as Bearer on the
 * POSTHOG_HOST app host, the host and key patterns (US, EU and self-hosted
 * accepted; ingestion hosts, lookalikes, paths and trailing slashes refused),
 * the probe, the read-only, destructive and switched-off sets, the confirm
 * wording on flag changes, and every tool's method and URL plus the request
 * bodies (HogQL query, insight, flag and annotation writes, soft deletes),
 * all sent through the real RestEngine to a local server after
 * interpolateConnectorConfig, as DynamicMcpTools does.
 *
 * Live part: skipped unless POSTHOG_PERSONAL_API_KEY is set.
 *   POSTHOG_PERSONAL_API_KEY=phx_... [POSTHOG_HOST=https://eu.posthog.com] [POSTHOG_PROJECT_ID=12345] \
 *     npx jest src/adapters/intl/posthog.live.spec.ts
 * POSTHOG_HOST defaults to https://us.posthog.com. Without POSTHOG_PROJECT_ID
 * the first project of the current organization (or, for a key limited to
 * projects, the user's current project) is read. Every read tool runs once.
 *
 * POSTHOG_LIVE_WRITE=1 also creates an insight named "AnythingMCP live spec
 * (safe to delete)", reads, changes and soft-deletes it; creates an inactive
 * feature flag anythingmcp-live-spec-<time> with a 0% rollout, reads, changes
 * and soft-deletes it; and adds and soft-deletes an annotation. Cleanup runs in
 * `finally`. The key needs insight:write, feature_flag:write and
 * annotation:write for this.
 */

type Mapping = {
  method: string;
  path: string;
  encodePathParams?: boolean;
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: Record<string, boolean>;
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: Mapping;
  responseMapping?: Record<string, unknown>;
};
const a = adapterJson as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind: string; secret?: boolean; pattern?: string; link?: string }>;
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
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Built at runtime so no realistic-looking key sits in the source.
const FAKE_KEY = 'phx_' + 'x'.repeat(8) + 'test';

/** Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params. */
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown> = {}): Promise<any> => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return engine().execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, env), headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  );
};

const READ_ONLY = [
  'posthog_get_annotation',
  'posthog_get_cohort',
  'posthog_get_current_user',
  'posthog_get_dashboard',
  'posthog_get_experiment',
  'posthog_get_feature_flag',
  'posthog_get_insight',
  'posthog_get_person',
  'posthog_get_project',
  'posthog_list_annotations',
  'posthog_list_cohorts',
  'posthog_list_dashboards',
  'posthog_list_experiments',
  'posthog_list_feature_flags',
  'posthog_list_insights',
  'posthog_list_organizations',
  'posthog_list_persons',
  'posthog_list_projects',
  'posthog_run_hogql_query',
  'posthog_run_insight_query',
];
const OFF = ['posthog_delete_annotation', 'posthog_delete_feature_flag', 'posthog_delete_insight'];
const DESTRUCTIVE = [...OFF, 'posthog_update_feature_flag', 'posthog_update_insight'].sort();

describe('posthog adapter: static spec conformance', () => {
  it('is listed (verified live on 11 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('sends the personal API key as Bearer to the configured app host', () => {
    expect(a.category).toBe('analytics');
    expect(a.connector.baseUrl).toBe('{{POSTHOG_HOST}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{POSTHOG_PERSONAL_API_KEY}}' });
    expect(a.connector.headers).toEqual({ 'User-Agent': 'AnythingMCP', Accept: 'application/json' });
    expect(a.requiredEnvVars).toEqual(['POSTHOG_HOST', 'POSTHOG_PERSONAL_API_KEY']);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'POSTHOG_HOST')!.kind).toBe('address');
    expect(described.find((d) => d.name === 'POSTHOG_PERSONAL_API_KEY')!.secret).toBe(true);
    expect(a.envVarMeta.POSTHOG_PERSONAL_API_KEY.link).toBe('https://us.posthog.com/settings/user-api-keys');
  });

  it('accepts US, EU and self-hosted addresses and refuses ingestion hosts, lookalikes, paths and trailing slashes', () => {
    const host = new RegExp(a.envVarMeta.POSTHOG_HOST.pattern!);
    for (const ok of [
      'https://us.posthog.com',
      'https://eu.posthog.com',
      'https://app.posthog.com',
      'https://posthog.example.com',
      'https://analytics.acme.io:8443',
      'https://10.0.0.5',
      'https://posthog.company.de',
    ]) {
      expect(`${ok}:${host.test(ok)}`).toBe(`${ok}:true`);
    }
    for (const bad of [
      'https://us.posthog.com/',
      'https://us.posthog.com/api',
      'https://us.posthog.com/project/1',
      'http://us.posthog.com',
      'us.posthog.com',
      'https://us.i.posthog.com',
      'https://eu.i.posthog.com',
      'https://us.posthog.com.evil.example',
      'https://evil-us.posthog.com',
      'https://posthog.com',
      'https://us.posthog.com:443',
      'https://posthog.example.com/',
    ]) {
      expect(`${bad}:${host.test(bad)}`).toBe(`${bad}:false`);
    }
    const key = new RegExp(a.envVarMeta.POSTHOG_PERSONAL_API_KEY.pattern!);
    expect(key.test('phx_' + '0'.repeat(40))).toBe(true);
    expect(key.test('Bearer phx_' + '0'.repeat(40))).toBe(false);
    expect(key.test('phc_' + '0'.repeat(40))).toBe(false);
    expect(key.test('phx_short')).toBe(false);
  });

  it('probes with the current user, which needs no argument and works for every key scoping', () => {
    expect(a.probe.tool).toBe('posthog_get_current_user');
    expect(tool('posthog_get_current_user').parameters.required).toBeUndefined();
    expect(tool('posthog_get_current_user').endpointMapping.path).toBe('/api/users/@me/');
    expect(a.connector.healthcheckPath).toBe('/api/users/@me/');
  });

  it('prefixes every tool with posthog_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^posthog_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads and both query tools read-only, overwrites and deletes destructive, and installs deletes switched off', () => {
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort()).toEqual(READ_ONLY);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET')) expect(READ_ONLY).toContain(t.name);
    for (const name of ['posthog_run_hogql_query', 'posthog_run_insight_query']) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(tool(name).description).toMatch(/read-only although it is a POST/i);
    }
    const destructive = a.tools.filter((t) => annotationsOf(t).readOnlyHint === false && annotationsOf(t).destructiveHint === true).map((t) => t.name);
    expect(destructive.sort()).toEqual(DESTRUCTIVE);
    for (const name of DESTRUCTIVE) expect(annotationsOf(tool(name)).idempotentHint).toBe(false);
    for (const name of ['posthog_create_insight', 'posthog_create_feature_flag', 'posthog_create_annotation']) {
      expect(`${name}:${annotationsOf(tool(name)).destructiveHint}`).toBe(`${name}:false`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const name of [
      'posthog_create_feature_flag',
      'posthog_update_feature_flag',
      'posthog_delete_feature_flag',
      'posthog_update_insight',
      'posthog_delete_insight',
      'posthog_delete_annotation',
    ]) {
      expect(`${name}: ${tool(name).description}`).toMatch(/confirm/i);
    }
  });

  it('soft-deletes with PATCH deleted=true, since PostHog refuses hard deletes', () => {
    for (const name of OFF) {
      expect(tool(name).endpointMapping.method).toBe('PATCH');
      expect(tool(name).endpointMapping.bodyMapping).toMatchObject({ deleted: true });
    }
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('encodes every path argument and puts every project tool on the projects path', () => {
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    for (const t of a.tools.filter((x) => x.parameters.properties?.project_id && x.name !== 'posthog_get_project')) {
      expect(`${t.name}:${t.endpointMapping.path.startsWith('/api/projects/{project_id}/')}`).toBe(`${t.name}:true`);
      expect(t.parameters.required).toContain('project_id');
    }
    expect(JSON.stringify(adapterJson)).not.toContain('/api/environments/');
  });

  it('only points the model at tools that exist, documents setup and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bposthog_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bposthog_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(15);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('https://us.posthog.com/settings/user-api-keys');
    expect(a.instructions).toContain('https://eu.posthog.com/settings/user-api-keys');
    expect(a.instructions).toContain('Read-only setup');
    for (const scope of ['query:read', 'insight:write', 'feature_flag:write', 'person:read', 'user:read']) {
      expect(a.instructions).toContain(scope);
    }
    expect(a.instructions).toMatch(/OFFSET/);
    expect(JSON.stringify(adapterJson)).not.toMatch(/[–—]/);
    for (const t of a.tools) {
      expect(`${t.name}:${t.description.length >= 60}`).toBe(`${t.name}:true`);
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof (def as { description?: string }).description}`).toBe(`${t.name}.${p}:string`);
      }
    }
  });
});

describe('posthog adapter: response shaping', () => {
  it('trims the current user to ids and names, without project tokens', () => {
    const raw = {
      uuid: 'u-1',
      email: 'ana@example.com',
      first_name: 'Ana',
      last_name: 'Diaz',
      distinct_id: 'd-1',
      team: { id: 12, uuid: 't', name: 'Web', project_id: 12, organization: 'o-1', timezone: 'Europe/Berlin', api_token: 'phc_public' },
      organization: { id: 'o-1', name: 'Acme', slug: 'acme', membership_level: 15, teams: [{ id: 12, name: 'Web', project_id: 12, timezone: 'UTC', api_token: 'phc_public' }] },
      organizations: [{ id: 'o-1', name: 'Acme', slug: 'acme', membership_level: 15, logo_media_id: null }],
    };
    const out = applyResponseTransform(raw, tool('posthog_get_current_user').responseMapping);
    expect(out.applied).toBe(true);
    expect(out.value).toEqual({
      uuid: 'u-1',
      email: 'ana@example.com',
      first_name: 'Ana',
      last_name: 'Diaz',
      current_project: { id: 12, name: 'Web', project_id: 12, organization: 'o-1', timezone: 'Europe/Berlin' },
      current_organization: { id: 'o-1', name: 'Acme', slug: 'acme', membership_level: 15, projects: [{ id: 12, name: 'Web', project_id: 12, timezone: 'UTC' }] },
      organizations: [{ id: 'o-1', name: 'Acme', slug: 'acme', membership_level: 15 }],
    });
    const none = applyResponseTransform({ uuid: 'u-2', team: null, organization: null, organizations: [] }, tool('posthog_get_current_user').responseMapping);
    expect(none.value).toMatchObject({ uuid: 'u-2', current_project: null, current_organization: null });
  });

  it('never hands back project secrets, not even on an unexpected shape', () => {
    const mapping = tool('posthog_get_project').responseMapping;
    const raw = { id: 12, name: 'Web', timezone: 'UTC', secret_api_token: 'phs_secret', secret_api_token_backup: 'phs_old', heatmaps_screenshot_secret: 's', live_events_token: 'l' };
    const out = applyResponseTransform(raw, mapping);
    expect(out.value).toMatchObject({ id: 12, name: 'Web', timezone: 'UTC' });
    expect(JSON.stringify(out.value)).not.toMatch(/phs_|secret|live_events/);
    const odd = applyResponseTransform('phs_secret', mapping);
    expect(JSON.stringify(odd.value ?? null)).not.toContain('phs_secret');
  });

  it('drops the generated ClickHouse SQL and timings from query answers and caps them at 200 KB', () => {
    for (const name of ['posthog_run_hogql_query', 'posthog_run_insight_query']) {
      const mapping = tool(name).responseMapping;
      const out = applyResponseTransform({ columns: ['n'], results: [[1]], hogql: 'SELECT 1', clickhouse: 'SELECT 1 FROM x', timings: [{ k: 'a', t: 1 }] }, mapping);
      expect(out.value).toEqual({ columns: ['n'], results: [[1]], hogql: 'SELECT 1' });
      const big = applyResponseTransform({ results: Array.from({ length: 30000 }, (_, i) => [i, 'x'.repeat(20)]) }, mapping);
      expect(big.truncated).toBe(true);
    }
    for (const name of ['posthog_get_insight', 'posthog_get_dashboard', 'posthog_list_persons', 'posthog_list_insights']) {
      expect(tool(name).responseMapping).toMatchObject({ transform: { maxBytes: 200000 } });
    }
  });
});

describe('posthog adapter: requests through the real engine', () => {
  let server: http.Server;
  let origin: string;
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        res.end('{"results": []}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => (seen.length = 0));

  const env = () => ({ POSTHOG_HOST: origin, POSTHOG_PERSONAL_API_KEY: FAKE_KEY });
  const call = (name: string, params: Record<string, unknown> = {}) => execute(name, env(), params);
  const body = () => JSON.parse(seen[0].body);
  const P = '/api/projects/12345';

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['posthog_get_current_user', {}, 'GET', '/api/users/@me/'],
    ['posthog_list_organizations', { limit: 10 }, 'GET', '/api/organizations/?limit=10'],
    ['posthog_list_projects', {}, 'GET', '/api/organizations/%40current/projects/'],
    ['posthog_get_project', { organization_id: 'o-1', project_id: '12345' }, 'GET', '/api/organizations/o-1/projects/12345/'],
    ['posthog_run_hogql_query', { project_id: '12345', query: 'SELECT 1' }, 'POST', `${P}/query/`],
    ['posthog_run_insight_query', { project_id: '12345', query: { kind: 'TrendsQuery', series: [] } }, 'POST', `${P}/query/`],
    ['posthog_list_persons', { project_id: '12345' }, 'GET', `${P}/persons/?limit=20`],
    ['posthog_get_person', { project_id: '12345', person_id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }, 'GET', `${P}/persons/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/`],
    ['posthog_list_insights', { project_id: '12345' }, 'GET', `${P}/insights/?basic=true&limit=25`],
    ['posthog_get_insight', { project_id: '12345', insight_id: 'AaVQ8Ijw' }, 'GET', `${P}/insights/AaVQ8Ijw/`],
    ['posthog_create_insight', { project_id: '12345', name: 'N', query: {} }, 'POST', `${P}/insights/`],
    ['posthog_update_insight', { project_id: '12345', insight_id: 7, name: 'N' }, 'PATCH', `${P}/insights/7/`],
    ['posthog_delete_insight', { project_id: '12345', insight_id: 7 }, 'PATCH', `${P}/insights/7/`],
    ['posthog_list_dashboards', { project_id: '12345' }, 'GET', `${P}/dashboards/`],
    ['posthog_get_dashboard', { project_id: '12345', dashboard_id: 3 }, 'GET', `${P}/dashboards/3/`],
    ['posthog_list_feature_flags', { project_id: '12345' }, 'GET', `${P}/feature_flags/`],
    ['posthog_get_feature_flag', { project_id: '12345', flag_id: 9 }, 'GET', `${P}/feature_flags/9/`],
    ['posthog_create_feature_flag', { project_id: '12345', key: 'k', filters: {}, active: false }, 'POST', `${P}/feature_flags/`],
    ['posthog_update_feature_flag', { project_id: '12345', flag_id: 9, active: false }, 'PATCH', `${P}/feature_flags/9/`],
    ['posthog_delete_feature_flag', { project_id: '12345', flag_id: 9 }, 'PATCH', `${P}/feature_flags/9/`],
    ['posthog_list_cohorts', { project_id: '12345' }, 'GET', `${P}/cohorts/?basic=true`],
    ['posthog_get_cohort', { project_id: '12345', cohort_id: 4 }, 'GET', `${P}/cohorts/4/`],
    ['posthog_list_annotations', { project_id: '12345' }, 'GET', `${P}/annotations/`],
    ['posthog_get_annotation', { project_id: '12345', annotation_id: 5 }, 'GET', `${P}/annotations/5/`],
    ['posthog_create_annotation', { project_id: '12345', content: 'c', date_marker: '2026-10-11T09:30:00Z' }, 'POST', `${P}/annotations/`],
    ['posthog_delete_annotation', { project_id: '12345', annotation_id: 5 }, 'PATCH', `${P}/annotations/5/`],
    ['posthog_list_experiments', { project_id: '12345' }, 'GET', `${P}/experiments/`],
    ['posthog_get_experiment', { project_id: '12345', experiment_id: 6 }, 'GET', `${P}/experiments/6/`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the key as Bearer', async (name, params, method, url) => {
    await call(name, params);
    expect(seen).toHaveLength(1);
    expect(`${seen[0].method} ${seen[0].url}`).toBe(`${method} ${url}`);
    expect(seen[0].headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(seen[0].headers['user-agent']).toBe('AnythingMCP');
  });

  it('encodes a project id or argument that would otherwise change the path', async () => {
    await call('posthog_get_insight', { project_id: '12/../7', insight_id: 'a b' });
    expect(seen[0].url).toBe('/api/projects/12%2F..%2F7/insights/a%20b/');
  });

  it('wraps the SQL in a HogQLQuery with the documented body and a query-log name', async () => {
    await call('posthog_run_hogql_query', { project_id: '12345', query: "SELECT count() FROM events WHERE event = '$pageview' LIMIT 10" });
    expect(seen[0].headers['content-type']).toMatch(/application\/json/);
    expect(body()).toEqual({
      query: { kind: 'HogQLQuery', query: "SELECT count() FROM events WHERE event = '$pageview' LIMIT 10" },
      name: 'AnythingMCP HogQL query',
    });
    seen.length = 0;
    await call('posthog_run_hogql_query', { project_id: '12345', query: 'SELECT count() FROM events WHERE event = {e}', values: { e: 'signed_up' }, name: 'signups' });
    expect(body()).toEqual({ query: { kind: 'HogQLQuery', query: 'SELECT count() FROM events WHERE event = {e}', values: { e: 'signed_up' } }, name: 'signups' });
  });

  it('passes an insight query through as given', async () => {
    const query = { kind: 'FunnelsQuery', series: [{ kind: 'EventsNode', event: 'signed_up' }, { kind: 'EventsNode', event: 'paid' }], dateRange: { date_from: '-30d' } };
    await call('posthog_run_insight_query', { project_id: '12345', query });
    expect(body()).toEqual({ query, name: 'AnythingMCP insight query' });
  });

  it('creates, changes and soft-deletes an insight with only the given fields', async () => {
    const query = { kind: 'InsightVizNode', source: { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$pageview' }] } };
    await call('posthog_create_insight', { project_id: '12345', name: 'Pageviews', query, tags: ['ai'] });
    expect(body()).toEqual({ name: 'Pageviews', query, tags: ['ai'] });
    seen.length = 0;
    await call('posthog_update_insight', { project_id: '12345', insight_id: 'AaVQ8Ijw', description: 'Daily', favorited: true });
    expect(body()).toEqual({ description: 'Daily', favorited: true });
    seen.length = 0;
    await call('posthog_delete_insight', { project_id: '12345', insight_id: 7 });
    expect(body()).toEqual({ deleted: true });
  });

  it('creates, changes and soft-deletes a feature flag with the version from the last read', async () => {
    const filters = { groups: [{ properties: [], rollout_percentage: 0 }] };
    await call('posthog_create_feature_flag', { project_id: '12345', key: 'new-checkout', name: 'New checkout', filters, active: false });
    expect(body()).toEqual({ key: 'new-checkout', name: 'New checkout', filters, active: false });
    seen.length = 0;
    await call('posthog_update_feature_flag', { project_id: '12345', flag_id: 9, version: 3, filters: { groups: [{ properties: [], rollout_percentage: 25 }] }, active: true });
    expect(body()).toEqual({ version: 3, active: true, filters: { groups: [{ properties: [], rollout_percentage: 25 }] } });
    seen.length = 0;
    await call('posthog_delete_feature_flag', { project_id: '12345', flag_id: 9, version: 4 });
    expect(body()).toEqual({ deleted: true, version: 4 });
    seen.length = 0;
    await call('posthog_delete_feature_flag', { project_id: '12345', flag_id: 9 });
    expect(body()).toEqual({ deleted: true });
  });

  it('adds an annotation scoped to the project by default and soft-deletes it', async () => {
    await call('posthog_create_annotation', { project_id: '12345', content: 'Released v2', date_marker: '2026-10-11T09:30:00Z' });
    expect(body()).toEqual({ content: 'Released v2', date_marker: '2026-10-11T09:30:00Z', scope: 'project' });
    seen.length = 0;
    await call('posthog_delete_annotation', { project_id: '12345', annotation_id: 5 });
    expect(body()).toEqual({ deleted: true });
  });

  it('sends list filters and paging as query parameters', async () => {
    await call('posthog_list_persons', { project_id: '12345', search: 'ana@', distinct_id: 'd-1', email: 'ana@example.com', limit: 5, offset: 10 });
    const persons = new URL(seen[0].url!, origin).searchParams;
    expect(Object.fromEntries(persons)).toEqual({ search: 'ana@', distinct_id: 'd-1', email: 'ana@example.com', limit: '5', offset: '10' });
    seen.length = 0;
    await call('posthog_list_feature_flags', { project_id: '12345', search: 'checkout', key: 'new-checkout', active: 'STALE', type: 'boolean' });
    expect(Object.fromEntries(new URL(seen[0].url!, origin).searchParams)).toEqual({ search: 'checkout', key: 'new-checkout', active: 'STALE', type: 'boolean' });
    seen.length = 0;
    await call('posthog_list_insights', { project_id: '12345', insight: 'FUNNELS', saved: true, basic: false, order: '-last_modified_at', search: 'signup' });
    expect(Object.fromEntries(new URL(seen[0].url!, origin).searchParams)).toEqual({
      search: 'signup',
      insight: 'FUNNELS',
      saved: 'true',
      basic: 'false',
      order: '-last_modified_at',
      limit: '25',
    });
    seen.length = 0;
    await call('posthog_list_experiments', { project_id: '12345', status: 'running', archived: false });
    expect(Object.fromEntries(new URL(seen[0].url!, origin).searchParams)).toEqual({ status: 'running', archived: 'false' });
    seen.length = 0;
    await call('posthog_get_insight', { project_id: '12345', insight_id: 7, refresh: 'blocking' });
    expect(seen[0].url).toBe(`${P}/insights/7/?refresh=blocking`);
  });
});

const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
const HOST = (process.env.POSTHOG_HOST || 'https://us.posthog.com').replace(/\/+$/, '');
const live = KEY ? describe : describe.skip;

live('posthog adapter: live API', () => {
  const env: Record<string, string> = { POSTHOG_HOST: HOST, POSTHOG_PERSONAL_API_KEY: KEY as string };
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);
  const status = (e: any) => e?.response?.status;

  let project = process.env.POSTHOG_PROJECT_ID;
  let organization = '@current';

  beforeAll(async () => {
    const me = await run('posthog_get_current_user');
    const shaped = applyResponseTransform(me, tool('posthog_get_current_user').responseMapping).value as {
      current_project: { id: number; organization: string } | null;
    };
    if (shaped.current_project) organization = shaped.current_project.organization;
    if (project) return;
    const list = await run('posthog_list_projects').catch(() => null);
    project = String(list?.results?.[0]?.id ?? shaped.current_project?.id ?? '');
  }, 30000);

  it('reads the user, organizations, projects and one project without secrets', async () => {
    const me = applyResponseTransform(await run('posthog_get_current_user'), tool('posthog_get_current_user').responseMapping);
    expect(me.applied).toBe(true);
    expect(typeof (me.value as { email: string }).email).toBe('string');
    // A key limited to specific projects may not read organization endpoints.
    const orgs = await run('posthog_list_organizations').catch((e) => e);
    if (Array.isArray(orgs?.results)) expect(orgs.results.length).toBeGreaterThan(0);
    else expect(status(orgs)).toBe(403);
    const projects = await run('posthog_list_projects').catch((e) => e);
    if (Array.isArray(projects?.results)) expect(projects.results.length).toBeGreaterThan(0);
    else expect(status(projects)).toBe(403);
    expect(project).toBeTruthy();
    const one = await run('posthog_get_project', { organization_id: organization, project_id: project }).catch((e) => e);
    if (status(one)) {
      expect(status(one)).toBe(403);
    } else {
      const shaped = applyResponseTransform(one, tool('posthog_get_project').responseMapping).value;
      expect(String((shaped as { id: number }).id)).toBe(project);
      expect(JSON.stringify(shaped)).not.toMatch(/secret_api_token|phs_/);
    }
  }, 60000);

  it('runs HogQL with and without placeholders, refuses a write, and runs a trends query', async () => {
    const res = await run('posthog_run_hogql_query', { project_id: project, query: 'SELECT count() AS n FROM events WHERE timestamp >= now() - INTERVAL 1 DAY' });
    expect(Array.isArray(res.results)).toBe(true);
    expect(res.columns).toEqual(['n']);
    const withValues = await run('posthog_run_hogql_query', { project_id: project, query: 'SELECT {word} AS w', values: { word: 'hello' } });
    expect(withValues.results).toEqual([['hello']]);
    const write = await run('posthog_run_hogql_query', { project_id: project, query: "INSERT INTO events (event) VALUES ('x')" }).catch((e) => e);
    expect(status(write)).toBe(400);
    const trends = await run('posthog_run_insight_query', {
      project_id: project,
      query: { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$pageview' }], dateRange: { date_from: '-7d' } },
    });
    expect(Array.isArray(trends.results)).toBe(true);
  }, 90000);

  it('reads persons, insights and dashboards', async () => {
    const persons = await run('posthog_list_persons', { project_id: project, limit: 2 });
    expect(Array.isArray(persons.results)).toBe(true);
    if (persons.results[0]) {
      const person = await run('posthog_get_person', { project_id: project, person_id: persons.results[0].uuid });
      expect(person.uuid).toBe(persons.results[0].uuid);
    }
    const insights = await run('posthog_list_insights', { project_id: project, limit: 2 });
    expect(Array.isArray(insights.results)).toBe(true);
    if (insights.results[0]) {
      expect((await run('posthog_get_insight', { project_id: project, insight_id: insights.results[0].short_id })).id).toBe(insights.results[0].id);
    }
    const dashboards = await run('posthog_list_dashboards', { project_id: project, limit: 2 });
    expect(Array.isArray(dashboards.results)).toBe(true);
    if (dashboards.results[0]) {
      expect((await run('posthog_get_dashboard', { project_id: project, dashboard_id: dashboards.results[0].id })).id).toBe(dashboards.results[0].id);
    }
  }, 90000);

  it('reads feature flags, cohorts, annotations and experiments', async () => {
    const pairs: Array<[string, string, string]> = [
      ['posthog_list_feature_flags', 'posthog_get_feature_flag', 'flag_id'],
      ['posthog_list_cohorts', 'posthog_get_cohort', 'cohort_id'],
      ['posthog_list_annotations', 'posthog_get_annotation', 'annotation_id'],
      ['posthog_list_experiments', 'posthog_get_experiment', 'experiment_id'],
    ];
    for (const [list, get, arg] of pairs) {
      const page = await run(list, { project_id: project, limit: 2 });
      expect(`${list}:${Array.isArray(page.results)}`).toBe(`${list}:true`);
      if (page.results[0]) expect((await run(get, { project_id: project, [arg]: page.results[0].id })).id).toBe(page.results[0].id);
    }
  }, 90000);

  it('a wrong key is a 401', async () => {
    await expect(
      execute('posthog_get_current_user', { ...env, POSTHOG_PERSONAL_API_KEY: 'phx_' + 'wrong'.repeat(8) }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (process.env.POSTHOG_LIVE_WRITE === '1' ? it : it.skip)(
    'creates, reads, changes and soft-deletes an insight, an inactive flag and an annotation',
    async () => {
      const problems: string[] = [];
      let insightId: number | undefined;
      let flag: { id: number; version: number } | undefined;
      let annotationId: number | undefined;
      try {
        const insight = await run('posthog_create_insight', {
          project_id: project,
          name: 'AnythingMCP live spec (safe to delete)',
          query: { kind: 'InsightVizNode', source: { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$pageview' }], dateRange: { date_from: '-7d' } } },
        });
        insightId = insight.id;
        expect((await run('posthog_get_insight', { project_id: project, insight_id: insight.short_id })).id).toBe(insightId);
        const changed = await run('posthog_update_insight', { project_id: project, insight_id: insightId, description: 'Changed by the AnythingMCP live spec' });
        expect(changed.description).toBe('Changed by the AnythingMCP live spec');

        const key = `anythingmcp-live-spec-${Date.now()}`;
        const created = await run('posthog_create_feature_flag', {
          project_id: project,
          key,
          name: 'AnythingMCP live spec (safe to delete)',
          filters: { groups: [{ properties: [], rollout_percentage: 0 }] },
          active: false,
        });
        flag = { id: created.id, version: created.version };
        expect(created.active).toBe(false);
        const read = await run('posthog_get_feature_flag', { project_id: project, flag_id: flag.id });
        expect(read.key).toBe(key);
        const renamed = await run('posthog_update_feature_flag', { project_id: project, flag_id: flag.id, version: read.version, name: 'AnythingMCP live spec (changed)' });
        expect(renamed.name).toBe('AnythingMCP live spec (changed)');
        expect(renamed.active).toBe(false);
        flag.version = renamed.version;

        const annotation = await run('posthog_create_annotation', { project_id: project, content: 'AnythingMCP live spec (safe to delete)', date_marker: new Date().toISOString() });
        annotationId = annotation.id;
        expect((await run('posthog_get_annotation', { project_id: project, annotation_id: annotationId })).content).toBe('AnythingMCP live spec (safe to delete)');
      } finally {
        if (insightId) await run('posthog_delete_insight', { project_id: project, insight_id: insightId }).catch((e) => problems.push(`insight: ${e.message}`));
        if (flag) await run('posthog_delete_feature_flag', { project_id: project, flag_id: flag.id, version: flag.version }).catch((e) => problems.push(`flag: ${e.message}`));
        if (annotationId) await run('posthog_delete_annotation', { project_id: project, annotation_id: annotationId }).catch((e) => problems.push(`annotation: ${e.message}`));
      }
      expect(problems).toEqual([]);
    },
    120000,
  );
});
