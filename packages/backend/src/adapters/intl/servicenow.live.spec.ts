import axios from 'axios';
import * as adapter from './servicenow.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Three layers of verification for the ServiceNow adapter:
 *
 *   1. Static: always runs. Pins Basic auth with the integration user, the
 *      per-instance base URL, every tool's method and URL (Table, Aggregate,
 *      Service Catalog, CMDB Instance and Attachment APIs, as documented in
 *      ServiceNow's REST API reference), the sysparm_* parameters, the state
 *      values sent to resolve and close incidents, which tools write, and that
 *      deletion installs switched off.
 *
 *   2. Reads against a real instance without credentials: RUN_SERVICENOW_LIVE=1
 *      sends every read through the real engine to SERVICENOW_PROBE_INSTANCE
 *      (default hi, ServiceNow's own support instance) with placeholder
 *      credentials. ServiceNow authenticates before it routes, so paths answer
 *      401 there, real or not (sys_choice and the Attachment API answer 403
 *      from their ACLs); the layer proves the base URL, the Basic header and
 *      the error classification, not the paths. An instance name that does
 *      not exist has no DNS record and fails without a status.
 *
 *   3. Live reads: skipped unless SERVICENOW_INSTANCE, SERVICENOW_USERNAME and
 *      SERVICENOW_PASSWORD are set (a free personal developer instance works).
 *      Lists incidents, reads one by number, counts, reads choices, users,
 *      groups, knowledge, the catalog, the CMDB and attachments. Nothing is
 *      written.
 *
 *        SERVICENOW_INSTANCE=dev123456 SERVICENOW_USERNAME=... SERVICENOW_PASSWORD=... \
 *          npx jest src/adapters/intl/servicenow.live.spec.ts
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
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    exposeHeaders?: string[];
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

// Built at run time so no literal here looks like a real password.
const PASSWORD = 'pw9!'.repeat(4);
const ENV = { SERVICENOW_INSTANCE: 'dev123456', SERVICENOW_USERNAME: 'amcp.integration', SERVICENOW_PASSWORD: PASSWORD };
const BASE = 'https://dev123456.service-now.com/api';
const SYS_ID = '9d385017c611228701d22104cc95c371';

// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, env),
      headers: config.headers,
    },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'servicenow_add_note',
  'servicenow_close_incident',
  'servicenow_create_change_request',
  'servicenow_create_incident',
  'servicenow_create_problem',
  'servicenow_delete_record',
  'servicenow_order_catalog_item',
  'servicenow_resolve_incident',
  'servicenow_update_change_request',
  'servicenow_update_incident',
  'servicenow_update_problem',
  'servicenow_update_record',
];
const SWITCHED_OFF = ['servicenow_delete_record'];

// [tool, args, method, path below /api]
const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['servicenow_list_incidents', {}, 'GET', '/now/table/incident'],
  ['servicenow_get_incident', { number: 'INC0010023' }, 'GET', '/now/table/incident'],
  ['servicenow_create_incident', { short_description: 'VPN down' }, 'POST', '/now/table/incident'],
  ['servicenow_update_incident', { sys_id: SYS_ID, state: '2' }, 'PATCH', `/now/table/incident/${SYS_ID}`],
  ['servicenow_add_note', { sys_id: SYS_ID, work_notes: 'Checked the tunnel.' }, 'PATCH', `/now/table/incident/${SYS_ID}`],
  ['servicenow_resolve_incident', { sys_id: SYS_ID, close_code: 'Solution provided', close_notes: 'Restarted the gateway.' }, 'PATCH', `/now/table/incident/${SYS_ID}`],
  ['servicenow_close_incident', { sys_id: SYS_ID, close_code: 'Solution provided', close_notes: 'Confirmed by caller.' }, 'PATCH', `/now/table/incident/${SYS_ID}`],
  ['servicenow_list_change_requests', {}, 'GET', '/now/table/change_request'],
  ['servicenow_get_change_request', { number: 'CHG0030001' }, 'GET', '/now/table/change_request'],
  ['servicenow_create_change_request', { short_description: 'Patch web servers' }, 'POST', '/now/table/change_request'],
  ['servicenow_update_change_request', { sys_id: SYS_ID, state: '-4' }, 'PATCH', `/now/table/change_request/${SYS_ID}`],
  ['servicenow_list_problems', {}, 'GET', '/now/table/problem'],
  ['servicenow_get_problem', { number: 'PRB0040001' }, 'GET', '/now/table/problem'],
  ['servicenow_create_problem', { short_description: 'Recurring VPN drops' }, 'POST', '/now/table/problem'],
  ['servicenow_update_problem', { sys_id: SYS_ID, state: '103' }, 'PATCH', `/now/table/problem/${SYS_ID}`],
  ['servicenow_list_requests', {}, 'GET', '/now/table/sc_request'],
  ['servicenow_list_requested_items', {}, 'GET', '/now/table/sc_req_item'],
  ['servicenow_get_requested_item', { number: 'RITM0010001' }, 'GET', '/now/table/sc_req_item'],
  ['servicenow_get_requested_item_variables', { ritm_sys_id: SYS_ID }, 'GET', '/now/table/sc_item_option_mtom'],
  ['servicenow_search_catalog_items', { text: 'laptop' }, 'GET', '/sn_sc/servicecatalog/items'],
  ['servicenow_get_catalog_item', { sys_id: SYS_ID }, 'GET', `/sn_sc/servicecatalog/items/${SYS_ID}`],
  ['servicenow_order_catalog_item', { sys_id: SYS_ID, variables: { model: 'x1' } }, 'POST', `/sn_sc/servicecatalog/items/${SYS_ID}/order_now`],
  ['servicenow_search_knowledge', { query: 'vpn' }, 'GET', '/now/table/kb_knowledge'],
  ['servicenow_get_knowledge_article', { number: 'KB0010001' }, 'GET', '/now/table/kb_knowledge'],
  ['servicenow_find_users', { search: 'tuter' }, 'GET', '/now/table/sys_user'],
  ['servicenow_find_groups', { search: 'service desk' }, 'GET', '/now/table/sys_user_group'],
  ['servicenow_list_group_members', { group_sys_id: SYS_ID }, 'GET', '/now/table/sys_user_grmember'],
  ['servicenow_find_configuration_items', { search: 'web01' }, 'GET', '/now/table/cmdb_ci'],
  ['servicenow_get_configuration_item', { ci_class: 'cmdb_ci_linux_server', sys_id: SYS_ID }, 'GET', `/now/cmdb/instance/cmdb_ci_linux_server/${SYS_ID}`],
  ['servicenow_query_table', { table: 'sc_task' }, 'GET', '/now/table/sc_task'],
  ['servicenow_get_record', { table: 'sc_task', sys_id: SYS_ID }, 'GET', `/now/table/sc_task/${SYS_ID}`],
  ['servicenow_count_records', { table: 'incident', group_by: 'assignment_group' }, 'GET', '/now/stats/incident'],
  ['servicenow_list_choices', { table: 'incident', field: 'close_code' }, 'GET', '/now/table/sys_choice'],
  ['servicenow_update_record', { table: 'sc_task', sys_id: SYS_ID, fields: { state: '3' } }, 'PATCH', `/now/table/sc_task/${SYS_ID}`],
  ['servicenow_delete_record', { table: 'sc_task', sys_id: SYS_ID }, 'DELETE', `/now/table/sc_task/${SYS_ID}`],
  ['servicenow_list_attachments', { table: 'incident', sys_id: SYS_ID }, 'GET', '/now/attachment'],
];

describe('servicenow adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (every path is in ServiceNow\'s REST API reference; not run against a live instance)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('signs in with Basic auth on the instance named in SERVICENOW_INSTANCE', async () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{SERVICENOW_USERNAME}}', password: '{{SERVICENOW_PASSWORD}}' });
    expect(a.connector.baseUrl).toBe('https://{{SERVICENOW_INSTANCE}}.service-now.com/api');
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    mockedAxios.mockResolvedValue({ data: { result: [] } });
    await call('servicenow_list_incidents', {});
    expect(sent().auth).toEqual({ username: 'amcp.integration', password: PASSWORD });
    expect(sent().url).not.toContain(PASSWORD);
    expect(JSON.stringify(sent().params)).not.toContain(PASSWORD);
  });

  it('checks the variables and keeps the password secret', () => {
    expect(a.requiredEnvVars).toEqual(['SERVICENOW_INSTANCE', 'SERVICENOW_USERNAME', 'SERVICENOW_PASSWORD']);
    const instance = new RegExp(a.envVarMeta.SERVICENOW_INSTANCE.pattern!);
    for (const ok of ['dev123456', 'acme', 'acme-test']) expect(instance.test(ok)).toBe(true);
    for (const bad of ['https://dev123456.service-now.com', 'dev123456.service-now.com', 'dev123456/', '-acme', '']) expect(instance.test(bad)).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'SERVICENOW_PASSWORD')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'SERVICENOW_INSTANCE')!.kind).toBe('address');
    expect(a.verifyHints['401']).toContain('SERVICENOW_PASSWORD');
    expect(a.verifyHints['403']).toContain('itil');
    expect(a.verifyHints.unreachable).toContain('SERVICENOW_INSTANCE');
  });

  it('probes with one incident number', () => {
    expect(a.probe).toEqual({ tool: 'servicenow_list_incidents', params: { limit: 1, fields: 'number,sys_id' } });
  });

  it('prefixes every tool with servicenow_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^servicenow_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, asks for a yes on every write and installs deletion switched off', () => {
    const reads = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(a.tools.filter((t) => !reads.includes(t.name)).map((t) => t.name).sort()).toEqual(WRITES);
    for (const t of a.tools.filter((x) => reads.includes(x.name))) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(t.description).toMatch(/Read-only\.$/);
    }
    for (const name of WRITES) expect(tool(name).description).toMatch(/get a yes from the user first/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(SWITCHED_OFF);
    expect(annotationsOf(tool('servicenow_delete_record')).destructiveHint).toBe(true);
    // A note only adds a journal entry.
    expect(annotationsOf(tool('servicenow_add_note')).destructiveHint).toBe(false);
  });

  it('encodes path values, so a table or sys_id cannot reach another route', async () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('{'))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('servicenow_get_record', { table: '../attachment', sys_id: 'x' });
    expect(sent().url).toBe(`${BASE}/now/table/..%2Fattachment/x`);
  });

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to %s', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: { result: {} } });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
  });

  it('lists incidents with sysparm_* parameters, labels by default and the total count', async () => {
    mockedAxios.mockResolvedValue({ data: { result: [] } });
    await call('servicenow_list_incidents', { query: 'active=true^priority=1', offset: 40 });
    expect(sent().params).toEqual({
      sysparm_query: 'active=true^priority=1',
      sysparm_fields: tool('servicenow_list_incidents').parameters.properties!.fields.default,
      sysparm_limit: 20,
      sysparm_offset: 40,
      sysparm_display_value: 'true',
      sysparm_exclude_reference_link: 'true',
    });
    expect(tool('servicenow_list_incidents').endpointMapping.exposeHeaders).toEqual(['x-total-count']);
    expect(tool('servicenow_list_incidents').parameters.properties!.query.default).toBe('active=true^ORDERBYDESCsys_updated_on');
  });

  it('reads one incident by number', async () => {
    mockedAxios.mockResolvedValue({ data: { result: [] } });
    await call('servicenow_get_incident', { number: 'INC0010023' });
    expect(sent().params).toEqual({ sysparm_query: 'number=INC0010023', sysparm_limit: '1', sysparm_display_value: 'true', sysparm_exclude_reference_link: 'true' });
  });

  it('runs the generic query with exactly the sysparm parameters given', async () => {
    mockedAxios.mockResolvedValue({ data: { result: [] } });
    await call('servicenow_query_table', { table: 'sc_task', query: 'active=true', fields: 'number,state', limit: 5, display_value: 'all' });
    expect(sent().params).toEqual({ sysparm_query: 'active=true', sysparm_fields: 'number,state', sysparm_limit: 5, sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true' });
  });

  it('resolves with state 6 and closes with state 7, always with close_code and close_notes', async () => {
    mockedAxios.mockResolvedValue({ data: { result: {} } });
    await call('servicenow_resolve_incident', { sys_id: SYS_ID, close_code: 'Solution provided', close_notes: 'Restarted the gateway.' });
    expect(sent().data).toEqual({ state: '6', close_code: 'Solution provided', close_notes: 'Restarted the gateway.' });
    mockedAxios.mockClear();
    await call('servicenow_close_incident', { sys_id: SYS_ID, close_code: 'Solution provided', close_notes: 'Confirmed.', work_notes: 'Caller agreed.' });
    expect(sent().data).toEqual({ state: '7', close_code: 'Solution provided', close_notes: 'Confirmed.', work_notes: 'Caller agreed.' });
    for (const name of ['servicenow_resolve_incident', 'servicenow_close_incident']) {
      expect(tool(name).parameters.required).toEqual(['sys_id', 'close_code', 'close_notes']);
    }
    // Resolve and close go through their own tools, which send the required fields.
    expect(tool('servicenow_update_incident').parameters.properties!.state.enum).toEqual(['1', '2', '3', '8']);
  });

  it('creates an incident with the fields given, merges extra fields and asks for the number back', async () => {
    mockedAxios.mockResolvedValue({ data: { result: {} } });
    await call('servicenow_create_incident', { short_description: 'VPN down', impact: '2', urgency: '1', assignment_group: 'Service Desk', input_display_value: true, additional_fields: { u_site: 'Freiburg' } });
    expect(sent().data).toEqual({ u_site: 'Freiburg', short_description: 'VPN down', impact: '2', urgency: '1', assignment_group: 'Service Desk' });
    expect(sent().params).toEqual({
      sysparm_input_display_value: true,
      sysparm_fields: 'number,sys_id,state,short_description,priority,assignment_group,assigned_to,sys_updated_on',
      sysparm_display_value: 'true',
      sysparm_exclude_reference_link: 'true',
    });
  });

  it('adds a work note or a comment to any task table', async () => {
    mockedAxios.mockResolvedValue({ data: { result: {} } });
    await call('servicenow_add_note', { table: 'sc_req_item', sys_id: SYS_ID, comments: 'Your laptop ships today.' });
    expect(sent().url).toBe(`${BASE}/now/table/sc_req_item/${SYS_ID}`);
    expect(sent().data).toEqual({ comments: 'Your laptop ships today.' });
  });

  it('orders a catalog item with the body the Service Catalog API expects', async () => {
    mockedAxios.mockResolvedValue({ data: { result: { number: 'REQ0010001' } } });
    await call('servicenow_order_catalog_item', { sys_id: SYS_ID, variables: { model: 'x1' }, requested_for: 'u1' });
    expect(sent().data).toEqual({ sysparm_quantity: 1, variables: { model: 'x1' }, sysparm_requested_for: 'u1' });
  });

  it('searches knowledge with the text index, published articles by default', async () => {
    mockedAxios.mockResolvedValue({ data: { result: [] } });
    await call('servicenow_search_knowledge', { query: 'reset vpn' });
    expect(sent().params.sysparm_query).toBe('workflow_state=published^123TEXTQUERY321=reset vpn');
  });

  it('builds the people, CMDB, choices, variables, counts and attachment queries', async () => {
    mockedAxios.mockResolvedValue({ data: { result: [] } });
    const q = async (name: string, params: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await call(name, params);
      return sent().params;
    };
    expect((await q('servicenow_find_users', { search: 'tuter' })).sysparm_query).toBe('active=true^nameLIKEtuter^ORemailLIKEtuter^ORuser_nameLIKEtuter');
    expect((await q('servicenow_find_groups', { search: 'desk' })).sysparm_query).toBe('active=true^nameLIKEdesk');
    expect((await q('servicenow_list_group_members', { group_sys_id: SYS_ID })).sysparm_query).toBe(`group=${SYS_ID}`);
    expect((await q('servicenow_find_configuration_items', { search: '10.0.0.5' })).sysparm_query).toBe('nameLIKE10.0.0.5^ORip_addressLIKE10.0.0.5^ORfqdnLIKE10.0.0.5^ORserial_numberLIKE10.0.0.5');
    expect((await q('servicenow_list_choices', { table: 'incident', field: 'close_code' })).sysparm_query).toBe('name=incident^element=close_code^inactive=false^language=en^ORDERBYsequence');
    expect((await q('servicenow_get_requested_item_variables', { ritm_sys_id: SYS_ID })).sysparm_query).toBe(`request_item=${SYS_ID}`);
    expect(await q('servicenow_count_records', { table: 'incident', query: 'active=true', group_by: 'assignment_group' })).toEqual({ sysparm_count: 'true', sysparm_query: 'active=true', sysparm_group_by: 'assignment_group', sysparm_display_value: 'true' });
    expect((await q('servicenow_list_attachments', { table: 'incident', sys_id: SYS_ID })).sysparm_query).toBe(`table_name=incident^table_sys_id=${SYS_ID}^ORDERBYDESCsys_created_on`);
  });

  it('updates any record with exactly the fields given', async () => {
    mockedAxios.mockResolvedValue({ data: { result: {} } });
    await call('servicenow_update_record', { table: 'sc_task', sys_id: SYS_ID, fields: { state: '3', work_notes: 'Done' } });
    expect(sent().data).toEqual({ state: '3', work_notes: 'Done' });
  });

  it('documents roles, ACLs, OAuth, state codes and the official MCP server choice', () => {
    for (const s of ['itil', 'rest_api_explorer', 'snc_platform_rest_api_access', 'snc_read_only', 'ACLs', 'Web service access only', 'oauth_auth.do', 'oauth_token.do', '/api/mcp-oauth/callback']) {
      expect(a.instructions).toContain(s);
    }
    expect(a.instructions).toMatch(/6 Resolved, 7 Closed/);
    expect(a.instructions).toMatch(/close_code/);
    expect(a.instructions).toMatch(/-5 New, -4 Assess/);
    expect(a.instructions).toMatch(/101 New/);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bservicenow_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bservicenow_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(30);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const authLive = process.env.RUN_SERVICENOW_LIVE === '1' ? describe : describe.skip;

authLive('servicenow adapter: reads reach a real instance and are refused without credentials', () => {
  const env = { ...ENV, SERVICENOW_INSTANCE: process.env.SERVICENOW_PROBE_INSTANCE || 'hi', SERVICENOW_USERNAME: 'amcp.placeholder' };
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const reads = table.filter(([, , method]) => method === 'GET');

  // 401 for most paths; tables and APIs that allow guest sessions at the API
  // level (sys_choice, the Attachment API) answer 403 from their ACL instead.
  it.each(reads)('%s is refused with 401 or 403', async (name, params) => {
    const err = await execute(name, env, params).catch((e) => e);
    expect([401, 403]).toContain(err.status);
  }, 30_000);

  it('fails without an HTTP status when the instance name does not exist', async () => {
    const err = await execute('servicenow_list_incidents', { ...env, SERVICENOW_INSTANCE: 'amcp-no-such-instance-0' }, {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status ?? err.response?.status).toBeUndefined();
  }, 30_000);
});

const LIVE_INSTANCE = process.env.SERVICENOW_INSTANCE;
const LIVE_USER = process.env.SERVICENOW_USERNAME;
const LIVE_PASSWORD = process.env.SERVICENOW_PASSWORD;
const live = LIVE_INSTANCE && LIVE_USER && LIVE_PASSWORD ? describe : describe.skip;

live('servicenow adapter: live reads', () => {
  const env = { SERVICENOW_INSTANCE: LIVE_INSTANCE as string, SERVICENOW_USERNAME: LIVE_USER as string, SERVICENOW_PASSWORD: LIVE_PASSWORD as string };
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);

  it('lists and reads incidents, counts them and reads their choices', async () => {
    const list = await run('servicenow_list_incidents', { limit: 2, query: 'ORDERBYDESCsys_created_on' });
    expect(Array.isArray(list.result)).toBe(true);
    expect(Number(list._headers['x-total-count'])).toBeGreaterThanOrEqual(list.result.length);
    if (list.result[0]) {
      const one = await run('servicenow_get_incident', { number: list.result[0].number });
      expect(one.result[0].sys_id).toBe(list.result[0].sys_id);
      expect(Array.isArray((await run('servicenow_list_attachments', { table: 'incident', sys_id: one.result[0].sys_id })).result)).toBe(true);
    }
    expect((await run('servicenow_count_records', { table: 'incident' })).result.stats.count).toBeDefined();
    const states = await run('servicenow_list_choices', { table: 'incident', field: 'state' });
    expect(states.result.map((c: { value: string }) => c.value)).toEqual(expect.arrayContaining(['1', '2', '6', '7']));
  }, 120_000);

  it('reads changes, problems, requests, people, knowledge, the catalog and the CMDB', async () => {
    for (const name of ['servicenow_list_change_requests', 'servicenow_list_problems', 'servicenow_list_requests', 'servicenow_list_requested_items']) {
      expect(Array.isArray((await run(name, { limit: 1 })).result)).toBe(true);
    }
    expect(Array.isArray((await run('servicenow_find_users', { search: 'a', limit: 1 })).result)).toBe(true);
    expect(Array.isArray((await run('servicenow_find_groups', { search: 'a', limit: 1 })).result)).toBe(true);
    expect(Array.isArray((await run('servicenow_search_knowledge', { query: 'email', limit: 1 })).result)).toBe(true);
    expect(Array.isArray((await run('servicenow_search_catalog_items', { limit: 1 })).result)).toBe(true);
    const cis = await run('servicenow_find_configuration_items', { search: 'a', limit: 1, fields: 'sys_id,sys_class_name' });
    if (cis.result[0]) {
      const ci = await run('servicenow_get_configuration_item', { ci_class: cis.result[0].sys_class_name.value, sys_id: cis.result[0].sys_id.value });
      expect(ci.result.attributes).toBeDefined();
    }
  }, 120_000);
});
