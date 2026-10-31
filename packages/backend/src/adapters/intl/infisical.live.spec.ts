import * as adapter from './infisical.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Infisical API (infisical.com/docs/api-reference, OpenAPI at https://app.infisical.com/api/docs/json):
 * base {{INFISICAL_URL}}/api (Cloud US app.infisical.com, Cloud EU eu.infisical.com or self-hosted),
 * machine identity Universal Auth: POST /api/v1/auth/universal-auth/login with clientId and
 * clientSecret returns accessToken and expiresIn (seconds), sent as Authorization: Bearer.
 * Secrets use the v4 API; list and metadata tools ask for viewSecretValue=false.
 * Live part (reads only: identity details, projects, one project, folders and secret names):
 *   INFISICAL_URL=https://app.infisical.com INFISICAL_CLIENT_ID=... INFISICAL_CLIENT_SECRET=... \
 *   RUN_INFISICAL_LIVE=1 npx jest src/adapters/intl/infisical
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
const PREFIX = 'infisical_';
const SECRET = '/v4/secrets/{secret_name}';

describe('infisical adapter: static spec conformance', () => {
  it('logs in as a machine identity with Universal Auth and sends the access token as Bearer', () => {
    expect(a.requiredEnvVars).toEqual(['INFISICAL_URL', 'INFISICAL_CLIENT_ID', 'INFISICAL_CLIENT_SECRET']);
    expect(a.connector.baseUrl).toBe('{{INFISICAL_URL}}/api');
    expect(a.connector.healthcheckPath).toBe('/v1/projects');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: '{{INFISICAL_URL}}/api/v1/auth/universal-auth/login',
      loginMethod: 'POST',
      loginBody: { clientId: '${username}', clientSecret: '${password}' },
      username: '{{INFISICAL_CLIENT_ID}}',
      password: '{{INFISICAL_CLIENT_SECRET}}',
      tokenJsonPath: 'accessToken',
      expiryJsonPath: 'expiresIn',
      expiryFormat: 'ttl_seconds',
      refreshOn401: true,
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
    });
    expect(a.envVarMeta?.INFISICAL_CLIENT_SECRET.secret).toBe(true);
    expect(a.envVarMeta?.INFISICAL_URL.kind).toBe('address');
    const url = new RegExp(a.envVarMeta?.INFISICAL_URL.pattern ?? '');
    for (const ok of ['https://app.infisical.com', 'https://eu.infisical.com', 'https://vault.example.com/infisical']) expect(url.test(ok)).toBe(true);
    for (const bad of ['https://app.infisical.com/', 'http://app.infisical.com', 'https://app infisical.com']) expect(url.test(bad)).toBe(false);
  });

  it('lists and describes secrets without values and reads a value only in the dedicated tool', () => {
    expect(tool('infisical_list_secrets').endpointMapping).toEqual({
      method: 'GET',
      path: '/v4/secrets',
      queryParams: {
        projectId: '$project_id',
        environment: '$environment',
        secretPath: '$secret_path',
        recursive: '$recursive',
        includeImports: '$include_imports',
        tagSlugs: '$tag_slugs',
        metadataFilter: '$metadata_filter',
        viewSecretValue: 'false',
        expandSecretReferences: 'false',
      },
    });
    expect(tool('infisical_get_secret').endpointMapping).toMatchObject({ method: 'GET', path: SECRET, queryParams: { projectId: '$project_id', version: '$version', viewSecretValue: 'false' } });
    expect(tool('infisical_read_secret_value').endpointMapping).toMatchObject({
      method: 'GET',
      path: SECRET,
      queryParams: { projectId: '$project_id', environment: '$environment', secretPath: '$secret_path', expandSecretReferences: '$expand_secret_references', viewSecretValue: 'true' },
    });
    expect(tool('infisical_read_secret_value').description).toMatch(/^READS THE SECRET VALUE/);
    // Only one tool asks Infisical for values.
    const valueReaders = a.tools.filter((t) => t.endpointMapping.queryParams?.viewSecretValue === 'true').map((t) => t.name);
    expect(valueReaders).toEqual(['infisical_read_secret_value']);
    expect(a.instructions).toMatch(/Secret values reach the AI/);
  });

  it('drops any secret value from the list and metadata answers', () => {
    const list = applyResponseTransform(
      {
        secrets: [{ id: 's1', secretKey: 'DB_URL', secretValue: 'leak', secretValueHidden: true, version: 3, tags: [{ id: 't1', slug: 'db', color: '#fff', name: 'db' }] }],
        imports: [{ secretPath: '/', environment: 'prod', folderId: 'f1', secrets: [{ secretKey: 'API_KEY', secretValue: 'leak', version: 1 }] }],
      },
      tool('infisical_list_secrets').responseMapping as never,
    ).value;
    expect(list).toEqual({
      secrets: [{ id: 's1', secretKey: 'DB_URL', secretValueHidden: true, version: 3, tags: [{ id: 't1', slug: 'db' }] }],
      imports: [{ secretPath: '/', environment: 'prod', folderId: 'f1', secrets: [{ secretKey: 'API_KEY', version: 1 }] }],
    });
    const one = applyResponseTransform({ secret: { id: 's1', secretKey: 'DB_URL', secretValue: 'leak', version: 2, tags: [] } }, tool('infisical_get_secret').responseMapping as never).value;
    expect(one).toEqual({ secret: { id: 's1', secretKey: 'DB_URL', version: 2, tags: [] } });
    expect(JSON.stringify(list)).not.toContain('leak');
  });

  it('maps projects, environments, folders, imports, tags, members, identities and audit logs', () => {
    expect(tool('infisical_get_identity_details').endpointMapping).toEqual({ method: 'GET', path: '/v1/identities/details' });
    expect(tool('infisical_list_projects').endpointMapping).toEqual({ method: 'GET', path: '/v1/projects', queryParams: { type: '$type' } });
    expect(tool('infisical_get_project').endpointMapping.path).toBe('/v1/projects/{project_id}');
    expect(tool('infisical_get_project_by_slug').endpointMapping.path).toBe('/v1/projects/slug/{project_slug}');
    expect(tool('infisical_get_environment').endpointMapping.path).toBe('/v1/projects/{project_id}/environments/slug/{environment}');
    expect(tool('infisical_list_folders').endpointMapping).toEqual({
      method: 'GET',
      path: '/v2/folders',
      queryParams: { projectId: '$project_id', environment: '$environment', path: '$path', recursive: '$recursive', lastSecretModified: '$last_secret_modified' },
    });
    expect(tool('infisical_get_folder').endpointMapping.path).toBe('/v1/folders/{folder_id}');
    expect(tool('infisical_list_secret_imports').endpointMapping).toEqual({ method: 'GET', path: '/v2/secret-imports', queryParams: { projectId: '$project_id', environment: '$environment', path: '$path' } });
    expect(tool('infisical_list_tags').endpointMapping.path).toBe('/v1/projects/{project_id}/tags');
    expect(tool('infisical_list_project_members').endpointMapping.path).toBe('/v1/projects/{project_id}/memberships');
    expect(tool('infisical_list_project_identities').endpointMapping).toMatchObject({ path: '/v1/projects/{project_id}/memberships/identities', queryParams: { identityName: '$identity_name', offset: '$offset', limit: '$limit' } });
    expect(tool('infisical_list_org_identities').endpointMapping).toMatchObject({ path: '/v2/organizations/{org_id}/identity-memberships', queryParams: { search: '$search', orderBy: '$order_by', orderDirection: '$order_direction' } });
    expect(tool('infisical_get_identity').endpointMapping.path).toBe('/v1/identities/{identity_id}');
    expect(tool('infisical_list_audit_logs').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/v1/organization/audit-logs',
      queryParams: { projectId: '$project_id', secretKey: '$secret_key', eventType: '$event_type', actorType: '$actor_type', actor: '$actor', startDate: '$start_date', endDate: '$end_date', offset: '$offset', limit: '$limit' },
    });
  });

  it('maps the writes with the documented body fields', () => {
    expect(tool('infisical_create_secret').endpointMapping).toEqual({
      method: 'POST',
      path: SECRET,
      bodyMapping: { projectId: '$project_id', environment: '$environment', secretPath: '$secret_path', secretValue: '$secret_value', secretComment: '$secret_comment', tagIds: '$tag_ids', skipMultilineEncoding: '$skip_multiline_encoding' },
    });
    expect(tool('infisical_create_secret').parameters?.required).toEqual(['secret_name', 'project_id', 'environment', 'secret_value']);
    expect(tool('infisical_update_secret').endpointMapping).toMatchObject({ method: 'PATCH', path: SECRET, bodyMapping: { newSecretName: '$new_secret_name', secretValue: '$secret_value' } });
    expect(tool('infisical_delete_secret').endpointMapping).toEqual({ method: 'DELETE', path: SECRET, bodyMapping: { projectId: '$project_id', environment: '$environment', secretPath: '$secret_path' } });
    expect(tool('infisical_create_folder').endpointMapping).toMatchObject({ method: 'POST', path: '/v2/folders', bodyMapping: { projectId: '$project_id', environment: '$environment', name: '$name', path: '$path' } });
    expect(tool('infisical_create_environment').endpointMapping).toEqual({ method: 'POST', path: '/v1/projects/{project_id}/environments', bodyMapping: { name: '$name', slug: '$slug', position: '$position' } });
    expect(tool('infisical_create_tag').endpointMapping).toEqual({ method: 'POST', path: '/v1/projects/{project_id}/tags', bodyMapping: { slug: '$slug', color: '$color' } });
  });

  it('switches off exactly the secret delete and says so in the instructions', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['infisical_delete_secret']);
    expect(a.instructions).toContain('**Switched off at install**: `infisical_delete_secret`');
    for (const t of a.tools) if (t.endpointMapping.method === 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:false`);
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

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env;
const live = env.RUN_INFISICAL_LIVE === '1' && env.INFISICAL_URL && env.INFISICAL_CLIENT_ID && env.INFISICAL_CLIENT_SECRET ? describe : describe.skip;
live('infisical adapter: live (read-only)', () => {
  const api = `${env.INFISICAL_URL}/api`;
  let token = '';
  const get = async (path: string) => {
    const res = await fetch(`${api}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('logs in, reads the identity, projects, folders and secret names without values', async () => {
    const login = await fetch(`${api}/v1/auth/universal-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ clientId: env.INFISICAL_CLIENT_ID, clientSecret: env.INFISICAL_CLIENT_SECRET }),
    });
    expect(login.status).toBe(200);
    const body = (await login.json()) as { accessToken: string; expiresIn: number };
    expect(typeof body.expiresIn).toBe('number');
    token = body.accessToken;
    const details = (await get('/v1/identities/details')) as { identityDetails: { organization: { id: string } } };
    expect(typeof details.identityDetails.organization.id).toBe('string');
    const { projects } = (await get('/v1/projects?type=secret-manager')) as { projects: Array<{ id: string; environments: Array<{ slug: string }> }> };
    expect(Array.isArray(projects)).toBe(true);
    const p = projects.find((x) => x.environments?.length);
    if (!p) return;
    expect(((await get(`/v1/projects/${p.id}`)) as { project: { id: string } }).project.id).toBe(p.id);
    const envSlug = p.environments[0].slug;
    expect(Array.isArray(((await get(`/v2/folders?projectId=${p.id}&environment=${envSlug}&path=%2F`)) as { folders: unknown[] }).folders)).toBe(true);
    const { secrets } = (await get(`/v4/secrets?projectId=${p.id}&environment=${envSlug}&secretPath=%2F&viewSecretValue=false&expandSecretReferences=false`)) as {
      secrets: Array<{ secretValueHidden?: boolean }>;
    };
    for (const s of secrets) expect(s.secretValueHidden).toBe(true);
  }, 60_000);
});
