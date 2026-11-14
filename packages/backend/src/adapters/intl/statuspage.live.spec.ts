import * as adapter from './statuspage.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Atlassian Statuspage management API (developer.statuspage.io; the OpenAPI
 * 3.0 document is embedded in that page): base https://api.statuspage.io/v1,
 * header `Authorization: OAuth <api key>`, JSON bodies wrapped in the resource
 * name ({"incident": {...}}), page/per_page paging (subscribers count pages
 * from 0, incidents use limit). Paths checked on 30 Oct 2026 against that
 * OpenAPI document; the host answers 401 to any path without a valid key.
 * Live part (reads only: pages, components, groups, incidents, templates,
 * subscriber counts, metrics):
 *   STATUSPAGE_API_KEY=... RUN_STATUSPAGE_LIVE=1 npx jest src/adapters/intl/statuspage
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; maximum?: number; minimum?: number }>; required?: string[] };
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
const PREFIX = 'statuspage_';
const P = '/pages/{page_id}';

describe('statuspage adapter: static spec conformance', () => {
  it('sends the key as Authorization: OAuth <key> to the management API', () => {
    expect(a.slug).toBe('statuspage');
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('statuspage');
    expect(a.requiredEnvVars).toEqual(['STATUSPAGE_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.statuspage.io/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'OAuth {{STATUSPAGE_API_KEY}}' });
    expect(a.envVarMeta?.STATUSPAGE_API_KEY.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta?.STATUSPAGE_API_KEY.pattern ?? '');
    expect(pattern.test('89a229ce1a8dbcf9ff30430fbe35eb4c0426574bca932061892cefd2138aa4b1')).toBe(true);
    expect(pattern.test('OAuth 89a229ce1a8dbcf9ff30430fbe35eb4c')).toBe(false);
    expect(a.connector.healthcheckPath).toBe('/pages');
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/pages(\/\{page_id\}|$)/);
  });

  it('maps pages, components, component groups and uptime', () => {
    expect(tool('statuspage_list_pages').endpointMapping).toEqual({ method: 'GET', path: '/pages' });
    expect(tool('statuspage_get_page').endpointMapping).toEqual({ method: 'GET', path: P });
    expect(tool('statuspage_list_components').endpointMapping).toEqual({ method: 'GET', path: `${P}/components`, queryParams: { page: '$page', per_page: '$per_page' } });
    expect(tool('statuspage_list_components').parameters?.properties?.per_page.maximum).toBe(100);
    expect(tool('statuspage_get_component').endpointMapping.path).toBe(`${P}/components/{component_id}`);
    expect(tool('statuspage_create_component').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/components`, bodyMapping: { component: { name: '$name', status: '$status', group_id: '$group_id' } } });
    expect(tool('statuspage_update_component').endpointMapping).toMatchObject({ method: 'PATCH', path: `${P}/components/{component_id}`, bodyMapping: { component: { status: '$status' } } });
    expect(tool('statuspage_update_component').parameters?.properties?.status.enum).toEqual(['operational', 'under_maintenance', 'degraded_performance', 'partial_outage', 'major_outage']);
    expect(tool('statuspage_get_component_uptime').endpointMapping).toEqual({ method: 'GET', path: `${P}/components/{component_id}/uptime`, queryParams: { start: '$start', end: '$end', skip_related_events: '$skip_related_events' } });
    expect(tool('statuspage_list_component_groups').endpointMapping.path).toBe(`${P}/component-groups`);
    expect(tool('statuspage_get_component_group').endpointMapping.path).toBe(`${P}/component-groups/{group_id}`);
    expect(tool('statuspage_create_component_group').endpointMapping).toEqual({
      method: 'POST',
      path: `${P}/component-groups`,
      bodyMapping: { description: '$description', component_group: { name: '$name', components: '$components' } },
    });
    expect(tool('statuspage_update_component_group').endpointMapping).toMatchObject({ method: 'PATCH', path: `${P}/component-groups/{group_id}` });
    expect(tool('statuspage_get_component_group_uptime').endpointMapping.path).toBe(`${P}/component-groups/{group_id}/uptime`);
  });

  it('maps incidents, maintenances, updates, postmortems and templates', () => {
    expect(tool('statuspage_list_incidents').endpointMapping).toEqual({ method: 'GET', path: `${P}/incidents`, queryParams: { q: '$q', limit: '$limit', page: '$page' } });
    expect(tool('statuspage_list_unresolved_incidents').endpointMapping.path).toBe(`${P}/incidents/unresolved`);
    expect(tool('statuspage_list_upcoming_incidents').endpointMapping.path).toBe(`${P}/incidents/upcoming`);
    expect(tool('statuspage_list_active_maintenances').endpointMapping.path).toBe(`${P}/incidents/active_maintenance`);
    expect(tool('statuspage_list_scheduled_incidents').endpointMapping.path).toBe(`${P}/incidents/scheduled`);
    expect(tool('statuspage_get_incident').endpointMapping).toEqual({ method: 'GET', path: `${P}/incidents/{incident_id}` });
    expect(tool('statuspage_create_incident').endpointMapping).toEqual({
      method: 'POST',
      path: `${P}/incidents`,
      bodyMapping: {
        incident: { name: '$name', status: '$status', body: '$body', impact_override: '$impact_override', components: '$components', component_ids: '$component_ids', deliver_notifications: '$deliver_notifications', metadata: '$metadata' },
      },
    });
    expect(tool('statuspage_create_incident').parameters?.properties?.status.enum).toEqual(['investigating', 'identified', 'monitoring', 'resolved']);
    const maint = tool('statuspage_create_scheduled_maintenance');
    expect(maint.endpointMapping).toMatchObject({ method: 'POST', path: `${P}/incidents`, bodyMapping: { incident: { status: 'scheduled', scheduled_for: '$scheduled_for', scheduled_until: '$scheduled_until', scheduled_auto_in_progress: '$scheduled_auto_in_progress', auto_transition_to_maintenance_state: '$auto_transition_to_maintenance_state' } } });
    expect(maint.parameters?.required).toEqual(['page_id', 'name', 'scheduled_for', 'scheduled_until']);
    expect(tool('statuspage_update_incident').endpointMapping).toMatchObject({ method: 'PATCH', path: `${P}/incidents/{incident_id}`, bodyMapping: { incident: { status: '$status', body: '$body', components: '$components' } } });
    expect(tool('statuspage_edit_incident_update').endpointMapping).toEqual({
      method: 'PATCH',
      path: `${P}/incidents/{incident_id}/incident_updates/{incident_update_id}`,
      bodyMapping: { incident_update: { body: '$body', display_at: '$display_at', deliver_notifications: '$deliver_notifications', wants_twitter_update: '$wants_twitter_update' } },
    });
    expect(tool('statuspage_delete_incident').endpointMapping).toEqual({ method: 'DELETE', path: `${P}/incidents/{incident_id}` });
    expect(tool('statuspage_get_postmortem').endpointMapping.path).toBe(`${P}/incidents/{incident_id}/postmortem`);
    expect(tool('statuspage_list_incident_templates').endpointMapping.path).toBe(`${P}/incident_templates`);
    expect(tool('statuspage_create_incident_template').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/incident_templates`, bodyMapping: { template: { name: '$name', title: '$title', body: '$body' } } });
  });

  it('maps subscribers and metrics', () => {
    expect(tool('statuspage_list_subscribers').endpointMapping).toEqual({
      method: 'GET',
      path: `${P}/subscribers`,
      queryParams: { q: '$q', type: '$type', state: '$state', limit: '$limit', page: '$page', sort_field: '$sort_field', sort_direction: '$sort_direction' },
    });
    expect(tool('statuspage_list_subscribers').parameters?.properties?.page.minimum).toBe(0);
    expect(tool('statuspage_get_subscriber').endpointMapping.path).toBe(`${P}/subscribers/{subscriber_id}`);
    expect(tool('statuspage_count_subscribers').endpointMapping).toEqual({ method: 'GET', path: `${P}/subscribers/count`, queryParams: { type: '$type', state: '$state' } });
    expect(tool('statuspage_get_subscriber_histogram').endpointMapping.path).toBe(`${P}/subscribers/histogram_by_state`);
    expect(tool('statuspage_list_unsubscribed_subscribers').endpointMapping.path).toBe(`${P}/subscribers/unsubscribed`);
    expect(tool('statuspage_list_incident_subscribers').endpointMapping.path).toBe(`${P}/incidents/{incident_id}/subscribers`);
    expect(tool('statuspage_create_subscriber').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/subscribers`, bodyMapping: { subscriber: { email: '$email', endpoint: '$endpoint', phone_number: '$phone_number', phone_country: '$phone_country' } } });
    expect(tool('statuspage_unsubscribe_subscriber').endpointMapping).toEqual({ method: 'DELETE', path: `${P}/subscribers/{subscriber_id}`, queryParams: { skip_unsubscription_notification: '$skip_unsubscription_notification' } });
    expect(tool('statuspage_list_metrics').endpointMapping.path).toBe(`${P}/metrics`);
    expect(tool('statuspage_get_metric').endpointMapping.path).toBe(`${P}/metrics/{metric_id}`);
    expect(tool('statuspage_add_metric_data').endpointMapping).toEqual({ method: 'POST', path: `${P}/metrics/{metric_id}/data`, bodyMapping: { data: { timestamp: '$timestamp', value: '$value' } } });
    expect(tool('statuspage_list_metrics_providers').endpointMapping.path).toBe(`${P}/metrics_providers`);
  });

  it('drops page colours and logos from the page answers', () => {
    const page = { id: 'p1', name: 'Acme', url: 'https://status.acme.test', time_zone: 'UTC', css_greens: '#2fcc66', css_reds: '#e74c3c', favicon_logo: { url: 'x' }, hero_cover: null };
    expect(shape('statuspage_list_pages', [page])).toEqual([{ id: 'p1', name: 'Acme', url: 'https://status.acme.test', time_zone: 'UTC' }]);
    expect(shape('statuspage_get_page', page)).toEqual({ id: 'p1', name: 'Acme', url: 'https://status.acme.test', time_zone: 'UTC' });
  });

  it('flags every write, switches the incident delete off and marks no read as a write', () => {
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET';
      expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:${write}`);
      if (t.endpointMapping.method === 'PATCH' || t.endpointMapping.method === 'DELETE') expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
      if (t.endpointMapping.method === 'POST') expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:false`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['statuspage_delete_incident']);
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

const live = process.env.RUN_STATUSPAGE_LIVE === '1' && process.env.STATUSPAGE_API_KEY ? describe : describe.skip;
live('statuspage adapter: live (read-only)', () => {
  // Statuspage allows about one request per second per key.
  const pause = () => new Promise((r) => setTimeout(r, 1100));
  const get = async (path: string) => {
    await pause();
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `OAuth ${process.env.STATUSPAGE_API_KEY}`, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as unknown;
  };
  it('reads pages, components, groups, incidents, templates, subscriber counts and metrics', async () => {
    const pages = (await get('/pages')) as Array<{ id: string }>;
    expect(Array.isArray(pages)).toBe(true);
    const page = pages[0];
    if (!page) return;
    expect(await get(`/pages/${page.id}`)).toMatchObject({ id: page.id });
    const components = (await get(`/pages/${page.id}/components?per_page=5`)) as Array<{ id: string }>;
    expect(Array.isArray(components)).toBe(true);
    if (components[0]) expect(await get(`/pages/${page.id}/components/${components[0].id}`)).toMatchObject({ id: components[0].id });
    expect(Array.isArray(await get(`/pages/${page.id}/component-groups`))).toBe(true);
    expect(Array.isArray(await get(`/pages/${page.id}/incidents?limit=5`))).toBe(true);
    expect(Array.isArray(await get(`/pages/${page.id}/incidents/unresolved`))).toBe(true);
    expect(Array.isArray(await get(`/pages/${page.id}/incidents/upcoming`))).toBe(true);
    expect(Array.isArray(await get(`/pages/${page.id}/incident_templates`))).toBe(true);
    expect(await get(`/pages/${page.id}/subscribers/count`)).toEqual(expect.any(Object));
    expect(Array.isArray(await get(`/pages/${page.id}/metrics`))).toBe(true);
  }, 90_000);
});
