import * as adapter from './incident-io.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * incident.io public API (docs.incident.io/api-reference; OpenAPI 3 at
 * https://api.incident.io/v1/openapiV3.json): base https://api.incident.io,
 * Bearer API key, versioned paths (/v1, /v2, /v3; the deprecated v1 incidents,
 * v2 actions, follow-ups and catalog are not used), cursor paging with
 * pagination_meta.after, deepObject filters such as status_category[one_of].
 * Paths checked on 30 Oct 2026 against that document and the live host (an
 * unknown route answers 404, a known one 401 without a valid key, or 422 when
 * a required query parameter is missing).
 * Live part (reads only: identity, configuration, incidents, actions,
 * follow-ups, alerts, schedules, users, teams, catalog):
 *   INCIDENT_IO_API_KEY=... RUN_INCIDENT_IO_LIVE=1 npx jest src/adapters/intl/incident-io
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
const PREFIX = 'incident_io_';

describe('incident-io adapter: static spec conformance', () => {
  it('sends the key as a Bearer token to api.incident.io', () => {
    expect(a.slug).toBe('incident-io');
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('incident-io');
    expect(a.requiredEnvVars).toEqual(['INCIDENT_IO_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.incident.io');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{INCIDENT_IO_API_KEY}}' });
    expect(a.envVarMeta?.INCIDENT_IO_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.INCIDENT_IO_API_KEY.pattern ?? '').test('inc_live_0123456789abcdefABCDEF')).toBe(true);
    expect(new RegExp(a.envVarMeta?.INCIDENT_IO_API_KEY.pattern ?? '').test('Bearer inc_live_0123456789abcdef')).toBe(false);
    expect(a.connector.healthcheckPath).toBe('/v1/identity');
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/v[123]\//);
  });

  it('uses the current API versions, never the deprecated endpoints', () => {
    const paths = a.tools.map((t) => t.endpointMapping.path);
    for (const old of ['/v1/incidents', '/v2/actions', '/v2/follow_ups', '/v2/catalog_types', '/v2/catalog_entries', '/v1/custom_fields', '/v1/incident_roles', '/v1/actions']) {
      expect(paths.some((p) => p === old || p.startsWith(`${old}/`))).toBe(false);
    }
  });

  it('maps incidents with the deepObject filters, updates and the timeline', () => {
    expect(tool('incident_io_list_incidents').endpointMapping).toEqual({
      method: 'GET',
      path: '/v2/incidents',
      queryParams: {
        page_size: '$page_size',
        after: '$after',
        sort_by: '$sort_by',
        filter_mode: '$filter_mode',
        'status_category[one_of]': '$status_category',
        'status_category[not_in]': '$status_category_not_in',
        'status[one_of]': '$status_id',
        'severity[one_of]': '$severity_id',
        'severity[gte]': '$severity_gte',
        'incident_type[one_of]': '$incident_type_id',
        'mode[one_of]': '$mode',
        'created_at[gte]': '$created_at_gte',
        'created_at[lte]': '$created_at_lte',
        'updated_at[gte]': '$updated_at_gte',
        __rawquery: '$extra_filters',
      },
    });
    expect(tool('incident_io_list_incidents').parameters?.properties?.status_category.type).toBe('array');
    expect(tool('incident_io_list_incidents').parameters?.properties?.page_size.maximum).toBe(250);
    expect(tool('incident_io_get_incident').endpointMapping).toEqual({ method: 'GET', path: '/v2/incidents/{incident_id}' });
    const create = tool('incident_io_create_incident');
    expect(create.endpointMapping).toMatchObject({ method: 'POST', path: '/v2/incidents', bodyMapping: { idempotency_key: '$idempotency_key', visibility: '$visibility', name: '$name', severity_id: '$severity_id', incident_role_assignments: '$incident_role_assignments', custom_field_entries: '$custom_field_entries' } });
    expect(create.parameters?.required).toEqual(['idempotency_key', 'visibility']);
    expect(tool('incident_io_edit_incident').endpointMapping).toEqual({
      method: 'POST',
      path: '/v2/incidents/{incident_id}/actions/edit',
      bodyMapping: {
        notify_incident_channel: '$notify_incident_channel',
        incident: {
          name: '$name',
          summary: '$summary',
          severity_id: '$severity_id',
          incident_status_id: '$incident_status_id',
          call_url: '$call_url',
          slack_channel_name_override: '$slack_channel_name_override',
          incident_role_assignments: '$incident_role_assignments',
          custom_field_entries: '$custom_field_entries',
          incident_timestamp_values: '$incident_timestamp_values',
        },
      },
    });
    expect(tool('incident_io_edit_incident').parameters?.required).toEqual(['incident_id', 'notify_incident_channel']);
    expect(tool('incident_io_list_incident_updates').endpointMapping).toEqual({ method: 'GET', path: '/v2/incident_updates', queryParams: { incident_id: '$incident_id', page_size: '$page_size', after: '$after' } });
    expect(tool('incident_io_create_incident_update').endpointMapping).toEqual({
      method: 'POST',
      path: '/v2/incident_updates',
      bodyMapping: { idempotency_key: '$idempotency_key', incident_id: '$incident_id', message: '$message', to_incident_status_id: '$to_incident_status_id', to_severity_id: '$to_severity_id' },
    });
    expect(tool('incident_io_list_incident_timeline_items').endpointMapping.path).toBe('/v2/incident_timeline_items');
  });

  it('maps configuration, actions, follow-ups, alerts, on-call, users, teams and catalog', () => {
    expect(tool('incident_io_get_identity').endpointMapping).toEqual({ method: 'GET', path: '/v1/identity' });
    expect(tool('incident_io_list_severities').endpointMapping.path).toBe('/v1/severities');
    expect(tool('incident_io_list_incident_statuses').endpointMapping.path).toBe('/v1/incident_statuses');
    expect(tool('incident_io_list_incident_roles').endpointMapping.path).toBe('/v2/incident_roles');
    expect(tool('incident_io_list_incident_types').endpointMapping.path).toBe('/v1/incident_types');
    expect(tool('incident_io_list_custom_fields').endpointMapping.path).toBe('/v2/custom_fields');
    expect(tool('incident_io_get_custom_field').endpointMapping.path).toBe('/v2/custom_fields/{custom_field_id}');
    expect(tool('incident_io_list_custom_field_options').endpointMapping).toEqual({ method: 'GET', path: '/v1/custom_field_options', queryParams: { custom_field_id: '$custom_field_id', page_size: '$page_size', after: '$after' } });
    expect(tool('incident_io_list_incident_timestamps').endpointMapping.path).toBe('/v2/incident_timestamps');
    expect(tool('incident_io_list_actions').endpointMapping.path).toBe('/v3/actions');
    expect(tool('incident_io_get_action').endpointMapping.path).toBe('/v3/actions/{action_id}');
    expect(tool('incident_io_create_action').endpointMapping).toEqual({ method: 'POST', path: '/v3/actions', bodyMapping: { incident_id: '$incident_id', description: '$description', assignee_id: '$assignee_id' } });
    expect(tool('incident_io_update_action').endpointMapping).toEqual({ method: 'PUT', path: '/v3/actions/{action_id}', bodyMapping: { description: '$description', status: '$status', assignee_id: '$assignee_id' } });
    expect(tool('incident_io_update_action').parameters?.properties?.status.enum).toEqual(['outstanding', 'completed', 'not_doing']);
    expect(tool('incident_io_list_follow_ups').endpointMapping.path).toBe('/v3/follow_ups');
    expect(tool('incident_io_get_follow_up').endpointMapping.path).toBe('/v3/follow_ups/{follow_up_id}');
    expect(tool('incident_io_create_follow_up').endpointMapping).toMatchObject({ method: 'POST', path: '/v3/follow_ups', bodyMapping: { incident_id: '$incident_id', title: '$title' } });
    expect(tool('incident_io_update_follow_up').endpointMapping).toMatchObject({ method: 'PUT', path: '/v3/follow_ups/{follow_up_id}', bodyMapping: { status: '$status', title: '$title' } });
    expect(tool('incident_io_update_follow_up').parameters?.required).toEqual(['follow_up_id', 'title', 'status']);
    expect(tool('incident_io_list_alerts').endpointMapping).toEqual({
      method: 'GET',
      path: '/v2/alerts',
      queryParams: { page_size: '$page_size', after: '$after', 'status[one_of]': '$status', 'alert_source[one_of]': '$alert_source_id', 'deduplication_key[is]': '$deduplication_key', 'created_at[gte]': '$created_at_gte', 'created_at[lte]': '$created_at_lte' },
    });
    // page_size is required by these endpoints, so the tools default it.
    for (const n of ['incident_io_list_alerts', 'incident_io_list_incident_alerts', 'incident_io_list_catalog_entries']) expect(tool(n).parameters?.properties?.page_size.default).toBe(25);
    expect(tool('incident_io_get_alert').endpointMapping.path).toBe('/v2/alerts/{alert_id}');
    expect(tool('incident_io_resolve_alert').endpointMapping).toEqual({ method: 'POST', path: '/v2/alerts/{alert_id}/actions/resolve' });
    expect(tool('incident_io_list_incident_alerts').endpointMapping.path).toBe('/v2/incident_alerts');
    expect(tool('incident_io_list_alert_sources').endpointMapping.path).toBe('/v2/alert_sources');
    expect(tool('incident_io_get_alert_source').endpointMapping.path).toBe('/v2/alert_sources/{alert_source_id}');
    expect(tool('incident_io_list_schedules').endpointMapping.path).toBe('/v2/schedules');
    expect(tool('incident_io_get_schedule').endpointMapping.path).toBe('/v2/schedules/{schedule_id}');
    expect(tool('incident_io_list_schedule_entries').endpointMapping).toEqual({ method: 'GET', path: '/v2/schedule_entries', queryParams: { schedule_id: '$schedule_id', entry_window_start: '$entry_window_start', entry_window_end: '$entry_window_end' } });
    expect(tool('incident_io_list_escalation_paths').endpointMapping.path).toBe('/v2/escalation_paths');
    expect(tool('incident_io_list_escalations').endpointMapping.queryParams).toMatchObject({ 'status[one_of]': '$status', 'escalation_path[one_of]': '$escalation_path_id', 'incident[one_of]': '$incident_id' });
    expect(tool('incident_io_create_escalation').endpointMapping).toEqual({
      method: 'POST',
      path: '/v2/escalations',
      bodyMapping: { idempotency_key: '$idempotency_key', title: '$title', description: '$description', escalation_path_id: '$escalation_path_id', user_ids: '$user_ids', incident_id: '$incident_id' },
    });
    expect(tool('incident_io_list_users').endpointMapping.path).toBe('/v2/users');
    expect(tool('incident_io_get_user').endpointMapping.path).toBe('/v2/users/{user_id}');
    expect(tool('incident_io_list_teams').endpointMapping.path).toBe('/v3/teams');
    expect(tool('incident_io_list_catalog_types').endpointMapping.path).toBe('/v3/catalog_types');
    expect(tool('incident_io_get_catalog_type').endpointMapping.path).toBe('/v3/catalog_types/{catalog_type_id}');
    expect(tool('incident_io_list_catalog_entries').endpointMapping).toEqual({ method: 'GET', path: '/v3/catalog_entries', queryParams: { catalog_type_id: '$catalog_type_id', identifier: '$identifier', page_size: '$page_size', after: '$after' } });
    expect(tool('incident_io_get_catalog_entry').endpointMapping).toEqual({ method: 'GET', path: '/v3/catalog_entries/{catalog_entry_id}', queryParams: { expand: '$expand' } });
  });

  it('leaves custom field option lists and alert source secret tokens out of the answers', () => {
    const entry = { custom_field: { id: 'cf', name: 'Product', field_type: 'single_select', options: [{ id: 'o1', value: 'A' }] }, values: [{ value_option: { id: 'o1', value: 'A' } }] };
    const trimmed = { custom_field: { id: 'cf', name: 'Product', field_type: 'single_select' }, values: [{ value_option: { id: 'o1', value: 'A' } }] };
    expect(shape('incident_io_list_incidents', { incidents: [{ id: 'i1', custom_field_entries: [entry] }], pagination_meta: { after: 'i1' } })).toEqual({ incidents: [{ id: 'i1', custom_field_entries: [trimmed] }], pagination_meta: { after: 'i1' } });
    expect(shape('incident_io_get_incident', { incident: { id: 'i1', custom_field_entries: [entry] } })).toEqual({ incident: { id: 'i1', custom_field_entries: [trimmed] } });
    expect(shape('incident_io_list_alert_sources', { alert_sources: [{ id: 's1', name: 'Datadog', secret_token: 'shh' }] })).toEqual({ alert_sources: [{ id: 's1', name: 'Datadog' }] });
    expect(shape('incident_io_get_alert_source', { alert_source: { id: 's1', secret_token: 'shh' } })).toEqual({ alert_source: { id: 's1' } });
  });

  it('flags every write and marks no read as a write', () => {
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET';
      expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:${write}`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
    for (const n of ['incident_io_edit_incident', 'incident_io_update_action', 'incident_io_update_follow_up', 'incident_io_resolve_alert']) expect(tool(n).annotations?.destructiveHint).toBe(true);
    for (const n of ['incident_io_create_incident', 'incident_io_create_incident_update', 'incident_io_create_escalation']) {
      expect(tool(n).annotations?.destructiveHint).toBe(false);
      expect(tool(n).parameters?.required).toContain('idempotency_key');
    }
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
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_INCIDENT_IO_LIVE === '1' && process.env.INCIDENT_IO_API_KEY ? describe : describe.skip;
live('incident-io adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.INCIDENT_IO_API_KEY}`, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads identity, configuration, incidents, actions, follow-ups, alerts, schedules, users, teams and catalog', async () => {
    expect(await get('/v1/identity')).toHaveProperty('identity.roles');
    expect(await get('/v1/severities')).toHaveProperty('severities');
    expect(await get('/v1/incident_statuses')).toHaveProperty('incident_statuses');
    expect(await get('/v2/incident_roles')).toHaveProperty('incident_roles');
    expect(await get('/v2/custom_fields')).toHaveProperty('custom_fields');
    const incidents = (await get('/v2/incidents?page_size=5&status_category%5Bone_of%5D=live&status_category%5Bone_of%5D=closed')).incidents as Array<{ id: string }>;
    expect(Array.isArray(incidents)).toBe(true);
    if (incidents[0]) {
      expect(await get(`/v2/incidents/${incidents[0].id}`)).toHaveProperty('incident.id', incidents[0].id);
      expect(await get(`/v2/incident_updates?incident_id=${incidents[0].id}`)).toHaveProperty('incident_updates');
    }
    expect(await get('/v3/actions?page_size=5')).toHaveProperty('actions');
    expect(await get('/v3/follow_ups?page_size=5')).toHaveProperty('follow_ups');
    expect(await get('/v2/alerts?page_size=5')).toHaveProperty('alerts');
    expect(await get('/v2/schedules?page_size=5')).toHaveProperty('schedules');
    expect(await get('/v2/users?page_size=5')).toHaveProperty('users');
    expect(await get('/v3/catalog_types')).toHaveProperty('catalog_types');
  }, 60_000);
});
