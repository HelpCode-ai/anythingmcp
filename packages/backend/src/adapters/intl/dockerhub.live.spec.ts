import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './dockerhub.json';
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
 * Two layers of verification for the Docker Hub adapter:
 *
 *   1. Static: always runs. Pins the LOGIN_TOKEN flow (POST /v2/auth/token
 *      with identifier and secret, access_token valid 10 minutes, sent as
 *      Bearer) and every tool's method, URL and query through the real
 *      RestEngine. Checked on 15 Oct 2026 against Docker's published Hub API
 *      spec (docs.docker.com/reference/api/hub/latest.yaml: auth/token,
 *      namespaces/{namespace}/repositories[/{repository}[/tags[/{tag}]]])
 *      and docker/hub-tool (pkg/hub: /v2/user/, /v2/user/orgs/,
 *      /v2/orgs/{name}). Two routes are not in the published spec and were
 *      checked live instead: /v2/search/repositories/ (same results and
 *      shape as the registry search the docker CLI uses) and the `name`
 *      filter on the tags list.
 *
 *   2. Live: skipped unless RUN_DOCKERHUB_LIVE=1. Without credentials it
 *      checks that the sign-in refuses a wrong token (401), that /v2/user/
 *      refuses a wrong access token (401), and runs every public read for
 *      real (they need no sign-in) to check the shaped output. With
 *      DOCKERHUB_USERNAME and DOCKERHUB_TOKEN it signs in and reads the
 *      account, its organizations and its repositories:
 *
 *        RUN_DOCKERHUB_LIVE=1 DOCKERHUB_USERNAME=jdoe DOCKERHUB_TOKEN=dckr_pat_... npx jest src/adapters/intl/dockerhub.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[]; minimum?: number; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; headers?: Record<string, string>; queryParams?: Record<string, unknown>; staticResponse?: string };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  unlisted?: boolean;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, any>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://hub.docker.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_PAT = ['dckr', '_pat_', 'A'.repeat(14), 'q'.repeat(13)].join('');
const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'AAAA'].join('.');
const ENV: Record<string, string> = { DOCKERHUB_USERNAME: 'jdoe', DOCKERHUB_TOKEN: FAKE_PAT };
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call. The sign-in is
// stubbed to hand out FAKE_JWT unless a real LoginTokenService is passed.
const fakeBundle = async () => ({ token: FAKE_JWT, expiresAt: Date.now() + 600_000 });
const stubLogin = { getToken: fakeBundle, forceRelogin: fakeBundle } as unknown as LoginTokenService;
const call = (name: string, params: Record<string, unknown>, env = ENV, login: LoginTokenService = stubLogin, authType = a.connector.authType) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, login).execute(
    {
      baseUrl: cfg.baseUrl,
      authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: cfg.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);
const sent = () => mockedAxios.mock.calls[0][0];

describe('dockerhub adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.name).toBe('Docker Hub');
  });

  it('signs in with POST /v2/auth/token and renews the 10-minute access token', () => {
    expect(a.icon).toBe('docker-hub');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: 'https://hub.docker.com/v2/auth/token',
      loginMethod: 'POST',
      loginBody: { identifier: '${username}', secret: '${password}' },
      username: '{{DOCKERHUB_USERNAME}}',
      password: '{{DOCKERHUB_TOKEN}}',
      tokenJsonPath: 'access_token',
      tokenTTLSeconds: 600,
      refreshOn401: true,
    });
    expect(a.connector.authConfig.proactiveRefreshSeconds).toBeLessThan(600);
    expect(a.connector.healthcheckPath).toBe('/v2/user/');
    expect(a.requiredEnvVars).toEqual(['DOCKERHUB_USERNAME', 'DOCKERHUB_TOKEN']);
    const [user, token] = describeAdapterEnvVars(a as never);
    expect(user).toMatchObject({ name: 'DOCKERHUB_USERNAME', secret: false, required: true });
    expect(token).toMatchObject({ name: 'DOCKERHUB_TOKEN', kind: 'credential', secret: true, required: true });
  });

  it('accepts a Docker ID and a dckr_pat_ token, and refuses e-mail addresses and other secrets', () => {
    const user = new RegExp(a.envVarMeta.DOCKERHUB_USERNAME.pattern!);
    for (const ok of ['jdoe', 'acme2024', 'JDoe']) expect(user.test(ok)).toBe(true);
    for (const bad of ['', 'jdoe@example.com', ' jdoe']) expect(user.test(bad)).toBe(false);
    const pat = new RegExp(a.envVarMeta.DOCKERHUB_TOKEN.pattern!);
    expect(pat.test(FAKE_PAT)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_PAT}`, `${FAKE_PAT} `, 'dckr_oat_AAAAAAAAAAAAAAAAAAAAAAAA', 'hunter2']) expect(pat.test(bad)).toBe(false);
  });

  it('logs in with identifier and secret, reads access_token and sends it as Bearer', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as any;
    mockedAxios.mockResolvedValueOnce({ data: { access_token: FAKE_JWT }, headers: {} });
    const bundle = await new LoginTokenService({} as any, config).getToken(auth);
    const login = sent();
    expect(login.method).toBe('POST');
    expect(login.url).toBe('https://hub.docker.com/v2/auth/token');
    expect(login.data).toEqual({ identifier: 'jdoe', secret: FAKE_PAT });
    expect(bundle.token).toBe(FAKE_JWT);
    expect(bundle.expiresAt - Date.now()).toBeLessThanOrEqual(600_000);
  });

  it('probes with the account read and explains the error codes', () => {
    expect(a.probe).toEqual({ tool: 'dockerhub_get_user' });
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with dockerhub_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^dockerhub_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('is read-only: every tool is a GET or static text', () => {
    for (const t of a.tools) {
      expect(['GET', 'static']).toContain(t.endpointMapping.method);
      expect(annotationsOf(t).readOnlyHint).toBe(true);
      expect(t.enabled).toBeUndefined();
    }
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bdockerhub_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bdockerhub_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://app.docker.com/settings/personal-access-tokens');
    expect(a.instructions).toMatch(/namespace `library`/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings that do real work (never maxBytes alone)', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(tr).toBeDefined();
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.expression ?? tr.exclude ?? tr.include).toBeDefined();
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
  });

  const table: Array<[string, Record<string, unknown>, string]> = [
    ['dockerhub_get_user', {}, `${BASE}/v2/user/`],
    ['dockerhub_list_my_orgs', {}, `${BASE}/v2/user/orgs/`],
    ['dockerhub_get_org', { org_name: 'docker' }, `${BASE}/v2/orgs/docker`],
    ['dockerhub_search_repositories', { query: 'nginx' }, `${BASE}/v2/search/repositories/`],
    ['dockerhub_list_repositories', { namespace: 'bitnami' }, `${BASE}/v2/namespaces/bitnami/repositories`],
    ['dockerhub_get_repository', { namespace: 'library', repository: 'nginx' }, `${BASE}/v2/namespaces/library/repositories/nginx`],
    ['dockerhub_list_tags', { namespace: 'library', repository: 'nginx' }, `${BASE}/v2/namespaces/library/repositories/nginx/tags`],
    ['dockerhub_get_tag', { namespace: 'library', repository: 'nginx', tag: '1.27-alpine' }, `${BASE}/v2/namespaces/library/repositories/nginx/tags/1.27-alpine`],
  ];

  it('lists every HTTP tool in the URL table', () => {
    const http = a.tools.filter((t) => t.endpointMapping.method !== 'static').map((t) => t.name).sort();
    expect(table.map(([name]) => name).sort()).toEqual(http);
  });

  it.each(table)('%s sends GET %s with the Bearer access token', async (name, params, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe('GET');
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_JWT}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('pages with page and page_size and filters with the documented names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('dockerhub_search_repositories', { query: 'postgres', page: 2 });
    expect(sent().params).toEqual({ query: 'postgres', page: 2, page_size: 25 });
    mockedAxios.mockClear();
    await call('dockerhub_list_repositories', { namespace: 'bitnami', name: 'redis', ordering: '-pull_count' });
    expect(sent().params).toEqual({ name: 'redis', ordering: '-pull_count', page_size: 25 });
    mockedAxios.mockClear();
    await call('dockerhub_list_tags', { namespace: 'library', repository: 'nginx', name: 'alpine', page_size: 5 });
    expect(sent().params).toEqual({ name: 'alpine', page_size: 5 });
  });

  it('answers the pull-limit question without calling Docker Hub', async () => {
    const t = tool('dockerhub_pull_limits');
    expect(t.endpointMapping.method).toBe('static');
    expect(t.endpointMapping.staticResponse).toMatch(/100 per 6 hours/);
    expect(t.endpointMapping.staticResponse).toMatch(/200 per 6 hours/);
    expect(t.endpointMapping.staticResponse).toMatch(/ratelimitpreview\/test/);
    expect(t.endpointMapping.staticResponse).toMatch(/HEAD/);
  });

  it('shapes tags with platforms and a tag with its per-platform images', () => {
    const tags = shape('dockerhub_list_tags', {
      count: 1367,
      next: 'https://hub.docker.com/v2/namespaces/library/repositories/nginx/tags?page=2&page_size=1',
      previous: null,
      results: [
        {
          creator: 1,
          id: 2,
          images: [
            { architecture: 'amd64', features: '', variant: null, digest: 'sha256:a', os: 'linux', os_features: '', os_version: null, size: 28801526, status: 'active', last_pulled: 't', last_pushed: 't' },
            { architecture: 'arm64', variant: 'v8', digest: 'sha256:b', os: 'linux', size: 27000000 },
          ],
          last_updated: 't',
          last_updater: 1,
          last_updater_username: 'doijanky',
          name: 'stable-trixie',
          repository: 21171,
          full_size: 63587356,
          v2: true,
          tag_status: 'active',
          tag_last_pulled: '2026-10-15T06:12:21Z',
          tag_last_pushed: '2026-10-15T04:52:26Z',
          media_type: 'application/vnd.oci.image.index.v1+json',
          content_type: 'image',
          digest: 'sha256:eb1c',
        },
      ],
    });
    expect(tags.error).toBeUndefined();
    expect(tags.value).toEqual({
      count: 1367,
      next: 'https://hub.docker.com/v2/namespaces/library/repositories/nginx/tags?page=2&page_size=1',
      tags: [
        {
          name: 'stable-trixie',
          digest: 'sha256:eb1c',
          full_size: 63587356,
          last_pushed: '2026-10-15T04:52:26Z',
          last_pulled: '2026-10-15T06:12:21Z',
          status: 'active',
          media_type: 'application/vnd.oci.image.index.v1+json',
          platforms: ['linux/amd64', 'linux/arm64'],
        },
      ],
    });
    const tag = shape('dockerhub_get_tag', {
      name: 'alpine',
      digest: 'sha256:idx',
      media_type: 'application/vnd.oci.image.index.v1+json',
      full_size: 1,
      tag_last_pushed: 't',
      tag_last_pulled: 't2',
      tag_status: 'active',
      last_updater_username: 'u',
      images: [{ architecture: 'arm64', variant: 'v8', os: 'linux', digest: 'sha256:b', size: 2, status: 'active', last_pushed: 'p', last_pulled: 'q', features: '', os_features: '' }],
    }).value as any;
    expect(tag.images).toEqual([{ os: 'linux', architecture: 'arm64', variant: 'v8', digest: 'sha256:b', size: 2, status: 'active', last_pushed: 'p', last_pulled: 'q' }]);
    expect(tag.digest).toBe('sha256:idx');
  });

  it('shapes the account without the gravatar e-mail', () => {
    const me = shape('dockerhub_get_user', { id: 'i', username: 'jdoe', full_name: 'Jane', location: 'Berlin', company: 'Acme', gravatar_email: 'jane@example.com', gravatar_url: 'g', is_staff: false, is_admin: false, profile_url: 'p', date_joined: 't', type: 'User' }).value;
    expect(me).toEqual({ id: 'i', username: 'jdoe', full_name: 'Jane', company: 'Acme', location: 'Berlin', type: 'User', date_joined: 't', profile_url: 'p' });
  });
});

const live = process.env.RUN_DOCKERHUB_LIVE === '1' ? describe : describe.skip;
live('dockerhub adapter: live', () => {
  const user = process.env.DOCKERHUB_USERNAME;
  const token = process.env.DOCKERHUB_TOKEN;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it('the sign-in refuses a wrong personal access token (401)', async () => {
    const auth = interpolateDeep(a.connector.authConfig, { DOCKERHUB_USERNAME: 'amcp-nobody-x1', DOCKERHUB_TOKEN: FAKE_PAT }) as any;
    await expect(new LoginTokenService({} as any, config).getToken(auth)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it.each([['dockerhub_get_user'], ['dockerhub_list_my_orgs']])('%s exists and refuses a wrong access token (401)', async (name) => {
    await expect(call(name, {})).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  // Public reads need no sign-in, so they run with authType NONE here to
  // check the real response shapes without an account.
  const pub = async (name: string, params: Record<string, unknown>) => {
    const out = shape(name, await call(name, params, ENV, stubLogin, 'NONE'));
    expect(out.error).toBeUndefined();
    return out.value as any;
  };

  it('searches, reads repositories, tags and an organization for real (public, free)', async () => {
    const found = await pub('dockerhub_search_repositories', { query: 'nginx', page_size: 3 });
    expect(found.results[0]).toMatchObject({ repo_name: 'nginx', is_official: true });
    const repo = await pub('dockerhub_get_repository', { namespace: 'library', repository: 'nginx' });
    expect(repo.pull_count).toBeGreaterThan(1e9);
    expect(repo.readme).toMatch(/nginx/i);
    const repos = await pub('dockerhub_list_repositories', { namespace: 'bitnami', ordering: '-pull_count', page_size: 3 });
    expect(repos.repositories).toHaveLength(3);
    const tags = await pub('dockerhub_list_tags', { namespace: 'library', repository: 'nginx', name: 'alpine', page_size: 3 });
    expect(tags.tags.every((t: any) => t.name.includes('alpine'))).toBe(true);
    expect(tags.tags[0].platforms).toContain('linux/amd64');
    const tag = await pub('dockerhub_get_tag', { namespace: 'library', repository: 'nginx', tag: 'alpine' });
    expect(tag.images.map((i: any) => i.architecture)).toEqual(expect.arrayContaining(['amd64', 'arm64']));
    expect(tag.digest).toMatch(/^sha256:/);
    expect((await pub('dockerhub_get_org', { org_name: 'docker' })).orgname).toBe('docker');
  }, 90000);

  (user && token ? it : it.skip)('signs in and reads the account, its organizations and repositories', async () => {
    const env = { DOCKERHUB_USERNAME: user!, DOCKERHUB_TOKEN: token! };
    const login = new LoginTokenService({} as any, config);
    const run = async (name: string, params: Record<string, unknown> = {}) => {
      const out = shape(name, await call(name, params, env, login));
      expect(out.error).toBeUndefined();
      return out.value as any;
    };
    const me = await run('dockerhub_get_user');
    expect(me.username.toLowerCase()).toBe(user!.toLowerCase());
    expect(typeof (await run('dockerhub_list_my_orgs')).count).toBe('number');
    expect(typeof (await run('dockerhub_list_repositories', { namespace: me.username })).count).toBe('number');
  }, 60000);
});
