import axios from 'axios';
import * as adapter from './netlify.json';
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
 * Two layers of verification for the Netlify adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with a personal access token, the
 *      /user healthcheck, and every tool's method, URL, query and body through
 *      the real RestEngine, checked against Netlify's OpenAPI document
 *      (open-api.netlify.com/swagger.json 2.60.0, read 15 Oct 2026; the site
 *      env route is listed there with a doubled /api/v1 prefix, so its path
 *      follows Netlify's own open-source MCP server instead). Also which tools
 *      only read, that every write asks for confirmation, that the submission
 *      delete and the env value reader ship switched off, and that site
 *      passwords, hook URLs, env values and skew tokens never reach the model.
 *
 *   2. Live: skipped unless RUN_NETLIFY_LIVE=1. Without a token it checks that
 *      Netlify refuses a wrong token with 401 on the real routes (Netlify routes
 *      first: an unknown path answers 404, so a 401 proves the route). With
 *      NETLIFY_TOKEN it reads the user, teams, sites and the first site's
 *      deploys, builds, hooks, forms, functions and env names, shaped by each
 *      tool's response mapping as production does. Nothing is written unless
 *      RUN_NETLIFY_LIVE_WRITES=1 and NETLIFY_LIVE_SITE_ID are set too: then
 *      that site's published deploy is locked and unlocked again.
 *
 *        RUN_NETLIFY_LIVE=1 NETLIFY_TOKEN=... npx jest src/adapters/intl/netlify.live.spec.ts
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; exposeHeaders?: string[] };
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

const HOST = 'https://api.netlify.com/api/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'nfp_' + 'Z'.repeat(36);
const ENV: Record<string, string> = { NETLIFY_TOKEN: FAKE_TOKEN };

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
  'netlify_cancel_deploy',
  'netlify_delete_form_submission',
  'netlify_lock_deploy',
  'netlify_restore_deploy',
  'netlify_rollback_site',
  'netlify_trigger_build',
  'netlify_unlock_deploy',
];
const NO_BODY = ['netlify_delete_form_submission', 'netlify_rollback_site'];
const SITE = 'my-site.netlify.app';
const DEP = '5f1e2d3c4b5a69788796a5b4';

describe('netlify adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the personal access token as a Bearer token and checks it on /user', () => {
    expect(a.category).toBe('infrastructure');
    expect(a.icon).toBe('netlify');
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{NETLIFY_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/user');
    expect(a.probe.tool).toBe('netlify_get_current_user');
    expect(a.requiredEnvVars).toEqual(['NETLIFY_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.NETLIFY_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts a bare token and refuses one pasted with a prefix', () => {
    const token = new RegExp(a.envVarMeta.NETLIFY_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, 'short', `${FAKE_TOKEN} x`]) expect(token.test(bad)).toBe(false);
  });

  it('explains wrong tokens, missing roles and the rate limit', () => {
    for (const key of ['401', '403', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool with netlify_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^netlify_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('confirms every write and ships the delete and the env value reader switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(`${name}:${/confirm/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(['netlify_delete_form_submission', 'netlify_get_env_var_value']);
    for (const name of ['netlify_restore_deploy', 'netlify_rollback_site', 'netlify_cancel_deploy', 'netlify_delete_form_submission']) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(tool('netlify_get_env_var_value').description).toMatch(/explicitly asks/);
    expect(tool('netlify_restore_deploy').description).toMatch(/immediately/);
  });

  it('only points the model at tools that exist, documents setup, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bnetlify_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bnetlify_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/Personal access tokens/);
    expect(a.instructions).toMatch(/analytics/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool with a body a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      if (NO_BODY.includes(t.name)) {
        expect(tr).toBeUndefined();
        continue;
      }
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  it('asks for the Link header on every paged list', () => {
    for (const t of a.tools.filter((x) => x.parameters.properties?.page)) {
      expect(`${t.name}:${t.endpointMapping.exposeHeaders}`).toBe(`${t.name}:link`);
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['netlify_get_current_user', {}, 'GET', '/user'],
    ['netlify_list_accounts', {}, 'GET', '/accounts'],
    ['netlify_list_sites', {}, 'GET', '/sites'],
    ['netlify_get_site', { site_id: SITE }, 'GET', `/sites/${SITE}`],
    ['netlify_list_deploys', { site_id: SITE }, 'GET', `/sites/${SITE}/deploys`],
    ['netlify_get_deploy', { deploy_id: DEP }, 'GET', `/deploys/${DEP}`],
    ['netlify_list_builds', { site_id: SITE }, 'GET', `/sites/${SITE}/builds`],
    ['netlify_get_build', { build_id: DEP }, 'GET', `/builds/${DEP}`],
    ['netlify_list_build_hooks', { site_id: SITE }, 'GET', `/sites/${SITE}/build_hooks`],
    ['netlify_list_functions', { site_id: SITE }, 'GET', `/sites/${SITE}/functions`],
    ['netlify_list_forms', { site_id: SITE }, 'GET', `/sites/${SITE}/forms`],
    ['netlify_list_form_submissions', { form_id: DEP }, 'GET', `/forms/${DEP}/submissions`],
    ['netlify_list_env_vars', { site_id: SITE }, 'GET', `/sites/${SITE}/env`],
    ['netlify_get_env_var_value', { account_id: 'acc1', key: 'API_URL', site_id: 's1' }, 'GET', '/accounts/acc1/env/API_URL'],
    ['netlify_list_dns_zones', {}, 'GET', '/dns_zones'],
    ['netlify_list_dns_records', { zone_id: 'z1' }, 'GET', '/dns_zones/z1/dns_records'],
    ['netlify_trigger_build', { site_id: SITE }, 'POST', `/sites/${SITE}/builds`],
    ['netlify_restore_deploy', { site_id: SITE, deploy_id: DEP }, 'POST', `/sites/${SITE}/deploys/${DEP}/restore`],
    ['netlify_rollback_site', { site_id: SITE }, 'PUT', `/sites/${SITE}/rollback`],
    ['netlify_lock_deploy', { deploy_id: DEP }, 'POST', `/deploys/${DEP}/lock`],
    ['netlify_unlock_deploy', { deploy_id: DEP }, 'POST', `/deploys/${DEP}/unlock`],
    ['netlify_cancel_deploy', { deploy_id: DEP }, 'POST', `/deploys/${DEP}/cancel`],
    ['netlify_delete_form_submission', { submission_id: DEP }, 'DELETE', `/submissions/${DEP}`],
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

  it('sends filters and the build options as query parameters, with no body', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('netlify_list_sites', { name: 'shop' });
    expect(sent().params).toEqual({ name: 'shop', filter: 'all', per_page: 30 });
    mockedAxios.mockClear();
    await call('netlify_list_deploys', { site_id: SITE, branch: 'main', production: true, page: 2 });
    expect(sent().params).toEqual({ branch: 'main', production: true, page: 2, per_page: 20 });
    mockedAxios.mockClear();
    await call('netlify_get_env_var_value', { account_id: 'acc1', key: 'API_URL', site_id: 's1' });
    expect(sent().params).toEqual({ site_id: 's1' });
    mockedAxios.mockClear();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('netlify_trigger_build', { site_id: SITE, branch: 'staging', clear_cache: true });
    expect(sent().params).toEqual({ branch: 'staging', clear_cache: true });
    expect(sent().data ?? {}).toEqual({});
  });

  it('never returns site passwords, hook URLs, env values or skew tokens', () => {
    const site = {
      id: 's1',
      name: 'shop',
      ssl_url: 'https://shop.netlify.app',
      password: 'visitor-secret',
      deploy_hook: 'https://api.netlify.com/hooks/github',
      build_settings: { repo_url: 'https://github.com/acme/shop', repo_branch: 'main', cmd: 'npm run build', dir: 'dist', env: { API_KEY: 'build-secret' } },
      published_deploy: { id: 'd1', state: 'ready', branch: 'main', skew_protection_token: 'skew-secret' },
      default_hooks_data: { access_token: 'hook-secret' },
    };
    const sites = shape('netlify_list_sites', [site]);
    expect(sites.sites[0]).toMatchObject({
      id: 's1',
      url: 'https://shop.netlify.app',
      repo_url: 'https://github.com/acme/shop',
      build_command: 'npm run build',
      publish_dir: 'dist',
      published_deploy: { id: 'd1', state: 'ready', branch: 'main' },
    });
    const one = shape('netlify_get_site', site);
    for (const out of [sites, one]) {
      for (const secret of ['visitor-secret', 'build-secret', 'skew-secret', 'hook-secret', 'hooks/github']) expect(JSON.stringify(out)).not.toContain(secret);
    }
    const hooks = shape('netlify_list_build_hooks', [{ id: 'h1', title: 'CMS', branch: 'main', url: 'https://api.netlify.com/build_hooks/abc123', site_id: 's1' }]);
    expect(hooks).toEqual({ build_hooks: [{ id: 'h1', title: 'CMS', branch: 'main' }] });
    const env = shape('netlify_list_env_vars', [
      { key: 'STRIPE_KEY', scopes: ['builds', 'functions'], is_secret: false, values: [{ id: 'v1', value: 'sk_live_plain', context: 'production' }, { id: 'v2', value: 'sk_test', context: 'dev' }], updated_at: '2026-10-01' },
    ]);
    expect(env).toEqual({ env_vars: [{ key: 'STRIPE_KEY', scopes: ['builds', 'functions'], is_secret: false, contexts: ['production', 'dev'], updated_at: '2026-10-01' }] });
    expect(JSON.stringify(env)).not.toContain('sk_');
    const dep = shape('netlify_get_deploy', { id: 'd1', state: 'error', error_message: 'Build script returned non-zero exit code: 2', skew_protection_token: 'skew-secret', branch: 'main', context: 'production' });
    expect(dep).toEqual({ id: 'd1', state: 'error', error_message: 'Build script returned non-zero exit code: 2', branch: 'main', context: 'production' });
  });
});

const live = process.env.RUN_NETLIFY_LIVE === '1' ? describe : describe.skip;
live('netlify adapter: live', () => {
  const real = !!process.env.NETLIFY_TOKEN;
  const env = () => ({ NETLIFY_TOKEN: process.env.NETLIFY_TOKEN! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['netlify_get_current_user', {}],
    ['netlify_list_sites', {}],
    ['netlify_list_deploys', { site_id: SITE }],
    ['netlify_list_env_vars', { site_id: SITE }],
    ['netlify_list_form_submissions', { form_id: DEP }],
    ['netlify_list_dns_zones', {}],
  ])('%s reaches Netlify and is refused with a wrong token (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads the user, teams, sites and what belongs to the first site', async () => {
    expect((await shaped('netlify_get_current_user', {}, env())).id).toBeTruthy();
    expect(Array.isArray((await shaped('netlify_list_accounts', {}, env())).accounts)).toBe(true);
    const sites = await shaped('netlify_list_sites', { per_page: 5 }, env());
    expect(Array.isArray(sites.sites)).toBe(true);
    const siteId = sites.sites[0]?.id;
    if (!siteId) return;
    expect((await shaped('netlify_get_site', { site_id: siteId }, env())).id).toBe(siteId);
    const deploys = await shaped('netlify_list_deploys', { site_id: siteId, per_page: 5 }, env());
    expect(Array.isArray(deploys.deploys)).toBe(true);
    expect(Array.isArray((await shaped('netlify_list_builds', { site_id: siteId }, env())).builds)).toBe(true);
    expect(Array.isArray((await shaped('netlify_list_build_hooks', { site_id: siteId }, env())).build_hooks)).toBe(true);
    expect(Array.isArray((await shaped('netlify_list_forms', { site_id: siteId }, env())).forms)).toBe(true);
    expect(Array.isArray((await shaped('netlify_list_functions', { site_id: siteId }, env())).deploys)).toBe(true);
    const vars = await shaped('netlify_list_env_vars', { site_id: siteId }, env());
    expect(JSON.stringify(vars)).not.toMatch(/"value"/);
    expect(Array.isArray((await shaped('netlify_list_dns_zones', {}, env())).dns_zones)).toBe(true);
  }, 120000);

  const writes = real && process.env.RUN_NETLIFY_LIVE_WRITES === '1' && process.env.NETLIFY_LIVE_SITE_ID;
  (writes ? it : it.skip)('locks and unlocks the published deploy of the given site', async () => {
    const site = await shaped('netlify_get_site', { site_id: process.env.NETLIFY_LIVE_SITE_ID! }, env());
    const deployId = site.published_deploy.id;
    expect((await shaped('netlify_lock_deploy', { deploy_id: deployId }, env())).locked).toBe(true);
    expect((await shaped('netlify_unlock_deploy', { deploy_id: deployId }, env())).locked).toBe(false);
  }, 60000);
});
