import axios from 'axios';
import * as adapter from './render.json';
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
 * Two layers of verification for the Render adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with the rnd_ API key, the /users
 *      healthcheck, and every tool's method, URL, query and body through the
 *      real RestEngine, checked against Render's OpenAPI document
 *      (api-docs.render.com/openapi/render-public-api-1.json, read 15 Oct 2026)
 *      and the client Render generates from it for its open-source MCP server
 *      (times sent as RFC 3339). Also which tools only read, that every write
 *      asks for confirmation, that the env value reader ships switched off and
 *      that env values never reach the model from the list.
 *
 *   2. Live: skipped unless RUN_RENDER_LIVE=1. Without a key it checks that
 *      Render refuses a wrong key with 401 on the real routes. Render checks
 *      the key before routing under /services and /metrics (an unknown path
 *      there also answers 401), so for those the probe proves the prefix; an
 *      unknown top-level path answers 404. With RENDER_API_KEY it reads the
 *      user, workspaces, services and the first service's deploys, events,
 *      env names, domains, jobs, logs and metrics, plus Postgres and Key Value
 *      lists, shaped by each tool's response mapping as production does.
 *      Nothing is written unless RUN_RENDER_LIVE_WRITES=1 and
 *      RENDER_LIVE_SERVICE_ID are set too: then that service is restarted.
 *
 *        RUN_RENDER_LIVE=1 RENDER_API_KEY=rnd_... npx jest src/adapters/intl/render.live.spec.ts
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

const HOST = 'https://api.render.com/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'rnd_' + 'Q'.repeat(28);
const ENV: Record<string, string> = { RENDER_API_KEY: FAKE_KEY };

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
  'render_cancel_deploy',
  'render_create_job',
  'render_restart_service',
  'render_resume_service',
  'render_rollback_deploy',
  'render_suspend_service',
  'render_trigger_deploy',
];
const NO_BODY = ['render_restart_service', 'render_resume_service', 'render_suspend_service'];
const SRV = 'srv-d1a2b3c4d5e6f7g8h9i0';
const DEP = 'dep-a1b2c3d4e5f6g7h8i9j0';

describe('render adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the API key as a Bearer token and checks it on /users', () => {
    expect(a.category).toBe('infrastructure');
    expect(a.icon).toBe('render');
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{RENDER_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/users');
    expect(a.probe.tool).toBe('render_get_current_user');
    expect(a.requiredEnvVars).toEqual(['RENDER_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.RENDER_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts an rnd_ key and refuses anything else', () => {
    const key = new RegExp(a.envVarMeta.RENDER_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, 'rnd_short', 'Q'.repeat(32), `${FAKE_KEY} `]) expect(key.test(bad)).toBe(false);
  });

  it('explains wrong keys, missing rights and the rate limit', () => {
    for (const key of ['401', '403', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool with render_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^render_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('confirms every write, flags the disruptive ones and ships the env value reader switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(`${name}:${/confirm/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['render_get_env_var_value']);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
    for (const name of ['render_suspend_service', 'render_restart_service', 'render_rollback_deploy', 'render_cancel_deploy']) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(tool('render_get_env_var_value').description).toMatch(/explicitly asks/);
    expect(tool('render_rollback_deploy').description).toMatch(/Auto deploys stay on/);
  });

  it('only points the model at tools that exist, documents setup, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\brender_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\brender_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/API Keys/);
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

  const S = `/services/${SRV}`;
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['render_get_current_user', {}, 'GET', '/users'],
    ['render_list_workspaces', {}, 'GET', '/owners'],
    ['render_list_projects', {}, 'GET', '/projects'],
    ['render_list_services', {}, 'GET', '/services'],
    ['render_get_service', { service_id: SRV }, 'GET', S],
    ['render_list_deploys', { service_id: SRV }, 'GET', `${S}/deploys`],
    ['render_get_deploy', { service_id: SRV, deploy_id: DEP }, 'GET', `${S}/deploys/${DEP}`],
    ['render_trigger_deploy', { service_id: SRV }, 'POST', `${S}/deploys`],
    ['render_cancel_deploy', { service_id: SRV, deploy_id: DEP }, 'POST', `${S}/deploys/${DEP}/cancel`],
    ['render_rollback_deploy', { service_id: SRV, deploy_id: DEP }, 'POST', `${S}/rollback`],
    ['render_restart_service', { service_id: SRV }, 'POST', `${S}/restart`],
    ['render_suspend_service', { service_id: SRV }, 'POST', `${S}/suspend`],
    ['render_resume_service', { service_id: SRV }, 'POST', `${S}/resume`],
    ['render_list_env_var_keys', { service_id: SRV }, 'GET', `${S}/env-vars`],
    ['render_get_env_var_value', { service_id: SRV, key: 'NODE_ENV' }, 'GET', `${S}/env-vars/NODE_ENV`],
    ['render_list_custom_domains', { service_id: SRV }, 'GET', `${S}/custom-domains`],
    ['render_list_jobs', { service_id: SRV }, 'GET', `${S}/jobs`],
    ['render_get_job', { service_id: SRV, job_id: 'job-x1' }, 'GET', `${S}/jobs/job-x1`],
    ['render_create_job', { service_id: SRV, start_command: 'npm run migrate' }, 'POST', `${S}/jobs`],
    ['render_list_logs', { owner_id: 'tea-x1', resource: [SRV] }, 'GET', '/logs'],
    ['render_get_metrics', { metric: 'cpu', resource: SRV }, 'GET', '/metrics/cpu'],
    ['render_list_events', { service_id: SRV }, 'GET', `${S}/events`],
    ['render_list_postgres', {}, 'GET', '/postgres'],
    ['render_get_postgres', { postgres_id: 'dpg-x1' }, 'GET', '/postgres/dpg-x1'],
    ['render_list_key_value', {}, 'GET', '/key-value'],
    ['render_get_key_value', { key_value_id: 'red-x1' }, 'GET', '/key-value/red-x1'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer key', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('sends the documented query names, log filters as repeated values and camelCase bodies', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('render_list_services', { type: 'web_service,cron_job', owner_id: 'tea-x1', suspended: 'not_suspended' });
    expect(sent().params).toEqual({ type: 'web_service,cron_job', ownerId: 'tea-x1', suspended: 'not_suspended', limit: 20 });
    mockedAxios.mockClear();
    await call('render_list_logs', { owner_id: 'tea-x1', resource: [SRV, 'crn-y'], level: ['error'], start_time: '2026-10-15T08:00:00Z' });
    expect(sent().params).toEqual({ ownerId: 'tea-x1', resource: [SRV, 'crn-y'], level: ['error'], startTime: '2026-10-15T08:00:00Z', direction: 'backward', limit: 50 });
    // Arrays go out as resource=a&resource=b, the OpenAPI default (form, explode).
    expect(sent().paramsSerializer(sent().params)).toContain(`resource=${SRV}&resource=crn-y`);
    mockedAxios.mockClear();
    await call('render_get_metrics', { metric: 'http-requests', resource: SRV, aggregate_by: 'statusCode', resolution_seconds: 300 });
    expect(sent().url).toBe(`${HOST}/metrics/http-requests`);
    expect(sent().params).toEqual({ resource: SRV, aggregateBy: 'statusCode', resolutionSeconds: 300 });
    mockedAxios.mockClear();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('render_trigger_deploy', { service_id: SRV, clear_cache: 'clear', commit_id: 'abc123' });
    expect(sent().data).toEqual({ clearCache: 'clear', commitId: 'abc123' });
    mockedAxios.mockClear();
    await call('render_rollback_deploy', { service_id: SRV, deploy_id: DEP });
    expect(sent().data).toEqual({ deployId: DEP });
    mockedAxios.mockClear();
    await call('render_create_job', { service_id: SRV, start_command: 'npm run migrate' });
    expect(sent().data).toEqual({ startCommand: 'npm run migrate' });
    mockedAxios.mockClear();
    await call('render_restart_service', { service_id: SRV });
    expect(sent().data ?? {}).toEqual({});
  });

  it('unwraps Render list items with their cursor and never lists env values', () => {
    const services = shape('render_list_services', [
      {
        service: {
          id: SRV,
          name: 'api',
          type: 'web_service',
          repo: 'https://github.com/acme/api',
          branch: 'main',
          suspended: 'not_suspended',
          dashboardUrl: 'https://dashboard.render.com/web/srv-x',
          serviceDetails: { url: 'https://api.onrender.com', region: 'frankfurt', plan: 'starter', runtime: 'node', envSpecificDetails: { startCommand: 'node server.js' } },
        },
        cursor: 'c1',
      },
    ]);
    expect(services).toEqual({
      services: [
        {
          id: SRV,
          name: 'api',
          type: 'web_service',
          repo: 'https://github.com/acme/api',
          branch: 'main',
          suspended: 'not_suspended',
          url: 'https://api.onrender.com',
          region: 'frankfurt',
          plan: 'starter',
          runtime: 'node',
          dashboard_url: 'https://dashboard.render.com/web/srv-x',
          cursor: 'c1',
        },
      ],
    });
    const vars = shape('render_list_env_var_keys', [
      { envVar: { key: 'DATABASE_URL', value: 'postgres://user:pw@host/db' }, cursor: 'c1' },
      { envVar: { key: 'NODE_ENV', value: 'production' }, cursor: 'c2' },
    ]);
    expect(vars).toEqual({ env_vars: [{ key: 'DATABASE_URL', cursor: 'c1' }, { key: 'NODE_ENV', cursor: 'c2' }] });
    expect(JSON.stringify(vars)).not.toContain('postgres://');
    const logs = shape('render_list_logs', {
      hasMore: true,
      nextStartTime: '2026-10-15T07:00:00Z',
      nextEndTime: '2026-10-15T07:59:59Z',
      logs: [{ id: 'l1', timestamp: '2026-10-15T08:00:00Z', message: 'GET /health 200', labels: [{ name: 'level', value: 'info' }] }],
    });
    expect(logs).toEqual({
      logs: [{ timestamp: '2026-10-15T08:00:00Z', message: 'GET /health 200', labels: [{ name: 'level', value: 'info' }] }],
      hasMore: true,
      nextStartTime: '2026-10-15T07:00:00Z',
      nextEndTime: '2026-10-15T07:59:59Z',
    });
    const pg = shape('render_get_postgres', { id: 'dpg-x1', name: 'main', status: 'available', databaseName: 'app', databaseUser: 'app_user', plan: 'basic_256mb', owner: { id: 'tea-x1', name: 'Acme', email: 'ops@acme.test' } });
    expect(pg).toEqual({ id: 'dpg-x1', name: 'main', status: 'available', plan: 'basic_256mb', database_name: 'app', database_user: 'app_user', owner: 'Acme' });
    const metrics = shape('render_get_metrics', [{ labels: [{ field: 'resource', value: SRV }], unit: 'cpu', values: [{ timestamp: '2026-10-15T08:00:00Z', value: 0.12 }] }]);
    expect(metrics.series[0].values).toEqual([{ timestamp: '2026-10-15T08:00:00Z', value: 0.12 }]);
  });
});

const live = process.env.RUN_RENDER_LIVE === '1' ? describe : describe.skip;
live('render adapter: live', () => {
  const real = !!process.env.RENDER_API_KEY;
  const env = () => ({ RENDER_API_KEY: process.env.RENDER_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['render_get_current_user', {}],
    ['render_list_workspaces', {}],
    ['render_list_services', {}],
    ['render_list_postgres', {}],
    ['render_list_key_value', {}],
    ['render_list_logs', { owner_id: 'tea-x1', resource: [SRV] }],
  ])('%s reaches Render and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads the user, workspaces, services and what belongs to the first service', async () => {
    expect((await shaped('render_get_current_user', {}, env())).id).toBeTruthy();
    const owners = await shaped('render_list_workspaces', {}, env());
    expect(Array.isArray(owners.workspaces)).toBe(true);
    expect(Array.isArray((await shaped('render_list_postgres', {}, env())).databases)).toBe(true);
    expect(Array.isArray((await shaped('render_list_key_value', {}, env())).instances)).toBe(true);
    const services = await shaped('render_list_services', { limit: 5 }, env());
    expect(Array.isArray(services.services)).toBe(true);
    const svc = services.services[0];
    if (!svc) return;
    expect((await shaped('render_get_service', { service_id: svc.id }, env())).id).toBe(svc.id);
    const deploys = await shaped('render_list_deploys', { service_id: svc.id, limit: 5 }, env());
    expect(Array.isArray(deploys.deploys)).toBe(true);
    expect(Array.isArray((await shaped('render_list_events', { service_id: svc.id }, env())).events)).toBe(true);
    const vars = await shaped('render_list_env_var_keys', { service_id: svc.id }, env());
    expect(JSON.stringify(vars)).not.toMatch(/"value"/);
    expect(Array.isArray((await shaped('render_list_custom_domains', { service_id: svc.id }, env())).custom_domains)).toBe(true);
    expect(Array.isArray((await shaped('render_list_jobs', { service_id: svc.id }, env())).jobs)).toBe(true);
    const logs = await shaped('render_list_logs', { owner_id: svc.owner_id, resource: [svc.id], limit: 5 }, env());
    expect(Array.isArray(logs.logs)).toBe(true);
    const cpu = await shaped('render_get_metrics', { metric: 'cpu', resource: svc.id }, env());
    expect(Array.isArray(cpu.series)).toBe(true);
  }, 120000);

  const writes = real && process.env.RUN_RENDER_LIVE_WRITES === '1' && process.env.RENDER_LIVE_SERVICE_ID;
  (writes ? it : it.skip)('restarts the given service', async () => {
    await expect(call('render_restart_service', { service_id: process.env.RENDER_LIVE_SERVICE_ID! }, env())).resolves.toBeDefined();
  }, 60000);
});
