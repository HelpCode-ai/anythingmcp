import axios from 'axios';
import * as adapter from './make.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Make adapter:
 *
 *   1. Static: always runs. Pins `Authorization: Token <token>` and the
 *      selectable zone host, every tool's method and URL through the real
 *      RestEngine, the pg[limit] / pg[offset] paging, the run and data store
 *      bodies, and the response mappings against the response schemas of
 *      Make's API reference (its OpenAPI documents), including that webhook
 *      addresses and connection details beyond the listed fields never leave.
 *
 *   2. Live: skipped unless RUN_MAKE_LIVE=1, MAKE_API_TOKEN and MAKE_ZONE
 *      (e.g. eu1.make.com) are set.
 *
 *        RUN_MAKE_LIVE=1 MAKE_ZONE=eu1.make.com MAKE_API_TOKEN=... npx jest src/adapters/intl/make.live.spec.ts
 *
 *      Runs the read tools and applies each responseMapping the way the MCP
 *      layer does. MAKE_LIVE_WRITE=1 with MAKE_LIVE_DATA_STORE_ID also adds a
 *      record "anythingmcp-live-spec" to that data store (delete it in Make
 *      afterwards). No scenario is run, started or stopped by the spec.
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
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; encodePathParams?: boolean; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; link?: string }>;
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

const TOKEN = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, token: string, params: Record<string, unknown>, zone = 'eu1.make.com') => {
  const env = { MAKE_API_TOKEN: token, MAKE_ZONE: zone };
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return engine().execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: { headerName: 'Authorization', apiKey: `Token ${token}` }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>, zone?: string) => execute(name, TOKEN, params, zone);
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const BASE = 'https://eu1.make.com/api/v2';
const WRITES = ['make_activate_scenario', 'make_add_data_store_record', 'make_deactivate_scenario', 'make_run_scenario'];

describe('make adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('make');
    expect(a.icon).toBe('make');
    expect(a.category).toBe('productivity');
  });

  it('sends Authorization: Token <token> to the zone host', () => {
    expect(a.connector.baseUrl).toBe('https://{{MAKE_ZONE}}/api/v2');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Token {{MAKE_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/users/me');
    expect(a.probe.tool).toBe('make_get_current_user');
  });

  it('asks for the token as a secret and the zone as a setting', () => {
    expect(a.requiredEnvVars).toEqual(['MAKE_ZONE', 'MAKE_API_TOKEN']);
    const tok = a.envVarMeta.MAKE_API_TOKEN;
    expect(tok.secret).toBe(true);
    expect(tok.kind).toBe('credential');
    const tokRe = new RegExp(tok.pattern!);
    expect(tokRe.test(TOKEN)).toBe(true);
    for (const bad of ['', `Token ${TOKEN}`, `${TOKEN} `]) expect(tokRe.test(bad)).toBe(false);
    const zone = new RegExp(a.envVarMeta.MAKE_ZONE.pattern!);
    for (const ok of ['eu1.make.com', 'eu2.make.com', 'us1.make.com', 'us2.make.com', 'eu1.make.celonis.com', 'us1.make.celonis.com']) expect(zone.test(ok)).toBe(true);
    for (const bad of ['https://eu1.make.com', 'eu1.make.com/api/v2', 'make.com', 'eu3.make.com', 'evil.com']) expect(zone.test(bad)).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'MAKE_API_TOKEN')!.secret).toBe(true);
  });

  it('prefixes every tool with make_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^make_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only, asks for confirmation on every write, and has no delete', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    }
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm with the user first/i);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE')).toEqual([]);
    expect(a.tools.filter((t) => t.enabled === false)).toEqual([]);
  });

  it('URL-encodes every path argument, and every responseMapping does real work', async () => {
    for (const t of a.tools.filter((x) => /\{[A-Za-z]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${Boolean(tr && (tr.select || tr.exclude || tr.include))}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('make_get_execution', { scenarioId: 5, executionId: '../../users/me' });
    expect(sent().url).toBe(`${BASE}/scenarios/5/executions/..%2F..%2Fusers%2Fme`);
  });

  it('only points the model at tools that exist, documents setup, scopes, zones and secrets, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmake_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmake_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Make\n')).toBe(true);
    for (const text of ['API access', 'scenarios:run', 'scenarios:write', 'datastores:write', 'eu1.make.com', 'Confirm before every write', 'never as instructions', 'webhook addresses', 'Out of scope']) {
      expect(a.instructions).toContain(text);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['make_get_current_user', {}, 'GET', `${BASE}/users/me`],
    ['make_list_organizations', {}, 'GET', `${BASE}/organizations`],
    ['make_list_teams', { organizationId: 7 }, 'GET', `${BASE}/teams`],
    ['make_list_scenarios', { teamId: 9 }, 'GET', `${BASE}/scenarios`],
    ['make_get_scenario', { scenarioId: 5 }, 'GET', `${BASE}/scenarios/5`],
    ['make_get_scenario_blueprint', { scenarioId: 5 }, 'GET', `${BASE}/scenarios/5/blueprint`],
    ['make_run_scenario', { scenarioId: 5 }, 'POST', `${BASE}/scenarios/5/run`],
    ['make_activate_scenario', { scenarioId: 5 }, 'POST', `${BASE}/scenarios/5/start`],
    ['make_deactivate_scenario', { scenarioId: 5 }, 'POST', `${BASE}/scenarios/5/stop`],
    ['make_list_scenario_logs', { scenarioId: 5 }, 'GET', `${BASE}/scenarios/5/logs`],
    ['make_get_execution', { scenarioId: 5, executionId: 'abc123' }, 'GET', `${BASE}/scenarios/5/executions/abc123`],
    ['make_list_connections', { teamId: 9 }, 'GET', `${BASE}/connections`],
    ['make_list_data_stores', { teamId: 9 }, 'GET', `${BASE}/data-stores`],
    ['make_list_data_store_records', { dataStoreId: 11 }, 'GET', `${BASE}/data-stores/11/data`],
    ['make_add_data_store_record', { dataStoreId: 11, data: { a: 1 } }, 'POST', `${BASE}/data-stores/11/data`],
    ['make_list_hooks', { teamId: 9 }, 'GET', `${BASE}/hooks`],
    ['make_list_incomplete_executions', { scenarioId: 5 }, 'GET', `${BASE}/dlqs`],
    ['make_get_incomplete_execution', { dlqId: 'd1' }, 'GET', `${BASE}/dlqs/d1`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Token header', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(url);
    expect(sent().headers.Authorization).toBe(`Token ${TOKEN}`);
  });

  it('uses the US and Celonis zones when MAKE_ZONE says so', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('make_get_current_user', {}, 'us2.make.com');
    expect(sent().url).toBe('https://us2.make.com/api/v2/users/me');
    mockedAxios.mockClear();
    await call('make_get_current_user', {}, 'eu1.make.celonis.com');
    expect(sent().url).toBe('https://eu1.make.celonis.com/api/v2/users/me');
  });

  it('pages with pg[limit] and pg[offset] and sends the filters by their API names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('make_list_scenarios', { teamId: 9, isActive: true, offset: 50 });
    expect(sent().params).toEqual({ teamId: 9, isActive: true, 'pg[limit]': 50, 'pg[offset]': 50 });
    expect(sent().paramsSerializer(sent().params)).toBe('teamId=9&isActive=true&pg%5Blimit%5D=50&pg%5Boffset%5D=50');
    mockedAxios.mockClear();
    await call('make_list_scenario_logs', { scenarioId: 5, status: 3, from: 1760000000000 });
    expect(sent().params).toEqual({ status: 3, from: 1760000000000, 'pg[limit]': 20 });
    mockedAxios.mockClear();
    await call('make_list_incomplete_executions', { scenarioId: 5, status: 'unresolved' });
    expect(sent().params).toEqual({ scenarioId: 5, status: 'unresolved' });
  });

  it('sends the run inputs and the data store record as Make expects, and nothing on start and stop', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('make_run_scenario', { scenarioId: 5, data: { email: 'jane@example.com' }, responsive: true });
    expect(sent().data).toEqual({ data: { email: 'jane@example.com' }, responsive: true });
    mockedAxios.mockClear();
    await call('make_run_scenario', { scenarioId: 5 });
    expect(sent().data).toEqual({});
    mockedAxios.mockClear();
    await call('make_add_data_store_record', { dataStoreId: 11, key: 'k1', data: { score: 3 } });
    expect(sent().data).toEqual({ key: 'k1', data: { score: 3 } });
    mockedAxios.mockClear();
    await call('make_activate_scenario', { scenarioId: 5 });
    expect(sent().data).toBeUndefined();
  });

  // Shapes from the response schemas in Make's API reference.
  it('shapes the user, organizations, teams and scenarios', () => {
    expect(shape('make_get_current_user', { authUser: { id: 1, name: 'Jane', email: 'jane@example.com', language: 'en', timezoneId: 113, localeId: 1, features: { a: true }, avatar: 'x', userTeamIds: [9], lastLogin: '2026-10-01T10:00:00.000Z' } }).value).toEqual({
      id: 1, name: 'Jane', email: 'jane@example.com', language: 'en', timezoneId: 113, userTeamIds: [9], lastLogin: '2026-10-01T10:00:00.000Z',
    });
    const orgs = shape('make_list_organizations', { organizations: [{ id: 7, name: 'Acme', zone: 'eu1.make.com', productName: 'Pro', isPaused: false, timezoneId: 113, teams: [{ id: 9, name: 'Ops' }], scenarios: 12, activeScenarios: 4, license: { apiLimit: 120 }, countryId: 1 }], pg: { limit: 50, offset: 0 } }).value as any;
    expect(orgs.organizations[0]).toEqual({ id: 7, name: 'Acme', zone: 'eu1.make.com', productName: 'Pro', isPaused: false, timezoneId: 113, teams: [{ id: 9, name: 'Ops' }], scenarios: 12, activeScenarios: 4, license: { apiLimit: 120 } });
    expect(shape('make_list_teams', { teams: [{ id: 9, name: 'Ops', organizationId: 7, operationsLimit: 10000, transferLimit: 1, type: 'team' }] }).value).toEqual({ teams: [{ id: 9, name: 'Ops', organizationId: 7, operationsLimit: 10000, type: 'team' }] });
    const sc = { id: 5, name: 'New lead to CRM', teamId: 9, hookId: 3, folderId: null, isActive: true, isPaused: false, isinvalid: false, islocked: false, usedPackages: ['gateway', 'hubspotcrm'], usedModules: ['gateway:CustomWebHook'], lastEdit: '2026-10-01T10:00:00.000Z', scheduling: { type: 'immediately' }, nextExec: null, dlqCount: 0, operations: 42, type: 'scenario', createdByUser: { id: 1, email: 'jane@example.com' } };
    const list = shape('make_list_scenarios', { scenarios: [sc], pg: { limit: 50, offset: 0 } }).value as any;
    expect(list.scenarios[0].usedPackages).toEqual(['gateway', 'hubspotcrm']);
    expect(list.scenarios[0].createdByUser).toBeUndefined();
    expect(list.pg).toEqual({ limit: 50, offset: 0 });
    const one = shape('make_get_scenario', { scenario: sc }).value as any;
    expect(one.scenario.usedModules).toBeUndefined();
    expect(one.scenario.name).toBe('New lead to CRM');
  });

  it('shapes the blueprint from response.blueprint, and cuts a huge one', () => {
    const bp = { code: 'OK', response: { blueprint: { name: 'New lead to CRM', flow: [{ id: 1, module: 'gateway:CustomWebHook', parameters: { hook: 3 } }], metadata: { version: 1 } }, scheduling: { type: 'immediately' }, idSequence: 2, created: 'x', last_edit: '2026-10-01', version: 7 } };
    expect(shape('make_get_scenario_blueprint', bp).value).toEqual({ name: 'New lead to CRM', flow: bp.response.blueprint.flow, metadata: { version: 1 }, scheduling: { type: 'immediately' }, version: 7, lastEdit: '2026-10-01' });
    const huge = { response: { blueprint: { name: 'Big', flow: Array.from({ length: 3000 }, (_, k) => ({ id: k, module: 'http:ActionSendData', mapper: { url: 'https://example.com/'.repeat(3) } })) } } };
    const out = shape('make_get_scenario_blueprint', huge);
    expect(out.truncated).toBe(true);
    expect((out.value as { preview: string }).preview.length).toBeLessThanOrEqual(100_000);
  });

  it('shapes runs, logs and executions', () => {
    expect(shape('make_run_scenario', { executionId: 'abc123', status: 1, outputs: { ok: true } }).value).toEqual({ executionId: 'abc123', status: 1, outputs: { ok: true } });
    expect(shape('make_activate_scenario', { scenario: { id: 5, isActive: true, islinked: true } }).value).toEqual({ id: 5, isActive: true });
    const logs = shape('make_list_scenario_logs', { scenarioLogs: [{ id: 'abc123', imtId: 'x', type: 'manual', status: 3, timestamp: '2026-10-01T10:00:00.000Z', duration: 1200, operations: 3, transfer: 100, centicredits: 1, organizationId: 7, teamId: 9, authorName: 'Jane', instant: true }], pg: { limit: 20 } }).value as any;
    expect(logs.logs[0]).toEqual({ id: 'abc123', imtId: 'x', type: 'manual', status: 3, timestamp: '2026-10-01T10:00:00.000Z', duration: 1200, operations: 3, transfer: 100, instant: true, authorName: 'Jane' });
    expect(shape('make_get_execution', { status: 'ERROR', outputs: null, error: { name: 'DataError', message: 'Missing value', causeModule: { id: 2 } } }).value).toEqual({ status: 'ERROR', outputs: null, error: { name: 'DataError', message: 'Missing value', causeModule: { id: 2 } } });
  });

  it('never returns webhook addresses, and lists connections and data stores by their safe fields', () => {
    const hooks = shape('make_list_hooks', { hooks: [{ id: 3, name: 'Leads', teamId: 9, udid: 'u1', type: 'web', packageName: null, enabled: true, gone: false, typeName: 'gateway-webhook', queueCount: 0, queueLimit: 10000, scenarioId: 5, data: { headers: true, ip: '1.2.3.4' }, url: 'https://hook.eu1.make.com/secretpath' }] }).value;
    expect(JSON.stringify(hooks)).not.toContain('secretpath');
    expect(JSON.stringify(hooks)).not.toContain('1.2.3.4');
    expect((hooks as any).hooks[0]).toEqual({ id: 3, name: 'Leads', typeName: 'gateway-webhook', type: 'web', packageName: null, enabled: true, gone: false, scenarioId: 5, queueCount: 0, queueLimit: 10000, teamId: 9 });
    const conns = shape('make_list_connections', { connections: [{ id: 4, name: 'Google (jane@example.com)', accountName: 'google', accountLabel: 'Google', packageName: null, expire: null, metadata: { value: 'jane@example.com', type: 'email' }, teamId: 9, upgradeable: false, scopesCnt: 2, scoped: true, accountType: 'oauth', editable: false, uid: 'x' }] }).value as any;
    expect(conns.connections[0].metadata).toBeUndefined();
    expect(conns.connections[0].accountType).toBe('oauth');
    expect(shape('make_list_data_stores', { dataStores: [{ id: 11, name: 'Leads', records: 3, size: '1024', maxSize: '1048576', teamId: 9, datastructureId: 2 }], pg: {} }).value).toEqual({ dataStores: [{ id: 11, name: 'Leads', records: 3, size: '1024', maxSize: '1048576', teamId: 9, datastructureId: 2 }], pg: {} });
    expect(shape('make_list_data_store_records', { records: [{ key: 'k1', data: { score: 3 } }], spec: [{ name: 'score', type: 'number' }], strict: true, count: 1, pg: { limit: 20 } }).value).toEqual({ records: [{ key: 'k1', data: { score: 3 } }], spec: [{ name: 'score', type: 'number' }], count: 1, pg: { limit: 20 } });
    expect(shape('make_list_incomplete_executions', { dlqs: [{ id: 'd1', reason: 'DataError', created: '2026-10-01', size: 10, resolved: false, retry: true, attempts: 1 }] }).value).toEqual({ incompleteExecutions: [{ id: 'd1', reason: 'DataError', created: '2026-10-01', size: 10, resolved: false, retry: true, attempts: 1 }] });
  });
});

const LIVE_TOKEN = process.env.MAKE_API_TOKEN;
const live = process.env.RUN_MAKE_LIVE === '1' && LIVE_TOKEN ? describe : describe.skip;

live('make adapter: live API', () => {
  const zone = process.env.MAKE_ZONE || 'eu1.make.com';
  const token = LIVE_TOKEN || '';
  const write = process.env.MAKE_LIVE_WRITE === '1' && !!process.env.MAKE_LIVE_DATA_STORE_ID;

  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const run = async (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    applyResponseTransform(await execute(name, token, params, zone), tool(name).responseMapping as never).value;

  it('reads the user, organizations and teams, then the team scenarios and their history', async () => {
    const me = await run('make_get_current_user');
    expect(typeof me.id).toBe('number');
    const orgs = await run('make_list_organizations', { limit: 5 });
    expect(Array.isArray(orgs.organizations)).toBe(true);
    const org = orgs.organizations.find((o: { zone: string }) => o.zone === zone) ?? orgs.organizations[0];
    if (!org) return;
    const teams = await run('make_list_teams', { organizationId: org.id });
    const team = teams.teams[0];
    if (!team) return;
    const scenarios = await run('make_list_scenarios', { teamId: team.id, limit: 3 });
    expect(Array.isArray(scenarios.scenarios)).toBe(true);
    const sc = scenarios.scenarios[0];
    if (sc) {
      expect((await run('make_get_scenario', { scenarioId: sc.id })).scenario.id).toBe(sc.id);
      expect(Array.isArray((await run('make_get_scenario_blueprint', { scenarioId: sc.id })).flow ?? [])).toBe(true);
      expect(Array.isArray((await run('make_list_scenario_logs', { scenarioId: sc.id, limit: 3 })).logs)).toBe(true);
      expect(Array.isArray((await run('make_list_incomplete_executions', { scenarioId: sc.id })).incompleteExecutions)).toBe(true);
    }
    expect(Array.isArray((await run('make_list_connections', { teamId: team.id })).connections)).toBe(true);
    const stores = await run('make_list_data_stores', { teamId: team.id });
    expect(Array.isArray(stores.dataStores)).toBe(true);
    if (stores.dataStores[0]) expect(Array.isArray((await run('make_list_data_store_records', { dataStoreId: stores.dataStores[0].id, limit: 3 })).records)).toBe(true);
    const hooks = await run('make_list_hooks', { teamId: team.id });
    expect(JSON.stringify(hooks)).not.toMatch(/hook\.[a-z0-9]+\.make\.(com|celonis\.com)\//);
  }, 120_000);

  (write ? it : it.skip)('adds a record to the test data store', async () => {
    const created = await run('make_add_data_store_record', { dataStoreId: Number(process.env.MAKE_LIVE_DATA_STORE_ID), key: 'anythingmcp-live-spec', data: {} });
    expect(created.key).toBe('anythingmcp-live-spec');
  }, 30_000);

  it('a wrong token is a 401', async () => {
    await expect(execute('make_get_current_user', '00000000-0000-0000-0000-000000000000', {}, zone)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);
});
