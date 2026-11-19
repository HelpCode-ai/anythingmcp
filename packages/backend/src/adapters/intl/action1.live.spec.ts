import * as adapter from './action1.json';

/**
 * Action1 API 3.0 adapter.
 *
 * Static checks always run: the five regional hosts offered as choices, the
 * client-credentials token request on the same host, every tool's method and
 * path against the OpenAPI document behind https://app.action1.com/apidocs/,
 * the paging parameters, and that nothing deploys, reboots, runs scripts or
 * deletes (the only write that is on renames an endpoint in the console).
 *
 * Live checks run only with RUN_ACTION1_LIVE=1. Without credentials they confirm
 * that the token endpoint refuses wrong ones with 400; with ACTION1_API_URL,
 * ACTION1_CLIENT_ID and ACTION1_CLIENT_SECRET they read the organizations and
 * one page of endpoints. Nothing is written.
 *
 *   RUN_ACTION1_LIVE=1 ACTION1_API_URL=https://app.eu.action1.com/api/3.0 \
 *     ACTION1_CLIENT_ID=... ACTION1_CLIENT_SECRET=... npx jest src/adapters/intl/action1.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  prerequisites?: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; help?: string; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
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
// Text outside `code` spans: the website renders descriptions as MDX.
const prose = (text: string) => text.replace(/`[^`]*`/g, '');

const PREFIX = 'action1_';
// Method and path of every tool, as the vendor documents them.
const ROUTES: Record<string, [string, string]> = {
  action1_list_organizations: ['GET', '/organizations'],
  action1_get_current_user: ['GET', '/me'],
  action1_search: ['GET', '/search/{org_id}'],
  action1_list_endpoints: ['GET', '/endpoints/managed/{org_id}'],
  action1_get_endpoint: ['GET', '/endpoints/managed/{org_id}/{endpoint_id}'],
  action1_update_endpoint: ['PATCH', '/endpoints/managed/{org_id}/{endpoint_id}'],
  action1_list_endpoint_missing_updates: ['GET', '/endpoints/managed/{org_id}/{endpoint_id}/missing-updates'],
  action1_list_endpoint_groups: ['GET', '/endpoints/groups/{org_id}'],
  action1_get_endpoint_group: ['GET', '/endpoints/groups/{org_id}/{group_id}'],
  action1_list_group_endpoints: ['GET', '/endpoints/groups/{org_id}/{group_id}/contents'],
  action1_list_missing_updates: ['GET', '/updates/{org_id}'],
  action1_list_package_updates: ['GET', '/updates/{org_id}/{package_id}'],
  action1_list_update_endpoints: ['GET', '/updates/{org_id}/{package_id}/versions/{version_id}/endpoints'],
  action1_list_vulnerabilities: ['GET', '/vulnerabilities/{org_id}'],
  action1_get_vulnerability: ['GET', '/vulnerabilities/{org_id}/{cve_id}'],
  action1_list_vulnerability_endpoints: ['GET', '/vulnerabilities/{org_id}/{cve_id}/endpoints'],
  action1_list_vulnerability_remediations: ['GET', '/vulnerabilities/{org_id}/{cve_id}/remediations'],
  action1_get_cve_description: ['GET', '/CVE-descriptions/{cve_id}'],
  action1_list_installed_software: ['GET', '/installed-software/{org_id}/data'],
  action1_list_endpoint_installed_software: ['GET', '/installed-software/{org_id}/data/{endpoint_id}'],
  action1_list_reports: ['GET', '/reports/all'],
  action1_list_report_category: ['GET', '/reports/all/{report_or_category_id}'],
  action1_get_report_data: ['GET', '/reportdata/{org_id}/{report_id}/data'],
  action1_drilldown_report_row: ['GET', '/reportdata/{org_id}/{report_id}/data/{report_row_id}/drilldown'],
  action1_requery_report: ['POST', '/reportdata/{org_id}/{report_id}/requery'],
  action1_list_automation_schedules: ['GET', '/automations/schedules/{org_id}'],
  action1_get_automation_schedule: ['GET', '/automations/schedules/{org_id}/{automation_id}'],
  action1_list_automation_instances: ['GET', '/automations/instances/{org_id}'],
  action1_get_automation_instance: ['GET', '/automations/instances/{org_id}/{instance_id}'],
  action1_list_automation_endpoint_results: ['GET', '/automations/instances/{org_id}/{instance_id}/endpoint-results'],
  action1_list_software_repository: ['GET', '/software-repository/{org_id}'],
  action1_list_audit_events: ['GET', '/audit/events'],
};
const REQUIRED: Record<string, string[]> = {
  action1_search: ['org_id', 'query'],
  action1_list_endpoints: ['org_id'],
  action1_get_endpoint: ['org_id', 'endpoint_id'],
  action1_update_endpoint: ['org_id', 'endpoint_id'],
  action1_list_endpoint_missing_updates: ['org_id', 'endpoint_id'],
  action1_list_endpoint_groups: ['org_id'],
  action1_get_endpoint_group: ['org_id', 'group_id'],
  action1_list_group_endpoints: ['org_id', 'group_id'],
  action1_list_missing_updates: ['org_id'],
  action1_list_package_updates: ['org_id', 'package_id'],
  action1_list_update_endpoints: ['org_id', 'package_id', 'version_id'],
  action1_list_vulnerabilities: ['org_id'],
  action1_get_vulnerability: ['org_id', 'cve_id'],
  action1_list_vulnerability_endpoints: ['org_id', 'cve_id'],
  action1_list_vulnerability_remediations: ['org_id', 'cve_id'],
  action1_get_cve_description: ['cve_id'],
  action1_list_installed_software: ['org_id'],
  action1_list_endpoint_installed_software: ['org_id', 'endpoint_id'],
  action1_list_report_category: ['report_or_category_id'],
  action1_get_report_data: ['org_id', 'report_id'],
  action1_drilldown_report_row: ['org_id', 'report_id', 'report_row_id'],
  action1_requery_report: ['org_id', 'report_id'],
  action1_list_automation_schedules: ['org_id'],
  action1_get_automation_schedule: ['org_id', 'automation_id'],
  action1_list_automation_instances: ['org_id'],
  action1_get_automation_instance: ['org_id', 'instance_id'],
  action1_list_automation_endpoint_results: ['org_id', 'instance_id'],
  action1_list_software_repository: ['org_id'],
};
// Installed switched off: an administrator turns them on per connector.
const SWITCHED_OFF: string[] = ['action1_requery_report'];
// Writes that are on at install.
const WRITES: string[] = ['action1_update_endpoint'];
// POST requests that only read (searches and log queries).
const READ_POSTS: string[] = [];

describe('action1 adapter: static contract', () => {
  it('declares the catalog envelope, the base URL and the authentication', () => {
    expect(a.slug).toBe('action1');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('itsm');
    expect(a.icon).toBe('action1');
    expect(a.requiredEnvVars).toEqual(['ACTION1_API_URL', 'ACTION1_CLIENT_ID', 'ACTION1_CLIENT_SECRET']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{ACTION1_API_URL}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({ grant: 'client_credentials', clientId: '{{ACTION1_CLIENT_ID}}', clientSecret: '{{ACTION1_CLIENT_SECRET}}', tokenUrl: '{{ACTION1_API_URL}}/oauth2/token', tokenAuthMethod: 'client_secret_post' });
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(`${name}:${Boolean(a.envVarMeta[name]?.help)}`).toBe(`${name}:true`);
      expect(`${name}:${a.envVarMeta[name]?.secret === true}`).toBe(`${name}:${(['ACTION1_CLIENT_SECRET'] as string[]).includes(name)}`);
    }
    // An optional variable in a connector header would be sent as the literal placeholder.
    for (const name of a.optionalEnvVars ?? []) expect(JSON.stringify(a.connector.headers ?? {})).not.toContain(name);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'action1_list_organizations' });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['400', '401', '403', '404', 'rate_limited', 'auth_failed']) expect(`${key}:${Boolean(a.verifyHints[key])}`).toBe(`${key}:true`);
  });

  it('maps every tool to its documented method and path', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const t of a.tools) {
      expect(`${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${t.name} ${ROUTES[t.name][0]} ${ROUTES[t.name][1]}`);
      expect(`${t.name}:${JSON.stringify(t.parameters?.required ?? [])}`).toBe(`${t.name}:${JSON.stringify(REQUIRED[t.name] ?? [])}`);
    }
  });

  it('prefixes every tool, sends every declared parameter, declares every argument it reads and requires its path parameters', () => {
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) {
        expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
        expect(`${t.name}:${p}:${Boolean(t.parameters?.properties?.[p]?.description)}`).toBe(`${t.name}:${p}:true`);
      }
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p) || envNames.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required ?? []).toContain(p);
    }
  });

  it('installs deletes and other risky calls switched off and marks reading POSTs read-only', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
    for (const t of a.tools) {
      const method = t.endpointMapping.method;
      if (method === 'DELETE') expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:false`);
      if (READ_POSTS.includes(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      else expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:undefined`);
      const reads = method === 'GET' || READ_POSTS.includes(t.name);
      expect(`${t.name}:${reads || WRITES.includes(t.name) || SWITCHED_OFF.includes(t.name)}`).toBe(`${t.name}:true`);
      if (reads) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const texts = [a.description, a.instructions, a.prerequisites ?? '', ...Object.values(a.verifyHints)];
    for (const t of a.tools) {
      texts.push(t.description);
      for (const p of Object.values(t.parameters?.properties ?? {})) texts.push(p.description ?? '');
    }
    for (const text of texts) expect(prose(text)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });


  it('offers the five regions and requests the token on the same host', () => {
    const meta = a.envVarMeta.ACTION1_API_URL;
    expect(meta.options?.map((o) => o.value)).toEqual([
      'https://app.action1.com/api/3.0',
      'https://app.na-2.action1.com/api/3.0',
      'https://app.eu.action1.com/api/3.0',
      'https://app.uk.action1.com/api/3.0',
      'https://app.au.action1.com/api/3.0',
    ]);
    const url = new RegExp(meta.pattern ?? '');
    for (const o of meta.options ?? []) expect(`${o.value}:${url.test(o.value)}`).toBe(`${o.value}:true`);
    for (const bad of ['https://app.action1.com', 'https://app.action1.com/api/3.0/', 'http://app.eu.action1.com/api/3.0', 'https://evil.example.com/api/3.0']) {
      expect(`${bad}:${url.test(bad)}`).toBe(`${bad}:false`);
    }
    expect(String(a.connector.authConfig.tokenUrl).startsWith(a.connector.baseUrl)).toBe(true);
    // Wrong credentials are answered with 400 at the token endpoint.
    expect(a.verifyHints['400']).toContain('region');
  });

  it('pages every list with limit and from and keeps the organization in the path', () => {
    for (const t of a.tools) {
      const props = t.parameters?.properties ?? {};
      if ('from' in props) expect(t.endpointMapping.queryParams).toMatchObject({ limit: '$limit', from: '$from' });
      if ('org_id' in props) expect(`${t.name}:${t.endpointMapping.path.includes('/{org_id}')}`).toBe(`${t.name}:true`);
    }
    expect(tool('action1_list_vulnerabilities').endpointMapping.queryParams).toMatchObject({ CVEIDs: '$cve_ids', score: '$score', remediation_status: '$remediation_status' });
    expect(tool('action1_get_report_data').endpointMapping.queryParams).toMatchObject({ endpoint_id: '$endpoint_id', live_only: '$live_only', details: '$details' });
    expect(tool('action1_search').endpointMapping.queryParams).toEqual({ query: '$query', limit: '$limit' });
  });

  it('only renames endpoints: no deployment, script, reboot, remote session, approval or delete', () => {
    expect(tool('action1_update_endpoint').endpointMapping.bodyMapping).toEqual({ name: '$name', comment: '$comment' });
    for (const t of a.tools) {
      expect(t.endpointMapping.method).not.toBe('DELETE');
      expect(t.endpointMapping.path).not.toMatch(/remote-sessions|approvals|\/scripts|\/stop$|\/move$|\/users|\/roles|\/settings|enterprise/);
      if (t.endpointMapping.path.startsWith('/automations')) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    }
  });
});

const env = process.env;
(env.RUN_ACTION1_LIVE === '1' ? describe : describe.skip)('action1 adapter: live (read-only)', () => {
  const base = env.ACTION1_API_URL ?? 'https://app.action1.com/api/3.0';
  const form = (id: string, secret: string) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
  });

  it('refuses wrong API credentials at the token endpoint with 400', async () => {
    const res = await fetch(`${base}/oauth2/token`, form('not-a-client', 'not-a-secret'));
    expect(res.status).toBe(400);
  }, 30_000);

  it('reads the organizations and one page of endpoints', async () => {
    if (!env.ACTION1_CLIENT_ID || !env.ACTION1_CLIENT_SECRET) throw new Error('Set ACTION1_CLIENT_ID and ACTION1_CLIENT_SECRET for the live check');
    const token = await fetch(`${base}/oauth2/token`, form(env.ACTION1_CLIENT_ID, env.ACTION1_CLIENT_SECRET));
    expect(token.status).toBe(200);
    const headers = { Accept: 'application/json', Authorization: `Bearer ${((await token.json()) as { access_token: string }).access_token}` };
    const orgs = await fetch(`${base}/organizations`, { headers });
    expect(orgs.status).toBe(200);
    const list = (await orgs.json()) as { items: Array<{ id: string }> };
    expect(Array.isArray(list.items)).toBe(true);
    if (list.items.length === 0) return;
    const endpoints = await fetch(`${base}/endpoints/managed/${list.items[0].id}?limit=2`, { headers });
    expect(endpoints.status).toBe(200);
  }, 60_000);
});
