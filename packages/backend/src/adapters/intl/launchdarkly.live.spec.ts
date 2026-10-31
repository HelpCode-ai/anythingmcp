import * as adapter from './launchdarkly.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * LaunchDarkly REST API (launchdarkly.com/docs/api; OpenAPI 3 at
 * https://app.launchdarkly.com/api/v2/openapi.json): base
 * https://app.launchdarkly.com (EU app.eu.launchdarkly.com, federal
 * app.launchdarkly.us), header `Authorization: <api-... access token>` with no
 * scheme, `LD-API-Version: 20240415`, limit and offset paging, and semantic
 * patch updates sent with `Content-Type: application/json;
 * domain-model=launchdarkly.semanticpatch` and a body of
 * { environmentKey, comment, instructions: [{ kind, ... }] }.
 * Paths checked on 30 Oct 2026 against that document and the live host (an
 * unknown route answers 404, a known one 401 without a valid token).
 * Live part (reads only: caller identity, projects, environments, flags,
 * flag statuses, segments, metrics, experiments, audit log, members, teams):
 *   LAUNCHDARKLY_API_TOKEN=api-... RUN_LAUNCHDARKLY_LIVE=1 npx jest src/adapters/intl/launchdarkly
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; maximum?: number; default?: unknown; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: { transform?: unknown };
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; healthcheckPath?: string };
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
const shape = (name: string, body: unknown) => applyResponseTransform(body, tool(name).responseMapping as never).value;
const PREFIX = 'launchdarkly_';
const SEMANTIC = 'application/json; domain-model=launchdarkly.semanticpatch';
const WRITES = ['launchdarkly_create_flag', 'launchdarkly_toggle_flag', 'launchdarkly_update_flag', 'launchdarkly_delete_flag', 'launchdarkly_create_segment', 'launchdarkly_update_segment'];
const OFF = ['launchdarkly_delete_flag'];

describe('launchdarkly adapter: static spec conformance', () => {
  it('sends the raw access token in Authorization with the pinned API version', () => {
    expect(a.slug).toBe('launchdarkly');
    expect(a.category).toBe('infrastructure');
    expect(a.icon).toBe('launchdarkly');
    expect(a.requiredEnvVars).toEqual(['LAUNCHDARKLY_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://app.launchdarkly.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{LAUNCHDARKLY_API_TOKEN}}' });
    expect(a.connector.headers?.['LD-API-Version']).toBe('20240415');
    expect(a.connector.healthcheckPath).toBe('/api/v2/caller-identity');
    expect(a.envVarMeta?.LAUNCHDARKLY_API_TOKEN.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta?.LAUNCHDARKLY_API_TOKEN.pattern ?? '');
    expect(pattern.test(['api', '01234567-89ab-cdef-0123-456789abcdef'].join('-'))).toBe(true);
    expect(pattern.test('sdk-01234567-89ab-cdef-0123-456789abcdef')).toBe(false);
    expect(pattern.test(`Bearer ${['api', '01234567-89ab-cdef-0123-456789abcdef'].join('-')}`)).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/api/v2/')).toBe(true);
  });

  it('maps projects, environments and flags, and keeps SDK keys out of the answers', () => {
    expect(tool('launchdarkly_get_caller_identity').endpointMapping).toEqual({ method: 'GET', path: '/api/v2/caller-identity' });
    expect(tool('launchdarkly_list_projects').endpointMapping).toEqual({ method: 'GET', path: '/api/v2/projects', queryParams: { filter: '$filter', sort: '$sort', expand: '$expand', limit: '$limit', offset: '$offset' } });
    expect(tool('launchdarkly_get_project').endpointMapping.path).toBe('/api/v2/projects/{project_key}');
    expect(tool('launchdarkly_list_environments').endpointMapping.path).toBe('/api/v2/projects/{project_key}/environments');
    expect(tool('launchdarkly_get_environment').endpointMapping.path).toBe('/api/v2/projects/{project_key}/environments/{environment_key}');
    expect(tool('launchdarkly_list_flags').endpointMapping).toEqual({
      method: 'GET',
      path: '/api/v2/flags/{project_key}',
      queryParams: { env: '$env', filter: '$filter', tag: '$tag', sort: '$sort', summary: '$summary', expand: '$expand', limit: '$limit', offset: '$offset' },
    });
    expect(tool('launchdarkly_get_flag').endpointMapping).toEqual({ method: 'GET', path: '/api/v2/flags/{project_key}/{flag_key}', queryParams: { env: '$env', expand: '$expand' } });
    expect(tool('launchdarkly_list_flag_statuses').endpointMapping.path).toBe('/api/v2/flag-statuses/{project_key}/{environment_key}');
    expect(tool('launchdarkly_get_flag_status').endpointMapping.path).toBe('/api/v2/flag-statuses/{project_key}/{environment_key}/{flag_key}');
    const env = { _id: 'client-side-id', key: 'production', apiKey: 'sdk-secret', mobileKey: 'mob-secret' };
    const kept = { _id: 'client-side-id', key: 'production' };
    expect(shape('launchdarkly_list_environments', { items: [env], totalCount: 1 })).toEqual({ items: [kept], totalCount: 1 });
    expect(shape('launchdarkly_get_environment', env)).toEqual(kept);
    expect(shape('launchdarkly_get_project', { key: 'default', environments: { items: [env] } })).toEqual({ key: 'default', environments: { items: [kept] } });
    expect(shape('launchdarkly_list_projects', { items: [{ key: 'default', environments: { items: [env] } }] })).toEqual({ items: [{ key: 'default', environments: { items: [kept] } }] });
  });

  it('writes flags and segments with semantic patches', () => {
    expect(tool('launchdarkly_create_flag').endpointMapping).toMatchObject({ method: 'POST', path: '/api/v2/flags/{project_key}', queryParams: { clone: '$clone' }, bodyMapping: { key: '$key', name: '$name', maintainerId: '$maintainer_id' } });
    expect(tool('launchdarkly_create_flag').parameters?.required).toEqual(['project_key', 'key', 'name']);
    expect(tool('launchdarkly_toggle_flag').endpointMapping).toEqual({
      method: 'PATCH',
      path: '/api/v2/flags/{project_key}/{flag_key}',
      queryParams: { dryRun: '$dry_run' },
      headers: { 'Content-Type': SEMANTIC },
      bodyMapping: { environmentKey: '$environment_key', comment: '$comment', instructions: [{ kind: '$action' }] },
    });
    expect(tool('launchdarkly_toggle_flag').parameters?.properties?.action.enum).toEqual(['turnFlagOn', 'turnFlagOff']);
    expect(tool('launchdarkly_toggle_flag').parameters?.required).toEqual(['project_key', 'flag_key', 'environment_key', 'action']);
    expect(tool('launchdarkly_update_flag').endpointMapping).toEqual({
      method: 'PATCH',
      path: '/api/v2/flags/{project_key}/{flag_key}',
      queryParams: { dryRun: '$dry_run' },
      headers: { 'Content-Type': SEMANTIC },
      bodyMapping: { environmentKey: '$environment_key', comment: '$comment', instructions: '$instructions' },
    });
    expect(tool('launchdarkly_delete_flag').endpointMapping).toEqual({ method: 'DELETE', path: '/api/v2/flags/{project_key}/{flag_key}' });
    expect(tool('launchdarkly_list_segments').endpointMapping.path).toBe('/api/v2/segments/{project_key}/{environment_key}');
    expect(tool('launchdarkly_get_segment').endpointMapping.path).toBe('/api/v2/segments/{project_key}/{environment_key}/{segment_key}');
    expect(tool('launchdarkly_create_segment').endpointMapping).toEqual({
      method: 'POST',
      path: '/api/v2/segments/{project_key}/{environment_key}',
      bodyMapping: { key: '$key', name: '$name', description: '$description', tags: '$tags', unbounded: '$unbounded' },
    });
    expect(tool('launchdarkly_update_segment').endpointMapping).toEqual({
      method: 'PATCH',
      path: '/api/v2/segments/{project_key}/{environment_key}/{segment_key}',
      queryParams: { dryRun: '$dry_run' },
      headers: { 'Content-Type': SEMANTIC },
      bodyMapping: { environmentKey: '$environment_key', comment: '$comment', instructions: '$instructions' },
    });
  });

  it('maps metrics, experiments, the audit log, members and teams', () => {
    const paths: Record<string, string> = {
      launchdarkly_list_metrics: '/api/v2/metrics/{project_key}',
      launchdarkly_get_metric: '/api/v2/metrics/{project_key}/{metric_key}',
      launchdarkly_list_experiments: '/api/v2/projects/{project_key}/experiments',
      launchdarkly_get_experiment: '/api/v2/projects/{project_key}/environments/{environment_key}/experiments/{experiment_key}',
      launchdarkly_list_audit_log: '/api/v2/auditlog',
      launchdarkly_get_audit_log_entry: '/api/v2/auditlog/{entry_id}',
      launchdarkly_list_members: '/api/v2/members',
      launchdarkly_get_member: '/api/v2/members/{member_id}',
      launchdarkly_list_teams: '/api/v2/teams',
      launchdarkly_get_team: '/api/v2/teams/{team_key}',
    };
    for (const [n, p] of Object.entries(paths)) expect(`${n}:${tool(n).endpointMapping.method} ${tool(n).endpointMapping.path}`).toBe(`${n}:GET ${p}`);
    expect(tool('launchdarkly_list_audit_log').endpointMapping.queryParams).toEqual({ before: '$before', after: '$after', q: '$q', spec: '$spec', member: '$member', limit: '$limit' });
    expect(tool('launchdarkly_list_audit_log').parameters?.properties?.limit.maximum).toBe(20);
    expect(tool('launchdarkly_list_experiments').endpointMapping.queryParams).toMatchObject({ lifecycleState: '$lifecycle_state' });
  });

  it('flags every write and switches off deleting a flag', () => {
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET';
      expect(`${t.name}:${write}`).toBe(`${t.name}:${WRITES.includes(t.name)}`);
      expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:${write}`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:${OFF.includes(t.name) ? false : undefined}`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    for (const n of ['launchdarkly_toggle_flag', 'launchdarkly_update_flag', 'launchdarkly_update_segment', 'launchdarkly_delete_flag']) expect(tool(n).annotations?.destructiveHint).toBe(true);
    for (const n of ['launchdarkly_create_flag', 'launchdarkly_create_segment']) expect(tool(n).annotations?.destructiveHint).toBe(false);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name)).toEqual(OFF);
    expect(a.instructions).toContain('**Switched off at install**: `launchdarkly_delete_flag`; it cannot be undone, so an admin switches it on when the team needs it.');
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
    expect(a.probe.tool).toBe('launchdarkly_get_caller_identity');
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_LAUNCHDARKLY_LIVE === '1' && process.env.LAUNCHDARKLY_API_TOKEN ? describe : describe.skip;
live('launchdarkly adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `${process.env.LAUNCHDARKLY_API_TOKEN}`, 'LD-API-Version': '20240415', Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads identity, projects, environments, flags, segments, metrics, experiments, audit log, members and teams', async () => {
    expect(await get('/api/v2/caller-identity')).toHaveProperty('accountId');
    const projects = (await get('/api/v2/projects?limit=5')).items as Array<{ key: string }>;
    expect(Array.isArray(projects)).toBe(true);
    if (projects[0]) {
      const p = projects[0].key;
      const envs = (await get(`/api/v2/projects/${p}/environments?limit=5`)).items as Array<{ key: string; apiKey?: string }>;
      expect(await get(`/api/v2/flags/${p}?limit=5`)).toHaveProperty('items');
      expect(await get(`/api/v2/metrics/${p}?limit=5`)).toHaveProperty('items');
      expect(await get(`/api/v2/projects/${p}/experiments?limit=5`)).toHaveProperty('items');
      if (envs[0]) {
        expect(await get(`/api/v2/segments/${p}/${envs[0].key}?limit=5`)).toHaveProperty('items');
        expect(await get(`/api/v2/flag-statuses/${p}/${envs[0].key}`)).toHaveProperty('items');
      }
    }
    expect(await get('/api/v2/auditlog?limit=5')).toHaveProperty('items');
    expect(await get('/api/v2/members?limit=5')).toHaveProperty('items');
    expect(await get('/api/v2/teams?limit=5')).toHaveProperty('items');
  }, 120_000);
});
