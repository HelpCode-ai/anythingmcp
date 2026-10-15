import axios from 'axios';
import * as adapter from './digitalocean.json';
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
 * Two layers of verification for the DigitalOcean adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with a personal access token and
 *      every tool's method, URL, query and body through the real RestEngine,
 *      checked against DigitalOcean's OpenAPI specification
 *      (digitalocean/openapi, specification/DigitalOcean-public.v2.yaml) and
 *      the official Go client (digitalocean/godo) on 15 Oct 2026. Also which
 *      tools change things, that each asks for confirmation, that the DNS
 *      delete ships switched off, and that database passwords, connection
 *      strings and app environment variables never come back.
 *
 *   2. Live: skipped unless RUN_DIGITALOCEAN_LIVE=1. Without a token it checks
 *      that DigitalOcean refuses a wrong token with 401 on the real routes
 *      (a made-up top-level route answers 404). With DIGITALOCEAN_TOKEN it reads
 *      account, Droplets, apps, databases, clusters, volumes, domains,
 *      firewalls and load balancers (balance and invoices when the token has
 *      billing:read), shaped by each tool's response mapping as production
 *      does. RUN_DIGITALOCEAN_LIVE_WRITES=1 with DIGITALOCEAN_TEST_DOMAIN also
 *      adds a TXT record anythingmcp-test to that domain and changes its TTL.
 *
 *        RUN_DIGITALOCEAN_LIVE=1 DIGITALOCEAN_TOKEN=dop_v1_... \
 *          npx jest src/adapters/intl/digitalocean.live.spec.ts
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

const HOST = 'https://api.digitalocean.com/v2';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'dop_v1_' + '0'.repeat(64);
const ENV: Record<string, string> = { DIGITALOCEAN_TOKEN: FAKE_TOKEN };

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
  'digitalocean_create_app_deployment',
  'digitalocean_create_domain_record',
  'digitalocean_delete_domain_record',
  'digitalocean_power_droplet',
  'digitalocean_snapshot_droplet',
  'digitalocean_update_domain_record',
];

describe('digitalocean adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the personal access token as Bearer and checks it on /account', () => {
    expect(a.category).toBe('infrastructure');
    expect(a.icon).toBe('digitalocean');
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{DIGITALOCEAN_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/account');
    expect(a.probe.tool).toBe('digitalocean_get_account');
    expect(a.requiredEnvVars).toEqual(['DIGITALOCEAN_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.DIGITALOCEAN_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts a dop_v1_ token (and an older bare one) and refuses one pasted with a prefix', () => {
    const token = new RegExp(a.envVarMeta.DIGITALOCEAN_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    expect(token.test('a'.repeat(64))).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, 'dop_v1_short', `${FAKE_TOKEN} `]) expect(token.test(bad)).toBe(false);
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with digitalocean_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^digitalocean_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks exactly the changes as writes, confirms each, ships the delete off and offers no destroy', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/wait for their yes/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['digitalocean_delete_domain_record']);
    const deletes = a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name);
    expect(deletes).toEqual(['digitalocean_delete_domain_record']);
    // Power off is the hard cut: the description has to say so.
    expect(tool('digitalocean_power_droplet').description).toMatch(/pulling the plug/);
  });

  it('only points the model at tools that exist, documents scopes, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bdigitalocean_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bdigitalocean_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('Custom Scopes');
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
    ['digitalocean_get_account', {}, 'GET', '/account'],
    ['digitalocean_get_balance', {}, 'GET', '/customers/my/balance'],
    ['digitalocean_list_invoices', {}, 'GET', '/customers/my/invoices'],
    ['digitalocean_list_droplets', {}, 'GET', '/droplets'],
    ['digitalocean_get_droplet', { droplet_id: 3164444 }, 'GET', '/droplets/3164444'],
    ['digitalocean_power_droplet', { droplet_id: 3164444, type: 'reboot' }, 'POST', '/droplets/3164444/actions'],
    ['digitalocean_snapshot_droplet', { droplet_id: 3164444, name: 'before upgrade' }, 'POST', '/droplets/3164444/actions'],
    ['digitalocean_get_action', { action_id: 36804636 }, 'GET', '/actions/36804636'],
    ['digitalocean_list_droplet_snapshots', { droplet_id: 3164444 }, 'GET', '/droplets/3164444/snapshots'],
    ['digitalocean_list_apps', {}, 'GET', '/apps'],
    ['digitalocean_get_app', { app_id: 'app-1' }, 'GET', '/apps/app-1'],
    ['digitalocean_list_app_deployments', { app_id: 'app-1' }, 'GET', '/apps/app-1/deployments'],
    ['digitalocean_get_app_deployment', { app_id: 'app-1', deployment_id: 'dep-1' }, 'GET', '/apps/app-1/deployments/dep-1'],
    ['digitalocean_create_app_deployment', { app_id: 'app-1' }, 'POST', '/apps/app-1/deployments'],
    ['digitalocean_get_app_logs_url', { app_id: 'app-1', type: 'RUN' }, 'GET', '/apps/app-1/logs'],
    ['digitalocean_get_app_deployment_logs_url', { app_id: 'app-1', deployment_id: 'dep-1', type: 'BUILD' }, 'GET', '/apps/app-1/deployments/dep-1/logs'],
    ['digitalocean_list_databases', {}, 'GET', '/databases'],
    ['digitalocean_get_database', { database_id: 'db-1' }, 'GET', '/databases/db-1'],
    ['digitalocean_list_database_replicas', { database_id: 'db-1' }, 'GET', '/databases/db-1/replicas'],
    ['digitalocean_list_kubernetes_clusters', {}, 'GET', '/kubernetes/clusters'],
    ['digitalocean_get_kubernetes_cluster', { cluster_id: 'k-1' }, 'GET', '/kubernetes/clusters/k-1'],
    ['digitalocean_list_volumes', {}, 'GET', '/volumes'],
    ['digitalocean_list_domains', {}, 'GET', '/domains'],
    ['digitalocean_list_domain_records', { domain_name: 'example.com' }, 'GET', '/domains/example.com/records'],
    ['digitalocean_create_domain_record', { domain_name: 'example.com', type: 'A', name: 'www', data: '203.0.113.10' }, 'POST', '/domains/example.com/records'],
    ['digitalocean_update_domain_record', { domain_name: 'example.com', record_id: 3352896, type: 'A', data: '203.0.113.11' }, 'PATCH', '/domains/example.com/records/3352896'],
    ['digitalocean_delete_domain_record', { domain_name: 'example.com', record_id: 3352896 }, 'DELETE', '/domains/example.com/records/3352896'],
    ['digitalocean_list_firewalls', {}, 'GET', '/firewalls'],
    ['digitalocean_get_firewall', { firewall_id: 'fw-1' }, 'GET', '/firewalls/fw-1'],
    ['digitalocean_list_load_balancers', {}, 'GET', '/load_balancers'],
    ['digitalocean_get_load_balancer', { lb_id: 'lb-1' }, 'GET', '/load_balancers/lb-1'],
    ['digitalocean_get_droplet_cpu_metrics', { host_id: '3164444', start: '1760486400', end: '1760490000' }, 'GET', '/monitoring/metrics/droplet/cpu'],
    [
      'digitalocean_get_droplet_bandwidth_metrics',
      { host_id: '3164444', interface: 'public', direction: 'outbound', start: '1760486400', end: '1760490000' },
      'GET',
      '/monitoring/metrics/droplet/bandwidth',
    ],
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

  it('sends the query parameters the API and the Go client use', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const params = async (name: string, p: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await call(name, p);
      return sent().params;
    };
    expect(await params('digitalocean_list_droplets', { tag_name: 'web' })).toEqual({ tag_name: 'web', per_page: 20 });
    expect(await params('digitalocean_get_app_logs_url', { app_id: 'app-1', type: 'RUN', component_name: 'api' })).toEqual({ type: 'RUN', component_name: 'api', follow: false });
    expect(await params('digitalocean_list_domain_records', { domain_name: 'example.com', type: 'A', name: 'www.example.com' })).toEqual({ type: 'A', name: 'www.example.com', per_page: 50 });
    expect(await params('digitalocean_get_droplet_bandwidth_metrics', { host_id: '1', interface: 'private', direction: 'inbound', start: '1', end: '2' })).toEqual({
      host_id: '1',
      interface: 'private',
      direction: 'inbound',
      start: '1',
      end: '2',
    });
  });

  it('builds the action, deployment and DNS record bodies with only the given fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const body = async (name: string, p: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await call(name, p);
      return sent().data;
    };
    expect(await body('digitalocean_power_droplet', { droplet_id: 1, type: 'power_off' })).toEqual({ type: 'power_off' });
    expect(await body('digitalocean_snapshot_droplet', { droplet_id: 1, name: 'nightly' })).toEqual({ type: 'snapshot', name: 'nightly' });
    expect(await body('digitalocean_create_app_deployment', { app_id: 'a', force_build: true })).toEqual({ force_build: true });
    expect(await body('digitalocean_create_domain_record', { domain_name: 'example.com', type: 'MX', name: '@', data: 'mail.example.com.', priority: 10, ttl: 3600 })).toEqual({
      type: 'MX',
      name: '@',
      data: 'mail.example.com.',
      priority: 10,
      ttl: 3600,
    });
    expect(await body('digitalocean_update_domain_record', { domain_name: 'example.com', record_id: 2, type: 'A', ttl: 300 })).toEqual({ type: 'A', ttl: 300 });
  });

  it('never returns database passwords or connection strings, even if the mapping fails', () => {
    const conn = { protocol: 'postgresql', uri: 'postgresql://doadmin:s3cret@db-1.db.ondigitalocean.com:25060/defaultdb?sslmode=require', host: 'db-1.db.ondigitalocean.com', port: 25060, user: 'doadmin', password: 's3cret', ssl: true };
    const db = { id: 'db-1', name: 'main', engine: 'pg', connection: conn, private_connection: { ...conn, host: 'private-db-1' }, users: [{ name: 'doadmin', role: 'primary', password: 's3cret' }] };
    const list = shape('digitalocean_list_databases', { databases: [db] });
    expect(list.databases[0]).toMatchObject({ id: 'db-1', host: 'db-1.db.ondigitalocean.com', port: 25060, private_host: 'private-db-1' });
    expect(JSON.stringify(list)).not.toContain('s3cret');
    const one = shape('digitalocean_get_database', { database: db });
    expect(one.database.users).toEqual([{ name: 'doadmin', role: 'primary' }]);
    expect(JSON.stringify(one)).not.toContain('s3cret');
    const replicas = shape('digitalocean_list_database_replicas', { replicas: [{ id: 'r1', name: 'read-1', connection: conn }] });
    expect(JSON.stringify(replicas)).not.toContain('s3cret');
    for (const name of ['digitalocean_list_databases', 'digitalocean_get_database', 'digitalocean_list_database_replicas']) {
      expect(tool(name).responseMapping!.transform.fallbackToRaw).toBe(false);
    }
  });

  it('leaves app environment variables out', () => {
    const spec = { name: 'shop', services: [{ name: 'api', instance_size_slug: 'apps-s-1vcpu-1gb', instance_count: 2, github: { repo: 'acme/shop', branch: 'main' }, envs: [{ key: 'STRIPE_KEY', value: 'sk_live_x', type: 'GENERAL' }] }], envs: [{ key: 'DB_PASSWORD', value: 'pw' }] };
    const app = shape('digitalocean_get_app', { app: { id: 'app-1', spec, live_url: 'https://shop.ondigitalocean.app', active_deployment: { id: 'd1', phase: 'ACTIVE', spec } } });
    expect(app.app.services).toEqual([{ name: 'api', instance_size_slug: 'apps-s-1vcpu-1gb', instance_count: 2, github_repo: 'acme/shop', github_branch: 'main' }]);
    expect(JSON.stringify(app)).not.toMatch(/sk_live_x|DB_PASSWORD|"pw"/);
    const apps = shape('digitalocean_list_apps', { apps: [{ id: 'app-1', spec, active_deployment: { id: 'd1', phase: 'ACTIVE', spec } }], meta: { total: 1 } });
    expect(JSON.stringify(apps)).not.toMatch(/sk_live_x|DB_PASSWORD/);
    const deployments = shape('digitalocean_list_app_deployments', { deployments: [{ id: 'd1', phase: 'ERROR', spec, progress: { error_steps: 1, total_steps: 5 } }] });
    expect(JSON.stringify(deployments)).not.toMatch(/sk_live_x|DB_PASSWORD/);
  });

  it('shapes Droplets to their addresses and size', () => {
    const out = shape('digitalocean_list_droplets', {
      droplets: [
        {
          id: 3164444,
          name: 'web-1',
          status: 'active',
          memory: 1024,
          vcpus: 1,
          disk: 25,
          region: { slug: 'fra1', name: 'Frankfurt 1', sizes: ['s-1vcpu-1gb'] },
          image: { name: '24.04 (LTS) x64', distribution: 'Ubuntu' },
          size_slug: 's-1vcpu-1gb',
          size: { slug: 's-1vcpu-1gb', price_monthly: 6 },
          networks: { v4: [{ ip_address: '203.0.113.10', type: 'public', netmask: '255.255.240.0' }], v6: [] },
          tags: ['web'],
        },
      ],
      links: { pages: { next: 'https://api.digitalocean.com/v2/droplets?page=2' } },
      meta: { total: 30 },
    });
    expect(out.droplets[0]).toMatchObject({ id: 3164444, region: 'fra1', networks: [{ ip_address: '203.0.113.10', type: 'public' }], image: { name: '24.04 (LTS) x64', distribution: 'Ubuntu' } });
    expect(out.total).toBe(30);
    expect(out.next_page).toContain('page=2');
  });
});

const live = process.env.RUN_DIGITALOCEAN_LIVE === '1' ? describe : describe.skip;
live('digitalocean adapter: live', () => {
  const real = !!process.env.DIGITALOCEAN_TOKEN;
  const env = () => ({ DIGITALOCEAN_TOKEN: process.env.DIGITALOCEAN_TOKEN! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['digitalocean_get_account', {}],
    ['digitalocean_list_droplets', {}],
    ['digitalocean_list_apps', {}],
    ['digitalocean_list_databases', {}],
    ['digitalocean_list_domain_records', { domain_name: 'example.com' }],
  ])('%s reaches DigitalOcean and is refused with a wrong token (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads account, Droplets, apps, databases, clusters, volumes, DNS, firewalls and load balancers', async () => {
    expect(typeof (await shaped('digitalocean_get_account', {}, env())).account.uuid).toBe('string');
    const droplets = await shaped('digitalocean_list_droplets', { per_page: 5 }, env());
    expect(Array.isArray(droplets.droplets ?? [])).toBe(true);
    const apps = await shaped('digitalocean_list_apps', { per_page: 5 }, env());
    if (apps.apps?.[0]) {
      const app = await shaped('digitalocean_get_app', { app_id: apps.apps[0].id }, env());
      expect(JSON.stringify(app)).not.toContain('"envs"');
      expect(Array.isArray((await shaped('digitalocean_list_app_deployments', { app_id: apps.apps[0].id, per_page: 3 }, env())).deployments ?? [])).toBe(true);
    }
    const dbs = await shaped('digitalocean_list_databases', {}, env());
    expect(JSON.stringify(dbs)).not.toMatch(/password|"uri"/);
    for (const name of [
      'digitalocean_list_kubernetes_clusters',
      'digitalocean_list_volumes',
      'digitalocean_list_domains',
      'digitalocean_list_firewalls',
      'digitalocean_list_load_balancers',
    ]) {
      await expect(shaped(name, { per_page: 5 }, env())).resolves.toBeDefined();
    }
  }, 120000);

  const writes = real && process.env.RUN_DIGITALOCEAN_LIVE_WRITES === '1' && !!process.env.DIGITALOCEAN_TEST_DOMAIN;
  (writes ? it : it.skip)('adds a TXT record to the test domain and changes its TTL', async () => {
    const domain = process.env.DIGITALOCEAN_TEST_DOMAIN!;
    const created = await shaped('digitalocean_create_domain_record', { domain_name: domain, type: 'TXT', name: 'anythingmcp-test', data: `live check ${Date.now()}`, ttl: 1800 }, env());
    expect(created.domain_record.id).toBeTruthy();
    const updated = await shaped('digitalocean_update_domain_record', { domain_name: domain, record_id: created.domain_record.id, type: 'TXT', ttl: 3600 }, env());
    expect(updated.domain_record.ttl).toBe(3600);
  }, 60000);
});
