import * as adapter from './hostinger.json';

/**
 * Hostinger public API (developers.hostinger.com, OpenAPI at github.com/hostinger/api/openapi.json):
 * base https://developers.hostinger.com/api/<area>/v1, Bearer token from hPanel, page-numbered lists.
 * Live part (reads only: subscriptions, domains, VPS list, data centers, templates):
 *   HOSTINGER_API_TOKEN=... RUN_HOSTINGER_LIVE=1 npx jest src/adapters/intl/hostinger
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
const PREFIX = 'hostinger_';
const VM = '/api/vps/v1/virtual-machines/{virtual_machine_id}';

describe('hostinger adapter: static spec conformance', () => {
  it('authenticates with a Bearer token against developers.hostinger.com', () => {
    expect(a.requiredEnvVars).toEqual(['HOSTINGER_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://developers.hostinger.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{HOSTINGER_API_TOKEN}}' });
    expect(a.envVarMeta?.HOSTINGER_API_TOKEN.secret).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/api\/(vps|domains|dns|billing|hosting)\/v1\//);
  });

  it('leaves out everything that buys, pays or cancels', () => {
    for (const t of a.tools) {
      const key = `${t.endpointMapping.method} ${t.endpointMapping.path}`;
      expect(key).not.toBe('POST /api/vps/v1/virtual-machines');
      expect(key).not.toBe('POST /api/domains/v1/portfolio');
      expect(key).not.toMatch(/billing\/v1\/(orders|subscriptions\/|payment-methods\/)/);
      expect(key).not.toMatch(/recreate|root-password|panel-password/);
    }
    for (const n of ['hostinger_list_subscriptions', 'hostinger_list_payment_methods', 'hostinger_get_catalog']) expect(tool(n).endpointMapping.method).toBe('GET');
  });

  it('maps the VPS endpoints', () => {
    expect(tool('hostinger_list_virtual_machines').endpointMapping).toEqual({ method: 'GET', path: '/api/vps/v1/virtual-machines' });
    expect(tool('hostinger_get_virtual_machine').endpointMapping).toEqual({ method: 'GET', path: VM });
    expect(tool('hostinger_get_vm_metrics').endpointMapping).toEqual({ method: 'GET', path: `${VM}/metrics`, queryParams: { date_from: '$date_from', date_to: '$date_to' } });
    expect(tool('hostinger_get_vm_metrics').parameters?.required).toEqual(['virtual_machine_id', 'date_from', 'date_to']);
    expect(tool('hostinger_get_vm_action').endpointMapping.path).toBe(`${VM}/actions/{action_id}`);
    for (const op of ['start', 'stop', 'restart']) expect(tool(`hostinger_${op}_vm`).endpointMapping).toEqual({ method: 'POST', path: `${VM}/${op}` });
    expect(tool('hostinger_set_vm_hostname').endpointMapping).toEqual({ method: 'PUT', path: `${VM}/hostname`, bodyMapping: { hostname: '$hostname' } });
    expect(tool('hostinger_restore_vm_backup').endpointMapping).toEqual({ method: 'POST', path: `${VM}/backups/{backup_id}/restore` });
    expect(tool('hostinger_create_vm_snapshot').endpointMapping).toEqual({ method: 'POST', path: `${VM}/snapshot` });
    expect(tool('hostinger_restore_vm_snapshot').endpointMapping).toEqual({ method: 'POST', path: `${VM}/snapshot/restore` });
    expect(tool('hostinger_get_docker_project_logs').endpointMapping.path).toBe(`${VM}/docker/{project_name}/logs`);
    expect(tool('hostinger_create_firewall_rule').endpointMapping).toEqual({
      method: 'POST',
      path: '/api/vps/v1/firewall/{firewall_id}/rules',
      bodyMapping: { protocol: '$protocol', port: '$port', source: '$source', source_detail: '$source_detail' },
    });
    expect(tool('hostinger_update_firewall_rule').endpointMapping.path).toBe('/api/vps/v1/firewall/{firewall_id}/rules/{rule_id}');
    expect(tool('hostinger_sync_firewall').endpointMapping).toEqual({ method: 'POST', path: '/api/vps/v1/firewall/{firewall_id}/sync' });
    expect(tool('hostinger_activate_firewall').endpointMapping.path).toBe('/api/vps/v1/firewall/{firewall_id}/activate/{virtual_machine_id}');
  });

  it('maps domains, DNS, billing and hosting', () => {
    expect(tool('hostinger_list_domains').endpointMapping).toEqual({ method: 'GET', path: '/api/domains/v1/portfolio' });
    expect(tool('hostinger_check_domain_availability').endpointMapping).toEqual({
      method: 'POST',
      path: '/api/domains/v1/availability',
      bodyMapping: { domain: '$domain', tlds: '$tlds', with_alternatives: '$with_alternatives' },
    });
    expect(tool('hostinger_update_domain_nameservers').endpointMapping.bodyMapping).toEqual({ ns1: '$ns1', ns2: '$ns2', ns3: '$ns3', ns4: '$ns4' });
    expect(tool('hostinger_get_dns_records').endpointMapping).toEqual({ method: 'GET', path: '/api/dns/v1/zones/{domain}' });
    expect(tool('hostinger_update_dns_records').endpointMapping).toEqual({ method: 'PUT', path: '/api/dns/v1/zones/{domain}', bodyMapping: { zone: '$zone', overwrite: '$overwrite' } });
    expect(tool('hostinger_validate_dns_records').endpointMapping.path).toBe('/api/dns/v1/zones/{domain}/validate');
    expect(tool('hostinger_delete_dns_records').endpointMapping).toEqual({ method: 'DELETE', path: '/api/dns/v1/zones/{domain}', bodyMapping: { filters: '$filters' } });
    expect(tool('hostinger_restore_dns_snapshot').endpointMapping.path).toBe('/api/dns/v1/snapshots/{domain}/{snapshot_id}/restore');
    expect(tool('hostinger_get_catalog').endpointMapping).toEqual({ method: 'GET', path: '/api/billing/v1/catalog', queryParams: { category: '$category', name: '$name' } });
    // Laravel reads array filters only in the bracketed form statuses[]=a&statuses[]=b.
    expect(tool('hostinger_list_hosting_orders').endpointMapping.queryParams).toEqual({ page: '$page', per_page: '$per_page', 'statuses[]': '$statuses', 'order_ids[]': '$order_ids' });
    expect(tool('hostinger_list_websites').endpointMapping.queryParams).toMatchObject({ website_types: '$website_types', is_enabled: '$is_enabled' });
    expect(tool('hostinger_list_databases').endpointMapping.path).toBe('/api/hosting/v1/accounts/{username}/databases');
    expect(tool('hostinger_clear_website_cache').endpointMapping).toEqual({
      method: 'DELETE',
      path: '/api/hosting/v1/accounts/{username}/websites/{domain}/cache/clear',
      queryParams: { directory: '$directory' },
    });
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

  it('annotates every write, marks restores and deletes destructive, and the POST checks read-only', () => {
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:false`);
      else expect(`${t.name}:${typeof t.annotations?.readOnlyHint}`).toBe(`${t.name}:boolean`);
      if (t.endpointMapping.method === 'DELETE') expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
    }
    expect(tool('hostinger_check_domain_availability').annotations?.readOnlyHint).toBe(true);
    expect(tool('hostinger_validate_dns_records').annotations?.readOnlyHint).toBe(true);
    for (const n of [
      'hostinger_stop_vm',
      'hostinger_restart_vm',
      'hostinger_restore_vm_backup',
      'hostinger_create_vm_snapshot',
      'hostinger_restore_vm_snapshot',
      'hostinger_update_dns_records',
      'hostinger_restore_dns_snapshot',
      'hostinger_update_domain_nameservers',
      'hostinger_activate_firewall',
      'hostinger_deactivate_firewall',
    ]) {
      expect(`${n}:${tool(n).annotations?.readOnlyHint}:${tool(n).annotations?.destructiveHint}`).toBe(`${n}:false:true`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_HOSTINGER_LIVE === '1' && process.env.HOSTINGER_API_TOKEN ? describe : describe.skip;
live('hostinger adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.HOSTINGER_API_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as unknown;
  };
  it('reads subscriptions, domains, virtual machines, data centers and templates', async () => {
    expect(Array.isArray(await get('/api/billing/v1/subscriptions'))).toBe(true);
    expect(Array.isArray(await get('/api/domains/v1/portfolio'))).toBe(true);
    const vms = (await get('/api/vps/v1/virtual-machines')) as Array<{ id: number }>;
    expect(Array.isArray(vms)).toBe(true);
    if (vms[0]) expect(await get(`/api/vps/v1/virtual-machines/${vms[0].id}`)).toMatchObject({ id: vms[0].id });
    expect(Array.isArray(await get('/api/vps/v1/data-centers'))).toBe(true);
    expect(Array.isArray(await get('/api/vps/v1/templates'))).toBe(true);
  }, 60_000);
});
