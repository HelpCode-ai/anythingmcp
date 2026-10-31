import * as adapter from './tailscale.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Tailscale API v2 (tailscale.com/api, OpenAPI at https://api.tailscale.com/api/v2?outputOpenapiSchema=true):
 * base https://api.tailscale.com/api/v2, an OAuth client exchanged for a one-hour bearer token at
 * /api/v2/oauth/token (client credentials), `-` in the path for the client's own tailnet.
 * Live part (reads only: devices, users, keys, DNS, settings, policy file):
 *   TAILSCALE_OAUTH_CLIENT_ID=... TAILSCALE_OAUTH_CLIENT_SECRET=... RUN_TAILSCALE_LIVE=1 npx jest src/adapters/intl/tailscale
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, unknown>;
    exposeHeaders?: string[];
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
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
const PREFIX = 'tailscale_';
const T = '/tailnet/-';
const READ_POSTS = ['tailscale_validate_policy_file', 'tailscale_preview_policy_rules'];

describe('tailscale adapter: static spec conformance', () => {
  it('signs in with an OAuth client (client credentials) and calls the client tailnet through -', () => {
    expect(a.requiredEnvVars).toEqual(['TAILSCALE_OAUTH_CLIENT_ID', 'TAILSCALE_OAUTH_CLIENT_SECRET']);
    expect(a.connector.baseUrl).toBe('https://api.tailscale.com/api/v2');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{TAILSCALE_OAUTH_CLIENT_ID}}',
      clientSecret: '{{TAILSCALE_OAUTH_CLIENT_SECRET}}',
      tokenUrl: 'https://api.tailscale.com/api/v2/oauth/token',
      tokenAuthMethod: 'client_secret_post',
    });
    expect(a.envVarMeta?.TAILSCALE_OAUTH_CLIENT_SECRET.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.TAILSCALE_OAUTH_CLIENT_SECRET.pattern ?? '').test('tskey-client-kAbC-xyz')).toBe(true);
    expect(new RegExp(a.envVarMeta?.TAILSCALE_OAUTH_CLIENT_SECRET.pattern ?? '').test('tskey-api-kAbC-xyz')).toBe(false);
    expect(a.connector.healthcheckPath).toBe(`${T}/devices`);
    const roots = ['/tailnet/-/', '/device/', '/users/', '/webhooks/'];
    for (const t of a.tools) expect(`${t.name}:${roots.some((r) => t.endpointMapping.path.startsWith(r))}`).toBe(`${t.name}:true`);
  });

  it('maps the device endpoints', () => {
    expect(tool('tailscale_list_devices').endpointMapping).toEqual({ method: 'GET', path: `${T}/devices`, queryParams: { fields: '$fields', __rawquery: '$filter' } });
    expect(tool('tailscale_get_device').endpointMapping).toEqual({ method: 'GET', path: '/device/{device_id}', queryParams: { fields: '$fields' } });
    expect(tool('tailscale_get_device_routes').endpointMapping).toEqual({ method: 'GET', path: '/device/{device_id}/routes' });
    expect(tool('tailscale_set_device_routes').endpointMapping).toEqual({ method: 'POST', path: '/device/{device_id}/routes', bodyMapping: { routes: '$routes' } });
    expect(tool('tailscale_authorize_device').endpointMapping).toEqual({ method: 'POST', path: '/device/{device_id}/authorized', bodyMapping: { authorized: '$authorized' } });
    expect(tool('tailscale_set_device_name').endpointMapping.bodyMapping).toEqual({ name: '$name' });
    expect(tool('tailscale_set_device_tags').endpointMapping).toEqual({ method: 'POST', path: '/device/{device_id}/tags', bodyMapping: { tags: '$tags' } });
    expect(tool('tailscale_set_device_key_expiry').endpointMapping).toEqual({ method: 'POST', path: '/device/{device_id}/key', bodyMapping: { keyExpiryDisabled: '$key_expiry_disabled' } });
    expect(tool('tailscale_expire_device_key').endpointMapping).toEqual({ method: 'POST', path: '/device/{device_id}/expire' });
    expect(tool('tailscale_delete_device').endpointMapping).toEqual({ method: 'DELETE', path: '/device/{device_id}' });
    expect(tool('tailscale_get_device_posture_attributes').endpointMapping.path).toBe('/device/{device_id}/attributes');
  });

  it('maps users, keys and auth key creation with the documented capabilities body', () => {
    expect(tool('tailscale_list_users').endpointMapping).toEqual({ method: 'GET', path: `${T}/users`, queryParams: { type: '$type', role: '$role' } });
    expect(tool('tailscale_get_user').endpointMapping.path).toBe('/users/{user_id}');
    expect(tool('tailscale_update_user_role').endpointMapping).toEqual({ method: 'POST', path: '/users/{user_id}/role', bodyMapping: { role: '$role' } });
    for (const action of ['approve', 'suspend', 'restore', 'delete']) {
      expect(tool(`tailscale_${action}_user`).endpointMapping).toEqual({ method: 'POST', path: `/users/{user_id}/${action}` });
    }
    expect(tool('tailscale_list_user_invites').endpointMapping).toEqual({ method: 'GET', path: `${T}/user-invites` });
    expect(tool('tailscale_list_keys').endpointMapping).toEqual({ method: 'GET', path: `${T}/keys`, queryParams: { all: '$all' } });
    expect(tool('tailscale_get_key').endpointMapping).toEqual({ method: 'GET', path: `${T}/keys/{key_id}` });
    expect(tool('tailscale_delete_key').endpointMapping).toEqual({ method: 'DELETE', path: `${T}/keys/{key_id}` });
    expect(tool('tailscale_create_auth_key').endpointMapping).toEqual({
      method: 'POST',
      path: `${T}/keys`,
      bodyMapping: {
        keyType: 'auth',
        description: '$description',
        expirySeconds: '$expiry_seconds',
        capabilities: { devices: { create: { reusable: '$reusable', ephemeral: '$ephemeral', preauthorized: '$preauthorized', tags: '$tags' } } },
      },
    });
  });

  it('maps the policy file: read with its etag, validate and preview as reads, replace with If-Match', () => {
    expect(tool('tailscale_get_policy_file').endpointMapping).toEqual({ method: 'GET', path: `${T}/acl`, queryParams: { details: '$details' }, headers: { Accept: 'application/json' }, exposeHeaders: ['etag'] });
    expect(tool('tailscale_validate_policy_file').endpointMapping).toEqual({ method: 'POST', path: `${T}/acl/validate`, bodyMapping: { __merge: '$policy' } });
    expect(tool('tailscale_preview_policy_rules').endpointMapping).toEqual({ method: 'POST', path: `${T}/acl/preview`, queryParams: { type: '$type', previewFor: '$preview_for' }, bodyMapping: { __merge: '$policy' } });
    expect(tool('tailscale_set_policy_file').endpointMapping).toEqual({ method: 'POST', path: `${T}/acl`, bodyMapping: { __merge: '$policy' }, headers: { 'If-Match': '$etag', Accept: 'application/json' } });
    for (const n of READ_POSTS) expect(tool(n).annotations?.readOnlyHint).toBe(true);
  });

  it('maps DNS, settings, logs, webhooks, Services and posture integrations', () => {
    expect(tool('tailscale_get_dns_configuration').endpointMapping).toEqual({ method: 'GET', path: `${T}/dns/configuration` });
    expect(tool('tailscale_set_dns_nameservers').endpointMapping).toEqual({ method: 'POST', path: `${T}/dns/nameservers`, bodyMapping: { dns: '$dns' } });
    expect(tool('tailscale_set_dns_preferences').endpointMapping).toEqual({ method: 'POST', path: `${T}/dns/preferences`, bodyMapping: { magicDNS: '$magic_dns' } });
    expect(tool('tailscale_set_dns_search_paths').endpointMapping).toEqual({ method: 'POST', path: `${T}/dns/searchpaths`, bodyMapping: { searchPaths: '$search_paths' } });
    expect(tool('tailscale_update_split_dns').endpointMapping).toEqual({ method: 'PATCH', path: `${T}/dns/split-dns`, bodyMapping: { __merge: '$domains' } });
    expect(tool('tailscale_get_tailnet_settings').endpointMapping).toEqual({ method: 'GET', path: `${T}/settings` });
    expect(tool('tailscale_update_tailnet_settings').endpointMapping).toMatchObject({ method: 'PATCH', path: `${T}/settings`, bodyMapping: { devicesApprovalOn: '$devices_approval_on', devicesKeyDurationDays: '$devices_key_duration_days', usersApprovalOn: '$users_approval_on', httpsEnabled: '$https_enabled' } });
    expect(tool('tailscale_get_contacts').endpointMapping.path).toBe(`${T}/contacts`);
    expect(tool('tailscale_list_configuration_audit_logs').endpointMapping).toEqual({ method: 'GET', path: `${T}/logging/configuration`, queryParams: { start: '$start', end: '$end', actor: '$actor', target: '$target', event: '$event' } });
    expect(tool('tailscale_list_network_flow_logs').endpointMapping).toEqual({ method: 'GET', path: `${T}/logging/network`, queryParams: { start: '$start', end: '$end' } });
    expect(tool('tailscale_get_log_streaming_status').endpointMapping.path).toBe(`${T}/logging/{log_type}/stream/status`);
    expect(tool('tailscale_get_log_streaming_configuration').endpointMapping.path).toBe(`${T}/logging/{log_type}/stream`);
    expect(tool('tailscale_get_log_streaming_status').parameters?.properties?.log_type.enum).toEqual(['configuration', 'network']);
    expect(tool('tailscale_list_webhooks').endpointMapping.path).toBe(`${T}/webhooks`);
    expect(tool('tailscale_get_webhook').endpointMapping.path).toBe('/webhooks/{endpoint_id}');
    expect(tool('tailscale_create_webhook').endpointMapping).toEqual({ method: 'POST', path: `${T}/webhooks`, bodyMapping: { endpointUrl: '$endpoint_url', providerType: '$provider_type', subscriptions: '$subscriptions' } });
    expect(tool('tailscale_list_services').endpointMapping.path).toBe(`${T}/services`);
    expect(tool('tailscale_get_service').endpointMapping.path).toBe(`${T}/services/{service_name}`);
    expect(tool('tailscale_list_service_hosts').endpointMapping.path).toBe(`${T}/services/{service_name}/devices`);
    expect(tool('tailscale_list_posture_integrations').endpointMapping.path).toBe(`${T}/posture/integrations`);
  });

  it('removes webhook secrets and log streaming credentials from read answers', () => {
    const hooks = applyResponseTransform({ webhooks: [{ endpointId: 'e1', endpointUrl: 'https://x', secret: 'tskey-webhook-s' }] }, tool('tailscale_list_webhooks').responseMapping as never).value;
    expect(hooks).toEqual({ webhooks: [{ endpointId: 'e1', endpointUrl: 'https://x' }] });
    const hook = applyResponseTransform({ endpointId: 'e1', secret: 's' }, tool('tailscale_get_webhook').responseMapping as never).value;
    expect(hook).toEqual({ endpointId: 'e1' });
    const stream = applyResponseTransform(
      { destinationType: 's3', url: 'https://x', token: 't', s3SecretAccessKey: 'k', gcsCredentials: 'g', s3Bucket: 'b' },
      tool('tailscale_get_log_streaming_configuration').responseMapping as never,
    ).value;
    expect(stream).toEqual({ destinationType: 's3', url: 'https://x', s3Bucket: 'b' });
    expect(tool('tailscale_create_auth_key').description).toMatch(/SECRET/);
    expect(tool('tailscale_create_webhook').description).toMatch(/SECRET/);
    expect(a.instructions).toMatch(/The AI sees whatever a tool returns/);
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
  });

  it('switches off exactly the irreversible actions and the policy replacement; writes are never marked read-only', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual([
      'tailscale_expire_device_key',
      'tailscale_delete_device',
      'tailscale_delete_user',
      'tailscale_delete_key',
      'tailscale_set_policy_file',
    ]);
    expect(a.instructions).toContain('**Switched off at install**: `tailscale_expire_device_key`, `tailscale_delete_device`, `tailscale_delete_user`, `tailscale_delete_key`; they cannot be undone');
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET' || READ_POSTS.includes(t.name)) continue;
      expect(`${t.name}:${t.annotations?.readOnlyHint === true}`).toBe(`${t.name}:false`);
    }
    for (const n of ['tailscale_delete_device', 'tailscale_delete_user', 'tailscale_delete_key']) expect(tool(n).annotations?.destructiveHint).toBe(true);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live =
  process.env.RUN_TAILSCALE_LIVE === '1' && process.env.TAILSCALE_OAUTH_CLIENT_ID && process.env.TAILSCALE_OAUTH_CLIENT_SECRET ? describe : describe.skip;
live('tailscale adapter: live (read-only)', () => {
  let token = '';
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as Record<string, unknown>;
  };
  beforeAll(async () => {
    const res = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.TAILSCALE_OAUTH_CLIENT_ID ?? '',
        client_secret: process.env.TAILSCALE_OAUTH_CLIENT_SECRET ?? '',
      }),
    });
    expect(res.status).toBe(200);
    token = ((await res.json()) as { access_token: string }).access_token;
  });
  it('reads devices, users, keys, DNS, settings and the policy file', async () => {
    const devices = (await get(`${T}/devices`)).devices as Array<{ nodeId: string }>;
    expect(Array.isArray(devices)).toBe(true);
    if (devices[0]) expect((await get(`/device/${devices[0].nodeId}/routes`)).enabledRoutes).toBeDefined();
    expect(Array.isArray((await get(`${T}/users`)).users)).toBe(true);
    expect(Array.isArray((await get(`${T}/keys`)).keys)).toBe(true);
    expect(await get(`${T}/dns/configuration`)).toBeDefined();
    expect(await get(`${T}/settings`)).toHaveProperty('devicesApprovalOn');
    expect(await get(`${T}/acl`)).toBeDefined();
  }, 60_000);
});
