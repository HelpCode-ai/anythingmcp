import axios from 'axios';
import * as adapter from './bigquery.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google BigQuery adapter:
 *
 *   1. Static: always runs. Pins the Google OAuth setup shared by the Google
 *      adapters, and every tool's method, URL, query and body through the real
 *      RestEngine, checked against Google's discovery document
 *      (bigquery.googleapis.com/$discovery/rest?version=v2, fetched 15 Oct
 *      2026): GoogleSQL forced on jobs.query, dry run, the cost cap, and the
 *      response shaping (rows flattened to value lists and capped).
 *
 *   2. Live: skipped unless RUN_BIGQUERY_LIVE=1. Without a token it checks that
 *      Google refuses a fake one with 401 on the real routes and answers 404
 *      on a made-up one. With BIGQUERY_ACCESS_TOKEN (scope bigquery or
 *      cloud-platform.read-only, e.g. from the OAuth 2.0 Playground) and
 *      BIGQUERY_PROJECT_ID (a project where the account is BigQuery Job User)
 *      it lists projects and datasets, reads a public table's schema and rows
 *      for free, dry-runs a query and runs a tiny one (scans about 10 MB, the
 *      billing minimum, inside the free tier):
 *
 *        RUN_BIGQUERY_LIVE=1 BIGQUERY_ACCESS_TOKEN=ya29... BIGQUERY_PROJECT_ID=my-project \
 *          npx jest src/adapters/intl/bigquery.live.spec.ts
 *
 *      Nothing writes: the adapter's only write besides queries is cancel.
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; maximum?: number }>; required?: string[] };
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

const BASE = 'https://bigquery.googleapis.com/bigquery/v2';
const engine = (token = 'test-token') =>
  new RestEngine({ getAccessToken: jest.fn().mockResolvedValue(token) } as unknown as OAuth2TokenService, {} as LoginTokenService);
// Arguments as DynamicMcpTools hands them to the engine: schema defaults filled in.
const call = (name: string, params: Record<string, unknown>, token?: string) =>
  engine(token).execute(
    { baseUrl: a.connector.baseUrl, authType: a.connector.authType, authConfig: { ...a.connector.authConfig }, headers: { ...a.connector.headers } } as any,
    tool(name).endpointMapping,
    applySchemaDefaults(tool(name).parameters as any, params),
  ) as Promise<any>;
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = ['bigquery_cancel_job', 'bigquery_run_query'];

describe('bigquery adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.icon).toBe('googlebigquery');
  });

  it('signs in with the shared Google OAuth client and the bigquery scope, read-only alternative documented', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/bigquery',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    const meta = describeAdapterEnvVars(a as never);
    expect(meta.find((m) => m.name === 'GOOGLE_CLIENT_SECRET')).toMatchObject({ secret: true, required: true });
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('https://www.googleapis.com/auth/cloud-platform.read-only');
    expect(a.instructions).toMatch(/no `bigquery\.readonly` scope/);
  });

  it('checks the connection on a cheap authenticated list', () => {
    expect(a.connector.healthcheckPath).toBe('/projects?maxResults=1');
    expect(a.probe).toEqual({ tool: 'bigquery_list_projects', params: { maxResults: 1 } });
  });

  it('prefixes every tool with bigquery_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^bigquery_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks only queries and cancel as writes, and asks for confirmation on both', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(tool('bigquery_cancel_job').description).toMatch(/Confirm with the user first/);
    expect(tool('bigquery_run_query').description).toMatch(/explicit confirmation/);
    expect(tool('bigquery_run_query').description).toMatch(/dry-run first/);
    expect(a.instructions).toMatch(/ask the user to confirm before running it/);
    expect(a.instructions).toMatch(/US\$6\.25 per TiB/);
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bbigquery_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbigquery_[a-z_]+/g)]),
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

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['bigquery_list_projects', {}, 'GET', `${BASE}/projects`],
    ['bigquery_list_datasets', { project_id: 'p1' }, 'GET', `${BASE}/projects/p1/datasets`],
    ['bigquery_get_dataset', { project_id: 'p1', dataset_id: 'sales' }, 'GET', `${BASE}/projects/p1/datasets/sales`],
    ['bigquery_list_tables', { project_id: 'p1', dataset_id: 'sales' }, 'GET', `${BASE}/projects/p1/datasets/sales/tables`],
    ['bigquery_get_table', { project_id: 'p1', dataset_id: 'sales', table_id: 'orders' }, 'GET', `${BASE}/projects/p1/datasets/sales/tables/orders`],
    ['bigquery_preview_table_rows', { project_id: 'p1', dataset_id: 'sales', table_id: 'orders' }, 'GET', `${BASE}/projects/p1/datasets/sales/tables/orders/data`],
    ['bigquery_run_query', { project_id: 'p1', query: 'SELECT 1' }, 'POST', `${BASE}/projects/p1/queries`],
    ['bigquery_get_query_results', { project_id: 'p1', job_id: 'job_1' }, 'GET', `${BASE}/projects/p1/queries/job_1`],
    ['bigquery_list_jobs', { project_id: 'p1' }, 'GET', `${BASE}/projects/p1/jobs`],
    ['bigquery_get_job', { project_id: 'p1', job_id: 'job_1' }, 'GET', `${BASE}/projects/p1/jobs/job_1`],
    ['bigquery_cancel_job', { project_id: 'p1', job_id: 'job_1' }, 'POST', `${BASE}/projects/p1/jobs/job_1/cancel`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the discovery-document URL with the OAuth token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe('Bearer test-token');
  });

  it('forces GoogleSQL, waits under the engine timeout and sends only what was given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('bigquery_run_query', { project_id: 'p1', query: 'SELECT 1' });
    expect(sent().data).toEqual({ query: 'SELECT 1', useLegacySql: false, maxResults: 100, timeoutMs: 20000 });
    expect(tool('bigquery_run_query').parameters.properties!.timeoutMs.maximum).toBeLessThan(30000);
    mockedAxios.mockClear();
    await call('bigquery_run_query', {
      project_id: 'p1',
      query: 'SELECT * FROM `p.d.t` WHERE c = @c',
      dryRun: true,
      maximumBytesBilled: '10737418240',
      parameterMode: 'NAMED',
      queryParameters: [{ name: 'c', parameterType: { type: 'STRING' }, parameterValue: { value: 'DE' } }],
      defaultDataset: { projectId: 'p', datasetId: 'd' },
      location: 'EU',
    });
    expect(sent().data).toEqual({
      query: 'SELECT * FROM `p.d.t` WHERE c = @c',
      useLegacySql: false,
      dryRun: true,
      maxResults: 100,
      timeoutMs: 20000,
      maximumBytesBilled: '10737418240',
      parameterMode: 'NAMED',
      queryParameters: [{ name: 'c', parameterType: { type: 'STRING' }, parameterValue: { value: 'DE' } }],
      defaultDataset: { projectId: 'p', datasetId: 'd' },
      location: 'EU',
    });
  });

  it('previews rows with a small default and lists jobs with the full projection', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('bigquery_preview_table_rows', { project_id: 'p1', dataset_id: 'd', table_id: 't', selectedFields: 'a,b' });
    expect(sent().params).toEqual({ maxResults: 10, selectedFields: 'a,b' });
    mockedAxios.mockClear();
    await call('bigquery_list_jobs', { project_id: 'p1', stateFilter: ['running', 'pending'] });
    expect(sent().params).toEqual({ maxResults: 20, stateFilter: ['running', 'pending'], projection: 'full' });
    mockedAxios.mockClear();
    await call('bigquery_get_query_results', { project_id: 'p1', job_id: 'j', location: 'europe-west3', pageToken: 'tok' });
    expect(sent().params).toEqual({ location: 'europe-west3', pageToken: 'tok', maxResults: 100, timeoutMs: 20000 });
  });

  it('flattens query rows into value lists and keeps the cost fields', () => {
    const out = shape('bigquery_run_query', {
      kind: 'bigquery#queryResponse',
      jobComplete: true,
      jobReference: { projectId: 'p1', jobId: 'job_1', location: 'US' },
      schema: { fields: [{ name: 'word', type: 'STRING', mode: 'NULLABLE' }, { name: 'n', type: 'INTEGER', mode: 'NULLABLE' }] },
      rows: [{ f: [{ v: 'the' }, { v: '25568' }] }, { f: [{ v: 'and' }, { v: null }] }],
      totalRows: '2',
      totalBytesProcessed: '6432064',
      totalBytesBilled: '10485760',
      cacheHit: false,
      statementType: 'SELECT',
      queryId: 'q',
    });
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      jobComplete: true,
      jobReference: { projectId: 'p1', jobId: 'job_1', location: 'US' },
      statementType: 'SELECT',
      totalBytesProcessed: '6432064',
      totalBytesBilled: '10485760',
      cacheHit: false,
      totalRows: '2',
      schema: [{ name: 'word', type: 'STRING', mode: 'NULLABLE' }, { name: 'n', type: 'INTEGER', mode: 'NULLABLE' }],
      rows: [{ values: ['the', '25568'] }, { values: ['and', null] }],
    });
    const dry = shape('bigquery_run_query', { kind: 'bigquery#queryResponse', jobReference: { projectId: 'p1', location: 'US' }, totalBytesProcessed: '1099511627776', jobComplete: true, cacheHit: false, schema: { fields: [] } });
    expect(dry.value).toMatchObject({ totalBytesProcessed: '1099511627776', jobComplete: true });
  });

  it('caps preview rows at 100 and query rows at 1000 whatever the API returns', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ f: [{ v: String(i) }] }));
    const preview = shape('bigquery_preview_table_rows', { totalRows: '5000', rows: many(150), pageToken: 'x' }).value as any;
    expect(preview.rows).toHaveLength(100);
    const query = shape('bigquery_get_query_results', { jobComplete: true, rows: many(1200) }).value as any;
    expect(query.rows).toHaveLength(1000);
  });

  it('keeps dataset access lists out of the answer', () => {
    const out = shape('bigquery_get_dataset', {
      datasetReference: { projectId: 'p1', datasetId: 'd' },
      location: 'EU',
      access: [{ role: 'OWNER', userByEmail: 'someone@example.com' }],
    }).value as any;
    expect(out).toEqual({ datasetReference: { projectId: 'p1', datasetId: 'd' }, location: 'EU' });
  });
});

const live = process.env.RUN_BIGQUERY_LIVE === '1' ? describe : describe.skip;
live('bigquery adapter: live', () => {
  const token = process.env.BIGQUERY_ACCESS_TOKEN;
  const project = process.env.BIGQUERY_PROJECT_ID;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['bigquery_list_projects', {}],
    ['bigquery_list_datasets', { project_id: 'bigquery-public-data' }],
    ['bigquery_get_dataset', { project_id: 'bigquery-public-data', dataset_id: 'samples' }],
    ['bigquery_list_tables', { project_id: 'bigquery-public-data', dataset_id: 'samples' }],
    ['bigquery_get_table', { project_id: 'bigquery-public-data', dataset_id: 'samples', table_id: 'shakespeare' }],
    ['bigquery_run_query', { project_id: 'bigquery-public-data', query: 'SELECT 1', dryRun: true }],
    ['bigquery_get_query_results', { project_id: 'bigquery-public-data', job_id: 'job_x' }],
    ['bigquery_list_jobs', { project_id: 'bigquery-public-data' }],
    ['bigquery_get_job', { project_id: 'bigquery-public-data', job_id: 'job_x' }],
    ['bigquery_cancel_job', { project_id: 'bigquery-public-data', job_id: 'job_x' }],
    // An existing project id: for an unknown one jobs.query answers 400
    // "Cannot parse as CloudRegion" before it checks the token.
  ])('%s reaches a real route and Google refuses a fake token (401)', async (name, params) => {
    await expect(call(name, params, 'ya29.fake-token')).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers 404 on a made-up route', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/projects/p1/does-not-exist`, method: 'GET', headers: { Authorization: 'Bearer ya29.fake' } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (token && project ? it : it.skip)('reads a public table for free, dry-runs and runs a tiny query', async () => {
    const run = async (name: string, params: Record<string, unknown>) => {
      const out = shape(name, await call(name, params, token));
      expect(out.error).toBeUndefined();
      return out.value as any;
    };
    expect((await run('bigquery_list_projects', { maxResults: 5 })).projects.length).toBeGreaterThan(0);
    const table = await run('bigquery_get_table', { project_id: 'bigquery-public-data', dataset_id: 'samples', table_id: 'shakespeare' });
    expect(table.schema.map((f: { name: string }) => f.name)).toContain('word');
    const preview = await run('bigquery_preview_table_rows', { project_id: 'bigquery-public-data', dataset_id: 'samples', table_id: 'shakespeare', maxResults: 3 });
    expect(preview.rows).toHaveLength(3);
    const sql = 'SELECT word, word_count FROM `bigquery-public-data.samples.shakespeare` WHERE corpus = @c ORDER BY word_count DESC LIMIT 3';
    const queryParameters = [{ name: 'c', parameterType: { type: 'STRING' }, parameterValue: { value: 'hamlet' } }];
    const dry = await run('bigquery_run_query', { project_id: project, query: sql, dryRun: true, parameterMode: 'NAMED', queryParameters });
    expect(Number(dry.totalBytesProcessed)).toBeGreaterThan(0);
    const res = await run('bigquery_run_query', { project_id: project, query: sql, parameterMode: 'NAMED', queryParameters, maximumBytesBilled: '104857600' });
    expect(res.jobComplete).toBe(true);
    expect(res.rows).toHaveLength(3);
    const job = await run('bigquery_get_job', { project_id: project, job_id: res.jobReference.jobId, location: res.jobReference.location });
    expect(job.status.state).toBe('DONE');
    expect(Array.isArray((await run('bigquery_list_jobs', { project_id: project, maxResults: 3 })).jobs)).toBe(true);
  }, 120000);
});
