import * as adapter from './workos.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * WorkOS API (workos.com/docs/reference, markdown pages listed in workos.com/llms.txt):
 * base https://api.workos.com, Bearer secret API key (sk_...), cursor paging with
 * before/after and list_metadata, array filters sent comma-separated.
 * Live part (reads only: organizations, users, memberships, connections, directories,
 * roles, permissions, audit log actions and events):
 *   WORKOS_API_KEY=sk_test_... RUN_WORKOS_LIVE=1 npx jest src/adapters/intl/workos
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
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
const PREFIX = 'workos_';
const PAGE = { limit: '$limit', before: '$before', after: '$after', order: '$order' };
const SWITCHED_OFF = [
  'workos_delete_organization',
  'workos_delete_organization_domain',
  'workos_delete_user',
  'workos_revoke_session',
  'workos_delete_organization_membership',
  'workos_revoke_invitation',
  'workos_create_audit_log_event',
];

describe('workos adapter: static spec conformance', () => {
  it('authenticates with the secret API key as a Bearer token', () => {
    expect(a.requiredEnvVars).toEqual(['WORKOS_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.workos.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{WORKOS_API_KEY}}' });
    expect(a.envVarMeta?.WORKOS_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.WORKOS_API_KEY.pattern ?? '').test('sk_test_a2V5XzAxSDEyMzQ1Njc4OQ')).toBe(true);
    expect(new RegExp(a.envVarMeta?.WORKOS_API_KEY.pattern ?? '').test('Bearer sk_test_123456789')).toBe(false);
    expect(a.connector.healthcheckPath).toBe('/organizations?limit=1');
  });

  it('maps organizations, domains and users to the documented paths', () => {
    expect(tool('workos_list_organizations').endpointMapping).toEqual({ method: 'GET', path: '/organizations', queryParams: { search: '$search', domains: '$domains', ...PAGE } });
    expect(tool('workos_get_organization').endpointMapping).toEqual({ method: 'GET', path: '/organizations/{organization_id}' });
    expect(tool('workos_get_organization_by_external_id').endpointMapping.path).toBe('/organizations/external_id/{external_id}');
    expect(tool('workos_create_organization').endpointMapping).toMatchObject({ method: 'POST', path: '/organizations', bodyMapping: { name: '$name', domain_data: '$domain_data' } });
    expect(tool('workos_update_organization').endpointMapping).toMatchObject({ method: 'PUT', path: '/organizations/{organization_id}', bodyMapping: { stripe_customer_id: '$stripe_customer_id' } });
    expect(tool('workos_delete_organization').endpointMapping).toEqual({ method: 'DELETE', path: '/organizations/{organization_id}' });
    expect(tool('workos_create_organization_domain').endpointMapping).toEqual({ method: 'POST', path: '/organization_domains', bodyMapping: { organization_id: '$organization_id', domain: '$domain' } });
    expect(tool('workos_verify_organization_domain').endpointMapping).toEqual({ method: 'POST', path: '/organization_domains/{domain_id}/verify' });
    expect(tool('workos_list_users').endpointMapping).toEqual({ method: 'GET', path: '/user_management/users', queryParams: { email: '$email', organization_id: '$organization_id', ...PAGE } });
    expect(tool('workos_get_user_by_external_id').endpointMapping.path).toBe('/user_management/users/external_id/{external_id}');
    expect(tool('workos_list_user_identities').endpointMapping.path).toBe('/user_management/users/{user_id}/identities');
    expect(tool('workos_list_user_sessions').endpointMapping).toEqual({ method: 'GET', path: '/user_management/users/{user_id}/sessions', queryParams: PAGE });
    expect(tool('workos_revoke_session').endpointMapping).toEqual({ method: 'POST', path: '/user_management/sessions/revoke', bodyMapping: { session_id: '$session_id' } });
  });

  it('never lets the AI set a password or a password hash', () => {
    for (const name of ['workos_create_user', 'workos_update_user']) {
      const props = Object.keys(tool(name).parameters?.properties ?? {});
      for (const p of props) expect(p.startsWith('password')).toBe(false);
    }
  });

  it('maps memberships, invitations, SSO and Directory Sync', () => {
    const OM = '/user_management/organization_memberships';
    expect(tool('workos_list_organization_memberships').endpointMapping).toEqual({ method: 'GET', path: OM, queryParams: { organization_id: '$organization_id', user_id: '$user_id', statuses: '$statuses', ...PAGE } });
    expect(tool('workos_create_organization_membership').endpointMapping).toMatchObject({ method: 'POST', path: OM, bodyMapping: { user_id: '$user_id', organization_id: '$organization_id', role_slug: '$role_slug', role_slugs: '$role_slugs' } });
    expect(tool('workos_update_organization_membership').endpointMapping).toMatchObject({ method: 'PUT', path: `${OM}/{membership_id}` });
    expect(tool('workos_deactivate_organization_membership').endpointMapping).toEqual({ method: 'PUT', path: `${OM}/{membership_id}/deactivate` });
    expect(tool('workos_reactivate_organization_membership').endpointMapping).toEqual({ method: 'PUT', path: `${OM}/{membership_id}/reactivate` });
    const INV = '/user_management/invitations';
    expect(tool('workos_send_invitation').endpointMapping).toMatchObject({ method: 'POST', path: INV, bodyMapping: { email: '$email', expires_in_days: '$expires_in_days', inviter_user_id: '$inviter_user_id' } });
    expect(tool('workos_resend_invitation').endpointMapping).toEqual({ method: 'POST', path: `${INV}/{invitation_id}/resend`, bodyMapping: { locale: '$locale' } });
    expect(tool('workos_revoke_invitation').endpointMapping).toEqual({ method: 'POST', path: `${INV}/{invitation_id}/revoke` });
    expect(tool('workos_list_connections').endpointMapping).toEqual({ method: 'GET', path: '/connections', queryParams: { organization_id: '$organization_id', connection_type: '$connection_type', domain: '$domain', search: '$search', ...PAGE } });
    expect(tool('workos_get_connection').endpointMapping.path).toBe('/connections/{connection_id}');
    expect(tool('workos_list_directories').endpointMapping.path).toBe('/directories');
    expect(tool('workos_sync_directory').endpointMapping).toEqual({ method: 'POST', path: '/directories/{directory_id}/sync' });
    expect(tool('workos_list_directory_users').endpointMapping).toEqual({ method: 'GET', path: '/directory_users', queryParams: { directory: '$directory', group: '$group', email: '$email', idp_id: '$idp_id', ...PAGE } });
    expect(tool('workos_list_directory_groups').endpointMapping).toEqual({ method: 'GET', path: '/directory_groups', queryParams: { directory: '$directory', user: '$user', ...PAGE } });
    expect(tool('workos_get_directory_user').endpointMapping.path).toBe('/directory_users/{directory_user_id}');
    expect(tool('workos_get_directory_group').endpointMapping.path).toBe('/directory_groups/{directory_group_id}');
  });

  it('maps Audit Logs, events, roles and permissions', () => {
    expect(tool('workos_list_audit_log_actions').endpointMapping).toEqual({ method: 'GET', path: '/audit_logs/actions', queryParams: PAGE });
    expect(tool('workos_list_audit_log_schemas').endpointMapping.path).toBe('/audit_logs/actions/{action_name}/schemas');
    expect(tool('workos_create_audit_log_event').endpointMapping).toEqual({
      method: 'POST',
      path: '/audit_logs/events',
      bodyMapping: { organization_id: '$organization_id', event: '$event' },
      headers: { 'Idempotency-Key': '$idempotency_key' },
    });
    expect(tool('workos_create_audit_log_export').endpointMapping).toMatchObject({ method: 'POST', path: '/audit_logs/exports', bodyMapping: { range_start: '$range_start', range_end: '$range_end', actor_names: '$actor_names' } });
    expect(tool('workos_create_audit_log_export').annotations).toEqual({ readOnlyHint: true });
    expect(tool('workos_get_audit_log_export').endpointMapping.path).toBe('/audit_logs/exports/{export_id}');
    expect(tool('workos_get_audit_log_retention').endpointMapping.path).toBe('/organizations/{organization_id}/audit_logs_retention');
    expect(tool('workos_list_events').endpointMapping).toEqual({
      method: 'GET',
      path: '/events',
      queryParams: { events: '$events', organization_id: '$organization_id', range_start: '$range_start', range_end: '$range_end', after: '$after', before: '$before', limit: '$limit', order: '$order' },
    });
    expect(tool('workos_list_events').parameters?.required).toEqual(['events']);
    expect(tool('workos_list_roles').endpointMapping).toEqual({ method: 'GET', path: '/authorization/roles' });
    expect(tool('workos_get_role').endpointMapping.path).toBe('/authorization/roles/{role_slug}');
    expect(tool('workos_list_organization_roles').endpointMapping.path).toBe('/authorization/organizations/{organization_id}/roles');
    expect(tool('workos_list_permissions').endpointMapping).toEqual({ method: 'GET', path: '/authorization/permissions', queryParams: PAGE });
  });

  it('strips invitation tokens and accept links, and raw directory attributes from lists', () => {
    const inv = { id: 'invitation_1', email: 'a@example.com', state: 'pending', token: 'secret', accept_invitation_url: 'https://app/invite?invitation_token=secret' };
    const list = applyResponseTransform({ object: 'list', data: [inv], list_metadata: { after: null } }, tool('workos_list_invitations').responseMapping as never).value;
    expect(list).toEqual({ object: 'list', data: [{ id: 'invitation_1', email: 'a@example.com', state: 'pending' }], list_metadata: { after: null } });
    for (const name of ['workos_get_invitation', 'workos_send_invitation', 'workos_resend_invitation', 'workos_revoke_invitation']) {
      expect(applyResponseTransform(inv, tool(name).responseMapping as never).value).toEqual({ id: 'invitation_1', email: 'a@example.com', state: 'pending' });
    }
    const du = applyResponseTransform({ data: [{ id: 'directory_user_1', email: 'b@example.com', raw_attributes: { phone: '1' }, custom_attributes: { department: 'IT' } }] }, tool('workos_list_directory_users').responseMapping as never).value;
    expect(du).toEqual({ data: [{ id: 'directory_user_1', email: 'b@example.com', custom_attributes: { department: 'IT' } }] });
    const dg = applyResponseTransform({ data: [{ id: 'directory_group_1', name: 'Admins', raw_attributes: { x: 1 } }] }, tool('workos_list_directory_groups').responseMapping as never).value;
    expect(dg).toEqual({ data: [{ id: 'directory_group_1', name: 'Admins' }] });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
  });

  it('switches off exactly the deletes, revokes and the audit log write', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(SWITCHED_OFF);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'DELETE')) expect(SWITCHED_OFF).toContain(t.name);
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:false`);
    }
    const line = a.instructions.split('\n').find((l) => l.startsWith('**Switched off at install**: ')) ?? '';
    const named = [...line.matchAll(/`(workos_\w+)`/g)].map((m) => m[1]);
    expect([...named].sort()).toEqual([...SWITCHED_OFF].sort());
    expect(line).toContain('so an admin switches them on when the team needs them.');
  });

  it('probes with a read tool, warns about sensitive data and documents every tool', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    expect(a.instructions).toContain('What the AI sees');
    expect(a.instructions).toContain('accept_invitation_url');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_WORKOS_LIVE === '1' && process.env.WORKOS_API_KEY ? describe : describe.skip;
live('workos adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.WORKOS_API_KEY}`, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as { object?: string; data: unknown[]; list_metadata?: Record<string, unknown> };
  };
  it('reads the main lists of the environment', async () => {
    const orgs = await get('/organizations?limit=1');
    expect(orgs.object).toBe('list');
    expect(Array.isArray(orgs.data)).toBe(true);
    expect(orgs.list_metadata).toBeDefined();
    for (const p of [
      '/user_management/users?limit=1',
      '/user_management/invitations?limit=1',
      '/connections?limit=1',
      '/directories?limit=1',
      '/authorization/roles',
      '/authorization/permissions?limit=1',
      '/audit_logs/actions?limit=1',
      '/events?events=user.created,organization.created&limit=1',
    ]) {
      expect(Array.isArray((await get(p)).data)).toBe(true);
    }
    const org = orgs.data[0] as { id?: string } | undefined;
    if (org?.id) {
      expect(Array.isArray((await get(`/user_management/organization_memberships?organization_id=${org.id}&limit=1`)).data)).toBe(true);
      expect(Array.isArray((await get(`/authorization/organizations/${org.id}/roles`)).data)).toBe(true);
    }
  }, 60_000);
});
