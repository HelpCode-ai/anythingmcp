import axios from 'axios';
import * as adapter from './buildkite.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Buildkite REST API (buildkite.com/docs/apis/rest-api, base
 * https://api.buildkite.com/v2) and Test Engine API (/v2/analytics, OpenAPI at
 * https://api.buildkite.com/v2/analytics/openapi.yaml), Bearer token. Paths,
 * query names and bodies are checked against the REST API pages and that
 * OpenAPI document (read 30 Oct 2026) and against Buildkite's own Go client
 * (buildkite/go-buildkite) and MCP server (buildkite/buildkite-mcp-server).
 * With a fake token the user, organization, pipeline, build, job, log,
 * artifact, queue and Test Engine routes checked answered 401 on 30 Oct 2026.
 *
 * Live part (reads only: token, user, organizations, pipelines, builds, agents, clusters, suites):
 *   RUN_BUILDKITE_LIVE=1 BUILDKITE_API_TOKEN=bkua_... npx jest src/adapters/intl/buildkite.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; exposeHeaders?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping as never, annotations: t.annotations });

const HOST = 'https://api.buildkite.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'bkua_' + '0'.repeat(40);
const ENV: Record<string, string> = { BUILDKITE_API_TOKEN: FAKE_TOKEN };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping as never, ENV);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: config.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  ) as Promise<unknown>;
};
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'buildkite_cancel_build',
  'buildkite_create_annotation',
  'buildkite_create_build',
  'buildkite_rebuild_build',
  'buildkite_retry_failed_jobs',
  'buildkite_retry_job',
  'buildkite_unblock_job',
];
const SWITCHED_OFF = ['buildkite_cancel_build'];
const J = '01908131-7d9f-495e-a17b-80ed31276810';
const B = '/v2/organizations/acme/pipelines/web/builds/42';
const TE = '/v2/analytics/organizations/acme/suites/rspec';

describe('buildkite adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the API access token as a Bearer token and checks it on /v2/access-token', () => {
    expect(a.icon).toBe('buildkite');
    expect(a.requiredEnvVars).toEqual(['BUILDKITE_API_TOKEN']);
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{BUILDKITE_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/v2/access-token');
    expect(a.envVarMeta.BUILDKITE_API_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    const token = new RegExp(a.envVarMeta.BUILDKITE_API_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', 'short', `Bearer ${FAKE_TOKEN}`, `${FAKE_TOKEN} x`]) expect(token.test(bad)).toBe(false);
  });

  it('every tool is prefixed and unique in the catalog, every declared parameter reaches the request and path parameters are required', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)?.tools ?? []) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.name).toMatch(/^buildkite_[a-z_]+$/);
      expect(t.endpointMapping.path.startsWith('/v2/')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(p).toMatch(/^[a-zA-Z0-9_]+$/);
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
    }
  });

  it('knows exactly which tools write, asks for confirmation on each, ships no deletes and switches off cancel', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(`${name}:${/agree/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(SWITCHED_OFF);
    expect(annotationsOf(tool('buildkite_cancel_build'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const name of ['buildkite_rebuild_build', 'buildkite_retry_job', 'buildkite_retry_failed_jobs', 'buildkite_unblock_job']) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    expect(a.instructions).toContain('**Switched off at install**: `buildkite_cancel_build`; it cannot be undone');
    // Job environment variables hold secrets and stay out.
    expect(a.tools.some((t) => t.endpointMapping.path.endsWith('/env'))).toBe(false);
  });

  it('probes with a read tool and documents every tool in the instructions, without em dashes', () => {
    expect(a.probe.tool).toBe('buildkite_get_access_token');
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
    const names = new Set(a.tools.map((t) => t.name));
    for (const name of names) expect(`${name}:${a.instructions.includes(`\`${name}\``)}`).toBe(`${name}:true`);
    for (const [m] of [...a.instructions.matchAll(/\bbuildkite_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbuildkite_[a-z_]+/g)])]) expect(names).toContain(m);
    expect(a.instructions).toContain('https://mcp.buildkite.com/mcp');
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['buildkite_get_access_token', {}, 'GET', '/v2/access-token'],
    ['buildkite_get_current_user', {}, 'GET', '/v2/user'],
    ['buildkite_list_organizations', {}, 'GET', '/v2/organizations'],
    ['buildkite_get_organization', { org: 'acme' }, 'GET', '/v2/organizations/acme'],
    ['buildkite_list_pipelines', { org: 'acme' }, 'GET', '/v2/organizations/acme/pipelines'],
    ['buildkite_get_pipeline', { org: 'acme', pipeline: 'web' }, 'GET', '/v2/organizations/acme/pipelines/web'],
    ['buildkite_list_builds', { org: 'acme' }, 'GET', '/v2/organizations/acme/builds'],
    ['buildkite_list_pipeline_builds', { org: 'acme', pipeline: 'web' }, 'GET', '/v2/organizations/acme/pipelines/web/builds'],
    ['buildkite_get_build', { org: 'acme', pipeline: 'web', number: 42 }, 'GET', B],
    ['buildkite_list_jobs', { org: 'acme', pipeline: 'web', number: 42 }, 'GET', `${B}/jobs`],
    ['buildkite_get_job', { org: 'acme', job_id: J }, 'GET', `/v2/organizations/acme/jobs/${J}`],
    ['buildkite_get_job_log', { org: 'acme', job_id: J }, 'GET', `/v2/organizations/acme/jobs/${J}/log`],
    ['buildkite_list_build_artifacts', { org: 'acme', pipeline: 'web', number: 42 }, 'GET', `${B}/artifacts`],
    ['buildkite_list_job_artifacts', { org: 'acme', job_id: J }, 'GET', `/v2/organizations/acme/jobs/${J}/artifacts`],
    ['buildkite_get_artifact', { org: 'acme', job_id: J, artifact_id: 'art1' }, 'GET', `/v2/organizations/acme/jobs/${J}/artifacts/art1`],
    ['buildkite_list_annotations', { org: 'acme', pipeline: 'web', number: 42 }, 'GET', `${B}/annotations`],
    ['buildkite_list_agents', { org: 'acme' }, 'GET', '/v2/organizations/acme/agents'],
    ['buildkite_get_agent', { org: 'acme', agent_id: 'ag1' }, 'GET', '/v2/organizations/acme/agents/ag1'],
    ['buildkite_list_clusters', { org: 'acme' }, 'GET', '/v2/organizations/acme/clusters'],
    ['buildkite_get_cluster', { org: 'acme', cluster_id: 'c1' }, 'GET', '/v2/organizations/acme/clusters/c1'],
    ['buildkite_list_cluster_queues', { org: 'acme', cluster_id: 'c1' }, 'GET', '/v2/organizations/acme/clusters/c1/queues'],
    ['buildkite_list_test_suites', { org: 'acme' }, 'GET', '/v2/analytics/organizations/acme/suites'],
    ['buildkite_list_tests', { org: 'acme', suite: 'rspec' }, 'GET', `${TE}/tests`],
    ['buildkite_get_test', { org: 'acme', suite: 'rspec', test_id: 't1' }, 'GET', `${TE}/tests/t1`],
    ['buildkite_list_test_runs', { org: 'acme', suite: 'rspec' }, 'GET', `${TE}/runs`],
    ['buildkite_get_test_run', { org: 'acme', suite: 'rspec', run_id: 'r1' }, 'GET', `${TE}/runs/r1`],
    ['buildkite_list_failed_executions', { org: 'acme', suite: 'rspec', run_id: 'r1' }, 'GET', `${TE}/runs/r1/failed_executions`],
    ['buildkite_create_build', { org: 'acme', pipeline: 'web', commit: 'HEAD', branch: 'main' }, 'POST', '/v2/organizations/acme/pipelines/web/builds'],
    ['buildkite_rebuild_build', { org: 'acme', pipeline: 'web', number: 42 }, 'PUT', `${B}/rebuild`],
    ['buildkite_retry_failed_jobs', { org: 'acme', pipeline: 'web', number: 42 }, 'PUT', `${B}/retry_failed_jobs`],
    ['buildkite_retry_job', { org: 'acme', job_id: J }, 'PUT', `/v2/organizations/acme/jobs/${J}/retry`],
    ['buildkite_unblock_job', { org: 'acme', job_id: J }, 'PUT', `/v2/organizations/acme/jobs/${J}/unblock`],
    ['buildkite_create_annotation', { org: 'acme', pipeline: 'web', number: 42, body: 'All good' }, 'POST', `${B}/annotations`],
    ['buildkite_cancel_build', { org: 'acme', pipeline: 'web', number: 42 }, 'PUT', `${B}/cancel`],
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
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('builds the documented query strings, headers and bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('buildkite_list_pipeline_builds', { org: 'acme', pipeline: 'web', branch: 'main', state: 'failed' });
    expect(sent().params).toEqual({ branch: 'main', state: 'failed', exclude_jobs: true, exclude_pipeline: true, per_page: 30 });
    mockedAxios.mockClear();
    await call('buildkite_list_jobs', { org: 'acme', pipeline: 'web', number: 42, state: 'failed' });
    expect(sent().params).toEqual({ 'state[]': 'failed', per_page: 30 });
    mockedAxios.mockClear();
    await call('buildkite_get_job_log', { org: 'acme', job_id: J });
    expect(sent().headers).toMatchObject({ Accept: 'text/plain', Range: 'bytes=-100000' });
    mockedAxios.mockClear();
    await call('buildkite_get_job_log', { org: 'acme', job_id: J, tail_bytes: 5000 });
    expect(sent().headers.Range).toBe('bytes=-5000');
    mockedAxios.mockClear();
    await call('buildkite_list_tests', { org: 'acme', suite: 'rspec', sort_by: 'reliability', order: 'asc', period: '7days' });
    expect(sent().headers['Buildkite-Version']).toBe('2026-08-01');
    expect(sent().params).toEqual({ sort_by: 'reliability', order: 'asc', period: '7days', per_page: 30 });
    mockedAxios.mockClear();
    await call('buildkite_create_build', { org: 'acme', pipeline: 'web', commit: 'HEAD', branch: 'main', message: 'From AI', env: { DEPLOY: 'false' } });
    expect(sent().data).toEqual({ commit: 'HEAD', branch: 'main', message: 'From AI', env: { DEPLOY: 'false' } });
    mockedAxios.mockClear();
    await call('buildkite_unblock_job', { org: 'acme', job_id: J, fields: { 'release-name': 'x' } });
    expect(sent().data).toEqual({ fields: { 'release-name': 'x' } });
    mockedAxios.mockClear();
    await call('buildkite_retry_failed_jobs', { org: 'acme', pipeline: 'web', number: 42, states: 'failed,timed_out' });
    expect(sent().data).toEqual({ states: 'failed,timed_out' });
  });

  it('exposes the Link header on paged lists', () => {
    for (const t of a.tools) {
      const paged = 'page' in (t.parameters.properties ?? {}) || 'after' in (t.parameters.properties ?? {});
      expect(`${t.name}:${paged}`).toBe(`${t.name}:${(t.endpointMapping.exposeHeaders ?? []).includes('link')}`);
    }
  });
});

const live = process.env.RUN_BUILDKITE_LIVE === '1' && process.env.BUILDKITE_API_TOKEN ? describe : describe.skip;
live('buildkite adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await mockedAxios.__actual.get(`${HOST}${path}`, { headers: { Authorization: `Bearer ${process.env.BUILDKITE_API_TOKEN}`, Accept: 'application/json' }, validateStatus: () => true });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.data as any;
  };
  it('reads the token, the user, organizations, pipelines, builds, agents, clusters and suites', async () => {
    expect(Array.isArray((await get('/v2/access-token')).scopes)).toBe(true);
    const orgs = (await get('/v2/organizations')) as Array<{ slug: string }>;
    expect(Array.isArray(orgs)).toBe(true);
    if (!orgs[0]) return;
    const org = orgs[0].slug;
    expect(Array.isArray(await get(`/v2/organizations/${org}/pipelines?per_page=5`))).toBe(true);
    expect(Array.isArray(await get(`/v2/organizations/${org}/builds?per_page=5&exclude_jobs=true`))).toBe(true);
    expect(Array.isArray(await get(`/v2/organizations/${org}/agents?per_page=5`))).toBe(true);
    expect(Array.isArray(await get(`/v2/organizations/${org}/clusters`))).toBe(true);
    expect(Array.isArray(await get(`/v2/analytics/organizations/${org}/suites`))).toBe(true);
  }, 60_000);
});
