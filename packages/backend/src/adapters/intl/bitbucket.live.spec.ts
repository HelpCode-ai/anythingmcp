import axios from 'axios';
import * as adapter from './bitbucket.json';
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
 * Two layers of verification for the Bitbucket Cloud adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with an Atlassian API token
 *      (app passwords were switched off on 28 July 2026), the /user
 *      healthcheck, and every tool's method, URL, query, headers and body
 *      through the real RestEngine, checked against Bitbucket's published
 *      OpenAPI document (dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json,
 *      read 15 Oct 2026). Response mappings run on responses recorded from
 *      api.bitbucket.org (public repository atlassian/atlassian-event, read
 *      anonymously on 15 Oct 2026). Also which tools only read, that every
 *      write asks for confirmation, and that step image credentials and links
 *      never reach the model.
 *
 *   2. Live: skipped unless RUN_BITBUCKET_LIVE=1. Without a token it checks
 *      that Bitbucket refuses a wrong token with 401 on the real routes
 *      (Bitbucket checks the token before routing, so this proves the host
 *      and prefix; the routes themselves were checked anonymously against a
 *      public repository, where an unknown route answers 404). With
 *      BITBUCKET_API_TOKEN it reads the user and workspaces, and with
 *      BITBUCKET_WORKSPACE and BITBUCKET_REPO also branches, commits, files,
 *      pull requests and pipelines, shaped by each tool's response mapping as
 *      production does. Nothing is written unless RUN_BITBUCKET_LIVE_WRITES=1
 *      and BITBUCKET_LIVE_PR are set too: then one comment is posted on that
 *      pull request.
 *
 *        RUN_BITBUCKET_LIVE=1 BITBUCKET_API_TOKEN=... BITBUCKET_WORKSPACE=acme BITBUCKET_REPO=web \
 *          npx jest src/adapters/intl/bitbucket.live.spec.ts
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, string> };
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

const HOST = 'https://api.bitbucket.org/2.0';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'ATATT3x' + 'F'.repeat(24);
const ENV: Record<string, string> = { BITBUCKET_API_TOKEN: FAKE_TOKEN };

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
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) => shape(name, await call(name, params, env));
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'bitbucket_add_pull_request_comment',
  'bitbucket_approve_pull_request',
  'bitbucket_create_pull_request',
  'bitbucket_merge_pull_request',
  'bitbucket_run_pipeline',
];
const R = '/repositories/acme/web';
const PIPE = '{1b2c3d4e-0000-4000-8000-000000000001}';
const STEP = '{9f8e7d6c-0000-4000-8000-000000000002}';
const enc = encodeURIComponent;

describe('bitbucket adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the API token as a Bearer token and checks it on /user', () => {
    expect(a.category).toBe('infrastructure');
    expect(a.icon).toBe('bitbucket');
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{BITBUCKET_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/user');
    expect(a.probe.tool).toBe('bitbucket_get_current_user');
    expect(a.requiredEnvVars).toEqual(['BITBUCKET_API_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.BITBUCKET_API_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts a bare token and refuses one pasted with a prefix or spaces', () => {
    const token = new RegExp(a.envVarMeta.BITBUCKET_API_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, 'short', `${FAKE_TOKEN} x`]) expect(token.test(bad)).toBe(false);
  });

  it('explains wrong tokens, missing scopes and the rate limit', () => {
    for (const key of ['401', '403', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/app password/);
  });

  it('prefixes every tool with bitbucket_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^bitbucket_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('confirms every write, flags the merge as destructive and ships no deletes', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(`${name}:${/confirm/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
    expect(annotationsOf(tool('bitbucket_merge_pull_request'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool('bitbucket_merge_pull_request').description).toMatch(/destination branch for everyone/);
    expect(tool('bitbucket_run_pipeline').description).toMatch(/build minutes/);
  });

  it('only points the model at tools that exist, documents setup, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bbitbucket_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbitbucket_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/28 July 2026/);
    expect(a.instructions).toMatch(/read:pullrequest:bitbucket/);
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
    ['bitbucket_get_current_user', {}, 'GET', '/user'],
    ['bitbucket_list_workspaces', {}, 'GET', '/user/workspaces'],
    ['bitbucket_list_repositories', { workspace: 'acme' }, 'GET', '/repositories/acme'],
    ['bitbucket_get_repository', { workspace: 'acme', repo_slug: 'web' }, 'GET', R],
    ['bitbucket_list_branches', { workspace: 'acme', repo_slug: 'web' }, 'GET', `${R}/refs/branches`],
    ['bitbucket_list_commits', { workspace: 'acme', repo_slug: 'web' }, 'GET', `${R}/commits`],
    ['bitbucket_get_commit', { workspace: 'acme', repo_slug: 'web', commit: 'abc123' }, 'GET', `${R}/commit/abc123`],
    ['bitbucket_get_file', { workspace: 'acme', repo_slug: 'web', commit: 'main', path: 'src/app.ts' }, 'GET', `${R}/src/main/src/app.ts`],
    ['bitbucket_list_pull_requests', { workspace: 'acme', repo_slug: 'web' }, 'GET', `${R}/pullrequests`],
    ['bitbucket_get_pull_request', { workspace: 'acme', repo_slug: 'web', pull_request_id: 7 }, 'GET', `${R}/pullrequests/7`],
    ['bitbucket_get_pull_request_diffstat', { workspace: 'acme', repo_slug: 'web', pull_request_id: 7 }, 'GET', `${R}/pullrequests/7/diffstat`],
    ['bitbucket_get_pull_request_diff', { workspace: 'acme', repo_slug: 'web', pull_request_id: 7 }, 'GET', `${R}/pullrequests/7/diff`],
    ['bitbucket_list_pull_request_commits', { workspace: 'acme', repo_slug: 'web', pull_request_id: 7 }, 'GET', `${R}/pullrequests/7/commits`],
    ['bitbucket_list_pull_request_comments', { workspace: 'acme', repo_slug: 'web', pull_request_id: 7 }, 'GET', `${R}/pullrequests/7/comments`],
    [
      'bitbucket_create_pull_request',
      { workspace: 'acme', repo_slug: 'web', title: 'Login', source_branch: 'feature/login', destination_branch: 'main' },
      'POST',
      `${R}/pullrequests`,
    ],
    ['bitbucket_add_pull_request_comment', { workspace: 'acme', repo_slug: 'web', pull_request_id: 7, text: 'LGTM' }, 'POST', `${R}/pullrequests/7/comments`],
    ['bitbucket_approve_pull_request', { workspace: 'acme', repo_slug: 'web', pull_request_id: 7 }, 'POST', `${R}/pullrequests/7/approve`],
    ['bitbucket_merge_pull_request', { workspace: 'acme', repo_slug: 'web', pull_request_id: 7 }, 'POST', `${R}/pullrequests/7/merge`],
    ['bitbucket_list_pipelines', { workspace: 'acme', repo_slug: 'web' }, 'GET', `${R}/pipelines`],
    ['bitbucket_get_pipeline', { workspace: 'acme', repo_slug: 'web', pipeline_uuid: PIPE }, 'GET', `${R}/pipelines/${enc(PIPE)}`],
    ['bitbucket_list_pipeline_steps', { workspace: 'acme', repo_slug: 'web', pipeline_uuid: PIPE }, 'GET', `${R}/pipelines/${enc(PIPE)}/steps`],
    [
      'bitbucket_get_pipeline_step_log',
      { workspace: 'acme', repo_slug: 'web', pipeline_uuid: PIPE, step_uuid: STEP },
      'GET',
      `${R}/pipelines/${enc(PIPE)}/steps/${enc(STEP)}/log`,
    ],
    ['bitbucket_run_pipeline', { workspace: 'acme', repo_slug: 'web', ref_name: 'main' }, 'POST', `${R}/pipelines`],
    ['bitbucket_list_environments', { workspace: 'acme', repo_slug: 'web' }, 'GET', `${R}/environments`],
    ['bitbucket_list_deployments', { workspace: 'acme', repo_slug: 'web' }, 'GET', `${R}/deployments`],
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

  it('reads the repository root at HEAD by default and sends list filters with defaults', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('bitbucket_get_file', { workspace: 'acme', repo_slug: 'web' });
    expect(sent().url).toBe(`${HOST}${R}/src/HEAD/`);
    mockedAxios.mockClear();
    await call('bitbucket_list_pull_requests', { workspace: 'acme', repo_slug: 'web', q: 'destination.branch.name = "main"' });
    expect(sent().params).toEqual({ state: ['OPEN'], q: 'destination.branch.name = "main"', sort: '-updated_on', pagelen: 25 });
    mockedAxios.mockClear();
    await call('bitbucket_list_commits', { workspace: 'acme', repo_slug: 'web', include: 'main', path: 'src/' });
    expect(sent().params).toEqual({ include: 'main', path: 'src/', pagelen: 20 });
    mockedAxios.mockClear();
    await call('bitbucket_list_pipelines', { workspace: 'acme', repo_slug: 'web', branch: 'main' });
    expect(sent().params).toEqual({ 'target.branch': 'main', sort: '-created_on', pagelen: 20 });
  });

  it('sends a Range header for the step log only when asked', async () => {
    mockedAxios.mockResolvedValue({ data: 'log' });
    const base = { workspace: 'acme', repo_slug: 'web', pipeline_uuid: PIPE, step_uuid: STEP };
    await call('bitbucket_get_pipeline_step_log', base);
    expect(sent().headers.Range).toBeUndefined();
    mockedAxios.mockClear();
    await call('bitbucket_get_pipeline_step_log', { ...base, range: 'bytes=-150000' });
    expect(sent().headers.Range).toBe('bytes=-150000');
  });

  it('builds pull request, comment, merge and pipeline bodies the way the API documents them', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const repo = { workspace: 'acme', repo_slug: 'web' };
    await call('bitbucket_create_pull_request', {
      ...repo,
      title: 'Add login',
      source_branch: 'feature/login',
      destination_branch: 'main',
      description: 'Adds the form',
      close_source_branch: true,
      reviewers: [{ uuid: '{504c3b62-8120-4f0c-a7bc-87800b9d6f70}' }],
    });
    expect(sent().data).toEqual({
      title: 'Add login',
      description: 'Adds the form',
      source: { branch: { name: 'feature/login' } },
      destination: { branch: { name: 'main' } },
      close_source_branch: true,
      reviewers: [{ uuid: '{504c3b62-8120-4f0c-a7bc-87800b9d6f70}' }],
    });
    mockedAxios.mockClear();
    // A plain comment carries no empty inline or parent objects.
    await call('bitbucket_add_pull_request_comment', { ...repo, pull_request_id: 7, text: 'Looks good' });
    expect(sent().data).toEqual({ content: { raw: 'Looks good' } });
    mockedAxios.mockClear();
    await call('bitbucket_add_pull_request_comment', { ...repo, pull_request_id: 7, text: 'Typo', inline: { path: 'src/app.ts', to: 42 } });
    expect(sent().data).toEqual({ content: { raw: 'Typo' }, inline: { path: 'src/app.ts', to: 42 } });
    mockedAxios.mockClear();
    await call('bitbucket_merge_pull_request', { ...repo, pull_request_id: 7, merge_strategy: 'squash', close_source_branch: true });
    expect(sent().data).toEqual({ type: 'pullrequest_merge_parameters', merge_strategy: 'squash', close_source_branch: true });
    mockedAxios.mockClear();
    await call('bitbucket_approve_pull_request', { ...repo, pull_request_id: 7 });
    expect(sent().data ?? {}).toEqual({});
    mockedAxios.mockClear();
    await call('bitbucket_run_pipeline', { ...repo, ref_name: 'main' });
    expect(sent().data).toEqual({ target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'main' } });
    mockedAxios.mockClear();
    await call('bitbucket_run_pipeline', {
      ...repo,
      ref_name: 'release/2.0',
      selector: { type: 'custom', pattern: 'deploy-to-staging' },
      variables: [{ key: 'ENV', value: 'staging' }],
    });
    expect(sent().data).toEqual({
      target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'release/2.0', selector: { type: 'custom', pattern: 'deploy-to-staging' } },
      variables: [{ key: 'ENV', value: 'staging' }],
    });
  });

  // Recorded from api.bitbucket.org (atlassian/atlassian-event), trimmed.
  const AUTHOR = { display_name: 'Petro Semeniuk', uuid: '{2d553853-62d7-4ecb-a796-bd8fc0bfdd4f}', nickname: 'psemeniuk', links: { avatar: { href: 'https://x' } } };
  const PR_SAMPLE = {
    id: 20,
    title: 'Issue/vpp 243',
    description: 'This brings scope awareness to event listeners.',
    state: 'MERGED',
    draft: false,
    author: AUTHOR,
    source: { branch: { name: 'issue/VPP-243', links: {} }, commit: { hash: 'db89d0c8e7d7', links: {} }, repository: { full_name: 'atlassian/atlassian-event' } },
    destination: { branch: { name: 'master' }, commit: { hash: 'e6bf7c63b7af' } },
    merge_commit: { hash: '6e2c4a1b0f3d' },
    comment_count: 5,
    task_count: 0,
    created_on: '2016-04-28T05:27:11.180930+00:00',
    updated_on: '2016-05-02T01:28:35.120434+00:00',
    participants: [{ user: AUTHOR, role: 'PARTICIPANT', approved: false, state: null, participated_on: '2016-04-29T07:06:39+00:00' }],
    rendered: { description: { html: '<p>long</p>' } },
    summary: { raw: 'long', html: '<p>long</p>' },
    links: { html: { href: 'https://bitbucket.org/atlassian/atlassian-event/pull-requests/20' }, diff: { href: 'https://x' } },
  };

  it('keeps pull requests compact and drops rendered HTML and links', () => {
    const list = shape('bitbucket_list_pull_requests', { values: [PR_SAMPLE], pagelen: 1, size: 20, page: 1, next: 'https://api.bitbucket.org/2.0/x?page=2' });
    expect(list).toEqual({
      pull_requests: [
        {
          id: 20,
          title: 'Issue/vpp 243',
          state: 'MERGED',
          draft: false,
          author: 'Petro Semeniuk',
          source_branch: 'issue/VPP-243',
          destination_branch: 'master',
          comment_count: 5,
          task_count: 0,
          created_on: '2016-04-28T05:27:11.180930+00:00',
          updated_on: '2016-05-02T01:28:35.120434+00:00',
          html_url: 'https://bitbucket.org/atlassian/atlassian-event/pull-requests/20',
        },
      ],
      next: 'https://api.bitbucket.org/2.0/x?page=2',
      page: 1,
      size: 20,
    });
    const one = shape('bitbucket_get_pull_request', PR_SAMPLE);
    expect(one).toMatchObject({
      id: 20,
      source_branch: 'issue/VPP-243',
      source_commit: 'db89d0c8e7d7',
      destination_branch: 'master',
      merge_commit: '6e2c4a1b0f3d',
      participants: [{ name: 'Petro Semeniuk', uuid: '{2d553853-62d7-4ecb-a796-bd8fc0bfdd4f}', role: 'PARTICIPANT', approved: false, state: null }],
    });
    expect(JSON.stringify(one)).not.toContain('<p>');
  });

  it('returns file text unchanged, strips links from folder listings and caps large text', () => {
    expect(shape('bitbucket_get_file', '/target\n*.iml\n')).toBe('/target\n*.iml\n');
    const dir = shape('bitbucket_get_file', {
      pagelen: 10,
      values: [
        { path: '.gitignore', type: 'commit_file', size: 19, attributes: [], escaped_path: '.gitignore', commit: { hash: '8047fe8', type: 'commit', links: { self: { href: 'https://x' } } }, links: { self: { href: 'https://x' } } },
        { path: 'src', type: 'commit_directory', commit: { hash: '8047fe8', type: 'commit', links: {} }, links: {} },
      ],
      page: 1,
    });
    expect(dir.values).toEqual([
      { path: '.gitignore', type: 'commit_file', size: 19, attributes: [], escaped_path: '.gitignore', commit: { hash: '8047fe8' } },
      { path: 'src', type: 'commit_directory', commit: { hash: '8047fe8' } },
    ]);
    const big = shape('bitbucket_get_pull_request_diff', 'x'.repeat(250000));
    expect(big._truncated).toBe(true);
  });

  it('never returns a step image password or pipeline variables', () => {
    const steps = shape('bitbucket_list_pipeline_steps', {
      values: [
        {
          uuid: STEP,
          name: 'Build',
          state: { name: 'COMPLETED', result: { name: 'FAILED' } },
          image: { name: 'registry.example.com/build:1', username: 'ci', password: 'hunter2-secret', email: 'ci@example.com' },
          script_commands: [{ name: 'npm test', command: 'npm test' }],
          duration_in_seconds: 42,
        },
      ],
      page: 1,
      size: 1,
    });
    expect(steps.steps).toEqual([
      { uuid: STEP, name: 'Build', state: 'COMPLETED', result: 'FAILED', duration_in_seconds: 42, image: 'registry.example.com/build:1', commands: ['npm test'] },
    ]);
    expect(JSON.stringify(steps)).not.toContain('hunter2');
    const run = shape('bitbucket_get_pipeline', {
      uuid: PIPE,
      build_number: 12,
      state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
      target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'main', commit: { hash: 'abc' } },
      variables: [{ key: 'TOKEN', value: 'secret-value', secured: false }],
    });
    expect(run).toMatchObject({ uuid: PIPE, build_number: 12, state: 'COMPLETED', result: 'SUCCESSFUL', ref_name: 'main', commit: 'abc' });
    expect(JSON.stringify(run)).not.toContain('secret-value');
  });
});

const live = process.env.RUN_BITBUCKET_LIVE === '1' ? describe : describe.skip;
live('bitbucket adapter: live', () => {
  const real = !!process.env.BITBUCKET_API_TOKEN;
  const env = () => ({ BITBUCKET_API_TOKEN: process.env.BITBUCKET_API_TOKEN! });
  const ws = process.env.BITBUCKET_WORKSPACE;
  const repo = process.env.BITBUCKET_REPO;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['bitbucket_get_current_user', {}],
    ['bitbucket_list_workspaces', {}],
    ['bitbucket_list_repositories', { workspace: 'atlassian' }],
    ['bitbucket_list_pull_requests', { workspace: 'atlassian', repo_slug: 'atlassian-event' }],
    ['bitbucket_list_pipelines', { workspace: 'atlassian', repo_slug: 'atlassian-event' }],
  ])('%s reaches Bitbucket and is refused with a wrong token (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads the user and workspaces', async () => {
    const me = await shaped('bitbucket_get_current_user', {}, env());
    expect(me.uuid).toBeTruthy();
    const wss = await shaped('bitbucket_list_workspaces', {}, env());
    expect(Array.isArray(wss.workspaces)).toBe(true);
  }, 60000);

  (real && ws && repo ? it : it.skip)('reads code, pull requests and pipelines of one repository', async () => {
    const r = { workspace: ws!, repo_slug: repo! };
    const info = await shaped('bitbucket_get_repository', r, env());
    expect(info.slug).toBe(repo);
    expect(Array.isArray((await shaped('bitbucket_list_branches', r, env())).branches)).toBe(true);
    const commits = await shaped('bitbucket_list_commits', { ...r, pagelen: 2 }, env());
    expect(Array.isArray(commits.commits)).toBe(true);
    const root = await shaped('bitbucket_get_file', r, env());
    expect(Array.isArray(root.values)).toBe(true);
    const prs = await shaped('bitbucket_list_pull_requests', { ...r, state: ['OPEN', 'MERGED'] }, env());
    expect(Array.isArray(prs.pull_requests)).toBe(true);
    const prId = prs.pull_requests[0]?.id;
    if (prId) {
      expect((await shaped('bitbucket_get_pull_request', { ...r, pull_request_id: prId }, env())).id).toBe(prId);
      expect(Array.isArray((await shaped('bitbucket_get_pull_request_diffstat', { ...r, pull_request_id: prId }, env())).files)).toBe(true);
      expect(Array.isArray((await shaped('bitbucket_list_pull_request_comments', { ...r, pull_request_id: prId }, env())).comments)).toBe(true);
    }
    const pipes = await shaped('bitbucket_list_pipelines', r, env());
    expect(Array.isArray(pipes.pipelines)).toBe(true);
    const pipe = pipes.pipelines[0]?.uuid;
    if (pipe) {
      const steps = await shaped('bitbucket_list_pipeline_steps', { ...r, pipeline_uuid: pipe }, env());
      const step = steps.steps[0]?.uuid;
      if (step) expect(await shaped('bitbucket_get_pipeline_step_log', { ...r, pipeline_uuid: pipe, step_uuid: step, range: 'bytes=0-999' }, env())).toBeDefined();
    }
    expect(Array.isArray((await shaped('bitbucket_list_environments', r, env())).environments)).toBe(true);
    expect(Array.isArray((await shaped('bitbucket_list_deployments', r, env())).deployments)).toBe(true);
  }, 180000);

  const writes = real && ws && repo && process.env.RUN_BITBUCKET_LIVE_WRITES === '1' && process.env.BITBUCKET_LIVE_PR;
  (writes ? it : it.skip)('posts one comment on the given pull request', async () => {
    const out = await shaped(
      'bitbucket_add_pull_request_comment',
      { workspace: ws!, repo_slug: repo!, pull_request_id: Number(process.env.BITBUCKET_LIVE_PR), text: `AnythingMCP live check ${Date.now()}` },
      env(),
    );
    expect(out.id).toBeTruthy();
  }, 60000);
});
