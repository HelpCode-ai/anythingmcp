import * as adapter from './ninjaone.json';

/**
 * NinjaOne Public API v2 (app.ninjarmm.com/apidocs): per-instance host https://{host}/v2,
 * OAuth 2.0 client credentials at https://{host}/ws/oauth/token, scope "monitoring management".
 * Live part: NINJAONE_HOST=eu.ninjarmm.com NINJAONE_CLIENT_ID=... NINJAONE_CLIENT_SECRET=... RUN_NINJAONE_LIVE=1 npx jest src/adapters/intl/ninjaone
 * (reads only: organizations, devices, device health).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'ninjaone_';
const SWITCHED_OFF = ['ninjaone_reboot_device', 'ninjaone_apply_os_patches'];
// POST that only reads (runs a saved ticket view).
const READ_POSTS = ['ninjaone_run_ticket_board'];

describe('ninjaone adapter: static spec conformance', () => {
  it('calls the instance host with OAuth 2.0 client credentials', () => {
    expect(a.slug).toBe('ninjaone');
    expect(a.category).toBe('itsm');
    expect(a.requiredEnvVars).toEqual(['NINJAONE_HOST', 'NINJAONE_CLIENT_ID', 'NINJAONE_CLIENT_SECRET']);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://{{NINJAONE_HOST}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{NINJAONE_CLIENT_ID}}',
      clientSecret: '{{NINJAONE_CLIENT_SECRET}}',
      tokenUrl: 'https://{{NINJAONE_HOST}}/ws/oauth/token',
      tokenAuthMethod: 'client_secret_post',
      scope: 'monitoring management',
    });
    expect(a.envVarMeta?.NINJAONE_CLIENT_SECRET.secret).toBe(true);
    expect(a.probe).toEqual({ tool: 'ninjaone_list_organizations', params: { page_size: 1 } });
  });

  it('accepts only the regional instance hosts', () => {
    const host = new RegExp(a.envVarMeta?.NINJAONE_HOST.pattern ?? '');
    for (const ok of ['app.ninjarmm.com', 'us2.ninjarmm.com', 'eu.ninjarmm.com', 'ca.ninjarmm.com', 'oc.ninjarmm.com', 'jp.ninjarmm.com', 'fed.ninjarmm.com']) {
      expect(`${ok}:${host.test(ok)}`).toBe(`${ok}:true`);
    }
    for (const bad of ['https://eu.ninjarmm.com', 'eu.ninjarmm.com/', 'api.ninjarmm.com', 'eu.ninjaone.com', 'example.com']) {
      expect(`${bad}:${host.test(bad)}`).toBe(`${bad}:false`);
    }
  });

  it('covers the organization, device and monitoring routes', () => {
    expect(tool('ninjaone_list_organizations').endpointMapping).toEqual({
      method: 'GET',
      path: '/v2/organizations',
      queryParams: { pageSize: '$page_size', after: '$after', of: '$org_filter' },
    });
    expect(tool('ninjaone_get_organization').endpointMapping).toEqual({ method: 'GET', path: '/v2/organization/{organization_id}' });
    expect(tool('ninjaone_list_organization_locations').endpointMapping.path).toBe('/v2/organization/{organization_id}/locations');
    expect(tool('ninjaone_list_organization_devices').endpointMapping).toMatchObject({ path: '/v2/organization/{organization_id}/devices', queryParams: { pageSize: '$page_size', after: '$after' } });
    expect(tool('ninjaone_list_devices').endpointMapping).toMatchObject({ method: 'GET', path: '/v2/devices', queryParams: { df: '$df', pageSize: '$page_size', after: '$after' } });
    expect(tool('ninjaone_list_devices_detailed').endpointMapping).toMatchObject({ method: 'GET', path: '/v2/devices-detailed', queryParams: { df: '$df' } });
    expect(tool('ninjaone_search_devices').endpointMapping).toMatchObject({ path: '/v2/devices/search', queryParams: { q: '$q', limit: '$limit' } });
    expect(tool('ninjaone_get_device').endpointMapping).toEqual({ method: 'GET', path: '/v2/device/{device_id}' });
    expect(tool('ninjaone_list_device_alerts').endpointMapping.path).toBe('/v2/device/{device_id}/alerts');
    expect(tool('ninjaone_list_device_activities').endpointMapping).toMatchObject({ path: '/v2/device/{device_id}/activities', queryParams: { olderThan: '$older_than', activityType: '$activity_type' } });
    expect(tool('ninjaone_list_device_software').endpointMapping.path).toBe('/v2/device/{device_id}/software');
    expect(tool('ninjaone_list_device_os_patches').endpointMapping.path).toBe('/v2/device/{device_id}/os-patches');
    expect(tool('ninjaone_list_alerts').endpointMapping).toMatchObject({ method: 'GET', path: '/v2/alerts', queryParams: { df: '$df', sourceType: '$source_type' } });
    expect(tool('ninjaone_list_activities').endpointMapping).toMatchObject({ method: 'GET', path: '/v2/activities', queryParams: { class: '$activity_class', olderThan: '$older_than', df: '$df' } });
  });

  it('maps every query report with df, cursor and pageSize', () => {
    const queries: Record<string, string> = {
      ninjaone_query_device_health: '/v2/queries/device-health',
      ninjaone_query_os_patches: '/v2/queries/os-patches',
      ninjaone_query_os_patch_installs: '/v2/queries/os-patch-installs',
      ninjaone_query_software: '/v2/queries/software',
      ninjaone_query_antivirus_status: '/v2/queries/antivirus-status',
      ninjaone_query_antivirus_threats: '/v2/queries/antivirus-threats',
      ninjaone_query_volumes: '/v2/queries/volumes',
      ninjaone_query_operating_systems: '/v2/queries/operating-systems',
      ninjaone_query_computer_systems: '/v2/queries/computer-systems',
    };
    for (const [name, path] of Object.entries(queries)) {
      expect(tool(name).endpointMapping).toMatchObject({ method: 'GET', path, queryParams: { df: '$df', cursor: '$cursor', pageSize: '$page_size' } });
    }
    expect(tool('ninjaone_query_device_health').endpointMapping.queryParams).toMatchObject({ health: '$health' });
    expect(tool('ninjaone_query_volumes').endpointMapping.queryParams).toMatchObject({ include: '$include' });
  });

  it('maps management, users, ticketing and related items', () => {
    expect(tool('ninjaone_list_policies').endpointMapping).toEqual({ method: 'GET', path: '/v2/policies' });
    expect(tool('ninjaone_list_groups').endpointMapping).toEqual({ method: 'GET', path: '/v2/groups' });
    expect(tool('ninjaone_list_technicians').endpointMapping).toEqual({ method: 'GET', path: '/v2/user/technicians' });
    expect(tool('ninjaone_list_end_users').endpointMapping).toEqual({ method: 'GET', path: '/v2/user/end-users' });
    expect(tool('ninjaone_list_ticket_boards').endpointMapping).toEqual({ method: 'GET', path: '/v2/ticketing/trigger/boards' });
    expect(tool('ninjaone_run_ticket_board').endpointMapping).toEqual({
      method: 'POST',
      path: '/v2/ticketing/trigger/board/{board_id}/run',
      bodyMapping: { searchCriteria: '$search', filters: '$filters', sortBy: '$sort_by', includeColumns: '$include_columns', pageSize: '$page_size', lastCursorId: '$last_cursor_id' },
    });
    expect(tool('ninjaone_get_ticket').endpointMapping).toEqual({ method: 'GET', path: '/v2/ticketing/ticket/{ticket_id}' });
    expect(tool('ninjaone_list_ticket_log_entries').endpointMapping).toMatchObject({ path: '/v2/ticketing/ticket/{ticket_id}/log-entry', queryParams: { type: '$type', anchorId: '$anchor_id' } });
    expect(tool('ninjaone_list_ticket_statuses').endpointMapping).toEqual({ method: 'GET', path: '/v2/ticketing/statuses' });
    expect(tool('ninjaone_list_related_items').endpointMapping).toEqual({ method: 'GET', path: '/v2/related-items' });
    expect(tool('ninjaone_list_entity_related_items').endpointMapping).toMatchObject({ path: '/v2/related-items/with-entity/{entity_type}/{entity_id}', queryParams: { scope: '$scope' } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      expect(t.endpointMapping.path.startsWith('/v2/')).toBe(true);
    }
  });

  it('device actions install switched off and are destructive; everything else reads; no deletes or ticket writes', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...SWITCHED_OFF].sort());
    for (const n of SWITCHED_OFF) {
      expect(tool(n).annotations?.destructiveHint).toBe(true);
      expect(tool(n).annotations?.readOnlyHint).toBe(false);
    }
    expect(tool('ninjaone_reboot_device').endpointMapping).toEqual({ method: 'POST', path: '/v2/device/{device_id}/reboot/{mode}', bodyMapping: { reason: '$reason' } });
    expect(tool('ninjaone_apply_os_patches').endpointMapping).toEqual({ method: 'POST', path: '/v2/device/{device_id}/patch/os/apply' });
    for (const t of a.tools) {
      expect(t.endpointMapping.method).not.toBe('DELETE');
      expect(t.endpointMapping.path).not.toMatch(/script|decommission|maintenance|approval|\/ticketing\/ticket$|\/comment/);
      if (SWITCHED_OFF.includes(t.name)) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      if (!READ_POSTS.includes(t.name)) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    }
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toContain('API Services (machine-to-machine)');
    expect(a.instructions).toContain('/ws/oauth/token');
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env;
const live = env.RUN_NINJAONE_LIVE === '1' && env.NINJAONE_HOST && env.NINJAONE_CLIENT_ID && env.NINJAONE_CLIENT_SECRET ? describe : describe.skip;
live('ninjaone adapter: live (read-only)', () => {
  const base = `https://${env.NINJAONE_HOST}`;
  let headers: Record<string, string> = {};
  beforeAll(async () => {
    const res = await fetch(`${base}/ws/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: String(env.NINJAONE_CLIENT_ID),
        client_secret: String(env.NINJAONE_CLIENT_SECRET),
        scope: 'monitoring management',
      }).toString(),
    });
    expect(res.status).toBe(200);
    const token = ((await res.json()) as { access_token: string }).access_token;
    headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  }, 30_000);

  it('reads organizations, devices and device health', async () => {
    const orgs = (await (await fetch(`${base}/v2/organizations?pageSize=5`, { headers })).json()) as unknown[];
    expect(Array.isArray(orgs)).toBe(true);
    const devices = (await (await fetch(`${base}/v2/devices?pageSize=5`, { headers })).json()) as unknown[];
    expect(Array.isArray(devices)).toBe(true);
    const health = (await (await fetch(`${base}/v2/queries/device-health?pageSize=5`, { headers })).json()) as { results: unknown[] };
    expect(Array.isArray(health.results)).toBe(true);
  }, 60_000);
});
