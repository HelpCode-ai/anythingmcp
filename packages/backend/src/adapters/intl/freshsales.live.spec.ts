import * as adapter from './freshsales.json';

/**
 * Freshsales / Freshworks CRM API (developers.freshworks.com/crm/api): base
 * <bundle alias>/api (https://<domain>.myfreshworks.com/crm/sales/api, legacy
 * https://<domain>.freshsales.io/api), header "Authorization: Token token=<key>",
 * JSON bodies wrapped in the module root ({"contact": {...}}), lists through views.
 * Live part (reads only: users, contact views, pipelines):
 *   FRESHSALES_BUNDLE_URL=https://acme.myfreshworks.com/crm/sales FRESHSALES_API_KEY=... \
 *   RUN_FRESHSALES_LIVE=1 npx jest src/adapters/intl/freshsales
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
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
const PREFIX = 'freshsales_';

describe('freshsales adapter: static spec conformance', () => {
  it('sends the key as "Token token=" to the bundle URL', () => {
    expect(a.requiredEnvVars).toEqual(['FRESHSALES_BUNDLE_URL', 'FRESHSALES_API_KEY']);
    expect(a.connector.baseUrl).toBe('{{FRESHSALES_BUNDLE_URL}}/api');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Token token={{FRESHSALES_API_KEY}}' });
    expect(a.envVarMeta.FRESHSALES_API_KEY.secret).toBe(true);
    const host = new RegExp(a.envVarMeta.FRESHSALES_BUNDLE_URL.pattern as string);
    for (const ok of ['https://acme.myfreshworks.com/crm/sales', 'https://acme.freshworks.com/crm/sales', 'https://acme.freshsales.io']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://acme.myfreshworks.com/crm/sales/', 'https://acme.myfreshworks.com/crm/sales/api', 'acme.freshsales.io', 'https://acme.freshdesk.com']) expect(host.test(bad)).toBe(false);
  });

  it('lists records through views and wraps bodies in the module root', () => {
    expect(tool('freshsales_list_views').endpointMapping.path).toBe('/{module}/filters');
    expect(tool('freshsales_list_views').parameters?.properties?.module.enum).toEqual(['contacts', 'sales_accounts', 'deals']);
    expect(tool('freshsales_list_contacts').endpointMapping).toMatchObject({ method: 'GET', path: '/contacts/view/{view_id}', queryParams: { page: '$page', per_page: '$per_page', sort: '$sort', sort_type: '$sort_type', include: '$include' } });
    expect(tool('freshsales_list_accounts').endpointMapping.path).toBe('/sales_accounts/view/{view_id}');
    expect(tool('freshsales_list_deals').endpointMapping.path).toBe('/deals/view/{view_id}');
    expect(tool('freshsales_create_contact').endpointMapping).toMatchObject({ method: 'POST', path: '/contacts', bodyMapping: { contact: { first_name: '$first_name', email: '$email', custom_field: '$custom_field' } } });
    expect(tool('freshsales_update_contact').endpointMapping).toMatchObject({ method: 'PUT', path: '/contacts/{contact_id}' });
    expect(tool('freshsales_upsert_contact').endpointMapping).toEqual({ method: 'POST', path: '/contacts/upsert', bodyMapping: { unique_identifier: '$unique_identifier', contact: '$contact' } });
    expect(tool('freshsales_create_account').endpointMapping).toMatchObject({ path: '/sales_accounts', bodyMapping: { sales_account: { name: '$name' } } });
    expect(tool('freshsales_create_deal').endpointMapping).toMatchObject({ path: '/deals', bodyMapping: { deal: { name: '$name', amount: '$amount', sales_account_id: '$sales_account_id', contacts_added_list: '$contacts_added_list' } } });
    expect(tool('freshsales_update_deal').endpointMapping).toMatchObject({ method: 'PUT', path: '/deals/{deal_id}', bodyMapping: { deal: { deal_stage_id: '$deal_stage_id', contacts_removed_list: '$contacts_removed_list' } } });
    expect(tool('freshsales_create_note').endpointMapping.bodyMapping).toEqual({ note: { description: '$description', targetable_type: '$targetable_type', targetable_id: '$targetable_id' } });
    expect(tool('freshsales_create_task').endpointMapping).toMatchObject({ path: '/tasks', bodyMapping: { task: { due_date: '$due_date', owner_id: '$owner_id', task_users_attributes: '$task_users_attributes' } } });
    expect(tool('freshsales_complete_task').endpointMapping).toEqual({ method: 'PUT', path: '/tasks/{task_id}', bodyMapping: { task: { status: 1 } } });
    expect(tool('freshsales_create_appointment').endpointMapping).toMatchObject({ path: '/appointments', bodyMapping: { appointment: { from_date: '$from_date', end_date: '$end_date', appointment_attendees_attributes: '$appointment_attendees_attributes' } } });
    expect(tool('freshsales_create_sales_activity').endpointMapping).toMatchObject({ path: '/sales_activities', bodyMapping: { sales_activity: { sales_activity_type_id: '$sales_activity_type_id', sales_activity_outcome_id: '$sales_activity_outcome_id' } } });
    for (const t of ['freshsales_create_note', 'freshsales_create_task', 'freshsales_create_appointment', 'freshsales_create_sales_activity'])
      expect(tool(t).parameters?.properties?.targetable_type.enum).toEqual(['Contact', 'SalesAccount', 'Deal']);
  });

  it('maps tasks, appointments, search, lookup, selectors and lists as documented', () => {
    expect(tool('freshsales_list_tasks').endpointMapping).toMatchObject({ path: '/tasks', queryParams: { filter: '$filter' } });
    expect(tool('freshsales_list_tasks').parameters?.required).toEqual(['filter']);
    expect(tool('freshsales_list_appointments').endpointMapping).toMatchObject({ path: '/appointments', queryParams: { filter: '$filter' } });
    expect(tool('freshsales_search').endpointMapping).toEqual({ method: 'GET', path: '/search', queryParams: { q: '$q', include: '$include', per_page: '$per_page' } });
    expect(tool('freshsales_lookup').endpointMapping).toEqual({ method: 'GET', path: '/lookup', queryParams: { q: '$q', f: '$f', entities: '$entities' } });
    expect(tool('freshsales_filtered_search').endpointMapping).toMatchObject({ method: 'POST', path: '/filtered_search/{entity}', bodyMapping: { filter_rule: '$filter_rule' } });
    expect(tool('freshsales_list_owners').endpointMapping).toEqual({ method: 'GET', path: '/selector/owners' });
    expect(tool('freshsales_list_selector').endpointMapping.path).toBe('/selector/{selector}');
    expect(tool('freshsales_list_selector').parameters?.properties?.selector.enum).toEqual(expect.arrayContaining(['deal_pipelines', 'deal_stages', 'lifecycle_stages', 'contact_statuses', 'sales_activity_types']));
    expect(tool('freshsales_list_pipeline_stages').endpointMapping.path).toBe('/selector/deal_pipelines/{pipeline_id}/deal_stages');
    expect(tool('freshsales_list_fields').endpointMapping.path).toBe('/settings/{module}/fields');
    expect(tool('freshsales_list_marketing_list_contacts').endpointMapping.path).toBe('/contacts/lists/{list_id}');
    expect(tool('freshsales_add_contacts_to_list').endpointMapping).toEqual({ method: 'PUT', path: '/lists/{list_id}/add_contacts', bodyMapping: { ids: '$ids' } });
    expect(tool('freshsales_remove_contacts_from_list').endpointMapping).toEqual({ method: 'PUT', path: '/lists/{list_id}/remove_contacts', bodyMapping: { ids: '$ids' } });
  });

  it('marks the POST search read-only, list removal destructive, and has no delete tools', () => {
    expect(tool('freshsales_filtered_search').annotations).toEqual({ readOnlyHint: true });
    expect(tool('freshsales_remove_contacts_from_list').annotations?.destructiveHint).toBe(true);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE')).toEqual([]);
    for (const t of a.tools) if (t.endpointMapping.method === 'POST' && !/^freshsales_(create|upsert)_/.test(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
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
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_FRESHSALES_LIVE === '1' && process.env.FRESHSALES_API_KEY && process.env.FRESHSALES_BUNDLE_URL ? describe : describe.skip;
live('freshsales adapter: live (read-only)', () => {
  const base = `${process.env.FRESHSALES_BUNDLE_URL}/api`;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Token token=${process.env.FRESHSALES_API_KEY}`, 'Content-Type': 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads users, contact views and pipelines', async () => {
    expect(Array.isArray((await get('/selector/owners')).users)).toBe(true);
    const views = (await get('/contacts/filters')).filters as Array<{ id: number; name: string }>;
    expect(views.length).toBeGreaterThan(0);
    expect(Array.isArray((await get(`/contacts/view/${views[0].id}?per_page=1`)).contacts)).toBe(true);
    expect(Array.isArray((await get('/selector/deal_pipelines')).deal_pipelines)).toBe(true);
  }, 60_000);
});
