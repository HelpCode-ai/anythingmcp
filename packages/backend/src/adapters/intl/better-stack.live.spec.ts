import * as adapter from './better-stack.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Better Stack Incidents API (formerly Better Uptime; docs at
 * betterstack.com/docs/uptime/api, served as Markdown with the endpoint
 * definitions): base https://incidents.betterstack.com/api, Bearer token
 * (team-scoped Incidents API token or a global API token), JSON:API bodies,
 * page/per_page paging with pagination.next. Incidents and escalation
 * policies are v3, everything else v2. Paths checked on 30 Oct 2026 against
 * the docs and against the live host (an unknown route answers 404, a known
 * one 401 without a valid token).
 * Live part (reads only: monitors, incidents, on-call, policies, status pages):
 *   BETTER_STACK_API_TOKEN=... RUN_BETTER_STACK_LIVE=1 npx jest src/adapters/intl/better-stack
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; maximum?: number }>; required?: string[] };
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
const PREFIX = 'better_stack_';
const SP = '/v2/status-pages/{status_page_id}';

describe('better-stack adapter: static spec conformance', () => {
  it('sends the token as a Bearer header to the Incidents API host', () => {
    expect(a.slug).toBe('better-stack');
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('better-stack');
    expect(a.requiredEnvVars).toEqual(['BETTER_STACK_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://incidents.betterstack.com/api');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{BETTER_STACK_API_TOKEN}}' });
    expect(a.envVarMeta?.BETTER_STACK_API_TOKEN.secret).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/v2/monitors?per_page=1');
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/v[23]\//);
  });

  it('maps monitors, monitor groups and heartbeats on v2', () => {
    expect(tool('better_stack_list_monitors').endpointMapping).toEqual({
      method: 'GET',
      path: '/v2/monitors',
      queryParams: { team_name: '$team_name', url: '$url', pronounceable_name: '$pronounceable_name', page: '$page', per_page: '$per_page' },
    });
    expect(tool('better_stack_get_monitor').endpointMapping).toEqual({ method: 'GET', path: '/v2/monitors/{monitor_id}' });
    expect(tool('better_stack_create_monitor').endpointMapping).toMatchObject({ method: 'POST', path: '/v2/monitors', bodyMapping: { monitor_type: '$monitor_type', url: '$url', check_frequency: '$check_frequency', paused: '$paused' } });
    expect(tool('better_stack_update_monitor').endpointMapping).toMatchObject({ method: 'PATCH', path: '/v2/monitors/{monitor_id}' });
    expect(tool('better_stack_pause_monitor').endpointMapping).toEqual({ method: 'PATCH', path: '/v2/monitors/{monitor_id}', bodyMapping: { paused: true } });
    expect(tool('better_stack_resume_monitor').endpointMapping).toEqual({ method: 'PATCH', path: '/v2/monitors/{monitor_id}', bodyMapping: { paused: false } });
    expect(tool('better_stack_get_monitor_availability').endpointMapping).toEqual({ method: 'GET', path: '/v2/monitors/{monitor_id}/sla', queryParams: { from: '$from', to: '$to' } });
    expect(tool('better_stack_get_monitor_response_times').endpointMapping).toEqual({ method: 'GET', path: '/v2/monitors/{monitor_id}/response-times' });
    expect(tool('better_stack_list_monitor_group_monitors').endpointMapping.path).toBe('/v2/monitor-groups/{monitor_group_id}/monitors');
    expect(tool('better_stack_get_monitor_group').endpointMapping.path).toBe('/v2/monitor-groups/{monitor_group_id}');
    expect(tool('better_stack_create_heartbeat').endpointMapping).toMatchObject({ method: 'POST', path: '/v2/heartbeats', bodyMapping: { name: '$name', period: '$period', grace: '$grace' } });
    expect(tool('better_stack_create_heartbeat').parameters?.required).toEqual(['name', 'period', 'grace']);
    expect(tool('better_stack_update_heartbeat').endpointMapping).toMatchObject({ method: 'PATCH', path: '/v2/heartbeats/{heartbeat_id}' });
    expect(tool('better_stack_get_heartbeat_availability').endpointMapping).toEqual({ method: 'GET', path: '/v2/heartbeats/{heartbeat_id}/availability', queryParams: { from: '$from', to: '$to' } });
    expect(tool('better_stack_list_heartbeat_groups').endpointMapping.path).toBe('/v2/heartbeat-groups');
  });

  it('maps incidents on v3 (comments stay on v2) with the documented filters and actions', () => {
    const list = tool('better_stack_list_incidents');
    expect(list.endpointMapping).toEqual({
      method: 'GET',
      path: '/v3/incidents',
      queryParams: { team_name: '$team_name', from: '$from', to: '$to', monitor_id: '$monitor_id', heartbeat_id: '$heartbeat_id', resolved: '$resolved', acknowledged: '$acknowledged', page: '$page', per_page: '$per_page' },
    });
    expect(list.parameters?.properties?.per_page.maximum).toBe(50);
    expect(tool('better_stack_get_incident').endpointMapping.path).toBe('/v3/incidents/{incident_id}');
    expect(tool('better_stack_get_incident_timeline').endpointMapping.path).toBe('/v3/incidents/{incident_id}/timeline');
    expect(tool('better_stack_create_incident').endpointMapping).toMatchObject({ method: 'POST', path: '/v3/incidents', bodyMapping: { requester_email: '$requester_email', summary: '$summary' } });
    expect(tool('better_stack_acknowledge_incident').endpointMapping).toEqual({ method: 'POST', path: '/v3/incidents/{incident_id}/acknowledge', bodyMapping: { acknowledged_by: '$acknowledged_by' } });
    expect(tool('better_stack_resolve_incident').endpointMapping).toEqual({ method: 'POST', path: '/v3/incidents/{incident_id}/resolve', bodyMapping: { resolved_by: '$resolved_by' } });
    expect(tool('better_stack_reopen_incident').endpointMapping).toEqual({ method: 'POST', path: '/v3/incidents/{incident_id}/reopen', bodyMapping: { reopened_by: '$reopened_by' } });
    expect(tool('better_stack_escalate_incident').endpointMapping).toMatchObject({ method: 'POST', path: '/v3/incidents/{incident_id}/escalate', bodyMapping: { escalation_type: '$escalation_type' } });
    expect(tool('better_stack_escalate_incident').parameters?.properties?.escalation_type.enum).toEqual(['User', 'Team', 'Schedule', 'Policy', 'Organization']);
    expect(tool('better_stack_list_incident_comments').endpointMapping).toEqual({ method: 'GET', path: '/v2/incidents/{incident_id}/comments' });
    expect(tool('better_stack_add_incident_comment').endpointMapping).toEqual({ method: 'POST', path: '/v2/incidents/{incident_id}/comments', bodyMapping: { content: '$content', user_email: '$user_email' } });
  });

  it('maps on-call, escalation policies, severities, status pages and integrations', () => {
    expect(tool('better_stack_get_on_call_calendar').endpointMapping).toEqual({ method: 'GET', path: '/v2/on-calls/{schedule_id}', queryParams: { date: '$date' } });
    expect(tool('better_stack_list_on_call_events').endpointMapping).toEqual({ method: 'GET', path: '/v2/on-calls/{schedule_id}/events', queryParams: { starts_at: '$starts_at', ends_at: '$ends_at' } });
    expect(tool('better_stack_list_escalation_policies').endpointMapping.path).toBe('/v3/policies');
    expect(tool('better_stack_get_escalation_policy').endpointMapping.path).toBe('/v3/policies/{policy_id}');
    expect(tool('better_stack_list_severities').endpointMapping.path).toBe('/v2/urgencies');
    expect(tool('better_stack_list_status_page_resources').endpointMapping.path).toBe(`${SP}/resources`);
    expect(tool('better_stack_list_status_reports').endpointMapping.path).toBe(`${SP}/status-reports`);
    expect(tool('better_stack_get_status_report').endpointMapping.path).toBe(`${SP}/status-reports/{status_report_id}`);
    expect(tool('better_stack_create_status_report').endpointMapping).toMatchObject({ method: 'POST', path: `${SP}/status-reports`, bodyMapping: { title: '$title', message: '$message', report_type: '$report_type', affected_resources: '$affected_resources', notify_subscribers: '$notify_subscribers' } });
    expect(tool('better_stack_update_status_report').endpointMapping).toEqual({ method: 'PATCH', path: `${SP}/status-reports/{status_report_id}`, bodyMapping: { title: '$title', starts_at: '$starts_at', ends_at: '$ends_at' } });
    expect(tool('better_stack_list_status_updates').endpointMapping.path).toBe(`${SP}/status-reports/{status_report_id}/status-updates`);
    expect(tool('better_stack_add_status_update').endpointMapping).toEqual({
      method: 'POST',
      path: `${SP}/status-reports/{status_report_id}/status-updates`,
      bodyMapping: { message: '$message', affected_resources: '$affected_resources', notify_subscribers: '$notify_subscribers', published_at: '$published_at' },
    });
    expect(tool('better_stack_list_incoming_webhooks').endpointMapping.path).toBe('/v2/incoming-webhooks');
    expect(tool('better_stack_list_outgoing_webhooks').endpointMapping.path).toBe('/v2/outgoing-webhooks');
    expect(tool('better_stack_list_slack_integrations').endpointMapping.path).toBe('/v2/slack-integrations');
    expect(tool('better_stack_list_metadata').endpointMapping).toMatchObject({ path: '/v3/metadata', queryParams: { owner_type: '$owner_type', owner_id: '$owner_id' } });
  });

  it('keeps monitor passwords, Playwright variables and policy incident tokens out of the answers', () => {
    const mon = { id: '2', attributes: { url: 'https://x', status: 'up', auth_password: 'secret', environment_variables: { K: 'v' } } };
    expect(shape('better_stack_list_monitors', { data: [mon], pagination: { next: null } })).toEqual({ data: [{ id: '2', attributes: { url: 'https://x', status: 'up' } }], pagination: { next: null } });
    expect(shape('better_stack_get_monitor', { data: mon })).toEqual({ data: { id: '2', attributes: { url: 'https://x', status: 'up' } } });
    expect(shape('better_stack_list_monitor_group_monitors', { data: [mon] })).toEqual({ data: [{ id: '2', attributes: { url: 'https://x', status: 'up' } }] });
    for (const n of ['better_stack_create_monitor', 'better_stack_update_monitor', 'better_stack_pause_monitor', 'better_stack_resume_monitor']) {
      expect(shape(n, { data: mon })).toEqual({ data: { id: '2', attributes: { url: 'https://x', status: 'up' } } });
    }
    const pol = { id: '4', attributes: { name: 'P', incident_token: 'tok', steps: [] } };
    expect(shape('better_stack_list_escalation_policies', { data: [pol] })).toEqual({ data: [{ id: '4', attributes: { name: 'P', steps: [] } }] });
    expect(shape('better_stack_get_escalation_policy', { data: pol })).toEqual({ data: { id: '4', attributes: { name: 'P', steps: [] } } });
    const page = { id: '9', attributes: { subdomain: 's', custom_css: 'x', custom_javascript: 'y', announcement_embed_css: 'z', aggregate_state: 'operational' } };
    expect(shape('better_stack_list_status_pages', { data: [page] })).toEqual({ data: [{ id: '9', attributes: { subdomain: 's', aggregate_state: 'operational' } }] });
  });

  it('reduces response times to the time and total duration of each check per region', () => {
    const body = {
      data: {
        id: '270985',
        type: 'monitor_response_times',
        attributes: { regions: [{ region: 'us', response_times: [{ at: '2026-10-30T11:00:57.000Z', response_time: 0.47, name_lookup_time: 0.00002, connection_time: 0.14, tls_handshake_time: 0.19, data_transfer_time: 0.13 }] }] },
      },
    };
    expect(shape('better_stack_get_monitor_response_times', body)).toEqual({ monitor_id: '270985', regions: [{ region: 'us', response_times: [{ at: '2026-10-30T11:00:57.000Z', response_time: 0.47 }] }] });
  });

  it('flags every write and alert, and marks none of the reads as a write', () => {
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET';
      expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:${write}`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
    for (const n of ['better_stack_update_monitor', 'better_stack_pause_monitor', 'better_stack_acknowledge_incident', 'better_stack_resolve_incident', 'better_stack_update_status_report']) {
      expect(tool(n).annotations?.destructiveHint).toBe(true);
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

const live = process.env.RUN_BETTER_STACK_LIVE === '1' && process.env.BETTER_STACK_API_TOKEN ? describe : describe.skip;
live('better-stack adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.BETTER_STACK_API_TOKEN}`, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as { data: unknown; pagination?: { next: string | null } };
  };
  it('reads monitors, incidents, on-call, policies and status pages', async () => {
    const monitors = await get('/v2/monitors?per_page=5');
    expect(Array.isArray(monitors.data)).toBe(true);
    expect(monitors.pagination).toHaveProperty('next');
    const first = (monitors.data as Array<{ id: string }>)[0];
    if (first) {
      expect((await get(`/v2/monitors/${first.id}`)).data).toMatchObject({ id: first.id });
      expect((await get(`/v2/monitors/${first.id}/sla`)).data).toMatchObject({ attributes: { availability: expect.any(Number) } });
    }
    expect(Array.isArray((await get('/v3/incidents?per_page=5')).data)).toBe(true);
    expect(Array.isArray((await get('/v2/heartbeats')).data)).toBe(true);
    expect(Array.isArray((await get('/v2/on-calls')).data)).toBe(true);
    expect(Array.isArray((await get('/v3/policies')).data)).toBe(true);
    expect(Array.isArray((await get('/v2/status-pages')).data)).toBe(true);
  }, 60_000);
});
