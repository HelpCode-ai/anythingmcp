import axios from 'axios';
import { buildClientSchema, getIntrospectionQuery, Kind, OperationDefinitionNode, parse, validate } from 'graphql';
import * as adapter from './railway.json';
import { GraphqlEngine } from '../../connectors/engines/graphql.engine';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { GraphqlSchemaService } from '../../connectors/engines/graphql-schema.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Railway adapter (GraphQL):
 *
 *   1. Static: always runs. Every operation parses, its variables match the
 *      tool's queryParams one to one, and each request goes through the real
 *      GraphqlEngine with the Bearer token. Every operation was validated
 *      against Railway's live schema (public introspection of
 *      backboard.railway.com/graphql/v2) and compared with the queries in
 *      Railway's official CLI (railwayapp/cli, src/gql) on 15 Oct 2026. Also
 *      that variable values stay out unless the switched-off tool is enabled,
 *      and that redeploy and restart ask for confirmation.
 *
 *   2. Live: skipped unless RUN_RAILWAY_LIVE=1. Without a token it loads the
 *      public schema and validates every operation against it, and checks that
 *      a wrong token is answered with Not Authorized. With RAILWAY_API_TOKEN it
 *      reads projects, a project, deployments, build and runtime logs, variable
 *      names and estimated usage. RUN_RAILWAY_LIVE_WRITES=1 with
 *      RAILWAY_TEST_DEPLOYMENT_ID also restarts that deployment.
 *
 *        RUN_RAILWAY_LIVE=1 RAILWAY_API_TOKEN=... \
 *          npx jest src/adapters/intl/railway.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const post = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(Object.create(actual.default), actual.default, { post, __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedPost = (axios as unknown as { post: jest.Mock }).post;
const actualAxios = (axios as unknown as { __actual: typeof axios }).__actual;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
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
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const operation = (t: Tool) =>
  parse(t.endpointMapping.path).definitions.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)!;
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'GRAPHQL', endpointMapping: t.endpointMapping, annotations: t.annotations });

const URL = 'https://backboard.railway.com/graphql/v2';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = ['0'.repeat(8), '0'.repeat(4), '4000', '8000', '0'.repeat(12)].join('-');
const ENV: Record<string, string> = { RAILWAY_API_TOKEN: FAKE_TOKEN };

// Mirrors DynamicMcpTools for a GraphQL connector.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new GraphqlEngine({} as OAuth2TokenService, {} as LoginTokenService, {} as GraphqlSchemaService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    },
    endpointMapping as any,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) => shape(name, await call(name, params, env));

const WRITES = ['railway_redeploy_deployment', 'railway_restart_deployment'];

describe('railway adapter: static spec conformance', () => {
  beforeEach(() => mockedPost.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('posts to the public GraphQL API with an account or workspace token as Bearer', () => {
    expect(a.category).toBe('infrastructure');
    expect(a.icon).toBe('railway');
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe(URL);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{RAILWAY_API_TOKEN}}' });
    // listing projects works with account and workspace tokens; me only with account tokens.
    expect(a.probe.tool).toBe('railway_list_projects');
    expect(a.requiredEnvVars).toEqual(['RAILWAY_API_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.RAILWAY_API_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.RAILWAY_API_TOKEN.pattern!);
    expect(pattern.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, 'short']) expect(pattern.test(bad)).toBe(false);
    for (const key of ['401', '429', 'auth_failed']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('explains that project tokens use another header and are not supported', () => {
    expect(a.instructions).toContain('Project-Access-Token');
    expect(a.instructions).toMatch(/Project tokens are not supported/);
  });

  it('prefixes every tool with railway_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^railway_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('every operation parses, matches its method, and maps each variable to a parameter', () => {
    for (const t of a.tools) {
      const op = operation(t);
      expect(`${t.name}:${op.operation}`).toBe(`${t.name}:${t.endpointMapping.method}`);
      const declared = (op.variableDefinitions ?? []).map((d) => d.variable.name.value).sort();
      expect(`${t.name}:${Object.keys(t.endpointMapping.queryParams ?? {}).sort()}`).toBe(`${t.name}:${declared}`);
      for (const value of Object.values(t.endpointMapping.queryParams ?? {})) {
        expect(Object.keys(t.parameters.properties ?? {})).toContain(value.slice(1));
      }
      for (const required of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(required);
    }
  });

  it('only redeploy and restart write, both confirm first, and variable values ship switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/wait for their yes/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['railway_get_variable_values']);
    const mutations = a.tools
      .filter((t) => t.endpointMapping.method === 'mutation')
      .flatMap((t) => operation(t).selectionSet.selections.map((s) => (s.kind === Kind.FIELD ? s.name.value : '')));
    expect(mutations.sort()).toEqual(['deploymentRedeploy', 'deploymentRestart']);
  });

  it('returns only variable names, never their values, from the default tool', () => {
    const out = shape('railway_list_variable_names', { variables: { DATABASE_URL: 'postgresql://u:secret@h/db', API_KEY: 'sk-123', PORT: '8080' } });
    expect(out).toEqual({ names: ['API_KEY', 'DATABASE_URL', 'PORT'] });
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(tool('railway_list_variable_names').responseMapping!.transform.fallbackToRaw).toBe(false);
  });

  it('installs the generic mutation and subscription helpers switched off', () => {
    const tools = getAdapter('railway')!.tools as Array<{ name: string; enabled?: boolean }>;
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('railway_graphql_mutation')?.enabled).toBe(false);
    expect(byName.get('railway_graphql_subscription')?.enabled).toBe(false);
    expect(byName.get('railway_graphql_query')?.enabled).not.toBe(false);
    expect(byName.get('railway_graphql_schema')?.enabled).not.toBe(false);
  });

  it('only points the model at tools that exist, documents setup, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const builtins = ['railway_graphql_query', 'railway_graphql_mutation', 'railway_graphql_subscription', 'railway_graphql_schema'];
    const mentioned = [
      ...a.instructions.matchAll(/\brailway_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\brailway_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect([...names, ...builtins]).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    // The generated mutation tool can change anything: the instructions say so.
    expect(a.instructions).toMatch(/railway_graphql_mutation` can change and delete/);
    expect(a.instructions).toMatch(/installed switched off/);
    expect(a.instructions).toContain('Account Settings, Tokens');
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

  const table: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['railway_get_me', {}, {}],
    ['railway_list_projects', { workspace_id: 'w1' }, { first: 20, workspaceId: 'w1' }],
    ['railway_get_project', { project_id: 'p1' }, { id: 'p1' }],
    ['railway_get_service_instance', { service_id: 's1', environment_id: 'e1' }, { serviceId: 's1', environmentId: 'e1' }],
    ['railway_list_deployments', { service_id: 's1', environment_id: 'e1' }, { first: 20, environmentId: 'e1', serviceId: 's1' }],
    ['railway_get_deployment', { deployment_id: 'd1' }, { id: 'd1' }],
    ['railway_get_deployment_logs', { deployment_id: 'd1', filter: '@level:error' }, { deploymentId: 'd1', limit: 200, filter: '@level:error' }],
    ['railway_get_build_logs', { deployment_id: 'd1' }, { deploymentId: 'd1', limit: 200 }],
    ['railway_redeploy_deployment', { deployment_id: 'd1', use_previous_image_tag: true }, { id: 'd1', usePreviousImageTag: true }],
    ['railway_restart_deployment', { deployment_id: 'd1' }, { id: 'd1' }],
    ['railway_list_variable_names', { project_id: 'p1', environment_id: 'e1', service_id: 's1' }, { projectId: 'p1', environmentId: 'e1', serviceId: 's1' }],
    ['railway_get_variable_values', { project_id: 'p1', environment_id: 'e1' }, { projectId: 'p1', environmentId: 'e1', unrendered: true }],
    [
      'railway_get_estimated_usage',
      { project_id: 'p1' },
      { measurements: ['CPU_USAGE', 'MEMORY_USAGE_GB', 'NETWORK_TX_GB', 'DISK_USAGE_GB'], projectId: 'p1' },
    ],
    [
      'railway_get_usage',
      { workspace_id: 'w1', group_by: ['SERVICE_ID'], start_date: '2026-10-01T00:00:00Z' },
      { measurements: ['CPU_USAGE', 'MEMORY_USAGE_GB', 'NETWORK_TX_GB', 'DISK_USAGE_GB'], workspaceId: 'w1', startDate: '2026-10-01T00:00:00Z', groupBy: ['SERVICE_ID'] },
    ],
  ];

  it('lists every tool in the request table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s posts its operation with the Bearer token and the right variables', async (name, params, variables) => {
    mockedPost.mockResolvedValue({ data: { data: {} } });
    await call(name, params);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe(URL);
    expect(body.query).toBe(tool(name).endpointMapping.path);
    // undefined variables are dropped when the body is serialized.
    expect(JSON.parse(JSON.stringify(body.variables))).toEqual(variables);
    expect(opts.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(body)).not.toContain('{{');
  });

  it('reports a GraphQL error such as Not Authorized as a failed call', async () => {
    mockedPost.mockResolvedValue({ data: { errors: [{ message: 'Not Authorized' }], data: null } });
    await expect(call('railway_list_projects', {})).rejects.toThrow(/Not Authorized/);
  });

  it('flattens projects, deployments and the project tree', () => {
    const projects = shape('railway_list_projects', {
      projects: { pageInfo: { hasNextPage: false, endCursor: 'c1' }, edges: [{ node: { id: 'p1', name: 'shop', workspace: { id: 'w1', name: 'Acme' } } }] },
    });
    expect(projects).toEqual({ projects: [{ id: 'p1', name: 'shop', workspace: { id: 'w1', name: 'Acme' } }], pageInfo: { hasNextPage: false, endCursor: 'c1' } });
    const deployments = shape('railway_list_deployments', {
      deployments: { pageInfo: { hasNextPage: false }, edges: [{ node: { id: 'd1', status: 'FAILED', meta: { commitMessage: 'fix', commitHash: 'abc', branch: 'main', serviceManifest: { big: true } } } }] },
    });
    expect(deployments.deployments[0]).toEqual({ id: 'd1', status: 'FAILED', commitMessage: 'fix', commitHash: 'abc', branch: 'main' });
    const project = shape('railway_get_project', {
      project: {
        id: 'p1',
        name: 'shop',
        environments: { edges: [{ node: { id: 'e1', name: 'production', isEphemeral: false } }] },
        services: {
          edges: [
            {
              node: {
                id: 's1',
                name: 'api',
                serviceInstances: {
                  edges: [{ node: { environmentId: 'e1', region: 'europe-west4', numReplicas: 1, domains: { serviceDomains: [{ domain: 'api.up.railway.app' }], customDomains: [] }, latestDeployment: { id: 'd1', status: 'SUCCESS' } } }],
                },
              },
            },
          ],
        },
      },
    });
    expect(project.environments).toEqual([{ id: 'e1', name: 'production', isEphemeral: false }]);
    expect(project.services[0].instances[0]).toMatchObject({ environmentId: 'e1', domains: [{ domain: 'api.up.railway.app' }], latestDeployment: { id: 'd1', status: 'SUCCESS' } });
  });
});

const live = process.env.RUN_RAILWAY_LIVE === '1' ? describe : describe.skip;
live('railway adapter: live', () => {
  const real = !!process.env.RAILWAY_API_TOKEN;
  const env = () => ({ RAILWAY_API_TOKEN: process.env.RAILWAY_API_TOKEN! });
  beforeAll(() => mockedPost.mockImplementation((url: string, data: unknown, opts: any) => actualAxios.post(url, data, opts)));
  afterAll(() => mockedPost.mockReset());

  it('every operation is valid against the public schema', async () => {
    const res = await actualAxios.post(URL, { query: getIntrospectionQuery() }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    const schema = buildClientSchema(res.data.data);
    for (const t of a.tools) {
      const errors = validate(schema, parse(t.endpointMapping.path)).map((e) => e.message);
      expect(`${t.name}:${errors.join('; ')}`).toBe(`${t.name}:`);
    }
  }, 60000);

  it('answers a wrong token with Not Authorized', async () => {
    await expect(call('railway_list_projects', {})).rejects.toThrow(/Not Authorized/);
  }, 30000);

  (real ? it : it.skip)('reads projects, a project, deployments, logs, variable names and usage', async () => {
    const projects = await shaped('railway_list_projects', { first: 5 }, env());
    expect(Array.isArray(projects.projects)).toBe(true);
    const first = projects.projects[0];
    if (!first) return;
    const project = await shaped('railway_get_project', { project_id: first.id }, env());
    expect(project.id).toBe(first.id);
    const environment = project.environments[0];
    const service = project.services[0];
    const deployments = await shaped('railway_list_deployments', { project_id: first.id, first: 5 }, env());
    expect(Array.isArray(deployments.deployments)).toBe(true);
    const deployment = deployments.deployments[0];
    if (deployment) {
      expect((await shaped('railway_get_deployment', { deployment_id: deployment.id }, env())).deployment.id).toBe(deployment.id);
      expect(Array.isArray((await shaped('railway_get_build_logs', { deployment_id: deployment.id, limit: 20 }, env())).logs)).toBe(true);
      expect(Array.isArray((await shaped('railway_get_deployment_logs', { deployment_id: deployment.id, limit: 20 }, env())).logs)).toBe(true);
    }
    if (environment && service) {
      const names = await shaped('railway_list_variable_names', { project_id: first.id, environment_id: environment.id, service_id: service.id }, env());
      expect(Array.isArray(names.names)).toBe(true);
      expect(typeof (await shaped('railway_get_service_instance', { service_id: service.id, environment_id: environment.id }, env())).serviceInstance).toBe('object');
    }
    const usage = await shaped('railway_get_estimated_usage', { project_id: first.id }, env());
    expect(Array.isArray(usage.estimates)).toBe(true);
  }, 120000);

  const writes = real && process.env.RUN_RAILWAY_LIVE_WRITES === '1' && !!process.env.RAILWAY_TEST_DEPLOYMENT_ID;
  (writes ? it : it.skip)('restarts the test deployment', async () => {
    const out = await shaped('railway_restart_deployment', { deployment_id: process.env.RAILWAY_TEST_DEPLOYMENT_ID }, env());
    expect(out.restarted).toBe(true);
  }, 60000);
});
