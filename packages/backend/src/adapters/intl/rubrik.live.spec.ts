import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { Kind, OperationDefinitionNode, parse } from 'graphql';
import * as adapter from './rubrik.json';
import * as ssrf from '../../common/ssrf.util';
import { GraphqlEngine } from '../../connectors/engines/graphql.engine';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { GraphqlSchemaService } from '../../connectors/engines/graphql-schema.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Rubrik Security Cloud adapter (GraphQL, read-only).
 *
 * Static checks always run. They pin the service account sign-in documented at
 * https://developer.rubrik.com/Rubrik-Security-Cloud-API/authentication/
 * (form-encoded POST https://<account>.my.rubrik.com/api/client_token with
 * client_id, client_secret and grant_type=client_credentials, answered with
 * access_token and expires_in, sent as Authorization: Bearer) through the real
 * LoginTokenService, and send every curated query through the real
 * GraphqlEngine (axios mocked). Every operation parses, is a query, and its
 * variables match the tool's queryParams one to one. All operations were
 * validated against the public RSC schema published in
 * rubrikinc/rubrik-powershell-sdk (docs/graphql/schema-public.graphql,
 * v20261026-45) on 5 Nov 2026.
 *
 * Live checks run only with RUN_RUBRIK_LIVE=1. Without credentials they check
 * that the published schema still declares every root field used here; with
 * RUBRIK_ACCOUNT, RUBRIK_CLIENT_ID and RUBRIK_CLIENT_SECRET they sign in and
 * run the account, cluster, SLA Domain and protected object queries:
 *
 *   RUN_RUBRIK_LIVE=1 RUBRIK_ACCOUNT=acme RUBRIK_CLIENT_ID='client|...' RUBRIK_CLIENT_SECRET=... \
 *     npx jest src/adapters/intl/rubrik.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  const post = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { post, __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { post: jest.Mock; __actual: typeof axios };
const mockedPost = mockedAxios.post;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    schemaUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers: Record<string, string>;
    config: { graphqlBuiltinsOff?: string[] };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const operation = (entry: Tool) =>
  parse(entry.endpointMapping.path).definitions.find(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  )!;
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({
    name: entry.name,
    connectorType: 'GRAPHQL',
    endpointMapping: entry.endpointMapping,
    annotations: entry.annotations,
  });

const URL = 'https://acme.my.rubrik.com/api/graphql';
// Built at runtime so no literal looks like a real credential.
const CLIENT_ID = `client|${['c9bba9a9', '0000', '4000', '8000', '000000000000'].join('-')}`;
const CLIENT_SECRET = 'x'.repeat(24);
const FAKE_TOKEN = 'rsc-access-token';
const ENV: Record<string, string> = {
  RUBRIK_ACCOUNT: 'acme',
  RUBRIK_CLIENT_ID: CLIENT_ID,
  RUBRIK_CLIENT_SECRET: CLIENT_SECRET,
};
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
const fakeBundle = async () => ({ token: FAKE_TOKEN, expiresAt: Date.now() + 43_200_000 });
const stubLogin = { getToken: fakeBundle, forceRelogin: fakeBundle } as unknown as LoginTokenService;

// Mirrors DynamicMcpTools for a GraphQL connector.
const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new GraphqlEngine({} as OAuth2TokenService, stubLogin, {} as GraphqlSchemaService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    },
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  ) as Promise<unknown>;
};

describe('rubrik adapter: static contract', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedPost.mockReset();
    jest.spyOn(ssrf, 'assertSafeOutboundUrl').mockResolvedValue(undefined);
  });

  it('posts to the account GraphQL endpoint and points the schema helpers at the published SDL', () => {
    expect(a.slug).toBe('rubrik');
    expect(a.category).toBe('infrastructure');
    expect(a.icon).toBe('rubrik');
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe('https://{{RUBRIK_ACCOUNT}}.my.rubrik.com/api/graphql');
    expect(a.connector.schemaUrl).toBe(
      'https://raw.githubusercontent.com/rubrikinc/rubrik-powershell-sdk/main/docs/graphql/schema-public.graphql',
    );
    expect(a.connector.config.graphqlBuiltinsOff).toEqual(['mutation', 'subscription']);
    expect(a.requiredEnvVars).toEqual(['RUBRIK_ACCOUNT', 'RUBRIK_CLIENT_ID', 'RUBRIK_CLIENT_SECRET']);
  });

  it('signs in with the service account client credentials, form-encoded', () => {
    const auth = a.connector.authConfig;
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(auth.loginUrl).toBe('https://{{RUBRIK_ACCOUNT}}.my.rubrik.com/api/client_token');
    expect(auth.loginMethod).toBe('POST');
    expect((auth.loginHeaders as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(auth.loginBody).toEqual({ grant_type: 'client_credentials', client_id: '${username}', client_secret: '${password}' });
    expect(auth.username).toBe('{{RUBRIK_CLIENT_ID}}');
    expect(auth.password).toBe('{{RUBRIK_CLIENT_SECRET}}');
    expect(auth.tokenJsonPath).toBe('access_token');
    expect(auth.expiryJsonPath).toBe('expires_in');
    expect(auth.expiryFormat).toBe('ttl_seconds');
    expect(auth.refreshOn401).toBe(true);
    expect(auth.headerName).toBe('Authorization');
    expect(auth.headerTemplate).toBe('Bearer ${token}');
  });

  it('describes the variables: account is an address, client id and secret are credentials', () => {
    const described = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(described.RUBRIK_ACCOUNT.secret).toBeFalsy();
    expect(described.RUBRIK_CLIENT_ID).toMatchObject({ kind: 'credential', required: true });
    expect(described.RUBRIK_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true, required: true });
    const account = new RegExp(a.envVarMeta.RUBRIK_ACCOUNT.pattern!);
    expect(account.test('acme')).toBe(true);
    for (const bad of ['', 'https://acme.my.rubrik.com', 'acme.my.rubrik.com', 'Acme']) expect(account.test(bad)).toBe(false);
    const clientId = new RegExp(a.envVarMeta.RUBRIK_CLIENT_ID.pattern!);
    expect(clientId.test(CLIENT_ID)).toBe(true);
    for (const bad of ['', 'c9bba9a9-0000', 'client| x']) expect(clientId.test(bad)).toBe(false);
    for (const key of ['401', '403']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('reads access_token and expires_in from the token endpoint', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as never;
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: { client_id: CLIENT_ID, access_token: FAKE_TOKEN, expires_in: 43200 },
      headers: {},
    });
    const bundle = await new LoginTokenService({} as never, config).getToken(auth);
    const login = mockedAxios.mock.calls.at(-1)![0];
    expect(login.method).toBe('POST');
    expect(login.url).toBe('https://acme.my.rubrik.com/api/client_token');
    expect(login.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(login.data).toEqual({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    expect(bundle.token).toBe(FAKE_TOKEN);
    expect(bundle.expiresAt - Date.now()).toBeGreaterThan(43_000_000);
    expect(bundle.expiresAt - Date.now()).toBeLessThanOrEqual(43_200_000);
  });

  it('probes with the account query, which takes no argument', () => {
    expect(a.probe.tool).toBe('rubrik_get_account');
    expect(operation(tool('rubrik_get_account')).variableDefinitions ?? []).toHaveLength(0);
  });

  it('prefixes every tool with rubrik_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^rubrik_[a-z_]+$/);
    for (const name of mine) expect(name).not.toMatch(/^rubrik_graphql_/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
  });

  it('every operation parses as a query and maps each variable to a declared parameter', () => {
    for (const entry of a.tools) {
      const op = operation(entry);
      expect(`${entry.name}:${op.operation}`).toBe(`${entry.name}:query`);
      expect(entry.endpointMapping.method).toBe('query');
      const declared = (op.variableDefinitions ?? []).map((d) => d.variable.name.value).sort();
      expect(`${entry.name}:${Object.keys(entry.endpointMapping.queryParams ?? {}).sort()}`).toBe(`${entry.name}:${declared}`);
      for (const value of Object.values(entry.endpointMapping.queryParams ?? {})) {
        expect(Object.keys(entry.parameters.properties ?? {})).toContain(value.slice(1));
      }
      for (const required of entry.parameters.required ?? []) expect(entry.parameters.properties).toHaveProperty(required);
      for (const def of op.variableDefinitions ?? []) {
        if (def.type.kind === Kind.NON_NULL_TYPE) {
          const param = entry.endpointMapping.queryParams![def.variable.name.value].slice(1);
          const isRequired = (entry.parameters.required ?? []).includes(param);
          const hasDefault = entry.parameters.properties?.[param]?.default !== undefined;
          expect(`${entry.name}.${param}:${isRequired || hasDefault}`).toBe(`${entry.name}.${param}:true`);
        }
      }
      expect(annotationsOf(entry).readOnlyHint).toBe(true);
      expect(entry.enabled).not.toBe(false);
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(entry.parameters.properties ?? {})) {
        expect(`${entry.name}.${p}:${typeof schema.description}`).toBe(`${entry.name}.${p}:string`);
      }
    }
  });

  it('names every tool in the instructions, warns about the mutation helper and writes no em dash', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(`\`${entry.name}\``);
    expect(a.instructions).toMatch(/`rubrik_graphql_mutation` and `rubrik_graphql_subscription` are installed switched off/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['rubrik_get_account', {}, {}],
    ['rubrik_list_clusters', { connection_state: ['Disconnected'] }, { first: 25, connectionState: ['Disconnected'] }],
    ['rubrik_get_cluster', { cluster_id: 'c-1' }, { clusterUuid: 'c-1' }],
    ['rubrik_list_sla_domains', { filter: [{ field: 'NAME', text: 'Gold' }] }, { first: 25, filter: [{ field: 'NAME', text: 'Gold' }] }],
    ['rubrik_get_sla_domain', { sla_domain_id: 's-1' }, { id: 's-1' }],
    [
      'rubrik_list_protected_objects',
      { compliance_status: ['OUT_OF_COMPLIANCE'], object_types: ['VmwareVirtualMachine'] },
      { first: 25, complianceStatus: ['OUT_OF_COMPLIANCE'], objectType: ['VmwareVirtualMachine'], sortBy: 'Name', sortOrder: 'ASC' },
    ],
    ['rubrik_get_compliance_summary', {}, { groupBy: 'ComplianceStatus', first: 50 }],
    [
      'rubrik_list_snapshots',
      { workload_id: 'w-1', time_range: { start: '2026-10-01T00:00:00Z', end: '2026-10-31T23:59:59Z' } },
      { workloadId: 'w-1', first: 25, sortOrder: 'DESC', timeRange: { start: '2026-10-01T00:00:00Z', end: '2026-10-31T23:59:59Z' } },
    ],
    [
      'rubrik_list_events',
      { last_activity_status: ['FAILURE'], last_activity_type: ['BACKUP'], last_updated_after: '2026-11-04T00:00:00Z' },
      { first: 25, sortOrder: 'DESC', lastActivityStatus: ['FAILURE'], lastActivityType: ['BACKUP'], lastUpdatedTimeGt: '2026-11-04T00:00:00Z' },
    ],
    ['rubrik_get_event_series', { activity_series_id: 'a-1', cluster_uuid: 'c-1' }, { activitySeriesId: 'a-1', clusterUuid: 'c-1', first: 50 }],
    ['rubrik_list_task_details', { time_after: '2026-11-01T00:00:00Z' }, { first: 25, sortOrder: 'DESC', timeGt: '2026-11-01T00:00:00Z' }],
    ['rubrik_list_anomalies', { is_anomaly: true }, { first: 25, sortOrder: 'DESC', isAnomaly: true }],
    ['rubrik_list_threat_hunts', { status: ['SUCCEEDED'] }, { first: 25, statusFilter: ['SUCCEEDED'] }],
    ['rubrik_get_threat_hunt_summary', { hunt_id: 'h-1' }, { huntId: 'h-1' }],
  ];

  it('lists every tool in the request table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((entry) => entry.name).sort());
  });

  it.each(table)('%s posts its query with the Bearer token and the right variables', async (name, params, variables) => {
    mockedPost.mockResolvedValue({ status: 200, data: { data: {} } });
    await call(name, params);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe(URL);
    expect(body.query).toBe(tool(name).endpointMapping.path);
    // undefined variables are dropped when the body is serialized.
    expect(JSON.parse(JSON.stringify(body.variables ?? {}))).toEqual(variables);
    expect(opts.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(body)).not.toContain('{{');
  });

  it('reports a GraphQL error as a failed call', async () => {
    mockedPost.mockResolvedValue({ status: 200, data: { errors: [{ message: 'Not authorized to perform this action' }], data: null } });
    await expect(call('rubrik_list_clusters', {})).rejects.toThrow(/Not authorized/);
  });
});

// Opt-in: RUN_RUBRIK_LIVE=1. Reads only.
const live = process.env.RUN_RUBRIK_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Rubrik Security Cloud: live', () => {
  it('the published schema still declares every root field the tools query', async () => {
    const response = await liveFetch.get(a.connector.schemaUrl, { responseType: 'text', validateStatus: () => true });
    expect(response.status).toBe(200);
    const sdl = String(response.data);
    const query = sdl.slice(sdl.indexOf('type Query {'));
    for (const entry of a.tools) {
      const op = operation(entry);
      for (const sel of op.selectionSet.selections) {
        if (sel.kind === Kind.FIELD) expect(query).toMatch(new RegExp(`\\n\\s+${sel.name.value}[(:]`));
      }
    }
  }, 60000);

  it('signs in and reads the account, clusters, SLA Domains and protected objects', async () => {
    const env = process.env;
    const missing = ['RUBRIK_ACCOUNT', 'RUBRIK_CLIENT_ID', 'RUBRIK_CLIENT_SECRET'].filter((name) => !env[name]);
    if (missing.length) throw new Error(`Set ${missing.join(', ')} for the authenticated live check`);
    const host = `https://${env.RUBRIK_ACCOUNT}.my.rubrik.com`;
    const login = await liveFetch.post(
      `${host}/api/client_token`,
      new URLSearchParams({ grant_type: 'client_credentials', client_id: env.RUBRIK_CLIENT_ID!, client_secret: env.RUBRIK_CLIENT_SECRET! }),
      { headers: { Accept: 'application/json' }, validateStatus: () => true },
    );
    expect(login.status).toBe(200);
    const token = (login.data as { access_token?: string }).access_token;
    expect(token).toBeTruthy();
    const run = async (name: string, variables: Record<string, unknown>) => {
      const res = await liveFetch.post(
        `${host}/api/graphql`,
        { query: tool(name).endpointMapping.path, variables },
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, validateStatus: () => true },
      );
      expect(res.status).toBe(200);
      expect(res.data.errors).toBeUndefined();
      return res.data.data;
    };
    expect(typeof (await run('rubrik_get_account', {})).accountId).toBe('string');
    expect(Array.isArray((await run('rubrik_list_clusters', { first: 2 })).clusterConnection.nodes)).toBe(true);
    expect(Array.isArray((await run('rubrik_list_sla_domains', { first: 2 })).slaDomains.nodes)).toBe(true);
    const objects = await run('rubrik_list_protected_objects', { first: 2, sortBy: 'Name', sortOrder: 'ASC' });
    expect(typeof objects.snappableConnection.count).toBe('number');
  }, 60000);
});
