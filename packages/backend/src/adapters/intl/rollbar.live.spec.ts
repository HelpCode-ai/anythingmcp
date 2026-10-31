import * as adapter from './rollbar.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Rollbar REST API (docs.rollbar.com/reference; each reference page carries
 * its OpenAPI 3.1 definition, indexed at docs.rollbar.com/llms.txt): base
 * https://api.rollbar.com/api/1, header X-Rollbar-Access-Token with a project
 * access token (one project) or an account access token (service or personal;
 * project tools then take project_id, the item search takes repeated
 * project_ids). Answers are {"err": 0, "result": ...}. Paths checked on
 * 30 Oct 2026 against those definitions and the live host (an unknown route
 * answers 404, a known one 401 without a valid token).
 * Live part (reads only: items, an item and its occurrences, top items,
 * occurrence counts, deploys, environments, RQL jobs):
 *   ROLLBAR_ACCESS_TOKEN=... RUN_ROLLBAR_LIVE=1 npx jest src/adapters/intl/rollbar
 * With an account token add ROLLBAR_PROJECT_ID=<id> for the project reads.
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; maximum?: number; minimum?: number; type?: string }>; required?: string[] };
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
const shape = (name: string, body: unknown) => applyResponseTransform(body, tool(name).responseMapping as never).value;
const PREFIX = 'rollbar_';
const V = '/api/1';
const ACCOUNT_ONLY = ['rollbar_list_projects', 'rollbar_get_project', 'rollbar_list_users', 'rollbar_get_user', 'rollbar_list_teams', 'rollbar_request_person_deletion', 'rollbar_get_person_deletion_status'];
const PROJECT_TOKEN_ONLY = ['rollbar_report_deploy', 'rollbar_update_deploy'];

describe('rollbar adapter: static spec conformance', () => {
  it('sends the token in X-Rollbar-Access-Token to api.rollbar.com', () => {
    expect(a.slug).toBe('rollbar');
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('rollbar');
    expect(a.requiredEnvVars).toEqual(['ROLLBAR_ACCESS_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.rollbar.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Rollbar-Access-Token', apiKey: '{{ROLLBAR_ACCESS_TOKEN}}' });
    expect(a.envVarMeta?.ROLLBAR_ACCESS_TOKEN.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.ROLLBAR_ACCESS_TOKEN.pattern ?? '').test('a1b2c3d4e5f60718293a4b5c6d7e8f90')).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/api/1/items');
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith(`${V}/`)).toBe(true);
  });

  it('explains both token kinds and gives every project tool an optional project_id for account tokens', () => {
    for (const s of ['project access token', 'account access token', 'service token', 'personal access token', 'post_server_item', 'project_ids']) expect(a.instructions).toContain(s);
    for (const t of a.tools) {
      if (ACCOUNT_ONLY.includes(t.name) || PROJECT_TOKEN_ONLY.includes(t.name)) continue;
      if (['rollbar_list_items', 'rollbar_query_occurrence_metrics', 'rollbar_get_resolution_time_metrics'].includes(t.name)) continue;
      expect(`${t.name}:${'project_id' in (t.parameters?.properties ?? {})}`).toBe(`${t.name}:true`);
    }
    // The item search takes a repeated project_ids list, never a singular project_id.
    expect(tool('rollbar_list_items').parameters?.properties?.project_ids.type).toBe('array');
    expect(tool('rollbar_list_items').parameters?.properties).not.toHaveProperty('project_id');
    // update-item sends project_id in the body, the comment endpoint requires it in the query.
    expect(tool('rollbar_update_item').endpointMapping.bodyMapping).toMatchObject({ project_id: '$project_id' });
    expect(tool('rollbar_add_item_comment').endpointMapping.queryParams).toEqual({ project_id: '$project_id' });
    expect(tool('rollbar_add_item_comment').parameters?.required).toEqual(['item_id', 'comment', 'project_id']);
    for (const n of ACCOUNT_ONLY.slice(0, 5)) expect(tool(n).description).toContain('account access token');
  });

  it('maps the item search with the documented repeated filters', () => {
    expect(tool('rollbar_list_items').endpointMapping).toEqual({
      method: 'GET',
      path: `${V}/items`,
      queryParams: { status: '$status', level: '$level', environment: '$environment', framework: '$framework', assigned_user: '$assigned_user', assigned_team: '$assigned_team', ids: '$ids', query: '$query', is_snoozed: '$is_snoozed', project_ids: '$project_ids', page: '$page' },
    });
    for (const p of ['status', 'level', 'environment', 'project_ids']) expect(tool('rollbar_list_items').parameters?.properties?.[p].type).toBe('array');
  });

  it('maps the item, occurrence, report, metrics, deploy, version, RQL and account endpoints', () => {
    expect(tool('rollbar_get_item').endpointMapping).toEqual({ method: 'GET', path: `${V}/item/{item_id}`, queryParams: { project_id: '$project_id' } });
    expect(tool('rollbar_get_item_by_counter').endpointMapping).toEqual({ method: 'GET', path: `${V}/item/`, queryParams: { counter: '$counter', uuid: '$uuid', project_id: '$project_id' } });
    expect(tool('rollbar_update_item').endpointMapping).toMatchObject({ method: 'PATCH', path: `${V}/item/{item_id}`, bodyMapping: { status: '$status', resolved_in_version: '$resolved_in_version', snooze_enabled: '$snooze_enabled', snooze_expiration_in_seconds: '$snooze_expiration_in_seconds' } });
    expect(tool('rollbar_update_item').parameters?.properties?.status.enum).toEqual(['active', 'resolved', 'muted']);
    expect(tool('rollbar_list_item_events').endpointMapping).toEqual({ method: 'GET', path: `${V}/item/{item_id}/events`, queryParams: { type: '$type', page: '$page', limit: '$limit', project_id: '$project_id' } });
    expect(tool('rollbar_add_item_comment').endpointMapping).toMatchObject({ method: 'POST', path: `${V}/item/{item_id}/comments`, bodyMapping: { comment: '$comment' } });
    expect(tool('rollbar_list_occurrences').endpointMapping).toEqual({ method: 'GET', path: `${V}/instances`, queryParams: { last_id: '$last_id', page: '$page', limit: '$limit', project_id: '$project_id' } });
    expect(tool('rollbar_list_item_occurrences').endpointMapping.path).toBe(`${V}/item/{item_id}/instances`);
    expect(tool('rollbar_get_occurrence').endpointMapping.path).toBe(`${V}/instance/{occurrence_id}`);
    expect(tool('rollbar_get_top_active_items').endpointMapping).toEqual({ method: 'GET', path: `${V}/reports/top_active_items`, queryParams: { hours: '$hours', environments: '$environments', sort: '$sort', project_id: '$project_id' } });
    expect(tool('rollbar_get_occurrence_counts').endpointMapping.path).toBe(`${V}/reports/occurrence_counts`);
    expect(tool('rollbar_get_activated_item_counts').endpointMapping.path).toBe(`${V}/reports/activated_counts`);
    expect(tool('rollbar_get_item_metrics').endpointMapping).toMatchObject({ method: 'POST', path: `${V}/metrics/items`, bodyMapping: { item_counters: '$item_counters' } });
    expect(tool('rollbar_query_occurrence_metrics').endpointMapping).toMatchObject({ method: 'POST', path: `${V}/metrics/occurrences`, bodyMapping: { filters: '$filters', group_by: '$group_by', aggregates: '$aggregates', granularity: '$granularity' } });
    expect(tool('rollbar_get_resolution_time_metrics').endpointMapping).toMatchObject({ method: 'POST', path: `${V}/metrics/ttr`, bodyMapping: { start_time: '$start_time', function: '$function' } });
    expect(tool('rollbar_list_deploys').endpointMapping.path).toBe(`${V}/deploys`);
    expect(tool('rollbar_get_deploy').endpointMapping.path).toBe(`${V}/deploy/{deploy_id}`);
    expect(tool('rollbar_report_deploy').endpointMapping).toEqual({
      method: 'POST',
      path: `${V}/deploy`,
      bodyMapping: { environment: '$environment', revision: '$revision', status: '$status', rollbar_username: '$rollbar_username', local_username: '$local_username', comment: '$comment' },
    });
    expect(tool('rollbar_update_deploy').endpointMapping).toEqual({ method: 'PATCH', path: `${V}/deploy/{deploy_id}`, bodyMapping: { status: '$status', comment: '$comment' } });
    expect(tool('rollbar_list_environments').endpointMapping.path).toBe(`${V}/environments`);
    expect(tool('rollbar_get_version').endpointMapping).toEqual({ method: 'GET', path: `${V}/versions/{version}`, queryParams: { environment: '$environment', project_id: '$project_id' } });
    expect(tool('rollbar_list_version_items').parameters?.required).toEqual(['version', 'environment', 'event']);
    expect(tool('rollbar_create_rql_job').endpointMapping).toEqual({ method: 'POST', path: `${V}/rql/jobs/`, bodyMapping: { query_string: '$query_string', force_refresh: '$force_refresh', project_id: '$project_id' } });
    expect(tool('rollbar_get_rql_job').endpointMapping.path).toBe(`${V}/rql/job/{job_id}`);
    expect(tool('rollbar_get_rql_job_result').endpointMapping.path).toBe(`${V}/rql/job/{job_id}/result`);
    expect(tool('rollbar_list_rql_jobs').endpointMapping.path).toBe(`${V}/rql/jobs/`);
    expect(tool('rollbar_cancel_rql_job').endpointMapping).toEqual({ method: 'POST', path: `${V}/rql/job/{job_id}/cancel`, bodyMapping: { project_id: '$project_id' } });
    expect(tool('rollbar_list_projects').endpointMapping.path).toBe(`${V}/projects`);
    expect(tool('rollbar_get_project').endpointMapping.path).toBe(`${V}/project/{project_id}`);
    expect(tool('rollbar_list_users').endpointMapping).toEqual({ method: 'GET', path: `${V}/users`, queryParams: { email: '$email' } });
    expect(tool('rollbar_get_user').endpointMapping.path).toBe(`${V}/user/{user_id}`);
    expect(tool('rollbar_list_teams').endpointMapping.path).toBe(`${V}/teams`);
    expect(tool('rollbar_request_person_deletion').endpointMapping).toEqual({ method: 'POST', path: `${V}/people/delete_jobs/`, queryParams: { email: '$email', username: '$username', id: '$id' } });
    expect(tool('rollbar_get_person_deletion_status').endpointMapping.path).toBe(`${V}/people/delete_jobs/{job_id}`);
  });

  it('leaves request headers, cookies and integration settings out of the answers', () => {
    const occ = { id: 9, item_id: 3, timestamp: 1, data: { body: { trace: { frames: [] } }, request: { url: 'https://x', headers: { Cookie: 'c', Authorization: 'a' }, cookies: { s: '1' } }, notifier: { name: 'pyrollbar' } } };
    const kept = { id: 9, item_id: 3, timestamp: 1, data: { body: { trace: { frames: [] } }, request: { url: 'https://x' } } };
    expect(shape('rollbar_list_occurrences', { err: 0, result: { page: 1, instances: [occ] } })).toEqual({ err: 0, result: { page: 1, instances: [kept] } });
    expect(shape('rollbar_list_item_occurrences', { err: 0, result: { page: 1, instances: [occ] } })).toEqual({ err: 0, result: { page: 1, instances: [kept] } });
    const proj = { id: 1, name: 'web', settings_data: { timezone: 'UTC', integrations: { slack: { token: 't' } } } };
    expect(shape('rollbar_get_project', { err: 0, result: proj })).toEqual({ err: 0, result: { id: 1, name: 'web', settings_data: { timezone: 'UTC' } } });
    expect(shape('rollbar_list_projects', { err: 0, result: [proj] })).toEqual({ err: 0, result: [{ id: 1, name: 'web', settings_data: { timezone: 'UTC' } }] });
  });

  it('flags every write, marks the POST queries read-only and switches the person deletion off', () => {
    const readPosts = ['rollbar_get_item_metrics', 'rollbar_query_occurrence_metrics', 'rollbar_get_resolution_time_metrics', 'rollbar_create_rql_job'];
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET' && !readPosts.includes(t.name);
      expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:${write}`);
      if (readPosts.includes(t.name)) expect(t.annotations).toEqual({ readOnlyHint: true });
      if (t.endpointMapping.method === 'PATCH') expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
    }
    expect(tool('rollbar_request_person_deletion').annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['rollbar_request_person_deletion']);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
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

  it('probes with a read tool that works with both token kinds and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('rollbar_list_items');
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_ROLLBAR_LIVE === '1' && process.env.ROLLBAR_ACCESS_TOKEN ? describe : describe.skip;
live('rollbar adapter: live (read-only)', () => {
  const pid = process.env.ROLLBAR_PROJECT_ID;
  const withProject = (path: string) => (pid ? `${path}${path.includes('?') ? '&' : '?'}project_id=${pid}` : path);
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { 'X-Rollbar-Access-Token': String(process.env.ROLLBAR_ACCESS_TOKEN), Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    const body = (await res.json()) as { err: number; result: unknown };
    expect(body.err).toBe(0);
    return body.result;
  };
  it('reads items, an item with its occurrences, reports, deploys, environments and RQL jobs', async () => {
    const items = (await get(pid ? `/api/1/items?status=active&project_ids=${pid}` : '/api/1/items?status=active')) as { items: Array<{ id: number }> };
    expect(Array.isArray(items.items)).toBe(true);
    const first = items.items[0];
    if (first) {
      expect(await get(withProject(`/api/1/item/${first.id}`))).toMatchObject({ id: first.id });
      expect(await get(withProject(`/api/1/item/${first.id}/instances?limit=2`))).toHaveProperty('instances');
      expect(await get(withProject(`/api/1/item/${first.id}/events?limit=5`))).toHaveProperty('events');
    }
    expect(Array.isArray(await get(withProject('/api/1/reports/top_active_items?hours=24')))).toBe(true);
    expect(Array.isArray(await get(withProject('/api/1/reports/occurrence_counts?bucket_size=3600')))).toBe(true);
    expect(await get(withProject('/api/1/deploys?limit=5'))).toHaveProperty('deploys');
    expect(await get(withProject('/api/1/environments'))).toHaveProperty('environments');
    expect(await get(withProject('/api/1/rql/jobs/'))).toBeDefined();
  }, 60_000);
});
