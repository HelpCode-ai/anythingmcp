import axios from 'axios';
import * as adapter from './databricks.json';
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
 * Two layers of verification for the Databricks adapter:
 *
 *   1. Static: always runs. Pins Bearer auth on the workspace host and every
 *      tool's method, URL, query and body through the real RestEngine, checked
 *      against the official Go SDK's service definitions (databricks-sdk-go
 *      main, service/{compute,sql,jobs,catalog,workspace,files,iam}, read 15
 *      Oct 2026): clusters on /api/2.1, jobs on /api/2.2, the Statement
 *      Execution API body, and the response shaping (secrets in cluster
 *      config left out, result rows capped).
 *
 *   2. Live: skipped unless RUN_DATABRICKS_LIVE=1. Without a token it checks
 *      that a workspace refuses a fake one with 403 "Invalid access token" on
 *      every real route and answers 404 on a made-up one (DATABRICKS_PROBE_HOST,
 *      default a public demo workspace). With DATABRICKS_HOST and
 *      DATABRICKS_TOKEN it reads the current user, clusters, warehouses, jobs,
 *      catalogs and the workspace root (free). With DATABRICKS_WAREHOUSE_ID of
 *      a RUNNING warehouse it also runs `SELECT 1` (a few DBU-seconds):
 *
 *        RUN_DATABRICKS_LIVE=1 DATABRICKS_HOST=dbc-....cloud.databricks.com DATABRICKS_TOKEN=dapi... \
 *          npx jest src/adapters/intl/databricks.live.spec.ts
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
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
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

const HOST = 'dbc-a1b2c3d4-e5f6.cloud.databricks.com';
const BASE = `https://${HOST}`;
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = ['dapi', '0f'.repeat(16)].join('');
const ENV: Record<string, string> = { DATABRICKS_HOST: HOST, DATABRICKS_TOKEN: FAKE_TOKEN };

// Mirrors DynamicMcpTools: {{VAR}} interpolated, schema defaults applied.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, env), headers: config.headers } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'databricks_cancel_job_run',
  'databricks_cancel_statement',
  'databricks_execute_sql',
  'databricks_run_job',
  'databricks_start_cluster',
  'databricks_start_warehouse',
  'databricks_stop_warehouse',
  'databricks_terminate_cluster',
];

describe('databricks adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.icon).toBe('databricks');
  });

  it('sends the token as Bearer to the workspace host and checks it on SCIM Me', () => {
    expect(a.connector.baseUrl).toBe('https://{{DATABRICKS_HOST}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{DATABRICKS_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/api/2.0/preview/scim/v2/Me');
    expect(a.probe).toEqual({ tool: 'databricks_get_current_user' });
    expect(a.requiredEnvVars).toEqual(['DATABRICKS_HOST', 'DATABRICKS_TOKEN']);
    const meta = describeAdapterEnvVars(a as never);
    expect(meta.find((m) => m.name === 'DATABRICKS_HOST')).toMatchObject({ kind: 'address', secret: false });
    expect(meta.find((m) => m.name === 'DATABRICKS_TOKEN')).toMatchObject({ kind: 'credential', secret: true });
  });

  it('accepts workspace hosts of all three clouds and refuses URLs', () => {
    const re = new RegExp(a.envVarMeta.DATABRICKS_HOST.pattern!);
    for (const ok of [HOST, 'adb-1234567890123456.7.azuredatabricks.net', '1234567890123456.7.gcp.databricks.com']) expect(re.test(ok)).toBe(true);
    for (const bad of [`https://${HOST}`, `${HOST}/`, `${HOST}/?o=123`, 'example.com']) expect(re.test(bad)).toBe(false);
    const tok = new RegExp(a.envVarMeta.DATABRICKS_TOKEN.pattern!);
    expect(tok.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, `${FAKE_TOKEN} `]) expect(tok.test(bad)).toBe(false);
  });

  it('prefixes every tool with databricks_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^databricks_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every change as a write that needs confirmation, deletes nothing and says what costs money', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/[Cc]onfirm with the user first|explicit confirmation/);
    for (const t of a.tools) expect(t.endpointMapping.method).not.toBe('DELETE');
    expect(a.tools.some((t) => /permanent-delete|jobs\/delete|workspace\/delete|dbfs\/delete/.test(t.endpointMapping.path))).toBe(false);
    expect(tool('databricks_execute_sql').description).toMatch(/STARTED automatically and bills DBUs/);
    expect(annotationsOf(tool('databricks_terminate_cluster'))).toMatchObject({ destructiveHint: true });
    expect(annotationsOf(tool('databricks_stop_warehouse'))).toMatchObject({ destructiveHint: true });
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bdatabricks_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bdatabricks_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings that do real work on every tool', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(tr).toBeDefined();
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.expression ?? tr.exclude ?? tr.include).toBeDefined();
    }
  });

  const S = '01ef-statement';
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['databricks_get_current_user', {}, 'GET', `${BASE}/api/2.0/preview/scim/v2/Me`],
    ['databricks_list_clusters', {}, 'GET', `${BASE}/api/2.1/clusters/list`],
    ['databricks_get_cluster', { cluster_id: 'c1' }, 'GET', `${BASE}/api/2.1/clusters/get`],
    ['databricks_start_cluster', { cluster_id: 'c1' }, 'POST', `${BASE}/api/2.1/clusters/start`],
    ['databricks_terminate_cluster', { cluster_id: 'c1' }, 'POST', `${BASE}/api/2.1/clusters/delete`],
    ['databricks_list_warehouses', {}, 'GET', `${BASE}/api/2.0/sql/warehouses`],
    ['databricks_get_warehouse', { warehouse_id: 'w1' }, 'GET', `${BASE}/api/2.0/sql/warehouses/w1`],
    ['databricks_start_warehouse', { warehouse_id: 'w1' }, 'POST', `${BASE}/api/2.0/sql/warehouses/w1/start`],
    ['databricks_stop_warehouse', { warehouse_id: 'w1' }, 'POST', `${BASE}/api/2.0/sql/warehouses/w1/stop`],
    ['databricks_execute_sql', { warehouse_id: 'w1', statement: 'SELECT 1' }, 'POST', `${BASE}/api/2.0/sql/statements`],
    ['databricks_get_statement', { statement_id: S }, 'GET', `${BASE}/api/2.0/sql/statements/${S}`],
    ['databricks_get_statement_chunk', { statement_id: S, chunk_index: 1 }, 'GET', `${BASE}/api/2.0/sql/statements/${S}/result/chunks/1`],
    ['databricks_cancel_statement', { statement_id: S }, 'POST', `${BASE}/api/2.0/sql/statements/${S}/cancel`],
    ['databricks_list_jobs', {}, 'GET', `${BASE}/api/2.2/jobs/list`],
    ['databricks_get_job', { job_id: 7 }, 'GET', `${BASE}/api/2.2/jobs/get`],
    ['databricks_run_job', { job_id: 7 }, 'POST', `${BASE}/api/2.2/jobs/run-now`],
    ['databricks_list_job_runs', {}, 'GET', `${BASE}/api/2.2/jobs/runs/list`],
    ['databricks_get_job_run', { run_id: 9 }, 'GET', `${BASE}/api/2.2/jobs/runs/get`],
    ['databricks_get_run_output', { run_id: '9' }, 'GET', `${BASE}/api/2.2/jobs/runs/get-output`],
    ['databricks_cancel_job_run', { run_id: 9 }, 'POST', `${BASE}/api/2.2/jobs/runs/cancel`],
    ['databricks_list_catalogs', {}, 'GET', `${BASE}/api/2.1/unity-catalog/catalogs`],
    ['databricks_list_schemas', { catalog_name: 'main' }, 'GET', `${BASE}/api/2.1/unity-catalog/schemas`],
    ['databricks_list_tables', { catalog_name: 'main', schema_name: 'sales' }, 'GET', `${BASE}/api/2.1/unity-catalog/tables`],
    ['databricks_get_table', { full_name: 'main.sales.orders' }, 'GET', `${BASE}/api/2.1/unity-catalog/tables/main.sales.orders`],
    ['databricks_list_workspace', { path: '/Users' }, 'GET', `${BASE}/api/2.0/workspace/list`],
    ['databricks_export_notebook', { path: '/Users/a/nb' }, 'GET', `${BASE}/api/2.0/workspace/export`],
    ['databricks_list_volume_files', { directory_path: '/Volumes/main/raw/landing' }, 'GET', `${BASE}/api/2.0/fs/directories/Volumes/main/raw/landing`],
    ['databricks_list_dbfs', { path: '/FileStore' }, 'GET', `${BASE}/api/2.0/dbfs/list`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the SDK path on the workspace host with the Bearer token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('runs SQL inline as JSON arrays with a row cap and a wait under the engine timeout', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('databricks_execute_sql', { warehouse_id: 'w1', statement: 'SELECT 1' });
    expect(sent().data).toEqual({
      warehouse_id: 'w1',
      statement: 'SELECT 1',
      row_limit: 200,
      byte_limit: 1000000,
      wait_timeout: '20s',
      on_wait_timeout: 'CONTINUE',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
    });
    mockedAxios.mockClear();
    const parameters = [{ name: 'c', value: 'DE', type: 'STRING' }];
    await call('databricks_execute_sql', { warehouse_id: 'w1', statement: 'SELECT * FROM t WHERE c = :c', catalog: 'main', schema: 'sales', parameters, row_limit: 10 });
    expect(sent().data).toMatchObject({ catalog: 'main', schema: 'sales', parameters, row_limit: 10 });
  });

  it('sends the documented query and body fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('databricks_get_cluster', { cluster_id: 'c1' });
    expect(sent().params).toEqual({ cluster_id: 'c1' });
    mockedAxios.mockClear();
    await call('databricks_terminate_cluster', { cluster_id: 'c1' });
    expect(sent().data).toEqual({ cluster_id: 'c1' });
    mockedAxios.mockClear();
    await call('databricks_run_job', { job_id: 7, job_parameters: { date: '2026-10-15' } });
    expect(sent().data).toEqual({ job_id: 7, job_parameters: { date: '2026-10-15' } });
    mockedAxios.mockClear();
    await call('databricks_list_tables', { catalog_name: 'main', schema_name: 'sales' });
    expect(sent().params).toEqual({ catalog_name: 'main', schema_name: 'sales', max_results: 100, omit_columns: 'true', omit_properties: 'true' });
    mockedAxios.mockClear();
    await call('databricks_export_notebook', { path: '/Users/a/nb' });
    expect(sent().params).toEqual({ path: '/Users/a/nb', format: 'SOURCE', direct_download: 'true' });
    mockedAxios.mockClear();
    await call('databricks_list_job_runs', { job_id: 7, active_only: true });
    expect(sent().params).toEqual({ job_id: 7, active_only: true, limit: 25 });
  });

  it('shapes a statement result: columns, rows as arrays, capped, chunk pointer kept', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => [String(i), null]);
    const out = shape('databricks_execute_sql', {
      statement_id: S,
      status: { state: 'SUCCEEDED' },
      manifest: { format: 'JSON_ARRAY', schema: { column_count: 2, columns: [{ name: 'id', type_text: 'BIGINT', type_name: 'LONG', position: 0 }, { name: 'note', type_text: 'STRING', type_name: 'STRING', position: 1 }] }, total_row_count: 1500, total_chunk_count: 2, truncated: false },
      result: { chunk_index: 0, row_offset: 0, row_count: 1500, data_array: rows, next_chunk_index: 1, next_chunk_internal_link: '/api/2.0/sql/statements/x/result/chunks/1' },
    });
    expect(out.error).toBeUndefined();
    const v = out.value as any;
    expect(v.columns).toEqual([{ name: 'id', type: 'BIGINT' }, { name: 'note', type: 'STRING' }]);
    expect(v.rows).toHaveLength(1000);
    expect(v.rows[1]).toEqual(['1', null]);
    expect(v).toMatchObject({ statement_id: S, status: { state: 'SUCCEEDED' }, total_row_count: 1500, next_chunk_index: 1 });
    const pending = shape('databricks_execute_sql', { statement_id: S, status: { state: 'PENDING' } });
    expect(pending.value).toEqual({ statement_id: S, status: { state: 'PENDING' } });
  });

  it('leaves cluster secrets out (Spark config, environment variables, init scripts, Docker credentials)', () => {
    const cluster = {
      cluster_id: 'c1',
      cluster_name: 'etl',
      state: 'RUNNING',
      spark_version: '15.4.x-scala2.12',
      spark_conf: { 'spark.hadoop.fs.azure.account.key': 'SECRET-KEY' },
      spark_env_vars: { DB_PASSWORD: 'SECRET-PASSWORD' },
      init_scripts: [{ workspace: { destination: '/x.sh' } }],
      docker_image: { url: 'img', basic_auth: { username: 'u', password: 'SECRET-DOCKER' } },
      custom_tags: { owner: 'x' },
      termination_reason: { code: 'INACTIVITY', type: 'SUCCESS', parameters: { inactivity_duration_min: '120' } },
    };
    for (const [name, raw] of [['databricks_get_cluster', cluster], ['databricks_list_clusters', { clusters: [cluster] }]] as const) {
      const out = shape(name, raw);
      expect(out.error).toBeUndefined();
      expect(JSON.stringify(out.value)).not.toMatch(/SECRET/);
    }
    expect((shape('databricks_list_clusters', { clusters: [cluster] }).value as any).clusters[0]).toMatchObject({ cluster_id: 'c1', state: 'RUNNING', termination_reason: 'INACTIVITY' });
  });

  it('passes a notebook exported as text through, capped', () => {
    const src = '# Databricks notebook source\nprint("hello")\n';
    expect(shape('databricks_export_notebook', src).value).toBe(src);
    const big = shape('databricks_export_notebook', 'x'.repeat(200_000)).value as any;
    expect(big._truncated).toBe(true);
  });
});

const live = process.env.RUN_DATABRICKS_LIVE === '1' ? describe : describe.skip;
live('databricks adapter: live', () => {
  const probeHost = process.env.DATABRICKS_PROBE_HOST ?? 'e2-demo-field-eng.cloud.databricks.com';
  const host = process.env.DATABRICKS_HOST;
  const token = process.env.DATABRICKS_TOKEN;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['databricks_get_current_user', {}],
    ['databricks_list_clusters', {}],
    ['databricks_get_cluster', { cluster_id: 'c1' }],
    ['databricks_list_warehouses', {}],
    ['databricks_get_warehouse', { warehouse_id: 'w1' }],
    ['databricks_execute_sql', { warehouse_id: 'w1', statement: 'SELECT 1' }],
    ['databricks_get_statement', { statement_id: 's1' }],
    ['databricks_get_statement_chunk', { statement_id: 's1', chunk_index: 1 }],
    ['databricks_list_jobs', {}],
    ['databricks_get_job', { job_id: 1 }],
    ['databricks_list_job_runs', {}],
    ['databricks_get_job_run', { run_id: 1 }],
    ['databricks_get_run_output', { run_id: '1' }],
    ['databricks_list_catalogs', {}],
    ['databricks_list_schemas', { catalog_name: 'main' }],
    ['databricks_list_tables', { catalog_name: 'main', schema_name: 'default' }],
    ['databricks_get_table', { full_name: 'main.default.t' }],
    ['databricks_list_workspace', { path: '/' }],
    ['databricks_export_notebook', { path: '/x' }],
    ['databricks_list_volume_files', { directory_path: '/Volumes/main/default/v' }],
    ['databricks_list_dbfs', { path: '/' }],
  ])('%s reaches a real route and the workspace refuses a fake token (403)', async (name, params) => {
    await expect(call(name, params, { DATABRICKS_HOST: probeHost, DATABRICKS_TOKEN: FAKE_TOKEN })).rejects.toMatchObject({ response: { status: 403 } });
  }, 30000);

  it('answers 404 on a made-up route', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `https://${probeHost}/api/2.0/does-not-exist`, method: 'GET', headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  const run = async (name: string, params: Record<string, unknown> = {}) => {
    const out = shape(name, await call(name, params, { DATABRICKS_HOST: host!, DATABRICKS_TOKEN: token! }));
    expect(out.error).toBeUndefined();
    return out.value as any;
  };

  (host && token ? it : it.skip)('reads the user, clusters, warehouses, jobs, catalogs and the workspace root', async () => {
    expect((await run('databricks_get_current_user')).userName).toBeTruthy();
    await run('databricks_list_clusters', { page_size: 5 });
    await run('databricks_list_warehouses');
    await run('databricks_list_jobs', { limit: 5 });
    await run('databricks_list_catalogs', { max_results: 5 });
    await run('databricks_list_workspace', { path: '/' });
  }, 120000);

  (host && token && process.env.DATABRICKS_WAREHOUSE_ID ? it : it.skip)('runs SELECT 1 on a running warehouse', async () => {
    const out = await run('databricks_execute_sql', { warehouse_id: process.env.DATABRICKS_WAREHOUSE_ID, statement: 'SELECT 1 AS one' });
    expect(out.status.state).toBe('SUCCEEDED');
    expect(out.rows).toEqual([['1']]);
  }, 120000);
});
