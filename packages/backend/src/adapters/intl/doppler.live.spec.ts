import * as adapter from './doppler.json';

/**
 * Doppler API v3 (docs.doppler.com/reference/api, OpenAPI at docs.doppler.com/openapi/core.json):
 * base https://api.doppler.com, Bearer token (service account, service or personal token),
 * project and config passed as query parameters on GET and in the JSON body on POST,
 * page/per_page paging.
 * Live part (reads only: token info, projects, configs, secret names; never secret values):
 *   DOPPLER_TOKEN=dp.xx.... RUN_DOPPLER_LIVE=1 npx jest src/adapters/intl/doppler
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
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
const PC = { project: '$project', config: '$config' };
const VALUE_READERS = ['doppler_list_secrets', 'doppler_get_secret', 'doppler_download_secrets'];

describe('doppler adapter: static spec conformance', () => {
  it('authenticates with a Bearer token against api.doppler.com', () => {
    expect(a.requiredEnvVars).toEqual(['DOPPLER_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.doppler.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{DOPPLER_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/v3/me');
    expect(a.envVarMeta?.DOPPLER_TOKEN.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.DOPPLER_TOKEN.pattern ?? '');
    expect(re.test('dp.sa.AbCdEf1234567890')).toBe(true);
    expect(re.test('dp.st.dev.AbCdEf1234567890')).toBe(true);
    expect(re.test('Bearer dp.pt.AbCdEf1234567890')).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/v3\//);
  });

  it('maps the workplace, project, environment and config endpoints', () => {
    expect(tool('doppler_get_me').endpointMapping).toEqual({ method: 'GET', path: '/v3/me' });
    expect(tool('doppler_get_workplace').endpointMapping).toEqual({ method: 'GET', path: '/v3/workplace' });
    expect(tool('doppler_list_workplace_users').endpointMapping).toEqual({ method: 'GET', path: '/v3/workplace/users', queryParams: { page: '$page', email: '$email' } });
    expect(tool('doppler_list_groups').endpointMapping.path).toBe('/v3/workplace/groups');
    expect(tool('doppler_list_service_accounts').endpointMapping.path).toBe('/v3/workplace/service_accounts');
    expect(tool('doppler_list_projects').endpointMapping).toEqual({ method: 'GET', path: '/v3/projects', queryParams: { page: '$page', per_page: '$per_page', tags: '$tags' } });
    expect(tool('doppler_get_project').endpointMapping).toEqual({ method: 'GET', path: '/v3/projects/project', queryParams: { project: '$project' } });
    expect(tool('doppler_list_project_members').endpointMapping.path).toBe('/v3/projects/project/members');
    expect(tool('doppler_list_environments').endpointMapping).toEqual({ method: 'GET', path: '/v3/environments', queryParams: { project: '$project' } });
    expect(tool('doppler_get_environment').endpointMapping.queryParams).toEqual({ project: '$project', environment: '$environment' });
    expect(tool('doppler_list_configs').endpointMapping).toMatchObject({ path: '/v3/configs', queryParams: { project: '$project', environment: '$environment' } });
    expect(tool('doppler_get_config').endpointMapping).toEqual({ method: 'GET', path: '/v3/configs/config', queryParams: PC });
  });

  it('maps the secret endpoints, names separate from values', () => {
    expect(tool('doppler_list_secret_names').endpointMapping).toEqual({ method: 'GET', path: '/v3/configs/config/secrets/names', queryParams: { ...PC, include_managed_secrets: '$include_managed_secrets' } });
    expect(tool('doppler_list_secrets').endpointMapping).toEqual({ method: 'GET', path: '/v3/configs/config/secrets', queryParams: { ...PC, secrets: '$secrets', include_managed_secrets: '$include_managed_secrets' } });
    expect(tool('doppler_get_secret').endpointMapping).toEqual({ method: 'GET', path: '/v3/configs/config/secret', queryParams: { ...PC, name: '$name' } });
    expect(tool('doppler_download_secrets').endpointMapping).toMatchObject({ path: '/v3/configs/config/secrets/download', queryParams: { ...PC, format: '$format' } });
    expect(tool('doppler_download_secrets').parameters?.properties?.format.enum).toEqual(['json', 'dotnet-json', 'env', 'yaml', 'docker', 'env-no-quotes']);
    expect(tool('doppler_update_secrets').endpointMapping).toEqual({ method: 'POST', path: '/v3/configs/config/secrets', bodyMapping: { project: '$project', config: '$config', secrets: '$secrets' } });
    expect(tool('doppler_update_secrets').parameters?.properties?.secrets.type).toBe('object');
    expect(tool('doppler_update_secret_note').endpointMapping).toEqual({ method: 'POST', path: '/v3/projects/project/note', queryParams: { project: '$project' }, bodyMapping: { secret: '$secret', note: '$note' } });
    expect(tool('doppler_delete_secret').endpointMapping).toEqual({ method: 'DELETE', path: '/v3/configs/config/secret', queryParams: { ...PC, name: '$name' } });
    // No tool issues dynamic secret leases as a side effect of a read.
    for (const t of a.tools) expect(Object.keys(t.endpointMapping.queryParams ?? {})).not.toContain('include_dynamic_secrets');
  });

  it('maps logs, integrations, service tokens and the structure writes', () => {
    expect(tool('doppler_list_config_logs').endpointMapping).toEqual({ method: 'GET', path: '/v3/configs/config/logs', queryParams: { ...PC, page: '$page', per_page: '$per_page' } });
    expect(tool('doppler_get_config_log').endpointMapping.queryParams).toEqual({ ...PC, log: '$log' });
    expect(tool('doppler_rollback_config_log').endpointMapping).toEqual({ method: 'POST', path: '/v3/configs/config/logs/log/rollback', queryParams: { ...PC, log: '$log' } });
    expect(tool('doppler_list_activity_logs').endpointMapping.path).toBe('/v3/logs');
    expect(tool('doppler_get_activity_log').endpointMapping).toEqual({ method: 'GET', path: '/v3/logs/log', queryParams: { log: '$log' } });
    expect(tool('doppler_list_integrations').endpointMapping).toEqual({ method: 'GET', path: '/v3/integrations' });
    expect(tool('doppler_get_integration').endpointMapping.queryParams).toEqual({ integration: '$integration' });
    expect(tool('doppler_list_service_tokens').endpointMapping).toEqual({ method: 'GET', path: '/v3/configs/config/tokens', queryParams: PC });
    expect(tool('doppler_create_project').endpointMapping).toEqual({ method: 'POST', path: '/v3/projects', bodyMapping: { name: '$name', description: '$description' } });
    expect(tool('doppler_update_project').endpointMapping).toEqual({ method: 'POST', path: '/v3/projects/project', bodyMapping: { project: '$project', name: '$name', description: '$description' } });
    expect(tool('doppler_create_environment').endpointMapping).toEqual({ method: 'POST', path: '/v3/environments', queryParams: { project: '$project' }, bodyMapping: { name: '$name', slug: '$slug', personal_configs: '$personal_configs' } });
    expect(tool('doppler_create_config').endpointMapping).toEqual({ method: 'POST', path: '/v3/configs', bodyMapping: { project: '$project', environment: '$environment', name: '$name' } });
    expect(tool('doppler_clone_config').endpointMapping).toEqual({ method: 'POST', path: '/v3/configs/config/clone', bodyMapping: { project: '$project', config: '$config', name: '$name' } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('doppler_')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      // project and config identify the target of every config-scoped call.
      if (u.has('config')) expect(t.parameters?.required).toEqual(expect.arrayContaining(['project', 'config']));
    }
  });

  it('switches off exactly the irreversible delete and marks overwrites as destructive', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['doppler_delete_secret']);
    expect(a.instructions).toContain('**Switched off at install**: `doppler_delete_secret`; it cannot be undone');
    for (const n of ['doppler_update_secrets', 'doppler_update_project', 'doppler_update_secret_note', 'doppler_rollback_config_log', 'doppler_delete_secret']) {
      expect(tool(n).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET')) expect(t.annotations?.readOnlyHint === false).toBe(false);
  });

  it('warns that value-reading tools expose secrets to the AI', () => {
    expect(a.instructions).toContain('**Secrets are visible to the AI.**');
    for (const n of VALUE_READERS) {
      expect(tool(n).description).toMatch(/^READS (A )?SECRET VALUES?: /);
      expect(a.instructions).toContain(`\`${n}\``);
    }
    expect(tool('doppler_list_secret_names').description).toContain('without any value');
    expect(tool('doppler_list_service_tokens').description).toContain('never returned');
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('doppler_get_me');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_DOPPLER_LIVE === '1' && process.env.DOPPLER_TOKEN ? describe : describe.skip;
live('doppler adapter: live (read-only, no secret values)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.DOPPLER_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the token info, and with project access the projects, configs and secret names', async () => {
    const me = (await get('/v3/me')) as { type?: string };
    expect(typeof me.type).toBe('string');
    if (process.env.DOPPLER_TOKEN?.startsWith('dp.st.')) return; // a service token reaches only its config
    const projects = ((await get('/v3/projects?per_page=5')).projects ?? []) as Array<{ slug: string }>;
    expect(Array.isArray(projects)).toBe(true);
    if (!projects.length) return;
    const project = encodeURIComponent(projects[0].slug);
    const configs = ((await get(`/v3/configs?project=${project}&per_page=5`)).configs ?? []) as Array<{ name: string }>;
    expect(Array.isArray(configs)).toBe(true);
    if (!configs.length) return;
    const names = (await get(`/v3/configs/config/secrets/names?project=${project}&config=${encodeURIComponent(configs[0].name)}`)).names;
    expect(Array.isArray(names)).toBe(true);
  }, 60_000);
});
