import * as adapter from './rootly.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Rootly public API (docs.rootly.com/api-reference; OpenAPI 3 at
 * https://rootly-heroku.s3.amazonaws.com/swagger/v1/swagger.json): base
 * https://api.rootly.com, Bearer API key, JSON:API bodies and media type
 * (application/vnd.api+json), filters as filter[name] and filter[field][gte],
 * page[number] / page[size] paging (page[after] cursor on incidents and
 * alerts), sparse fieldsets as fields[incidents] / fields[alerts].
 * Paths checked on 30 Oct 2026 against that document and the live host (an
 * unknown route answers 404, a known one 401 without a valid key).
 * Live part (reads only: current user, incidents, alerts, catalog, on-call,
 * status pages, retrospectives):
 *   ROOTLY_API_KEY=... RUN_ROOTLY_LIVE=1 npx jest src/adapters/intl/rootly
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
const PREFIX = 'rootly_';
const WRITES = [
  'rootly_create_incident',
  'rootly_update_incident',
  'rootly_mitigate_incident',
  'rootly_resolve_incident',
  'rootly_add_incident_event',
  'rootly_create_action_item',
  'rootly_update_action_item',
  'rootly_acknowledge_alert',
  'rootly_resolve_alert',
  'rootly_create_status_page_event',
];

describe('rootly adapter: static spec conformance', () => {
  it('sends the key as a Bearer token to api.rootly.com with the JSON:API media type', () => {
    expect(a.slug).toBe('rootly');
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('rootly');
    expect(a.requiredEnvVars).toEqual(['ROOTLY_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.rootly.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{ROOTLY_API_KEY}}' });
    expect(a.connector.headers).toEqual({ Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' });
    expect(a.envVarMeta?.ROOTLY_API_KEY.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta?.ROOTLY_API_KEY.pattern ?? '');
    expect(pattern.test('rootly_0123456789abcdef0123456789abcdef')).toBe(true);
    expect(pattern.test('Bearer rootly_0123456789abcdef')).toBe(false);
    expect(a.connector.healthcheckPath).toBe('/v1/users/me');
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/v1\//);
  });

  it('maps incidents with filters, sparse fields, cursor paging and the JSON:API write bodies', () => {
    const list = tool('rootly_list_incidents');
    expect(list.endpointMapping).toEqual({
      method: 'GET',
      path: '/v1/incidents',
      queryParams: {
        'filter[search]': '$search',
        'filter[status]': '$status',
        'filter[kind]': '$kind',
        'filter[severity]': '$severity',
        'filter[private]': '$private',
        'filter[sequential_id]': '$sequential_id',
        'filter[service_ids]': '$service_ids',
        'filter[team_ids]': '$team_ids',
        'filter[environment_ids]': '$environment_ids',
        'filter[functionality_ids]': '$functionality_ids',
        'filter[type_ids]': '$type_ids',
        'filter[created_at][gte]': '$created_at_gte',
        'filter[created_at][lte]': '$created_at_lte',
        'filter[started_at][gte]': '$started_at_gte',
        'filter[started_at][lte]': '$started_at_lte',
        'filter[resolved_at][gte]': '$resolved_at_gte',
        'filter[updated_at][gte]': '$updated_at_gte',
        sort: '$sort',
        include: '$include',
        'fields[incidents]': '$fields',
        'page[number]': '$page_number',
        'page[size]': '$page_size',
        'page[after]': '$page_after',
      },
    });
    expect(String(list.parameters?.properties?.fields.default)).toContain('sequential_id');
    expect(tool('rootly_get_incident').endpointMapping).toEqual({ method: 'GET', path: '/v1/incidents/{incident_id}', queryParams: { include: '$include' } });
    const create = tool('rootly_create_incident').endpointMapping;
    expect(create).toMatchObject({ method: 'POST', path: '/v1/incidents', headers: { 'Idempotency-Key': '$idempotency_key' } });
    expect(create.bodyMapping).toMatchObject({ data: { type: 'incidents', attributes: { title: '$title', severity_id: '$severity_id', service_ids: '$service_ids', kind: '$kind', status: '$status', private: '$private' } } });
    const update = tool('rootly_update_incident').endpointMapping;
    expect(update).toMatchObject({ method: 'PUT', path: '/v1/incidents/{incident_id}', bodyMapping: { data: { type: 'incidents', attributes: { status: '$status', summary: '$summary' } } } });
    expect(JSON.stringify(update.bodyMapping)).not.toContain('private');
    expect(tool('rootly_mitigate_incident').endpointMapping).toEqual({ method: 'PUT', path: '/v1/incidents/{incident_id}/mitigate', bodyMapping: { data: { type: 'incidents', attributes: { mitigation_message: '$mitigation_message' } } } });
    expect(tool('rootly_resolve_incident').endpointMapping).toEqual({ method: 'PUT', path: '/v1/incidents/{incident_id}/resolve', bodyMapping: { data: { type: 'incidents', attributes: { resolution_message: '$resolution_message' } } } });
    expect(tool('rootly_list_incident_events').endpointMapping.path).toBe('/v1/incidents/{incident_id}/events');
    expect(tool('rootly_add_incident_event').endpointMapping).toEqual({ method: 'POST', path: '/v1/incidents/{incident_id}/events', bodyMapping: { data: { type: 'incident_events', attributes: { event: '$event', visibility: '$visibility' } } } });
  });

  it('maps action items, alerts, catalog, on-call, status pages and retrospectives', () => {
    expect(tool('rootly_list_action_items').endpointMapping.path).toBe('/v1/action_items');
    expect(tool('rootly_list_incident_action_items').endpointMapping.path).toBe('/v1/incidents/{incident_id}/action_items');
    expect(tool('rootly_get_action_item').endpointMapping.path).toBe('/v1/action_items/{action_item_id}');
    expect(tool('rootly_create_action_item').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/incidents/{incident_id}/action_items', bodyMapping: { data: { type: 'incident_action_items', attributes: { summary: '$summary', priority: '$priority', assigned_to_user_id: '$assigned_to_user_id' } } } });
    expect(tool('rootly_update_action_item').endpointMapping).toMatchObject({ method: 'PUT', path: '/v1/action_items/{action_item_id}' });
    expect(tool('rootly_update_action_item').parameters?.properties?.status.enum).toEqual(['open', 'in_progress', 'cancelled', 'done']);
    expect(tool('rootly_list_alerts').endpointMapping.queryParams).toMatchObject({ 'filter[status]': '$status', 'filter[source]': '$source', 'fields[alerts]': '$fields', 'page[after]': '$page_after' });
    expect(String(tool('rootly_list_alerts').parameters?.properties?.fields.default)).not.toContain('data');
    expect(tool('rootly_get_alert').endpointMapping.path).toBe('/v1/alerts/{alert_id}');
    expect(tool('rootly_acknowledge_alert').endpointMapping).toEqual({ method: 'POST', path: '/v1/alerts/{alert_id}/acknowledge' });
    expect(tool('rootly_resolve_alert').endpointMapping).toEqual({ method: 'POST', path: '/v1/alerts/{alert_id}/resolve', bodyMapping: { data: { type: 'alerts', attributes: { resolution_message: '$resolution_message', resolve_related_incidents: '$resolve_related_incidents' } } } });
    const paths: Record<string, string> = {
      rootly_get_current_user: '/v1/users/me',
      rootly_list_services: '/v1/services',
      rootly_get_service: '/v1/services/{service_id}',
      rootly_list_functionalities: '/v1/functionalities',
      rootly_get_functionality: '/v1/functionalities/{functionality_id}',
      rootly_list_teams: '/v1/teams',
      rootly_get_team: '/v1/teams/{team_id}',
      rootly_list_environments: '/v1/environments',
      rootly_list_severities: '/v1/severities',
      rootly_list_incident_types: '/v1/incident_types',
      rootly_list_users: '/v1/users',
      rootly_list_oncalls: '/v1/oncalls',
      rootly_list_schedules: '/v1/schedules',
      rootly_get_schedule: '/v1/schedules/{schedule_id}',
      rootly_get_schedule_shifts: '/v1/schedules/{schedule_id}/shifts',
      rootly_list_shifts: '/v1/shifts',
      rootly_list_escalation_policies: '/v1/escalation_policies',
      rootly_list_status_pages: '/v1/status-pages',
      rootly_get_status_page: '/v1/status-pages/{status_page_id}',
      rootly_list_incident_status_page_events: '/v1/incidents/{incident_id}/status-page-events',
      rootly_list_retrospectives: '/v1/post_mortems',
      rootly_get_retrospective: '/v1/post_mortems/{retrospective_id}',
    };
    for (const [n, p] of Object.entries(paths)) expect(`${n}:${tool(n).endpointMapping.method} ${tool(n).endpointMapping.path}`).toBe(`${n}:GET ${p}`);
    expect(tool('rootly_list_shifts').endpointMapping.queryParams).toMatchObject({ 'schedule_ids[]': '$schedule_ids', 'user_ids[]': '$user_ids' });
    expect(tool('rootly_list_oncalls').endpointMapping.queryParams).toMatchObject({ since: '$since', until: '$until', 'filter[schedule_ids]': '$schedule_ids' });
    expect(tool('rootly_create_status_page_event').endpointMapping).toEqual({
      method: 'POST',
      path: '/v1/incidents/{incident_id}/status-page-events',
      bodyMapping: { data: { type: 'incident_status_page_events', attributes: { event: '$event', status_page_id: '$status_page_id', status: '$status', notify_subscribers: '$notify_subscribers' } } },
    });
    expect(tool('rootly_create_status_page_event').parameters?.required).toEqual(['incident_id', 'status_page_id', 'event']);
  });

  it('leaves Zoom meeting passwords and host links out of incident answers', () => {
    const attrs = { title: 'DB down', zoom_meeting_password: 'p', zoom_meeting_pstn_password: 'p', zoom_meeting_h323_password: 'p', zoom_meeting_start_url: 'https://zoom.us/s/1', zoom_meeting_join_url: 'https://zoom.us/j/1' };
    const kept = { title: 'DB down', zoom_meeting_join_url: 'https://zoom.us/j/1' };
    expect(shape('rootly_list_incidents', { data: [{ id: 'i1', attributes: attrs }], meta: { next_page: 2 } })).toEqual({ data: [{ id: 'i1', attributes: kept }], meta: { next_page: 2 } });
    for (const n of ['rootly_get_incident', 'rootly_create_incident', 'rootly_update_incident', 'rootly_mitigate_incident', 'rootly_resolve_incident']) {
      expect(shape(n, { data: { id: 'i1', attributes: attrs } })).toEqual({ data: { id: 'i1', attributes: kept } });
    }
  });

  it('flags every write, keeps them enabled and has no deletes', () => {
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET';
      expect(`${t.name}:${write}`).toBe(`${t.name}:${WRITES.includes(t.name)}`);
      expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:${write}`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
    for (const n of ['rootly_update_incident', 'rootly_mitigate_incident', 'rootly_resolve_incident', 'rootly_update_action_item', 'rootly_acknowledge_alert', 'rootly_resolve_alert']) expect(tool(n).annotations?.destructiveHint).toBe(true);
    for (const n of ['rootly_create_incident', 'rootly_add_incident_event', 'rootly_create_action_item', 'rootly_create_status_page_event']) expect(tool(n).annotations?.destructiveHint).toBe(false);
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

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('rootly_get_current_user');
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_ROOTLY_LIVE === '1' && process.env.ROOTLY_API_KEY ? describe : describe.skip;
live('rootly adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.ROOTLY_API_KEY}`, Accept: 'application/vnd.api+json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the current user, incidents, alerts, catalog, on-call, status pages and retrospectives', async () => {
    expect(await get('/v1/users/me')).toHaveProperty('data.id');
    const incidents = (await get('/v1/incidents?page%5Bsize%5D=5&fields%5Bincidents%5D=sequential_id,title,status')).data as Array<{ id: string }>;
    expect(Array.isArray(incidents)).toBe(true);
    if (incidents[0]) {
      expect(await get(`/v1/incidents/${incidents[0].id}`)).toHaveProperty('data.id', incidents[0].id);
      expect(await get(`/v1/incidents/${incidents[0].id}/events?page%5Bsize%5D=5`)).toHaveProperty('data');
    }
    for (const p of ['/v1/alerts', '/v1/services', '/v1/teams', '/v1/severities', '/v1/schedules', '/v1/status-pages', '/v1/post_mortems', '/v1/action_items']) {
      expect(await get(`${p}?page%5Bsize%5D=5`)).toHaveProperty('data');
    }
    expect(await get('/v1/oncalls')).toHaveProperty('data');
  }, 120_000);
});
