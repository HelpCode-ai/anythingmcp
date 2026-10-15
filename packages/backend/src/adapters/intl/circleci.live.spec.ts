import axios from 'axios';
import * as adapter from './circleci.json';
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
 * Two layers of verification for the CircleCI adapter:
 *
 *   1. Static: always runs. Pins the personal API token in the Circle-Token
 *      header, the /me healthcheck, and every tool's method, URL, query and
 *      body through the real RestEngine, checked against CircleCI's OpenAPI
 *      document (circleci.com/api/v2/openapi.json, read 15 Oct 2026). Job
 *      details, tests and artifacts are no longer in that document; their
 *      routes come from its 2024 edition and CircleCI's own open-source MCP
 *      server, and answered 200 for a public project on 15 Oct 2026.
 *      Response mappings run on responses recorded from the public project
 *      gh/CircleCI-Public/circleci-cli. Flaky tests come back with snake_case
 *      keys although the document spells them with hyphens. Also which tools
 *      only read, that every write asks for confirmation and that variable
 *      values never reach the model.
 *
 *   2. Live: skipped unless RUN_CIRCLECI_LIVE=1. Without a token it checks
 *      that CircleCI refuses a wrong token with 401 (CircleCI checks the token
 *      before routing), then reads a public project anonymously through the
 *      same mappings, which proves the routes. With CIRCLECI_TOKEN it reads
 *      the user and organizations, and with CIRCLECI_PROJECT_SLUG also
 *      pipelines, workflows, jobs, tests, artifacts, insights and variable
 *      names. Nothing is written unless RUN_CIRCLECI_LIVE_WRITES=1 and
 *      CIRCLECI_LIVE_WORKFLOW_ID are set too: then that workflow is rerun
 *      from its failed job.
 *
 *        RUN_CIRCLECI_LIVE=1 CIRCLECI_TOKEN=... CIRCLECI_PROJECT_SLUG=gh/acme/web \
 *          npx jest src/adapters/intl/circleci.live.spec.ts
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

const HOST = 'https://circleci.com/api/v2';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'CCIPAT_' + 'A'.repeat(30) + '_' + '0'.repeat(8);
const ENV: Record<string, string> = { CIRCLECI_TOKEN: FAKE_TOKEN };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call. anonymous leaves
// the token out, as a client without credentials would.
const call = (name: string, params: Record<string, unknown>, env = ENV, anonymous = false) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: anonymous ? 'NONE' : a.connector.authType,
      authConfig: anonymous ? undefined : interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, env = ENV, anonymous = false) =>
  shape(name, await call(name, params, env, anonymous));
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = ['circleci_cancel_workflow', 'circleci_rerun_workflow', 'circleci_trigger_pipeline'];
const SLUG = 'gh/acme/web';
const UUID = '5034460f-c7c4-4c43-9457-de07e2029e7b';

describe('circleci adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the personal token in the Circle-Token header and checks it on /me', () => {
    expect(a.category).toBe('infrastructure');
    expect(a.icon).toBe('circleci');
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Circle-Token', apiKey: '{{CIRCLECI_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/me');
    expect(a.probe.tool).toBe('circleci_get_current_user');
    expect(a.requiredEnvVars).toEqual(['CIRCLECI_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.CIRCLECI_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts new and classic tokens and refuses one pasted with a prefix', () => {
    const token = new RegExp(a.envVarMeta.CIRCLECI_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    expect(token.test('a'.repeat(40))).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, 'short', `${FAKE_TOKEN} x`]) expect(token.test(bad)).toBe(false);
  });

  it('explains wrong tokens, wrong slugs and the rate limit', () => {
    for (const key of ['401', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/project API token/);
  });

  it('prefixes every tool with circleci_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^circleci_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('confirms every write, flags cancel as destructive and ships no deletes', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(`${name}:${/confirm/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
    expect(annotationsOf(tool('circleci_cancel_workflow'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool('circleci_trigger_pipeline').description).toMatch(/credits/);
  });

  it('only points the model at tools that exist, explains slugs, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bcircleci_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bcircleci_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('gh/<org>/<repo>');
    expect(a.instructions).toContain('circleci/<organization id>/<project id>');
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
    ['circleci_get_current_user', {}, 'GET', '/me'],
    ['circleci_list_collaborations', {}, 'GET', '/me/collaborations'],
    ['circleci_get_project', { project_slug: SLUG }, 'GET', `/project/${SLUG}`],
    ['circleci_list_pipeline_definitions', { project_id: UUID }, 'GET', `/projects/${UUID}/pipeline-definitions`],
    ['circleci_list_pipelines', { project_slug: SLUG }, 'GET', `/project/${SLUG}/pipeline`],
    ['circleci_get_pipeline', { pipeline_id: UUID }, 'GET', `/pipeline/${UUID}`],
    ['circleci_get_pipeline_by_number', { project_slug: SLUG, pipeline_number: 25 }, 'GET', `/project/${SLUG}/pipeline/25`],
    ['circleci_list_pipeline_workflows', { pipeline_id: UUID }, 'GET', `/pipeline/${UUID}/workflow`],
    ['circleci_get_workflow', { workflow_id: UUID }, 'GET', `/workflow/${UUID}`],
    ['circleci_list_workflow_jobs', { workflow_id: UUID }, 'GET', `/workflow/${UUID}/job`],
    ['circleci_get_job', { project_slug: SLUG, job_number: 123 }, 'GET', `/project/${SLUG}/job/123`],
    ['circleci_list_job_tests', { project_slug: SLUG, job_number: 123 }, 'GET', `/project/${SLUG}/123/tests`],
    ['circleci_list_job_artifacts', { project_slug: SLUG, job_number: 123 }, 'GET', `/project/${SLUG}/123/artifacts`],
    ['circleci_get_workflow_metrics', { project_slug: SLUG }, 'GET', `/insights/${SLUG}/workflows`],
    ['circleci_get_workflow_summary', { project_slug: SLUG, workflow_name: 'build' }, 'GET', `/insights/${SLUG}/workflows/build/summary`],
    ['circleci_list_flaky_tests', { project_slug: SLUG }, 'GET', `/insights/${SLUG}/flaky-tests`],
    ['circleci_trigger_pipeline', { project_slug: SLUG, definition_id: UUID, branch: 'main' }, 'POST', `/project/${SLUG}/pipeline/run`],
    ['circleci_rerun_workflow', { workflow_id: UUID, from_failed: true }, 'POST', `/workflow/${UUID}/rerun`],
    ['circleci_cancel_workflow', { workflow_id: UUID }, 'POST', `/workflow/${UUID}/cancel`],
    ['circleci_list_contexts', { owner_id: UUID }, 'GET', '/context'],
    ['circleci_list_context_env_var_names', { context_id: UUID }, 'GET', `/context/${UUID}/environment-variable`],
    ['circleci_list_project_env_var_names', { project_slug: SLUG }, 'GET', `/project/${SLUG}/envvar`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Circle-Token header', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers['Circle-Token']).toBe(FAKE_TOKEN);
    expect(req.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('keeps the slashes of circleci/ slugs and sends the hyphenated query names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const appSlug = 'circleci/43G3lM5RtfFE7v5sa4nWAU/44n9wujWcTnVZ2b5S8Fnat';
    await call('circleci_list_pipelines', { project_slug: appSlug, branch: 'main', page_token: 'tok' });
    expect(sent().url).toBe(`${HOST}/project/${appSlug}/pipeline`);
    expect(sent().params).toEqual({ branch: 'main', 'page-token': 'tok' });
    mockedAxios.mockClear();
    await call('circleci_get_workflow_metrics', { project_slug: SLUG, reporting_window: 'last-7-days', all_branches: true });
    expect(sent().params).toEqual({ 'reporting-window': 'last-7-days', 'all-branches': true });
    mockedAxios.mockClear();
    await call('circleci_list_contexts', { owner_slug: 'gh/acme' });
    expect(sent().params).toEqual({ 'owner-slug': 'gh/acme' });
  });

  it('builds the trigger and rerun bodies the way the API documents them', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('circleci_trigger_pipeline', { project_slug: SLUG, definition_id: UUID, branch: 'main', parameters: { deploy: true } });
    expect(sent().data).toEqual({ definition_id: UUID, config: { branch: 'main' }, checkout: { branch: 'main' }, parameters: { deploy: true } });
    mockedAxios.mockClear();
    await call('circleci_trigger_pipeline', { project_slug: SLUG, definition_id: UUID, tag: 'v2.0.0' });
    expect(sent().data).toEqual({ definition_id: UUID, config: { tag: 'v2.0.0' }, checkout: { tag: 'v2.0.0' } });
    mockedAxios.mockClear();
    await call('circleci_rerun_workflow', { workflow_id: UUID, from_failed: true });
    expect(sent().data).toEqual({ from_failed: true });
    mockedAxios.mockClear();
    await call('circleci_rerun_workflow', { workflow_id: UUID, jobs: [UUID] });
    expect(sent().data).toEqual({ jobs: [UUID] });
    mockedAxios.mockClear();
    await call('circleci_cancel_workflow', { workflow_id: UUID });
    expect(sent().data ?? {}).toEqual({});
  });

  // Recorded from gh/CircleCI-Public/circleci-cli on 15 Oct 2026, trimmed.
  const PIPELINE = {
    id: 'cfe3d74b-3d32-4686-831a-cd870e8b2646',
    errors: [],
    project_slug: 'gh/CircleCI-Public/circleci-cli',
    updated_at: '2026-10-14T22:54:52.009Z',
    number: 8010,
    state: 'created',
    created_at: '2026-10-14T22:54:51.796Z',
    warnings: [],
    trigger: { received_at: '2026-10-14T22:54:51.438Z', type: 'webhook', actor: { login: 'dependabot[bot]', avatar_url: null } },
    vcs: {
      origin_repository_url: 'https://github.com/CircleCI-Public/circleci-cli',
      revision: '379a18c1938759735ad70904fbe44d04c6d61b2b',
      provider_name: 'GitHub',
      commit: { body: 'Bumps gopsutil from 4.26.8 to 4.26.9. (long body)', subject: 'Bump github.com/shirou/gopsutil/v4 in /' },
      branch: 'dependabot/go_modules/go_modules-197336f7a8',
    },
  };

  it('shapes pipelines, jobs and tests from recorded answers', () => {
    expect(shape('circleci_list_pipelines', { next_page_token: 'AO9u', items: [PIPELINE] })).toEqual({
      items: [
        {
          id: 'cfe3d74b-3d32-4686-831a-cd870e8b2646',
          number: 8010,
          state: 'created',
          project_slug: 'gh/CircleCI-Public/circleci-cli',
          created_at: '2026-10-14T22:54:51.796Z',
          updated_at: '2026-10-14T22:54:52.009Z',
          branch: 'dependabot/go_modules/go_modules-197336f7a8',
          revision: '379a18c1938759735ad70904fbe44d04c6d61b2b',
          commit_subject: 'Bump github.com/shirou/gopsutil/v4 in /',
          trigger_type: 'webhook',
          actor: 'dependabot[bot]',
          errors: [],
        },
      ],
      next_page_token: 'AO9u',
    });
    const job = shape('circleci_get_job', {
      created_at: '2026-10-14T22:54:52.344Z',
      duration: 329774,
      executor: { resource_class: 'medium', type: 'windows' },
      messages: [],
      status: 'success',
      parallel_runs: [{ index: 0, status: 'success' }],
      contexts: [{ name: 'release' }],
      latest_workflow: { id: 'e50b2a01-6fa6-4eef-8582-9693f3c32410', name: 'ci' },
      name: 'test-windows',
      number: 53092,
      organization: { name: 'CircleCI-Public' },
      parallelism: 1,
      pipeline: { id: 'cfe3d74b-3d32-4686-831a-cd870e8b2646' },
      project: { external_url: 'https://github.com/CircleCI-Public/circleci-cli', id: '7097f60c', name: 'circleci-cli', slug: 'gh/CircleCI-Public/circleci-cli' },
      web_url: 'https://circleci.com/gh/CircleCI-Public/circleci-cli/53092',
    });
    expect(job).toMatchObject({
      name: 'test-windows',
      number: 53092,
      status: 'success',
      duration: 329774,
      executor: { resource_class: 'medium', type: 'windows' },
      contexts: ['release'],
      pipeline_id: 'cfe3d74b-3d32-4686-831a-cd870e8b2646',
      workflow: { id: 'e50b2a01-6fa6-4eef-8582-9693f3c32410', name: 'ci' },
      project: 'gh/CircleCI-Public/circleci-cli',
      web_url: 'https://circleci.com/gh/CircleCI-Public/circleci-cli/53092',
    });
    const tests = shape('circleci_list_job_tests', {
      items: [
        { classname: 'github.com/CircleCI-Public/circleci-cli/acceptance', name: 'TestAPI_Get_Color', result: 'skipped', message: '--- SKIP', run_time: 0, source: 'unknown' },
        { classname: 'cli', name: 'TestOk', result: 'success', message: '=== RUN TestOk\n--- PASS (long output)', run_time: 0.2, source: 'unknown' },
        { classname: 'cli', name: 'TestBroken', result: 'failure', message: 'expected 1, got 2', run_time: 1.5, file: 'cli_test.go', source: 'unknown' },
      ],
      next_page_token: null,
    });
    // Passing and skipped tests are only counted: their output can run to megabytes.
    expect(tests).toEqual({
      total: 3,
      passed: 1,
      skipped: 1,
      failed: [{ name: 'TestBroken', classname: 'cli', file: 'cli_test.go', result: 'failure', run_time: 1.5, message: 'expected 1, got 2' }],
      next_page_token: null,
    });
  });

  it('reads flaky tests with snake_case keys and organizations from a bare array', () => {
    const flaky = shape('circleci_list_flaky_tests', {
      flaky_tests: [
        {
          test_name: 'TestLogin',
          classname: 'auth',
          file: 'auth_test.go',
          source: 'go',
          job_name: 'test',
          job_number: 77,
          workflow_name: 'ci',
          workflow_id: 'w1',
          pipeline_number: 12,
          times_flaked: 3,
          time_wasted: 120,
          workflow_created_at: '2026-10-01T00:00:00Z',
        },
      ],
      total_flaky_tests: 1,
    });
    expect(flaky.total_flaky_tests).toBe(1);
    expect(flaky.flaky_tests[0]).toMatchObject({ test_name: 'TestLogin', job_number: 77, times_flaked: 3 });
    const orgs = shape('circleci_list_collaborations', [{ id: 'o1', 'vcs-type': 'github', name: 'acme', avatar_url: 'https://x', slug: 'gh/acme' }]);
    expect(orgs).toEqual({ organizations: [{ id: 'o1', name: 'acme', vcs_type: 'github', slug: 'gh/acme' }] });
  });

  it('never returns environment variable values, not even the masked ones', () => {
    const out = shape('circleci_list_project_env_var_names', {
      items: [{ name: 'AWS_SECRET', value: 'xxxxabcd', 'created-at': '2026-01-01T00:00:00Z' }],
      next_page_token: null,
    });
    expect(out).toEqual({ items: [{ name: 'AWS_SECRET', created_at: '2026-01-01T00:00:00Z' }], next_page_token: null });
    expect(JSON.stringify(out)).not.toContain('abcd');
  });
});

const live = process.env.RUN_CIRCLECI_LIVE === '1' ? describe : describe.skip;
live('circleci adapter: live', () => {
  const real = !!process.env.CIRCLECI_TOKEN;
  const env = () => ({ CIRCLECI_TOKEN: process.env.CIRCLECI_TOKEN! });
  const slug = process.env.CIRCLECI_PROJECT_SLUG;
  const PUBLIC = 'gh/CircleCI-Public/circleci-cli';
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['circleci_get_current_user', {}],
    ['circleci_get_project', { project_slug: PUBLIC }],
    ['circleci_list_pipelines', { project_slug: PUBLIC }],
    ['circleci_get_job', { project_slug: PUBLIC, job_number: 1 }],
    ['circleci_list_flaky_tests', { project_slug: PUBLIC }],
  ])('%s reaches CircleCI and is refused with a wrong token (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('walks a public project anonymously: pipeline, workflow, jobs, job, tests, artifacts and insights', async () => {
    const project = await shaped('circleci_get_project', { project_slug: PUBLIC }, ENV, true);
    expect(project.slug).toBe(PUBLIC);
    const pipelines = await shaped('circleci_list_pipelines', { project_slug: PUBLIC }, ENV, true);
    const pipelineId = pipelines.items[0].id;
    const workflows = await shaped('circleci_list_pipeline_workflows', { pipeline_id: pipelineId }, ENV, true);
    expect(Array.isArray(workflows.items)).toBe(true);
    const workflowId = workflows.items[0]?.id;
    if (workflowId) {
      const jobs = await shaped('circleci_list_workflow_jobs', { workflow_id: workflowId }, ENV, true);
      const jobNumber = jobs.items.find((j: any) => j.job_number)?.job_number;
      if (jobNumber) {
        expect((await shaped('circleci_get_job', { project_slug: PUBLIC, job_number: jobNumber }, ENV, true)).number).toBe(jobNumber);
        const tests = await shaped('circleci_list_job_tests', { project_slug: PUBLIC, job_number: jobNumber }, ENV, true);
        expect(typeof tests.total).toBe('number');
        expect(Array.isArray(tests.failed)).toBe(true);
        expect(Array.isArray((await shaped('circleci_list_job_artifacts', { project_slug: PUBLIC, job_number: jobNumber }, ENV, true)).items)).toBe(true);
      }
    }
    const metrics = await shaped('circleci_get_workflow_metrics', { project_slug: PUBLIC }, ENV, true);
    expect(Array.isArray(metrics.items)).toBe(true);
    const flaky = await shaped('circleci_list_flaky_tests', { project_slug: PUBLIC }, ENV, true);
    expect(typeof flaky.total_flaky_tests).toBe('number');
  }, 120000);

  (real ? it : it.skip)('reads the user and organizations', async () => {
    expect((await shaped('circleci_get_current_user', {}, env())).id).toBeTruthy();
    expect(Array.isArray((await shaped('circleci_list_collaborations', {}, env())).organizations)).toBe(true);
  }, 60000);

  (real && slug ? it : it.skip)('reads pipelines, definitions and variable names of the given project', async () => {
    const project = await shaped('circleci_get_project', { project_slug: slug! }, env());
    expect(Array.isArray((await shaped('circleci_list_pipeline_definitions', { project_id: project.id }, env())).items)).toBe(true);
    expect(Array.isArray((await shaped('circleci_list_pipelines', { project_slug: slug! }, env())).items)).toBe(true);
    const vars = await shaped('circleci_list_project_env_var_names', { project_slug: slug! }, env());
    expect(JSON.stringify(vars)).not.toMatch(/"value"/);
  }, 120000);

  const writes = real && process.env.RUN_CIRCLECI_LIVE_WRITES === '1' && process.env.CIRCLECI_LIVE_WORKFLOW_ID;
  (writes ? it : it.skip)('reruns the given workflow from its failed job', async () => {
    const out = await shaped('circleci_rerun_workflow', { workflow_id: process.env.CIRCLECI_LIVE_WORKFLOW_ID!, from_failed: true }, env());
    expect(out.workflow_id).toBeTruthy();
  }, 60000);
});
