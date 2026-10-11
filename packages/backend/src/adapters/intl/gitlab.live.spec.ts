import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as adapterJson from './gitlab.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Static checks and request-shape checks against a local server always run.
 * The live block runs every read tool through the real RestEngine:
 *   GITLAB_TOKEN=glpat-... [GITLAB_URL=https://gitlab.com] [GITLAB_PROJECT=me/sandbox] \
 *     npx jest src/adapters/intl/gitlab.live.spec.ts
 * Without GITLAB_PROJECT the first project the user is a member of is read.
 * GITLAB_LIVE_WRITE=1 (needs GITLAB_PROJECT, a project the user owns, and an
 * api-scoped token) also creates a branch, an issue and a merge request named
 * "AnythingMCP test", changes and comments on them, and in `finally` closes and
 * deletes all three.
 */

type Mapping = {
  method: string;
  path: string;
  encodePathParams?: boolean;
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
  exposeHeaders?: string[];
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: Record<string, boolean>;
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: Mapping;
};
const a = adapterJson as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind: string; secret?: boolean; pattern?: string }>;
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
const OFF = ['gitlab_delete_branch', 'gitlab_delete_issue'];
const WRITES = [
  ...OFF,
  'gitlab_add_issue_note',
  'gitlab_add_merge_request_note',
  'gitlab_create_branch',
  'gitlab_create_issue',
  'gitlab_create_merge_request',
  'gitlab_update_issue',
  'gitlab_update_merge_request',
].sort();

describe('gitlab adapter: static spec conformance', () => {
  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('calls API v4 under the configured instance address with the token as Bearer', () => {
    expect(a.connector.baseUrl).toBe('{{GITLAB_URL}}/api/v4');
    expect(interpolateDeep(a.connector.baseUrl, { GITLAB_URL: 'https://gitlab.com' })).toBe('https://gitlab.com/api/v4');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{GITLAB_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['GITLAB_URL', 'GITLAB_TOKEN']);
    expect(a.envVarMeta.GITLAB_URL.kind).toBe('address');
    expect(a.envVarMeta.GITLAB_TOKEN.secret).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/user');
  });

  it('accepts GitLab.com and self-managed addresses, but not the API path or a trailing slash', () => {
    const url = new RegExp(a.envVarMeta.GITLAB_URL.pattern!);
    for (const ok of ['https://gitlab.com', 'https://gitlab.example.com', 'https://example.com/gitlab', 'http://10.0.0.5:8080']) {
      expect(url.test(ok)).toBe(true);
    }
    for (const bad of ['https://gitlab.com/', 'https://gitlab.com/api/v4', 'gitlab.com', 'https://gitlab.com/api/v4/']) {
      expect(url.test(bad)).toBe(false);
    }
    const token = new RegExp(a.envVarMeta.GITLAB_TOKEN.pattern!);
    expect(token.test('glpat-abcdefghijklmnopqrst')).toBe(true);
    expect(token.test('Bearer glpat-abcdefghijklmnopqrst')).toBe(false);
  });

  it('probes with the current user, which needs no argument', () => {
    expect(a.probe.tool).toBe('gitlab_get_current_user');
    expect(tool('gitlab_get_current_user').parameters.required).toBeUndefined();
  });

  it('prefixes every tool with gitlab_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gitlab_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only, writes only through the expected tools and installs deletes switched off', () => {
    const writes = a.tools.filter((t) => !annotationsOf(t).readOnlyHint).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const t of a.tools) expect(annotationsOf(t).readOnlyHint === true).toBe(t.endpointMapping.method === 'GET');
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const name of OFF) expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    for (const name of ['gitlab_create_issue', 'gitlab_create_merge_request', 'gitlab_add_issue_note', 'gitlab_create_branch']) {
      expect(tool(name).description).toMatch(/confirm/i);
    }
  });

  it('URL-encodes every path argument, since project paths, branches and file paths carry slashes', () => {
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('hands list tools the pagination headers', () => {
    for (const t of a.tools.filter((x) => x.parameters.properties?.page)) {
      expect(t.endpointMapping.exposeHeaders).toEqual(['x-next-page', 'x-total', 'x-total-pages']);
      expect(t.endpointMapping.queryParams).toMatchObject({ page: '$page', per_page: '$per_page' });
    }
  });

  it('only points the model at tools that exist, documents setup and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgitlab_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgitlab_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('https://gitlab.com/-/user_settings/personal_access_tokens');
    expect(a.instructions).toContain('read_api');
    expect(a.instructions).toContain('Read-only setup');
    expect(JSON.stringify(adapterJson)).not.toMatch(/[–—]/);
  });
});

describe('gitlab adapter: requests through the real engine', () => {
  let server: http.Server;
  let origin: string;
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url?.includes('/raw')) {
          res.setHeader('Content-Type', 'text/plain');
          res.end('hello\n');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('x-next-page', '2');
        res.setHeader('x-total', '41');
        res.end(JSON.stringify(req.url?.includes('/repository/files/') ? { file_name: 'a.ts', content: 'aGVsbG8=', size: 5 } : [{ id: 1 }]));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => (seen.length = 0));

  const run = (name: string, params: Record<string, unknown>) =>
    engine().executeWithMeta(
      { baseUrl: interpolateDeep(a.connector.baseUrl, { GITLAB_URL: origin }), authType: 'BEARER_TOKEN', authConfig: { token: 'glpat-test' }, headers: a.connector.headers },
      tool(name).endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );

  it('encodes a project path and sends the token as Bearer', async () => {
    await run('gitlab_get_project', { project_id: 'acme/web/shop' });
    expect(seen[0].url).toBe('/api/v4/projects/acme%2Fweb%2Fshop');
    expect(seen[0].headers.authorization).toBe('Bearer glpat-test');
  });

  it('lists the user projects by default, small, and returns the pagination headers', async () => {
    const res = await run('gitlab_list_projects', { search: 'shop' });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/api/v4/projects');
    expect(url.searchParams.get('membership')).toBe('true');
    expect(url.searchParams.get('simple')).toBe('true');
    expect(url.searchParams.get('per_page')).toBe('20');
    expect(url.searchParams.get('search')).toBe('shop');
    expect(res.headers).toEqual({ 'x-next-page': '2', 'x-total': '41' });
  });

  it('reads a file at HEAD by default, with the whole path encoded, and drops the base64 content', async () => {
    const info = await run('gitlab_get_file_info', { project_id: 42, file_path: 'src/app/main.ts' });
    expect(seen[0].url).toBe('/api/v4/projects/42/repository/files/src%2Fapp%2Fmain.ts?ref=HEAD');
    // The exclude runs in the response transform, after the engine.
    const shaped = applyResponseTransform(info.body, (tool('gitlab_get_file_info') as Tool & { responseMapping: Record<string, unknown> }).responseMapping);
    expect(shaped.value).toEqual({ file_name: 'a.ts', size: 5 });
    const raw = await run('gitlab_get_file_content', { project_id: 42, file_path: 'README.md', ref: 'main' });
    expect(seen[1].url).toBe('/api/v4/projects/42/repository/files/README.md/raw?ref=main');
    expect(raw.body).toBe('hello\n');
  });

  it('sends job scopes as repeated scope[] keys', async () => {
    await run('gitlab_list_pipeline_jobs', { project_id: 42, pipeline_id: 7, scope: ['failed', 'canceled'] });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/api/v4/projects/42/pipelines/7/jobs');
    expect(url.searchParams.getAll('scope[]')).toEqual(['failed', 'canceled']);
  });

  it('creates an issue with only the given fields and updates it with state_event', async () => {
    await run('gitlab_create_issue', { project_id: 'acme/web', title: 'Broken login', labels: 'bug', assignee_id: 5 });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/api/v4/projects/acme%2Fweb/issues');
    expect(JSON.parse(seen[0].body)).toEqual({ title: 'Broken login', assignee_id: 5, labels: 'bug' });
    await run('gitlab_update_issue', { project_id: 'acme/web', issue_iid: 12, state_event: 'close', add_labels: 'done' });
    expect(seen[1].method).toBe('PUT');
    expect(seen[1].url).toBe('/api/v4/projects/acme%2Fweb/issues/12');
    expect(JSON.parse(seen[1].body)).toEqual({ state_event: 'close', add_labels: 'done' });
  });

  it('encodes a branch name with a slash and lists cross-project issues assigned to the user', async () => {
    await run('gitlab_get_branch', { project_id: 42, branch: 'feature/login' });
    expect(seen[0].url).toBe('/api/v4/projects/42/repository/branches/feature%2Flogin');
    await run('gitlab_list_my_issues', {});
    expect(new URL(seen[1].url!, origin).searchParams.get('scope')).toBe('assigned_to_me');
  });
});

const TOKEN = process.env.GITLAB_TOKEN;
const BASE = (process.env.GITLAB_URL || 'https://gitlab.com').replace(/\/+$/, '');
const live = TOKEN ? describe : describe.skip;

live('gitlab adapter: live calls', () => {
  const config = () => ({
    baseUrl: interpolateDeep(a.connector.baseUrl, { GITLAB_URL: BASE }),
    authType: 'BEARER_TOKEN',
    authConfig: { token: TOKEN as string },
    headers: a.connector.headers,
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(config(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));

  let project: { id: number; path_with_namespace: string; default_branch?: string } | undefined;

  beforeAll(async () => {
    if (process.env.GITLAB_PROJECT) {
      project = await run('gitlab_get_project', { project_id: process.env.GITLAB_PROJECT });
    } else {
      const list = await run('gitlab_list_projects', { per_page: 1, order_by: 'last_activity_at' });
      project = list[0];
    }
  }, 30000);

  it('reads the user, projects, the project, members and labels', async () => {
    const me = await run('gitlab_get_current_user');
    expect(typeof me.username).toBe('string');
    expect(Array.isArray(await run('gitlab_list_projects', { per_page: 5 }))).toBe(true);
    expect(project).toBeDefined();
    const p = await run('gitlab_get_project', { project_id: project!.path_with_namespace, statistics: true });
    expect(p.id).toBe(project!.id);
    expect(Array.isArray(await run('gitlab_list_project_members', { project_id: project!.id, per_page: 5 }))).toBe(true);
    expect(Array.isArray(await run('gitlab_list_labels', { project_id: project!.id, with_counts: true }))).toBe(true);
  }, 60000);

  it('reads issues, their notes, and the issues assigned to the user', async () => {
    const issues = await run('gitlab_list_issues', { project_id: project!.id, state: 'all', per_page: 5 });
    expect(Array.isArray(issues)).toBe(true);
    if (issues[0]) {
      expect((await run('gitlab_get_issue', { project_id: project!.id, issue_iid: issues[0].iid })).iid).toBe(issues[0].iid);
      expect(Array.isArray(await run('gitlab_list_issue_notes', { project_id: project!.id, issue_iid: issues[0].iid }))).toBe(true);
    }
    expect(Array.isArray(await run('gitlab_list_my_issues', { per_page: 5 }))).toBe(true);
  }, 60000);

  it('reads merge requests with diffs, commits and notes', async () => {
    const mrs = await run('gitlab_list_merge_requests', { project_id: project!.id, state: 'all', per_page: 5 });
    expect(Array.isArray(mrs)).toBe(true);
    if (mrs[0]) {
      const iid = mrs[0].iid;
      expect((await run('gitlab_get_merge_request', { project_id: project!.id, merge_request_iid: iid })).iid).toBe(iid);
      expect(Array.isArray(await run('gitlab_get_merge_request_diffs', { project_id: project!.id, merge_request_iid: iid, per_page: 5 }))).toBe(true);
      expect(Array.isArray(await run('gitlab_list_merge_request_commits', { project_id: project!.id, merge_request_iid: iid }))).toBe(true);
      expect(Array.isArray(await run('gitlab_list_merge_request_notes', { project_id: project!.id, merge_request_iid: iid }))).toBe(true);
    }
    expect(Array.isArray(await run('gitlab_list_my_merge_requests', { scope: 'all', per_page: 5, state: 'opened', author_username: (await run('gitlab_get_current_user')).username }))).toBe(true);
  }, 60000);

  it('reads pipelines, their jobs and a job log', async () => {
    const pipelines = await run('gitlab_list_pipelines', { project_id: project!.id, per_page: 3 });
    expect(Array.isArray(pipelines)).toBe(true);
    if (!pipelines[0]) return;
    expect((await run('gitlab_get_pipeline', { project_id: project!.id, pipeline_id: pipelines[0].id })).id).toBe(pipelines[0].id);
    const jobs = await run('gitlab_list_pipeline_jobs', { project_id: project!.id, pipeline_id: pipelines[0].id });
    expect(Array.isArray(jobs)).toBe(true);
    if (!jobs[0]) return;
    expect((await run('gitlab_get_job', { project_id: project!.id, job_id: jobs[0].id })).id).toBe(jobs[0].id);
    const log = await run('gitlab_get_job_log', { project_id: project!.id, job_id: jobs[0].id }).catch((e) => e);
    // A job that never ran has no log (404); one that did answers text.
    expect(typeof log === 'string' || log?.response?.status === 404).toBe(true);
  }, 60000);

  it('reads branches, commits, a diff, the tree and a file', async () => {
    const branches = await run('gitlab_list_branches', { project_id: project!.id, per_page: 5 });
    expect(Array.isArray(branches)).toBe(true);
    if (!project!.default_branch) return; // an empty repository
    expect((await run('gitlab_get_branch', { project_id: project!.id, branch: project!.default_branch })).name).toBe(project!.default_branch);
    const commits = await run('gitlab_list_commits', { project_id: project!.id, per_page: 3 });
    expect(commits.length).toBeGreaterThan(0);
    expect((await run('gitlab_get_commit', { project_id: project!.id, sha: commits[0].id })).id).toBe(commits[0].id);
    expect(Array.isArray(await run('gitlab_get_commit_diff', { project_id: project!.id, sha: commits[0].id }))).toBe(true);
    const tree = await run('gitlab_list_repository_tree', { project_id: project!.id, per_page: 50 });
    const file = tree.find((e: { type: string }) => e.type === 'blob');
    if (!file) return;
    const info = await run('gitlab_get_file_info', { project_id: project!.id, file_path: file.path });
    expect(info.file_path).toBe(file.path);
    const content = await run('gitlab_get_file_content', { project_id: project!.id, file_path: file.path });
    expect(content).toBeDefined();
  }, 60000);

  it('searches the instance and inside the project', async () => {
    expect(Array.isArray(await run('gitlab_search', { scope: 'projects', search: project!.path_with_namespace.split('/').pop() }))).toBe(true);
    expect(Array.isArray(await run('gitlab_search_project', { project_id: project!.id, scope: 'issues', search: 'test' }))).toBe(true);
    if (project!.default_branch) {
      expect(Array.isArray(await run('gitlab_search_project', { project_id: project!.id, scope: 'blobs', search: 'a' }))).toBe(true);
    }
  }, 60000);

  it('a wrong token is a 401', async () => {
    await expect(
      engine().execute({ ...config(), authConfig: { token: 'glpat-wrong-wrong-wrong-wrong' } }, tool('gitlab_get_current_user').endpointMapping, {}),
    ).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (process.env.GITLAB_LIVE_WRITE === '1' && process.env.GITLAB_PROJECT ? it : it.skip)(
    'creates a test branch, issue and merge request, changes and comments on them, then removes all three',
    async () => {
      const pid = project!.id;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const branch = `anythingmcp-test-${stamp}`;
      let branchCreated = false;
      let issueIid: number | undefined;
      let mrIid: number | undefined;
      try {
        const b = await run('gitlab_create_branch', { project_id: pid, branch, ref: project!.default_branch });
        branchCreated = true;
        expect(b.name).toBe(branch);

        const issue = await run('gitlab_create_issue', { project_id: pid, title: 'AnythingMCP test', description: 'Created by the AnythingMCP live spec; safe to delete.' });
        issueIid = issue.iid;
        const updated = await run('gitlab_update_issue', { project_id: pid, issue_iid: issueIid, title: 'AnythingMCP test (updated)', add_labels: 'anythingmcp-test' });
        expect(updated.title).toBe('AnythingMCP test (updated)');
        const note = await run('gitlab_add_issue_note', { project_id: pid, issue_iid: issueIid, body: 'AnythingMCP test note' });
        expect(note.body).toBe('AnythingMCP test note');

        const mr = await run('gitlab_create_merge_request', { project_id: pid, source_branch: branch, target_branch: project!.default_branch, title: 'Draft: AnythingMCP test', remove_source_branch: true });
        mrIid = mr.iid;
        const mrUpdated = await run('gitlab_update_merge_request', { project_id: pid, merge_request_iid: mrIid, title: 'Draft: AnythingMCP test (updated)', description: 'Safe to delete.' });
        expect(mrUpdated.title).toBe('Draft: AnythingMCP test (updated)');
        const mrNote = await run('gitlab_add_merge_request_note', { project_id: pid, merge_request_iid: mrIid, body: 'AnythingMCP test comment' });
        expect(mrNote.body).toBe('AnythingMCP test comment');
      } finally {
        const problems: string[] = [];
        if (mrIid) {
          await run('gitlab_update_merge_request', { project_id: pid, merge_request_iid: mrIid, state_event: 'close' }).catch((e) => problems.push(`close MR: ${e.message}`));
          await engine()
            .execute(config(), { method: 'DELETE', path: '/projects/{project_id}/merge_requests/{merge_request_iid}' }, { project_id: pid, merge_request_iid: mrIid })
            .catch((e) => problems.push(`delete MR: ${e.message}`));
        }
        if (issueIid) {
          await run('gitlab_delete_issue', { project_id: pid, issue_iid: issueIid }).catch((e) => problems.push(`delete issue: ${e.message}`));
        }
        if (branchCreated) {
          await run('gitlab_delete_branch', { project_id: pid, branch }).catch((e) => problems.push(`delete branch: ${e.message}`));
        }
        expect(problems).toEqual([]);
      }
    },
    120000,
  );
});
