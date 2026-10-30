import axios from 'axios';
import * as adapter from './google-admin.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';

/**
 * Google Workspace Admin SDK (developers.google.com/workspace/admin, discovery
 * documents admin.googleapis.com/$discovery/rest?version=directory_v1 and
 * reports_v1): Directory API under /admin/directory/v1 and Reports API under
 * /admin/reports/v1, OAuth2 with the shared Google client, always on the
 * signed-in admin's own account (my_customer).
 *
 * Static part: always runs. Live part (reads only: customer, domains, users,
 * groups, org units, roles, login audit log) needs an access token of a
 * Workspace admin with the adapter's scopes:
 *   RUN_GOOGLE_ADMIN_LIVE=1 GOOGLE_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/google-admin
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
  parameters: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
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
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const PREFIX = 'google_admin_';
const BASE = 'https://admin.googleapis.com';
const DIR = '/admin/directory/v1';
const CUST = `${DIR}/customer/my_customer`;
const newEngine = () =>
  new RestEngine({ getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService, {} as LoginTokenService);
const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
});
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
const sent = () => mockedAxios.mock.calls[0][0];

describe('google-admin adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with the shared Google OAuth client and the Admin SDK scopes', () => {
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    const { scopes, ...rest } = a.connector.authConfig;
    expect(rest).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
    });
    expect(scopes.split(' ').map((x) => x.replace('https://www.googleapis.com/auth/', '')).sort()).toEqual(
      [
        'admin.directory.customer.readonly',
        'admin.directory.device.chromeos.readonly',
        'admin.directory.device.mobile.readonly',
        'admin.directory.domain.readonly',
        'admin.directory.group',
        'admin.directory.orgunit',
        'admin.directory.rolemanagement',
        'admin.directory.user',
        'admin.directory.user.security',
        'admin.reports.audit.readonly',
        'admin.reports.usage.readonly',
      ].sort(),
    );
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('Super Admin');
    expect(a.instructions).toContain('Admin API privileges');
  });

  it('only calls the Directory and Reports APIs of the own account', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      expect(`${t.name}:${p.startsWith(`${DIR}/`) || p.startsWith('/admin/reports/v1/')}`).toBe(`${t.name}:true`);
      expect(p).not.toMatch(/\{\{/);
      expect(p).not.toMatch(/^https?:/);
      if (p.includes('/customer')) expect(p).toMatch(/\/customers?\/my_customer/);
    }
    expect(tool('google_admin_list_users').endpointMapping.queryParams?.customer).toBe('my_customer');
    expect(tool('google_admin_list_groups').endpointMapping.queryParams?.customer).toBe('my_customer');
    // userKey and customer cannot be combined on groups.list.
    expect(tool('google_admin_list_user_groups').endpointMapping.queryParams?.customer).toBeUndefined();
  });

  it.each([
    ['google_admin_get_customer', {}, 'GET', `${DIR}/customers/my_customer`],
    ['google_admin_list_domains', {}, 'GET', `${CUST}/domains`],
    ['google_admin_get_domain', { domain_name: 'example.com' }, 'GET', `${CUST}/domains/example.com`],
    ['google_admin_list_domain_aliases', {}, 'GET', `${CUST}/domainaliases`],
    ['google_admin_list_users', {}, 'GET', `${DIR}/users`],
    ['google_admin_get_user', { user_key: 'anna@example.com' }, 'GET', `${DIR}/users/anna%40example.com`],
    ['google_admin_create_user', { primary_email: 'a@example.com', given_name: 'A', family_name: 'B', password: 'secret123' }, 'POST', `${DIR}/users`],
    ['google_admin_update_user', { user_key: '1234' }, 'PATCH', `${DIR}/users/1234`],
    ['google_admin_suspend_user', { user_key: '1234' }, 'PATCH', `${DIR}/users/1234`],
    ['google_admin_unsuspend_user', { user_key: '1234' }, 'PATCH', `${DIR}/users/1234`],
    ['google_admin_sign_out_user', { user_key: '1234' }, 'POST', `${DIR}/users/1234/signOut`],
    ['google_admin_undelete_user', { user_id: '1234' }, 'POST', `${DIR}/users/1234/undelete`],
    ['google_admin_delete_user', { user_key: '1234' }, 'DELETE', `${DIR}/users/1234`],
    ['google_admin_list_user_aliases', { user_key: '1234' }, 'GET', `${DIR}/users/1234/aliases`],
    ['google_admin_add_user_alias', { user_key: '1234', alias: 'x@example.com' }, 'POST', `${DIR}/users/1234/aliases`],
    ['google_admin_delete_user_alias', { user_key: '1234', alias: 'x@example.com' }, 'DELETE', `${DIR}/users/1234/aliases/x%40example.com`],
    ['google_admin_list_groups', {}, 'GET', `${DIR}/groups`],
    ['google_admin_list_user_groups', { user_key: '1234' }, 'GET', `${DIR}/groups`],
    ['google_admin_get_group', { group_key: 'g1' }, 'GET', `${DIR}/groups/g1`],
    ['google_admin_create_group', { email: 'g@example.com' }, 'POST', `${DIR}/groups`],
    ['google_admin_update_group', { group_key: 'g1' }, 'PATCH', `${DIR}/groups/g1`],
    ['google_admin_delete_group', { group_key: 'g1' }, 'DELETE', `${DIR}/groups/g1`],
    ['google_admin_list_group_members', { group_key: 'g1' }, 'GET', `${DIR}/groups/g1/members`],
    ['google_admin_get_group_member', { group_key: 'g1', member_key: 'm1' }, 'GET', `${DIR}/groups/g1/members/m1`],
    ['google_admin_has_group_member', { group_key: 'g1', member_key: 'm1' }, 'GET', `${DIR}/groups/g1/hasMember/m1`],
    ['google_admin_add_group_member', { group_key: 'g1', email: 'm@example.com' }, 'POST', `${DIR}/groups/g1/members`],
    ['google_admin_update_group_member', { group_key: 'g1', member_key: 'm1' }, 'PATCH', `${DIR}/groups/g1/members/m1`],
    ['google_admin_remove_group_member', { group_key: 'g1', member_key: 'm1' }, 'DELETE', `${DIR}/groups/g1/members/m1`],
    ['google_admin_list_org_units', {}, 'GET', `${CUST}/orgunits`],
    ['google_admin_get_org_unit', { org_unit_path: 'Sales/EMEA' }, 'GET', `${CUST}/orgunits/Sales/EMEA`],
    ['google_admin_create_org_unit', { name: 'EMEA', parent_org_unit_path: '/Sales' }, 'POST', `${CUST}/orgunits`],
    ['google_admin_update_org_unit', { org_unit_path: 'id:03ph8a2z' }, 'PATCH', `${CUST}/orgunits/id:03ph8a2z`],
    ['google_admin_list_roles', {}, 'GET', `${CUST}/roles`],
    ['google_admin_get_role', { role_id: '42' }, 'GET', `${CUST}/roles/42`],
    ['google_admin_list_role_assignments', {}, 'GET', `${CUST}/roleassignments`],
    ['google_admin_get_role_assignment', { role_assignment_id: '7' }, 'GET', `${CUST}/roleassignments/7`],
    ['google_admin_assign_role', { role_id: '42', assigned_to: '1234', scope_type: 'CUSTOMER' }, 'POST', `${CUST}/roleassignments`],
    ['google_admin_delete_role_assignment', { role_assignment_id: '7' }, 'DELETE', `${CUST}/roleassignments/7`],
    ['google_admin_list_chromeos_devices', {}, 'GET', `${CUST}/devices/chromeos`],
    ['google_admin_get_chromeos_device', { device_id: 'd1' }, 'GET', `${CUST}/devices/chromeos/d1`],
    ['google_admin_list_mobile_devices', {}, 'GET', `${CUST}/devices/mobile`],
    ['google_admin_get_mobile_device', { resource_id: 'r1' }, 'GET', `${CUST}/devices/mobile/r1`],
    ['google_admin_list_activities', { application_name: 'login' }, 'GET', '/admin/reports/v1/activity/users/all/applications/login'],
    ['google_admin_get_customer_usage', { date: '2026-10-20' }, 'GET', '/admin/reports/v1/usage/dates/2026-10-20'],
    ['google_admin_get_user_usage', { date: '2026-10-20' }, 'GET', '/admin/reports/v1/usage/users/all/dates/2026-10-20'],
  ])('%s sends %s to the documented Admin SDK URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url: `${BASE}${path}`, headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
  });

  it('covers every tool with a URL check above', () => {
    expect(a.tools).toHaveLength(45);
  });

  it('builds the user bodies the Directory API expects', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_admin_create_user', {
      primary_email: 'anna@example.com',
      given_name: 'Anna',
      family_name: 'Rossi',
      password: 'Initial-2026',
      change_password_at_next_login: true,
      org_unit_path: '/Sales',
    });
    expect(sent().data).toEqual({
      primaryEmail: 'anna@example.com',
      name: { givenName: 'Anna', familyName: 'Rossi' },
      password: 'Initial-2026',
      changePasswordAtNextLogin: true,
      orgUnitPath: '/Sales',
    });
    mockedAxios.mockClear();
    await call('google_admin_suspend_user', { user_key: 'anna@example.com' });
    expect(sent().data).toEqual({ suspended: true });
    mockedAxios.mockClear();
    await call('google_admin_unsuspend_user', { user_key: 'anna@example.com' });
    expect(sent().data).toEqual({ suspended: false });
    mockedAxios.mockClear();
    await call('google_admin_update_user', { user_key: 'anna@example.com', org_unit_path: '/Sales/EMEA', include_in_global_address_list: false });
    expect(sent().data).toEqual({ orgUnitPath: '/Sales/EMEA', includeInGlobalAddressList: false });
  });

  it('sends members, roles and org units with the documented field names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_admin_add_group_member', { group_key: 'sales@example.com', email: 'anna@example.com', role: 'MANAGER', delivery_settings: 'DIGEST' });
    expect(sent().data).toEqual({ email: 'anna@example.com', role: 'MANAGER', delivery_settings: 'DIGEST' });
    mockedAxios.mockClear();
    await call('google_admin_assign_role', { role_id: '42', assigned_to: '1234', scope_type: 'ORG_UNIT', org_unit_id: '03ph8a2z' });
    expect(sent().data).toEqual({ roleId: '42', assignedTo: '1234', scopeType: 'ORG_UNIT', orgUnitId: '03ph8a2z' });
    mockedAxios.mockClear();
    await call('google_admin_create_org_unit', { name: 'EMEA', parent_org_unit_path: '/Sales' });
    expect(sent().data).toEqual({ name: 'EMEA', parentOrgUnitPath: '/Sales' });
    expect(tool('google_admin_get_org_unit').endpointMapping.encodePathParams).toBeUndefined();
  });

  it('maps the report parameters and defaults user_key to all', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_admin_list_activities', { application_name: 'drive', start_time: '2026-10-01T00:00:00Z', event_name: 'download', org_unit_id: 'id:03ph', max_results: 50 });
    expect(sent().params).toEqual({ startTime: '2026-10-01T00:00:00Z', eventName: 'download', orgUnitID: 'id:03ph', maxResults: 50 });
    mockedAxios.mockClear();
    await call('google_admin_get_user_usage', { date: '2026-10-20', parameters: 'accounts:last_login_time' });
    expect(sent().params).toEqual({ parameters: 'accounts:last_login_time' });
    expect(tool('google_admin_list_activities').parameters.properties?.application_name.enum).toEqual(expect.arrayContaining(['login', 'admin', 'drive', 'token', 'groups', 'mobile']));
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('installs the deletes switched off, says so, and marks them destructive', () => {
    const off = ['google_admin_delete_group', 'google_admin_delete_role_assignment', 'google_admin_delete_user', 'google_admin_delete_user_alias', 'google_admin_remove_group_member'];
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(off);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name).sort()).toEqual(off);
    expect(a.instructions).toContain(
      '**Switched off at install**: `google_admin_delete_user`, `google_admin_delete_group`, `google_admin_remove_group_member`, `google_admin_delete_user_alias` and `google_admin_delete_role_assignment`; they cannot be undone',
    );
    for (const name of off) expect(`${name}:${annotationsOf(tool(name)).destructiveHint}`).toBe(`${name}:true`);
  });

  it('marks every GET read-only and no write read-only', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    }
    for (const name of ['google_admin_suspend_user', 'google_admin_unsuspend_user', 'google_admin_sign_out_user']) {
      expect(`${name}:${annotationsOf(tool(name)).destructiveHint}`).toBe(`${name}:false`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe).toEqual({ tool: 'google_admin_get_customer' });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    expect(a.connector.healthcheckPath).toBe(`${DIR}/customers/my_customer`);
    const names = new Set(a.tools.map((t) => t.name));
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(`\`${t.name}\``)}`).toBe(`${t.name}:true`);
    const mentioned = [...a.instructions.matchAll(/\bgoogle_admin_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgoogle_admin_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const live = process.env.RUN_GOOGLE_ADMIN_LIVE === '1' && TOKEN ? describe : describe.skip;

live('google-admin adapter: live (read-only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
      tool(name).endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );

  it('reads the account, domains, users, groups, org units and roles', async () => {
    const customer = await run('google_admin_get_customer');
    expect(customer.id).toMatch(/^C/);
    const domains = await run('google_admin_list_domains');
    expect(domains.domains.some((d: { isPrimary: boolean }) => d.isPrimary)).toBe(true);
    const users = await run('google_admin_list_users', { max_results: 5 });
    expect(users.users.length).toBeGreaterThan(0);
    const first = users.users[0];
    expect((await run('google_admin_get_user', { user_key: first.primaryEmail })).id).toBe(first.id);
    await run('google_admin_list_user_aliases', { user_key: first.id });
    await run('google_admin_list_user_groups', { user_key: first.primaryEmail });
    const groups = await run('google_admin_list_groups', { max_results: 5 });
    if (groups.groups?.length) await run('google_admin_list_group_members', { group_key: groups.groups[0].id, max_results: 5 });
    const units = await run('google_admin_list_org_units', { type: 'all' });
    expect(units.kind).toBe('admin#directory#orgUnits');
    const roles = await run('google_admin_list_roles');
    expect(roles.items.some((r: { isSuperAdminRole?: boolean }) => r.isSuperAdminRole)).toBe(true);
    await run('google_admin_list_role_assignments', { max_results: 5 });
  }, 60_000);

  it('reads devices and the login audit log', async () => {
    await run('google_admin_list_chromeos_devices', { max_results: 5 });
    await run('google_admin_list_mobile_devices', { max_results: 5 });
    const logins = await run('google_admin_list_activities', { application_name: 'login', max_results: 5 });
    expect(logins.kind).toBe('admin#reports#activities');
  }, 60_000);
});
