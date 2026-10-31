import * as adapter from './clickhouse-cloud.json';

/**
 * ClickHouse Cloud control-plane API (OpenAPI at https://api.clickhouse.cloud/v1):
 * base https://api.clickhouse.cloud, HTTP Basic auth with the API key id as user and
 * the key secret as password, answers wrapped as {status, requestId, result}.
 * Live part (reads only: organizations, services, members, a usage cost report):
 *   CLICKHOUSE_CLOUD_KEY_ID=... CLICKHOUSE_CLOUD_KEY_SECRET=... RUN_CLICKHOUSE_CLOUD_LIVE=1 npx jest src/adapters/intl/clickhouse-cloud
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { secret?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
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
const PREFIX = 'clickhouse_cloud_';
const ORG = '/v1/organizations/{organization_id}';
const SVC = `${ORG}/services/{service_id}`;

describe('clickhouse-cloud adapter: static spec conformance', () => {
  it('authenticates with Basic auth: key id as user, key secret as password', () => {
    expect(a.requiredEnvVars).toEqual(['CLICKHOUSE_CLOUD_KEY_ID', 'CLICKHOUSE_CLOUD_KEY_SECRET']);
    expect(a.connector.baseUrl).toBe('https://api.clickhouse.cloud');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{CLICKHOUSE_CLOUD_KEY_ID}}', password: '{{CLICKHOUSE_CLOUD_KEY_SECRET}}' });
    expect(a.envVarMeta?.CLICKHOUSE_CLOUD_KEY_SECRET.secret).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/v1\//);
  });

  it('maps the organization and service reads to the documented paths', () => {
    expect(tool('clickhouse_cloud_whoami').endpointMapping).toEqual({ method: 'GET', path: '/v1/whoami' });
    expect(tool('clickhouse_cloud_list_organizations').endpointMapping).toEqual({ method: 'GET', path: '/v1/organizations', queryParams: { limit: '$limit', cursor: '$cursor' } });
    expect(tool('clickhouse_cloud_list_services').endpointMapping).toEqual({ method: 'GET', path: `${ORG}/services`, queryParams: { filter: '$filter' } });
    expect(tool('clickhouse_cloud_get_service').endpointMapping.path).toBe(SVC);
    expect(tool('clickhouse_cloud_get_service_settings').endpointMapping.path).toBe(`${SVC}/clickhouseSettings`);
    expect(tool('clickhouse_cloud_get_service_metrics').endpointMapping).toEqual({ method: 'GET', path: `${SVC}/prometheus`, queryParams: { filtered_metrics: '$filtered_metrics' } });
    expect(tool('clickhouse_cloud_list_backups').endpointMapping.path).toBe(`${SVC}/backups`);
    expect(tool('clickhouse_cloud_get_backup').endpointMapping.path).toBe(`${SVC}/backups/{backup_id}`);
    expect(tool('clickhouse_cloud_get_backup_configuration').endpointMapping.path).toBe(`${SVC}/backupConfiguration`);
    expect(tool('clickhouse_cloud_list_clickpipes').endpointMapping.path).toBe(`${SVC}/clickpipes`);
    expect(tool('clickhouse_cloud_get_clickpipe').endpointMapping.path).toBe(`${SVC}/clickpipes/{clickpipe_id}`);
    expect(tool('clickhouse_cloud_get_usage_cost').endpointMapping).toEqual({ method: 'GET', path: `${ORG}/usageCost`, queryParams: { from_date: '$from_date', to_date: '$to_date', filter: '$filter' } });
    expect(tool('clickhouse_cloud_get_usage_cost').parameters?.required).toEqual(['organization_id', 'from_date', 'to_date']);
    expect(tool('clickhouse_cloud_get_credit_balances').endpointMapping.path).toBe(`${ORG}/creditBalances`);
    expect(tool('clickhouse_cloud_list_activities').endpointMapping.queryParams).toEqual({ from_date: '$from_date', to_date: '$to_date' });
    expect(tool('clickhouse_cloud_list_notifications').endpointMapping.queryParams).toMatchObject({ severity: '$severity', resource_type: '$resource_type', cursor: '$cursor' });
    for (const [n, p] of [['list_quotas', 'quotas'], ['list_members', 'members'], ['list_invitations', 'invitations'], ['list_roles', 'roles'], ['list_api_keys', 'keys']]) {
      expect(tool(PREFIX + n).endpointMapping.path).toBe(`${ORG}/${p}`);
    }
  });

  it('maps the writes with the documented bodies and PATCH verbs', () => {
    expect(tool('clickhouse_cloud_change_service_state').endpointMapping).toEqual({ method: 'PATCH', path: `${SVC}/state`, bodyMapping: { command: '$command' } });
    expect(tool('clickhouse_cloud_change_service_state').parameters?.properties?.command.enum).toEqual(['start', 'stop', 'awake']);
    expect(tool('clickhouse_cloud_update_service').endpointMapping).toEqual({ method: 'PATCH', path: SVC, bodyMapping: { name: '$name', releaseChannel: '$release_channel', ipAccessList: '$ip_access_list', tags: '$tags' } });
    expect(tool('clickhouse_cloud_update_replica_scaling').endpointMapping).toMatchObject({ method: 'PATCH', path: `${SVC}/replicaScaling`, bodyMapping: { minReplicaMemoryGb: '$min_replica_memory_gb', maxReplicaMemoryGb: '$max_replica_memory_gb', idleScaling: '$idle_scaling', idleTimeoutMinutes: '$idle_timeout_minutes' } });
    expect(tool('clickhouse_cloud_change_clickpipe_state').endpointMapping).toEqual({ method: 'PATCH', path: `${SVC}/clickpipes/{clickpipe_id}/state`, bodyMapping: { command: '$command' } });
    expect(tool('clickhouse_cloud_create_invitation').endpointMapping).toEqual({ method: 'POST', path: `${ORG}/invitations`, bodyMapping: { email: '$email', assignedRoleIds: '$assigned_role_ids' } });
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort();
    expect(writes).toEqual(['change_clickpipe_state', 'change_service_state', 'create_invitation', 'update_replica_scaling', 'update_service'].map((n) => PREFIX + n));
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('switches nothing off: no delete or irreversible action is mapped', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual([]);
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

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_CLICKHOUSE_CLOUD_LIVE === '1' && process.env.CLICKHOUSE_CLOUD_KEY_ID && process.env.CLICKHOUSE_CLOUD_KEY_SECRET ? describe : describe.skip;
live('clickhouse-cloud adapter: live (read-only)', () => {
  const auth = `Basic ${Buffer.from(`${process.env.CLICKHOUSE_CLOUD_KEY_ID}:${process.env.CLICKHOUSE_CLOUD_KEY_SECRET}`).toString('base64')}`;
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: auth, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as { result: unknown };
  };
  it('reads organizations, services, members and the last week of usage cost', async () => {
    const orgs = (await get('/v1/organizations')).result as Array<{ id: string }>;
    expect(orgs.length).toBeGreaterThan(0);
    const org = orgs[0].id;
    expect(Array.isArray((await get(`/v1/organizations/${org}/services`)).result)).toBe(true);
    expect(Array.isArray((await get(`/v1/organizations/${org}/members`)).result)).toBe(true);
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    const cost = (await get(`/v1/organizations/${org}/usageCost?from_date=${day(7)}&to_date=${day(1)}`)).result as { costs: unknown[] };
    expect(Array.isArray(cost.costs)).toBe(true);
  }, 60_000);
});
