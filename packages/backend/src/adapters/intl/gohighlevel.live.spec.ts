import * as adapter from './gohighlevel.json';

/**
 * HighLevel API v2 (marketplace.gohighlevel.com/docs, OpenAPI at github.com/GoHighLevel/highlevel-api-docs):
 * base https://services.leadconnectorhq.com, Private Integration token as Bearer, required Version header
 * (2021-07-28; 2021-04-15 for conversations and calendars), every call scoped to GOHIGHLEVEL_LOCATION_ID.
 * Live part (reads only: location, users, pipelines, calendars):
 *   GOHIGHLEVEL_API_TOKEN=... GOHIGHLEVEL_LOCATION_ID=... RUN_GOHIGHLEVEL_LIVE=1 npx jest src/adapters/intl/gohighlevel
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string; advanced?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const ENV = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings (connector variables excluded).
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
  for (const e of ENV) out.delete(e);
  return out;
};
const PREFIX = 'gohighlevel_';

describe('gohighlevel adapter: static spec conformance', () => {

  const LOC = '{{GOHIGHLEVEL_LOCATION_ID}}';

  it('authenticates with the Private Integration token and sends the Version header', () => {
    expect(a.requiredEnvVars).toEqual(['GOHIGHLEVEL_API_TOKEN', 'GOHIGHLEVEL_LOCATION_ID']);
    expect(a.connector.baseUrl).toBe('https://services.leadconnectorhq.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{GOHIGHLEVEL_API_TOKEN}}' });
    expect(a.connector.headers?.Version).toBe('2021-07-28');
    expect(a.envVarMeta?.GOHIGHLEVEL_API_TOKEN.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.GOHIGHLEVEL_LOCATION_ID.pattern as string).test('ve9EPM428h8vShlRW1KT')).toBe(true);
    expect(a.category).toBe('crm');
  });

  it('uses Version 2021-04-15 exactly on the conversation and calendar endpoints', () => {
    for (const t of a.tools) {
      const v = t.endpointMapping.headers?.Version;
      const old = /^\/(conversations|calendars)\//.test(t.endpointMapping.path);
      expect(`${t.name}:${v ?? ''}`).toBe(`${t.name}:${old ? '2021-04-15' : ''}`);
    }
  });

  it('scopes location-bound calls to the configured sub-account', () => {
    expect(tool('gohighlevel_get_location').endpointMapping.path).toBe(`/locations/${LOC}`);
    expect(tool('gohighlevel_search_contacts').endpointMapping).toMatchObject({ method: 'POST', path: '/contacts/search', bodyMapping: { locationId: LOC, query: '$query', filters: '$filters', pageLimit: '$page_limit' } });
    expect((tool('gohighlevel_create_contact').endpointMapping.bodyMapping as Record<string, unknown>).locationId).toBe(LOC);
    expect(tool('gohighlevel_search_opportunities').endpointMapping.queryParams).toMatchObject({ location_id: LOC, pipeline_id: '$pipeline_id', status: '$status' });
    expect(tool('gohighlevel_search_conversations').endpointMapping.queryParams).toMatchObject({ locationId: LOC, contactId: '$contact_id' });
    expect(tool('gohighlevel_list_invoices').endpointMapping.queryParams).toMatchObject({ altId: LOC, altType: 'location', limit: '$limit', offset: '$offset' });
    expect(tool('gohighlevel_list_social_posts').endpointMapping.path).toBe(`/social-media-posting/${LOC}/posts/list`);
    for (const n of ['gohighlevel_list_users', 'gohighlevel_list_workflows', 'gohighlevel_list_pipelines', 'gohighlevel_list_calendars', 'gohighlevel_list_forms', 'gohighlevel_list_form_submissions'])
      expect((tool(n).endpointMapping.queryParams as Record<string, unknown>).locationId).toBe(LOC);
  });

  it('maps contacts, workflows, messages, opportunities, appointments and invoices', () => {
    expect(tool('gohighlevel_upsert_contact').endpointMapping).toMatchObject({ method: 'POST', path: '/contacts/upsert' });
    expect(tool('gohighlevel_update_contact').endpointMapping).toMatchObject({ method: 'PUT', path: '/contacts/{contact_id}' });
    expect(tool('gohighlevel_add_contact_tags').endpointMapping).toEqual({ method: 'POST', path: '/contacts/{contact_id}/tags', bodyMapping: { tags: '$tags' } });
    expect(tool('gohighlevel_create_contact_task').endpointMapping.path).toBe('/contacts/{contact_id}/tasks');
    expect(tool('gohighlevel_add_contact_to_workflow').endpointMapping).toMatchObject({ method: 'POST', path: '/contacts/{contact_id}/workflow/{workflow_id}' });
    expect(tool('gohighlevel_send_message').endpointMapping).toMatchObject({ method: 'POST', path: '/conversations/messages', bodyMapping: { type: '$type', contactId: '$contactId', message: '$message', html: '$html', subject: '$subject' } });
    expect(tool('gohighlevel_send_message').parameters?.required).toEqual(['type', 'contactId']);
    expect(tool('gohighlevel_list_messages').endpointMapping.path).toBe('/conversations/{conversation_id}/messages');
    expect(tool('gohighlevel_update_opportunity_status').endpointMapping).toEqual({ method: 'PUT', path: '/opportunities/{opportunity_id}/status', bodyMapping: { status: '$status', lostReasonId: '$lostReasonId' } });
    expect(tool('gohighlevel_get_free_slots').endpointMapping).toMatchObject({ path: '/calendars/{calendar_id}/free-slots', queryParams: { startDate: '$startDate', endDate: '$endDate' } });
    expect(tool('gohighlevel_create_appointment').endpointMapping).toMatchObject({ method: 'POST', path: '/calendars/events/appointments', bodyMapping: { locationId: LOC, calendarId: '$calendarId', contactId: '$contactId', startTime: '$startTime' } });
    expect(tool('gohighlevel_send_invoice').endpointMapping).toMatchObject({ method: 'POST', path: '/invoices/{invoice_id}/send', bodyMapping: { altId: LOC, altType: 'location', action: '$action' } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(`${t.name}:${r}:${props.includes(r)}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('marks reads over POST or PATCH read-only and deletes destructive', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping.method;
      if (m === 'DELETE') expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
      if (m !== 'GET' && /_(search|find|preview|validate)_|_list_/.test(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      if (m === 'GET') expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
  });

  it('probes with a read tool without required parameters and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_GOHIGHLEVEL_LIVE === '1' && process.env.GOHIGHLEVEL_API_TOKEN && process.env.GOHIGHLEVEL_LOCATION_ID ? describe : describe.skip;
live('gohighlevel adapter: live (read-only)', () => {
  const loc = process.env.GOHIGHLEVEL_LOCATION_ID as string;
  const get = async (path: string, version = '2021-07-28') => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.GOHIGHLEVEL_API_TOKEN}`, Version: version, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the location, users, pipelines and calendars', async () => {
    expect((await get(`/locations/${loc}`)).location).toBeTruthy();
    expect(Array.isArray((await get(`/users/?locationId=${loc}`)).users)).toBe(true);
    expect(Array.isArray((await get(`/opportunities/pipelines?locationId=${loc}`)).pipelines)).toBe(true);
    expect(Array.isArray((await get(`/calendars/?locationId=${loc}`, '2021-04-15')).calendars)).toBe(true);
  }, 60_000);
});
