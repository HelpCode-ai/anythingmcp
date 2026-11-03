import * as adapter from './recruitee.json';

/**
 * Recruitee ATS API (docs.recruitee.com/reference/getting-started, full reference at
 * apidocs.recruitee.com): base https://api.recruitee.com/c/{company_id}, personal API token
 * as Bearer. Writes nest their fields under the resource name ({"candidate": ...},
 * {"offer": ...}, {"task": ...}); array query filters use the name[] form.
 * Live part (reads only: current admin, offers, departments, candidates):
 *   RECRUITEE_COMPANY_ID=... RECRUITEE_API_TOKEN=... RUN_RECRUITEE_LIVE=1 npx jest src/adapters/intl/recruitee
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
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
const PREFIX = 'recruitee_';
const isRead = (t: Tool) => t.endpointMapping.method === 'GET';

describe('recruitee adapter: static spec conformance', () => {
  it('authenticates with a Bearer personal token on the company-scoped base URL', () => {
    expect(a.slug).toBe('recruitee');
    expect(a.category).toBe('hr');
    expect(a.requiredEnvVars).toEqual(['RECRUITEE_COMPANY_ID', 'RECRUITEE_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.recruitee.com/c/{{RECRUITEE_COMPANY_ID}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{RECRUITEE_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/admin');
    expect(a.envVarMeta?.RECRUITEE_API_TOKEN.secret).toBe(true);
    const company = new RegExp(a.envVarMeta?.RECRUITEE_COMPANY_ID.pattern ?? '');
    expect(company.test('123456')).toBe(true);
    expect(company.test('acme')).toBe(true);
    expect(company.test('https://api.recruitee.com/c/123')).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/')).toBe(true);
  });

  it('maps jobs, candidates and search with the documented query names', () => {
    expect(tool('recruitee_list_offers').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/offers',
      queryParams: { 'statuses[]': '$statuses', 'department_ids[]': '$department_ids', 'include[]': '$include', kind: '$kind', limit: '$limit', page: '$page' },
    });
    expect(tool('recruitee_get_offer').endpointMapping).toEqual({ method: 'GET', path: '/offers/{id}' });
    expect(tool('recruitee_list_candidates').endpointMapping).toEqual({
      method: 'GET',
      path: '/candidates',
      queryParams: {
        query: '$query',
        offer_id: '$offer_id',
        qualified: '$qualified',
        disqualified: '$disqualified',
        deleted: '$deleted',
        ids: '$ids',
        created_after: '$created_after',
        sort: '$sort',
        limit: '$limit',
        offset: '$offset',
      },
    });
    expect(tool('recruitee_list_candidates').parameters?.properties?.limit.maximum).toBe(1000);
    expect(tool('recruitee_search_candidates').endpointMapping).toEqual({
      method: 'GET',
      path: '/search/new/candidates',
      queryParams: { filters_json: '$filters_json', sort_by: '$sort_by', limit: '$limit', page: '$page' },
    });
    expect(tool('recruitee_get_candidate').endpointMapping.path).toBe('/candidates/{id}');
    expect(tool('recruitee_list_activities').endpointMapping.queryParams).toMatchObject({ 'candidates[]': '$candidates', 'offers[]': '$offers', start_date: '$start_date' });
    expect(tool('recruitee_list_interview_events').endpointMapping).toMatchObject({ path: '/interview/events', queryParams: { status: '$status', 'admin_ids[]': '$admin_ids' } });
  });

  it('maps the remaining reads', () => {
    for (const [n, p] of [
      ['recruitee_get_current_admin', '/admin'],
      ['recruitee_list_admins', '/admins'],
      ['recruitee_list_offer_notes', '/offers/{offer_id}/notes'],
      ['recruitee_list_candidate_notes', '/candidates/{candidate_id}/notes'],
      ['recruitee_list_candidate_activities', '/tracking/candidates/{candidate_id}/activities'],
      ['recruitee_list_placements', '/offers/{offer_id}/placements'],
      ['recruitee_list_pipeline_templates', '/pipeline_templates'],
      ['recruitee_get_pipeline_template', '/pipeline_templates/{id}'],
      ['recruitee_list_disqualify_reasons', '/disqualify_reasons'],
      ['recruitee_list_departments', '/departments'],
      ['recruitee_get_department', '/departments/{id}'],
      ['recruitee_list_locations', '/locations'],
      ['recruitee_get_location', '/locations/{id}'],
      ['recruitee_list_tags', '/tags'],
      ['recruitee_list_sources', '/sources'],
      ['recruitee_get_interview_event', '/interview/events/{id}'],
      ['recruitee_list_interview_results', '/interview/results'],
      ['recruitee_list_tasks', '/tasks'],
      ['recruitee_list_candidate_tasks', '/candidates/{candidate_id}/tasks'],
    ]) expect(`${n}:${tool(n).endpointMapping.method} ${tool(n).endpointMapping.path}`).toBe(`${n}:GET ${p}`);
  });

  it('nests write fields under the resource name', () => {
    expect(tool('recruitee_create_candidate').endpointMapping).toEqual({
      method: 'POST',
      path: '/candidates',
      bodyMapping: {
        candidate: {
          name: '$name',
          emails: '$emails',
          phones: '$phones',
          links: '$links',
          social_links: '$social_links',
          cover_letter: '$cover_letter',
          sources: '$sources',
          remote_cv_url: '$remote_cv_url',
        },
        offers: '$offers',
      },
    });
    expect(tool('recruitee_update_candidate').endpointMapping).toEqual({ method: 'PATCH', path: '/candidates/{id}', bodyMapping: { candidate: '$fields' } });
    expect(tool('recruitee_delete_candidate').endpointMapping).toEqual({ method: 'DELETE', path: '/candidates/{id}' });
    expect(tool('recruitee_add_candidate_tags').endpointMapping).toEqual({ method: 'POST', path: '/candidates/{candidate_id}/tags', bodyMapping: { tags: '$tags' } });
    expect(tool('recruitee_remove_candidate_tags').endpointMapping).toEqual({ method: 'DELETE', path: '/candidates/{candidate_id}/tags', bodyMapping: { tags: '$tags' } });
    expect(tool('recruitee_add_candidate_field').endpointMapping).toEqual({
      method: 'POST',
      path: '/custom_fields/candidates/{candidate_id}/fields',
      bodyMapping: { field: { kind: '$kind', name: '$name', values: '$values' } },
    });
    expect(tool('recruitee_create_candidate_note').endpointMapping.bodyMapping).toEqual({
      note: { body_json: { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '$text' }] }] } } },
    });
    expect(tool('recruitee_assign_candidate').endpointMapping).toEqual({
      method: 'POST',
      path: '/placements',
      bodyMapping: { candidate_id: '$candidate_id', offer_id: '$offer_id', talent_pool_id: '$talent_pool_id', location_ids: '$location_ids' },
    });
    expect(tool('recruitee_change_stage').endpointMapping).toMatchObject({ method: 'PATCH', path: '/placements/{placement_id}/change_stage', bodyMapping: { stage_id: '$stage_id', run_actions: '$run_actions' } });
    expect(tool('recruitee_disqualify_candidate').endpointMapping).toEqual({ method: 'PATCH', path: '/placements/{placement_id}/disqualify', bodyMapping: { disqualify_reason_id: '$disqualify_reason_id' } });
    expect(tool('recruitee_requalify_candidate').endpointMapping).toEqual({ method: 'PATCH', path: '/placements/{placement_id}/requalify' });
    expect(tool('recruitee_create_offer').endpointMapping).toMatchObject({ method: 'POST', path: '/offers', bodyMapping: { offer: { title: '$title', kind: '$kind', location_ids: '$location_ids' } } });
    expect(tool('recruitee_update_offer').endpointMapping).toEqual({ method: 'PATCH', path: '/offers/{id}', bodyMapping: { offer: '$fields' } });
    for (const act of ['publish', 'unpublish', 'close']) expect(tool(`recruitee_${act}_offer`).endpointMapping).toEqual({ method: 'PATCH', path: `/offers/{id}/${act}` });
    expect(tool('recruitee_create_task').endpointMapping).toMatchObject({ method: 'POST', path: '/tasks', bodyMapping: { task: { title: '$title', admin_ids: '$admin_ids', candidate_id: '$candidate_id' } } });
    expect(tool('recruitee_complete_task').endpointMapping).toEqual({ method: 'PATCH', path: '/tasks/{id}/completion', bodyMapping: { task: { completed: '$completed' } } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes carry explicit annotations; candidate deletes install switched off', () => {
    for (const t of a.tools.filter((x) => !isRead(x))) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'DELETE')) expect(t.annotations?.destructiveHint).toBe(true);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['recruitee_delete_candidate', 'recruitee_remove_placement']);
    for (const t of a.tools.filter(isRead)) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(isRead(tool(a.probe.tool))).toBe(true);
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toContain('**Switched off at install**');
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_RECRUITEE_LIVE === '1' && process.env.RECRUITEE_COMPANY_ID && process.env.RECRUITEE_API_TOKEN ? describe : describe.skip;
live('recruitee adapter: live (read-only)', () => {
  const base = a.connector.baseUrl.replace('{{RECRUITEE_COMPANY_ID}}', process.env.RECRUITEE_COMPANY_ID ?? '');
  const call = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${process.env.RECRUITEE_API_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the current admin, offers, departments and candidates', async () => {
    expect(await call('/admin')).toHaveProperty('admin');
    expect(Array.isArray((await call('/offers?limit=5')).offers)).toBe(true);
    expect(Array.isArray((await call('/departments')).departments)).toBe(true);
    expect(Array.isArray((await call('/candidates?limit=5')).candidates)).toBe(true);
  }, 60_000);
});
