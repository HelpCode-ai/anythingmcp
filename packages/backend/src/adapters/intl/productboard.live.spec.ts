import * as adapter from './productboard.json';

/**
 * Productboard REST API v2 (developer.productboard.com/v2.0.0/reference, OpenAPI files under
 * developer.productboard.com/openapi/{entities,notes,members,teams}.yaml): base
 * https://api.productboard.com/v2, Bearer access token, cursor paging through links.next and pageCursor.
 * API v1 (X-Version: 1) was sunset on 2026-07-08, so nothing here sends that header.
 * Live part (reads only: entity configurations, features, notes, members):
 *   PRODUCTBOARD_API_TOKEN=... RUN_PRODUCTBOARD_LIVE=1 npx jest src/adapters/intl/productboard
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
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
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
const PREFIX = 'productboard_';

describe('productboard adapter: static spec conformance', () => {
  it('authenticates with a Bearer token against API v2, without the v1 X-Version header', () => {
    expect(a.requiredEnvVars).toEqual(['PRODUCTBOARD_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.productboard.com/v2');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{PRODUCTBOARD_API_TOKEN}}' });
    expect(a.connector.headers?.Accept).toBe('application/json');
    expect(JSON.stringify(a.connector)).not.toContain('X-Version');
    expect(a.envVarMeta?.PRODUCTBOARD_API_TOKEN.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.PRODUCTBOARD_API_TOKEN.pattern ?? '');
    expect(re.test(['eyJhbGciOi', 'JIUzI1NiJ9', 'payload', 'sig'].join('.'))).toBe(true);
    expect(re.test('Bearer abc')).toBe(false);
  });

  it('maps the entity endpoints with the documented bracket filters', () => {
    expect(tool('productboard_list_entity_configurations').endpointMapping).toEqual({ method: 'GET', path: '/entities/configurations', queryParams: { 'type[]': '$types' } });
    expect(tool('productboard_get_entity_configuration').endpointMapping.path).toBe('/entities/configurations/{type}');
    expect(tool('productboard_list_entities').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/entities',
      queryParams: { 'type[]': '$types', 'owner[email]': '$owner_email', 'status[name]': '$status_name', 'parent[id]': '$parent_id', 'fields[]': '$fields', pageCursor: '$page_cursor' },
    });
    expect(tool('productboard_search_entities').endpointMapping).toMatchObject({ method: 'POST', path: '/entities/search', bodyMapping: { data: { filter: { type: '$types', fields: '$field_filters' }, return: { fields: '$return_fields' } } } });
    expect(tool('productboard_get_entity').endpointMapping).toEqual({ method: 'GET', path: '/entities/{id}', queryParams: { 'fields[]': '$fields' } });
    expect(tool('productboard_create_entity').endpointMapping).toEqual({
      method: 'POST',
      path: '/entities',
      bodyMapping: { data: { type: '$type', fields: '$fields', relationships: '$relationships', metadata: { source: '$source' } } },
    });
    expect(tool('productboard_update_entity').endpointMapping).toEqual({ method: 'PATCH', path: '/entities/{id}', bodyMapping: { data: { fields: '$fields', patch: '$patch' } } });
    expect(tool('productboard_list_entity_relationships').endpointMapping).toMatchObject({ path: '/entities/{id}/relationships', queryParams: { 'target[type]': '$target_type', 'target[id]': '$target_id' } });
    expect(tool('productboard_create_entity_relationship').endpointMapping).toEqual({ method: 'POST', path: '/entities/{id}/relationships', bodyMapping: { data: { type: '$type', target: { id: '$target_id' } } } });
    expect(tool('productboard_set_entity_parent').endpointMapping).toEqual({ method: 'PUT', path: '/entities/{id}/relationships/parent', bodyMapping: { data: { target: { id: '$parent_id' } } } });
    expect(tool('productboard_list_field_values').endpointMapping).toMatchObject({ path: '/entities/fields/{field_id}/values', queryParams: { 'assignedEntityType[]': '$entity_types' } });
  });

  it('maps the note, member and team endpoints', () => {
    expect(tool('productboard_list_note_configurations').endpointMapping.path).toBe('/notes/configurations');
    expect(tool('productboard_list_notes').endpointMapping).toMatchObject({
      path: '/notes',
      queryParams: { 'metadata[source][system]': '$source_system', createdFrom: '$created_from', updatedTo: '$updated_to', processed: '$processed', pageCursor: '$page_cursor' },
    });
    expect(tool('productboard_search_notes').endpointMapping).toMatchObject({ method: 'POST', path: '/notes/search', bodyMapping: { data: { search: { query: '$query' } } } });
    expect(tool('productboard_get_note').endpointMapping).toEqual({ method: 'GET', path: '/notes/{id}' });
    expect(tool('productboard_create_note').endpointMapping).toEqual({
      method: 'POST',
      path: '/notes',
      bodyMapping: { data: { type: '$type', fields: { name: '$name', content: '$content', tags: '$tags', owner: '$owner' }, relationships: '$relationships', metadata: { source: '$source' } } },
    });
    expect(tool('productboard_create_note').parameters?.properties?.type.enum).toEqual(['textNote', 'conversationNote']);
    expect(tool('productboard_update_note').endpointMapping).toEqual({ method: 'PATCH', path: '/notes/{id}', bodyMapping: { data: { fields: '$fields', patch: '$patch' } } });
    expect(tool('productboard_list_note_relationships').endpointMapping.path).toBe('/notes/{id}/relationships');
    expect(tool('productboard_link_note').endpointMapping).toEqual({ method: 'POST', path: '/notes/{id}/relationships', bodyMapping: { data: { type: '$type', target: '$target' } } });
    expect(tool('productboard_list_members').endpointMapping).toMatchObject({ path: '/members', queryParams: { 'roles[]': '$roles', includeDisabled: '$include_disabled' } });
    expect(tool('productboard_get_member').endpointMapping.path).toBe('/members/{id}');
    expect(tool('productboard_list_teams').endpointMapping.path).toBe('/teams');
    expect(tool('productboard_list_team_members').endpointMapping.path).toBe('/teams/{id}/members');
  });

  it('marks the POST searches read-only and ships no delete tool', () => {
    expect(tool('productboard_search_entities').annotations).toEqual({ readOnlyHint: true });
    expect(tool('productboard_search_notes').annotations).toEqual({ readOnlyHint: true });
    for (const t of a.tools) {
      expect(t.endpointMapping.method).not.toBe('DELETE');
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
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

const live = process.env.RUN_PRODUCTBOARD_LIVE === '1' && process.env.PRODUCTBOARD_API_TOKEN ? describe : describe.skip;
live('productboard adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.PRODUCTBOARD_API_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: unknown; links?: { next?: string | null } };
  };
  it('reads entity configurations, features, notes and members', async () => {
    const configs = (await get('/entities/configurations')).data as Array<{ type: string }>;
    expect(configs.map((c) => c.type)).toContain('feature');
    expect(Array.isArray((await get('/entities?type[]=feature')).data)).toBe(true);
    expect(Array.isArray((await get('/notes')).data)).toBe(true);
    expect(Array.isArray((await get('/members')).data)).toBe(true);
  }, 60_000);
});
