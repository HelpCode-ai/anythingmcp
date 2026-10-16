import axios from 'axios';
import * as adapter from './neon.json';
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
 * Two layers of verification for the Neon adapter:
 *
 *   1. Static: always runs. Pins Bearer auth on console.neon.tech/api/v2 and
 *      every tool's method, URL, query and body through the real RestEngine,
 *      checked against Neon's OpenAPI document (neon.tech/api_spec/release/
 *      v2.json, fetched 15 Oct 2026). Pins above all that no password leaves:
 *      role passwords, connection URIs and the reveal-password route are
 *      never part of an answer, and SQL is deliberately absent (Neon's HTTP
 *      SQL endpoint needs a connection string with the role password).
 *
 *   2. Live: skipped unless RUN_NEON_LIVE=1. Without a key it checks that Neon
 *      refuses a fake one with 401 on every real route. Neon checks the key
 *      before routing, so a made-up route answers 401 too and cannot prove a
 *      route exists; the route table above is what pins them. With
 *      NEON_API_KEY it lists organizations, projects, branches, endpoints,
 *      databases, roles and operations (all free, no compute is woken).
 *      NEON_LIVE_WRITE=1 also creates a branch without compute that expires
 *      in an hour (free on every plan within the branch allowance):
 *
 *        RUN_NEON_LIVE=1 NEON_API_KEY=napi_... npx jest src/adapters/intl/neon.live.spec.ts
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

const BASE = 'https://console.neon.tech/api/v2';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['napi', '_', 'x9'.repeat(16)].join('');
const ENV: Record<string, string> = { NEON_API_KEY: FAKE_KEY };

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

const OFF = ['neon_delete_branch'];
const WRITES = ['neon_create_branch', 'neon_delete_branch', 'neon_start_endpoint', 'neon_suspend_endpoint'];

describe('neon adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.icon).toBe('neon');
  });

  it('sends the API key as Bearer on console.neon.tech/api/v2 and checks it on a list every key type may read', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{NEON_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/users/me/organizations');
    expect(a.probe).toEqual({ tool: 'neon_list_organizations' });
    expect(a.requiredEnvVars).toEqual(['NEON_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'NEON_API_KEY', kind: 'credential', secret: true, required: true });
  });

  it('accepts a key and refuses pasted headers or spaces', () => {
    const re = new RegExp(a.envVarMeta.NEON_API_KEY.pattern!);
    expect(re.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `, 'napi_short']) expect(re.test(bad)).toBe(false);
  });

  it('prefixes every tool with neon_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^neon_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks branch and compute changes as writes that need confirmation, and installs delete switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    for (const name of WRITES) expect(tool(name).description).toMatch(/Confirm with the user first/);
    expect(annotationsOf(tool('neon_suspend_endpoint'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsOf(tool('neon_delete_branch'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('never reaches a route that returns a password or a connection string, and runs no SQL', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.path).not.toMatch(/reveal_password|connection_uri|reset_password|\/sql\b/);
    }
    expect(a.instructions).toMatch(/Running SQL is not part of this connector/);
    expect(a.instructions).toMatch(/Neon-Connection-String|connection string including the role's password/);
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bneon_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bneon_[a-z_]+/g)]),
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

  const P = 'shiny-wind-028834';
  const B = 'br-aged-salad-637688';
  const E = 'ep-little-smoke-851426';
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['neon_list_organizations', {}, 'GET', `${BASE}/users/me/organizations`],
    ['neon_list_projects', {}, 'GET', `${BASE}/projects`],
    ['neon_get_project', { project_id: P }, 'GET', `${BASE}/projects/${P}`],
    ['neon_list_branches', { project_id: P }, 'GET', `${BASE}/projects/${P}/branches`],
    ['neon_get_branch', { project_id: P, branch_id: B }, 'GET', `${BASE}/projects/${P}/branches/${B}`],
    ['neon_create_branch', { project_id: P }, 'POST', `${BASE}/projects/${P}/branches`],
    ['neon_delete_branch', { project_id: P, branch_id: B }, 'DELETE', `${BASE}/projects/${P}/branches/${B}`],
    ['neon_list_endpoints', { project_id: P }, 'GET', `${BASE}/projects/${P}/endpoints`],
    ['neon_get_endpoint', { project_id: P, endpoint_id: E }, 'GET', `${BASE}/projects/${P}/endpoints/${E}`],
    ['neon_start_endpoint', { project_id: P, endpoint_id: E }, 'POST', `${BASE}/projects/${P}/endpoints/${E}/start`],
    ['neon_suspend_endpoint', { project_id: P, endpoint_id: E }, 'POST', `${BASE}/projects/${P}/endpoints/${E}/suspend`],
    ['neon_list_databases', { project_id: P, branch_id: B }, 'GET', `${BASE}/projects/${P}/branches/${B}/databases`],
    ['neon_list_roles', { project_id: P, branch_id: B }, 'GET', `${BASE}/projects/${P}/branches/${B}/roles`],
    ['neon_get_database_schema', { project_id: P, branch_id: B, db_name: 'neondb' }, 'GET', `${BASE}/projects/${P}/branches/${B}/schema`],
    ['neon_list_operations', { project_id: P }, 'GET', `${BASE}/projects/${P}/operations`],
    ['neon_get_operation', { project_id: P, operation_id: 'a07f8772' }, 'GET', `${BASE}/projects/${P}/operations/a07f8772`],
    ['neon_get_consumption', { org_id: 'org-1', from: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z', granularity: 'daily' }, 'GET', `${BASE}/consumption_history/v2/projects`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the OpenAPI URL with the Bearer key', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('sends list filters, the schema format and repeated consumption metrics', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('neon_list_projects', { org_id: 'org-1', search: 'shop' });
    expect(sent().params).toEqual({ org_id: 'org-1', search: 'shop', limit: 50 });
    mockedAxios.mockClear();
    await call('neon_get_database_schema', { project_id: P, branch_id: B, db_name: 'neondb' });
    expect(sent().params).toEqual({ db_name: 'neondb', format: 'sql' });
    mockedAxios.mockClear();
    await call('neon_get_consumption', { org_id: 'org-1', from: 'f', to: 't', granularity: 'daily', project_ids: [P] });
    expect(sent().params).toEqual({
      org_id: 'org-1',
      from: 'f',
      to: 't',
      granularity: 'daily',
      metrics: ['compute_unit_seconds', 'root_branch_bytes_month', 'child_branch_bytes_month', 'public_network_transfer_bytes'],
      project_ids: [P],
      limit: 10,
    });
  });

  it('creates a branch with the OpenAPI body shape', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('neon_create_branch', { project_id: P, name: 'feature-x', parent_id: B, expires_at: '2026-10-16T00:00:00Z', endpoints: [{ type: 'read_write' }] });
    expect(sent().data).toEqual({ branch: { name: 'feature-x', parent_id: B, expires_at: '2026-10-16T00:00:00Z' }, endpoints: [{ type: 'read_write' }] });
    mockedAxios.mockClear();
    await call('neon_create_branch', { project_id: P });
    expect(sent().data).toEqual({ branch: {} });
  });

  it('drops passwords and connection URIs from a created branch and from roles', () => {
    const created = shape('neon_create_branch', {
      branch: { id: B, name: 'feature-x', parent_id: 'br-main', current_state: 'init', pending_state: 'ready', created_at: 'c' },
      endpoints: [{ id: E, host: `${E}.us-east-2.aws.neon.tech`, type: 'read_write', current_state: 'init' }],
      operations: [{ id: 'op1', action: 'create_branch', status: 'running' }],
      roles: [{ branch_id: B, name: 'app', password: 'SECRET-PASSWORD' }],
      databases: [{ id: 1, name: 'neondb', owner_name: 'app' }],
      connection_uris: [{ connection_uri: 'postgresql://app:SECRET-PASSWORD@host/neondb', connection_parameters: { password: 'SECRET-PASSWORD' } }],
    });
    expect(created.error).toBeUndefined();
    expect(JSON.stringify(created.value)).not.toContain('SECRET-PASSWORD');
    expect(created.value).toMatchObject({
      branch: { id: B, name: 'feature-x', current_state: 'init' },
      endpoints: [{ id: E, type: 'read_write' }],
      roles: [{ name: 'app' }],
      databases: [{ name: 'neondb', owner_name: 'app' }],
    });
    const roles = shape('neon_list_roles', { roles: [{ branch_id: B, name: 'app', password: 'SECRET-PASSWORD', protected: false }] });
    expect(JSON.stringify(roles.value)).not.toContain('SECRET-PASSWORD');
  });

  it('shapes single objects as objects, not one-element lists', () => {
    const branch = shape('neon_get_branch', { branch: { id: B, name: 'main', default: true, logical_size: 100 } });
    expect(branch.value).toEqual({ branch: { id: B, name: 'main', default: true, logical_size: 100 } });
    const ep = shape('neon_start_endpoint', { endpoint: { id: E, current_state: 'idle', pending_state: 'active' }, operations: [{ id: 'o', action: 'start_compute', status: 'scheduling' }] });
    expect(ep.value).toEqual({ endpoint: { id: E, current_state: 'idle', pending_state: 'active' }, operations: [{ id: 'o', action: 'start_compute', status: 'scheduling' }] });
  });
});

const live = process.env.RUN_NEON_LIVE === '1' ? describe : describe.skip;
live('neon adapter: live', () => {
  const realKey = process.env.NEON_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['neon_list_organizations', {}],
    ['neon_list_projects', {}],
    ['neon_get_project', { project_id: 'shiny-wind-028834' }],
    ['neon_list_branches', { project_id: 'shiny-wind-028834' }],
    ['neon_list_endpoints', { project_id: 'shiny-wind-028834' }],
    ['neon_list_operations', { project_id: 'shiny-wind-028834' }],
  ])('%s: Neon refuses a fake key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('checks the key before routing: a made-up route is 401 as well', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/does-not-exist`, method: 'GET', headers: { Authorization: `Bearer ${FAKE_KEY}` } }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  const run = async (name: string, params: Record<string, unknown> = {}) => {
    const out = shape(name, await call(name, params, { NEON_API_KEY: realKey! }));
    expect(out.error).toBeUndefined();
    return out.value as any;
  };

  (realKey ? it : it.skip)('lists organizations, projects, branches, endpoints, databases, roles and operations', async () => {
    const orgs = await run('neon_list_organizations');
    expect(Array.isArray(orgs.organizations)).toBe(true);
    const projects = await run('neon_list_projects', orgs.organizations[0] ? { org_id: orgs.organizations[0].id, limit: 5 } : { limit: 5 });
    const project = projects.projects[0];
    if (!project) return;
    const branches = await run('neon_list_branches', { project_id: project.id, limit: 5 });
    const main = branches.branches.find((b: { default: boolean }) => b.default) ?? branches.branches[0];
    expect(Array.isArray((await run('neon_list_endpoints', { project_id: project.id })).endpoints)).toBe(true);
    expect(Array.isArray((await run('neon_list_databases', { project_id: project.id, branch_id: main.id })).databases)).toBe(true);
    const roles = await run('neon_list_roles', { project_id: project.id, branch_id: main.id });
    for (const r of roles.roles) expect(r.password).toBeUndefined();
    expect(Array.isArray((await run('neon_list_operations', { project_id: project.id, limit: 3 })).operations)).toBe(true);
  }, 120000);

  (realKey && process.env.NEON_LIVE_WRITE === '1' ? it : it.skip)('creates a compute-less branch that expires in an hour', async () => {
    const orgs = await run('neon_list_organizations');
    const projects = await run('neon_list_projects', orgs.organizations[0] ? { org_id: orgs.organizations[0].id, limit: 1 } : { limit: 1 });
    const expires = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const created = await run('neon_create_branch', { project_id: projects.projects[0].id, name: `amcp-live-${Date.now()}`, expires_at: expires });
    expect(created.branch.id).toMatch(/^br-/);
    expect(JSON.stringify(created)).not.toMatch(/postgresql:\/\//);
  }, 120000);
});
