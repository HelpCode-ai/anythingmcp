import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as adapterJson from './gitea.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Static checks and request-shape checks against a local server always run.
 * The live block runs every read tool through the real RestEngine:
 *   GITEA_TOKEN=... [GITEA_URL=https://gitea.com] [GITEA_REPO=owner/name] \
 *     npx jest src/adapters/intl/gitea.live.spec.ts
 * Without GITEA_REPO the first repository the user owns is read.
 */

type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
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

describe('gitea adapter: static spec conformance', () => {
  it('is listed', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('calls API v1 under the configured server address with the token in the Authorization header', () => {
    expect(a.connector.baseUrl).toBe('{{GITEA_URL}}/api/v1');
    expect(interpolateDeep(a.connector.baseUrl, { GITEA_URL: 'https://gitea.com' })).toBe('https://gitea.com/api/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'token {{GITEA_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['GITEA_URL', 'GITEA_TOKEN']);
    expect(a.envVarMeta.GITEA_URL.kind).toBe('address');
    expect(a.envVarMeta.GITEA_TOKEN.secret).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/user');
  });

  it('accepts gitea.com and self-hosted addresses, but not the API path or a trailing slash', () => {
    const url = new RegExp(a.envVarMeta.GITEA_URL.pattern!);
    for (const ok of ['https://gitea.com', 'https://git.example.com', 'https://example.com/gitea', 'http://10.0.0.5:3000']) {
      expect(url.test(ok)).toBe(true);
    }
    for (const bad of ['https://gitea.com/', 'https://gitea.com/api/v1', 'gitea.com', 'https://gitea.com/api/v1/']) {
      expect(url.test(bad)).toBe(false);
    }
    const token = new RegExp(a.envVarMeta.GITEA_TOKEN.pattern!);
    expect(token.test('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(token.test('token 0123456789abcdef0123456789abcdef01234567')).toBe(false);
    expect(token.test('Bearer 0123456789abcdef0123456789abcdef01234567')).toBe(false);
  });

  it('probes with the current user, which needs no argument', () => {
    expect(a.probe.tool).toBe('gitea_get_current_user');
    expect(tool('gitea_get_current_user').parameters.required).toBeUndefined();
  });

  it('prefixes every tool with gitea_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gitea_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('is read-only: every tool is a GET, marked read-only, and none is installed switched off', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(annotationsOf(t).readOnlyHint).toBe(true);
      expect(t.enabled).toBeUndefined();
    }
  });

  it('describes every parameter and gives every tool an example value', () => {
    for (const t of a.tools) {
      const props = (t.parameters.properties ?? {}) as Record<string, { description?: string; examples?: unknown[]; default?: unknown }>;
      for (const [name, def] of Object.entries(props)) expect(`${t.name}.${name}:${Boolean(def.description)}`).toBe(`${t.name}.${name}:true`);
      const hasInput = Object.keys(props).length > 0;
      const hasExample = Object.values(props).some((d) => d.examples !== undefined) || /e\.g\./.test(t.description) || Object.values(props).some((d) => /e\.g\./.test(d.description ?? ''));
      if (hasInput) expect(`${t.name}:${hasExample}`).toBe(`${t.name}:true`);
    }
  });

  it('hands list tools the pagination headers and maps page and limit', () => {
    for (const t of a.tools.filter((x) => x.parameters.properties?.limit)) {
      expect(t.endpointMapping.exposeHeaders).toEqual(['link', 'x-total-count']);
      expect(t.endpointMapping.queryParams).toMatchObject({ page: '$page', limit: '$limit' });
    }
  });

  it('only points the model at tools that exist, documents setup and writes no em or en dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgitea_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgitea_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    for (const scope of ['read:repository', 'read:issue', 'read:organization', 'read:user']) expect(a.instructions).toContain(scope);
    expect(a.instructions).toContain('Authorization: token');
    expect(JSON.stringify(adapterJson)).not.toMatch(/[–—]/);
  });
});

describe('gitea adapter: requests through the real engine', () => {
  let server: http.Server;
  let origin: string;
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      if (req.url?.includes('/raw/') || /\.diff(\?|$)/.test(req.url ?? '')) {
        res.setHeader('Content-Type', 'text/plain');
        res.end('hello\n');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('link', '<http://example.test/api/v1/x?page=2>; rel="next"');
      res.setHeader('x-total-count', '41');
      res.end(JSON.stringify([{ id: 1 }]));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => (seen.length = 0));

  const run = (name: string, params: Record<string, unknown>) =>
    engine().executeWithMeta(
      {
        baseUrl: interpolateDeep(a.connector.baseUrl, { GITEA_URL: origin }),
        authType: 'API_KEY',
        authConfig: { headerName: 'Authorization', apiKey: interpolateDeep(a.connector.authConfig.apiKey, { GITEA_TOKEN: 'secret-token' }) },
        headers: a.connector.headers,
      },
      tool(name).endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );
  const query = (i = 0) => new URL(seen[i].url!, origin).searchParams;
  const pathOf = (i = 0) => new URL(seen[i].url!, origin).pathname;

  it('sends the token as "token <token>" and reads a repository by owner and name', async () => {
    await run('gitea_get_repository', { owner: 'acme', repo: 'website' });
    expect(seen[0].url).toBe('/api/v1/repos/acme/website');
    expect(seen[0].headers.authorization).toBe('token secret-token');
    expect(seen[0].headers['user-agent']).toBe('AnythingMCP');
  });

  it('lists issues of a repository, issues only by default, and returns the pagination headers', async () => {
    const res = await run('gitea_list_issues', { owner: 'acme', repo: 'website', labels: 'bug', page: 2, limit: 10 });
    expect(pathOf()).toBe('/api/v1/repos/acme/website/issues');
    expect(query().get('type')).toBe('issues');
    expect(query().get('labels')).toBe('bug');
    expect(query().get('page')).toBe('2');
    expect(query().get('limit')).toBe('10');
    expect(res.headers).toEqual({ link: '<http://example.test/api/v1/x?page=2>; rel="next"', 'x-total-count': '41' });
  });

  it('lets the same list reach pull requests with type=pulls', async () => {
    await run('gitea_list_issues', { owner: 'acme', repo: 'website', type: 'pulls', state: 'all' });
    expect(query().get('type')).toBe('pulls');
    expect(query().get('state')).toBe('all');
  });

  it('searches issues across repositories for the ones awaiting the user review', async () => {
    await run('gitea_search_issues', { review_requested: true, type: 'pulls' });
    expect(pathOf()).toBe('/api/v1/repos/issues/search');
    expect(query().get('review_requested')).toBe('true');
    expect(query().get('state')).toBe('open');
    expect(query().get('type')).toBe('pulls');
  });

  it('reads a pull request, its files, reviews and the diff as text', async () => {
    await run('gitea_get_pull_request', { owner: 'acme', repo: 'website', index: 17 });
    expect(pathOf(0)).toBe('/api/v1/repos/acme/website/pulls/17');
    await run('gitea_get_pull_request_files', { owner: 'acme', repo: 'website', index: 17 });
    expect(pathOf(1)).toBe('/api/v1/repos/acme/website/pulls/17/files');
    await run('gitea_list_pull_request_reviews', { owner: 'acme', repo: 'website', index: 17 });
    expect(pathOf(2)).toBe('/api/v1/repos/acme/website/pulls/17/reviews');
    const diff = await run('gitea_get_pull_request_diff', { owner: 'acme', repo: 'website', index: 17 });
    expect(pathOf(3)).toBe('/api/v1/repos/acme/website/pulls/17.diff');
    expect(diff.body).toBe('hello\n');
  });

  it('keeps pull request commits and commit lists small by default', async () => {
    await run('gitea_list_pull_request_commits', { owner: 'acme', repo: 'website', index: 17 });
    expect(query(0).get('files')).toBe('false');
    expect(query(0).get('verification')).toBe('false');
    await run('gitea_list_commits', { owner: 'acme', repo: 'website', sha: 'main', path: 'src/app.go' });
    expect(pathOf(1)).toBe('/api/v1/repos/acme/website/commits');
    expect(query(1).get('stat')).toBe('false');
    expect(query(1).get('files')).toBe('false');
    expect(query(1).get('verification')).toBe('false');
    expect(query(1).get('sha')).toBe('main');
    expect(query(1).get('path')).toBe('src/app.go');
  });

  it('maps the prerelease parameter to the pre-release query key and keeps a tag with a slash in the path', async () => {
    await run('gitea_list_releases', { owner: 'acme', repo: 'website', prerelease: false, tag_filter: 'v1*' });
    expect(pathOf(0)).toBe('/api/v1/repos/acme/website/releases');
    expect(query(0).get('pre-release')).toBe('false');
    expect(query(0).get('tag_filter')).toBe('v1*');
    await run('gitea_get_release_by_tag', { owner: 'acme', repo: 'website', tag: 'release/v1.2.0' });
    expect(pathOf(1)).toBe('/api/v1/repos/acme/website/releases/tags/release/v1.2.0');
    await run('gitea_get_latest_release', { owner: 'acme', repo: 'website' });
    expect(pathOf(2)).toBe('/api/v1/repos/acme/website/releases/latest');
  });

  it('reads organizations, their repositories, members and teams', async () => {
    await run('gitea_list_my_organizations', {});
    expect(pathOf(0)).toBe('/api/v1/user/orgs');
    await run('gitea_get_organization', { org: 'acme' });
    expect(pathOf(1)).toBe('/api/v1/orgs/acme');
    await run('gitea_list_organization_repositories', { org: 'acme', limit: 5 });
    expect(pathOf(2)).toBe('/api/v1/orgs/acme/repos');
    expect(query(2).get('limit')).toBe('5');
    await run('gitea_list_organization_members', { org: 'acme' });
    expect(pathOf(3)).toBe('/api/v1/orgs/acme/members');
    await run('gitea_list_organization_teams', { org: 'acme' });
    expect(pathOf(4)).toBe('/api/v1/orgs/acme/teams');
  });

  it('reads a file at a ref with its folders left as slashes, and lists a tree recursively', async () => {
    const file = await run('gitea_get_file_content', { owner: 'acme', repo: 'website', filepath: 'docs/guide/README.md', ref: 'develop' });
    expect(pathOf(0)).toBe('/api/v1/repos/acme/website/raw/docs/guide/README.md');
    expect(query(0).get('ref')).toBe('develop');
    expect(file.body).toBe('hello\n');
    await run('gitea_get_file_content', { owner: 'acme', repo: 'website', filepath: 'README.md' });
    expect(query(1).has('ref')).toBe(false);
    await run('gitea_get_tree', { owner: 'acme', repo: 'website', sha: 'main', recursive: true });
    expect(pathOf(2)).toBe('/api/v1/repos/acme/website/git/trees/main');
    expect(query(2).get('recursive')).toBe('true');
  });

  it('searches repositories with the keyword, sort and paging', async () => {
    await run('gitea_search_repositories', { q: 'web', sort: 'stars', order: 'desc', archived: false, limit: 5 });
    expect(pathOf()).toBe('/api/v1/repos/search');
    expect(query().get('q')).toBe('web');
    expect(query().get('sort')).toBe('stars');
    expect(query().get('order')).toBe('desc');
    expect(query().get('archived')).toBe('false');
    expect(query().get('limit')).toBe('5');
  });
});

const TOKEN = process.env.GITEA_TOKEN;
const BASE = (process.env.GITEA_URL || 'https://gitea.com').replace(/\/+$/, '');
const live = TOKEN ? describe : describe.skip;

live('gitea adapter: live calls', () => {
  const config = (token = TOKEN as string) => ({
    baseUrl: interpolateDeep(a.connector.baseUrl, { GITEA_URL: BASE }),
    authType: 'API_KEY',
    authConfig: { headerName: 'Authorization', apiKey: `token ${token}` },
    headers: a.connector.headers,
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(config(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));

  let owner = '';
  let repo = '';
  let defaultBranch: string | undefined;

  beforeAll(async () => {
    if (process.env.GITEA_REPO) {
      [owner, repo] = process.env.GITEA_REPO.split('/');
    } else {
      const mine = await run('gitea_list_my_repositories', { limit: 1 });
      [owner, repo] = String(mine[0]?.full_name ?? '/').split('/');
    }
    if (owner && repo) defaultBranch = (await run('gitea_get_repository', { owner, repo })).default_branch;
  }, 30000);

  it('reads the user, repositories and the repository', async () => {
    const me = await run('gitea_get_current_user');
    expect(typeof me.login).toBe('string');
    expect(Array.isArray(await run('gitea_list_my_repositories', { limit: 5 }))).toBe(true);
    expect(Array.isArray((await run('gitea_search_repositories', { q: 'a', limit: 5 })).data)).toBe(true);
    expect(owner && repo).toBeTruthy();
    expect((await run('gitea_get_repository', { owner, repo })).name).toBe(repo);
    expect(Array.isArray(await run('gitea_list_user_repositories', { username: owner, limit: 5 }))).toBe(true);
  }, 60000);

  it('reads issues, their comments, labels, milestones and the issues of the user', async () => {
    const issues = await run('gitea_list_issues', { owner, repo, state: 'all', limit: 5 });
    expect(Array.isArray(issues)).toBe(true);
    if (issues[0]) {
      expect((await run('gitea_get_issue', { owner, repo, index: issues[0].number })).number).toBe(issues[0].number);
      expect(Array.isArray(await run('gitea_list_issue_comments', { owner, repo, index: issues[0].number }))).toBe(true);
    }
    expect(Array.isArray(await run('gitea_list_labels', { owner, repo, limit: 5 }))).toBe(true);
    expect(Array.isArray(await run('gitea_list_milestones', { owner, repo, state: 'all', limit: 5 }))).toBe(true);
    expect(Array.isArray(await run('gitea_search_issues', { assigned: true, limit: 5 }))).toBe(true);
  }, 60000);

  it('reads pull requests with files, the diff, commits and reviews', async () => {
    const prs = await run('gitea_list_pull_requests', { owner, repo, state: 'all', limit: 5 });
    expect(Array.isArray(prs)).toBe(true);
    if (!prs[0]) return;
    const index = prs[0].number;
    expect((await run('gitea_get_pull_request', { owner, repo, index })).number).toBe(index);
    expect(Array.isArray(await run('gitea_get_pull_request_files', { owner, repo, index, limit: 5 }))).toBe(true);
    expect(typeof (await run('gitea_get_pull_request_diff', { owner, repo, index }))).toBe('string');
    expect(Array.isArray(await run('gitea_list_pull_request_commits', { owner, repo, index, limit: 5 }))).toBe(true);
    expect(Array.isArray(await run('gitea_list_pull_request_reviews', { owner, repo, index }))).toBe(true);
  }, 60000);

  it('reads releases, and the latest one when the repository has any', async () => {
    const releases = await run('gitea_list_releases', { owner, repo, limit: 5 });
    expect(Array.isArray(releases)).toBe(true);
    if (!releases.some((r: { draft: boolean; prerelease: boolean }) => !r.draft && !r.prerelease)) return;
    expect(typeof (await run('gitea_get_latest_release', { owner, repo })).tag_name).toBe('string');
    expect((await run('gitea_get_release_by_tag', { owner, repo, tag: releases[0].tag_name })).tag_name).toBe(releases[0].tag_name);
  }, 60000);

  it('reads the organizations of the user and the first one in detail', async () => {
    const orgs = await run('gitea_list_my_organizations', { limit: 5 });
    expect(Array.isArray(orgs)).toBe(true);
    if (!orgs[0]) return;
    const org = orgs[0].name;
    expect((await run('gitea_get_organization', { org })).name).toBe(org);
    expect(Array.isArray(await run('gitea_list_organization_repositories', { org, limit: 5 }))).toBe(true);
    expect(Array.isArray(await run('gitea_list_organization_members', { org, limit: 5 }))).toBe(true);
    expect(Array.isArray(await run('gitea_list_organization_teams', { org, limit: 5 }))).toBe(true);
  }, 60000);

  it('reads branches, commits, the tree and a file', async () => {
    expect(Array.isArray(await run('gitea_list_branches', { owner, repo, limit: 5 }))).toBe(true);
    if (!defaultBranch) return; // an empty repository
    const commits = await run('gitea_list_commits', { owner, repo, limit: 3 });
    expect(commits.length).toBeGreaterThan(0);
    expect((await run('gitea_get_commit', { owner, repo, sha: commits[0].sha })).sha).toBe(commits[0].sha);
    const tree = await run('gitea_get_tree', { owner, repo, sha: defaultBranch, per_page: 50 });
    const file = (tree.tree ?? []).find((e: { type: string }) => e.type === 'blob');
    if (!file) return;
    expect(typeof (await run('gitea_get_file_content', { owner, repo, filepath: file.path }))).toBe('string');
  }, 60000);

  it('a wrong token is a 401', async () => {
    await expect(
      engine().execute(config('wrong-wrong-wrong-wrong-wrong'), tool('gitea_get_current_user').endpointMapping, {}),
    ).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);
});