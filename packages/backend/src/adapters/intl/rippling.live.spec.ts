import * as adapter from './rippling.json';

/**
 * Rippling REST API (developer.rippling.com/documentation/rest-api, reference pages as Markdown):
 * base https://rest.ripplingapis.com, Bearer API token from Developer > API credentials.
 * Collection paths end with a slash; lists page with limit (max 100) and the cursor taken
 * from next_link; filter takes an OData-style expression.
 * Live part (reads only: companies, workers, departments, leave types):
 *   RIPPLING_API_TOKEN=... RUN_RIPPLING_LIVE=1 npx jest src/adapters/intl/rippling
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
const PREFIX = 'rippling_';
const isRead = (t: Tool) => t.endpointMapping.method === 'GET';
const PAGE = { order_by: '$order_by', limit: '$limit', cursor: '$cursor' };

describe('rippling adapter: static spec conformance', () => {
  it('authenticates with a Bearer API token against the REST host', () => {
    expect(a.slug).toBe('rippling');
    expect(a.category).toBe('hr');
    expect(a.requiredEnvVars).toEqual(['RIPPLING_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://rest.ripplingapis.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{RIPPLING_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/companies/');
    expect(a.envVarMeta?.RIPPLING_API_TOKEN.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.RIPPLING_API_TOKEN.pattern ?? '');
    expect(re.test(['abc', 'DEF', '0123456789', 'ghijklmnop'].join(''))).toBe(true);
    expect(re.test('Bearer abc')).toBe(false);
    for (const t of a.tools) {
      expect(t.endpointMapping.path.startsWith('/')).toBe(true);
      expect(`${t.name}:${t.endpointMapping.path.endsWith('/')}`).toBe(`${t.name}:true`);
    }
  });

  it('maps workers, users and compensations with filter, expand and cursor paging', () => {
    expect(tool('rippling_list_workers').endpointMapping).toEqual({
      method: 'GET',
      path: '/workers/',
      queryParams: { filter: '$filter', expand: '$expand', ...PAGE },
    });
    expect(tool('rippling_get_worker').endpointMapping).toEqual({ method: 'GET', path: '/workers/{id}/', queryParams: { expand: '$expand' } });
    expect(tool('rippling_list_users').endpointMapping).toEqual({ method: 'GET', path: '/users/', queryParams: PAGE });
    expect(tool('rippling_get_user').endpointMapping).toEqual({ method: 'GET', path: '/users/{id}/' });
    expect(tool('rippling_list_compensations').endpointMapping).toEqual({ method: 'GET', path: '/compensations/', queryParams: { expand: '$expand', ...PAGE } });
    expect(tool('rippling_list_companies').endpointMapping.path).toBe('/companies/');
    expect(tool('rippling_list_custom_fields').endpointMapping).toEqual({ method: 'GET', path: '/custom-fields/', queryParams: PAGE });
    expect(tool('rippling_list_workers').parameters?.properties?.limit.maximum).toBe(100);
  });

  it('maps the org structure, groups, leave and time endpoints', () => {
    for (const [n, p] of [
      ['rippling_list_departments', '/departments/'],
      ['rippling_list_teams', '/teams/'],
      ['rippling_list_work_locations', '/work-locations/'],
      ['rippling_list_levels', '/levels/'],
      ['rippling_list_titles', '/titles/'],
      ['rippling_list_employment_types', '/employment-types/'],
      ['rippling_list_job_codes', '/job-codes/'],
      ['rippling_list_supergroups', '/supergroups/'],
      ['rippling_list_leave_types', '/leave-types/'],
      ['rippling_list_leave_balances', '/leave-balances/'],
      ['rippling_list_leave_requests', '/leave-requests/'],
      ['rippling_list_time_entries', '/time-entries/'],
    ]) expect(`${n}:${tool(n).endpointMapping.path}`).toBe(`${n}:${p}`);
    expect(tool('rippling_list_leave_requests').endpointMapping.queryParams).toEqual({ filter: '$filter', expand: '$expand', ...PAGE });
    expect(tool('rippling_list_leave_types').endpointMapping.queryParams).toEqual({ filter: '$filter', ...PAGE });
    expect(tool('rippling_list_supergroup_members').endpointMapping).toEqual({
      method: 'GET',
      path: '/supergroups/{group_id}/members/',
      queryParams: { expand: '$expand', ...PAGE },
    });
    expect(tool('rippling_get_leave_balance').endpointMapping.path).toBe('/leave-balances/{id}/');
    expect(tool('rippling_get_time_entry').endpointMapping.path).toBe('/time-entries/{id}/');
  });

  it('maps writes with the documented body fields', () => {
    expect(tool('rippling_create_department').endpointMapping).toEqual({
      method: 'POST',
      path: '/departments/',
      bodyMapping: { name: '$name', parent_id: '$parent_id', reference_code: '$reference_code' },
    });
    expect(tool('rippling_update_department').endpointMapping.method).toBe('PATCH');
    expect(tool('rippling_update_team').endpointMapping).toEqual({ method: 'PATCH', path: '/teams/{id}/', bodyMapping: { name: '$name', parent_id: '$parent_id' } });
    expect(tool('rippling_create_work_location').endpointMapping.bodyMapping).toEqual({ name: '$name', address: '$address' });
    expect(tool('rippling_create_leave_request').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/leave-requests/',
      bodyMapping: { worker_id: '$worker_id', status: '$status', start_date: '$start_date', end_date: '$end_date', leave_type_id: '$leave_type_id', leave_policy_id: '$leave_policy_id' },
    });
    expect(tool('rippling_create_leave_request').parameters?.required).toEqual(['worker_id', 'status', 'start_date', 'end_date']);
    expect(tool('rippling_update_leave_request').endpointMapping).toMatchObject({ method: 'PATCH', path: '/leave-requests/{id}/', bodyMapping: { status: '$status', reviewer_id: '$reviewer_id' } });
    expect(tool('rippling_update_leave_request').parameters?.properties?.status.enum).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'CANCELED']);
    expect(tool('rippling_create_time_entry').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/time-entries/',
      bodyMapping: { worker_id: '$worker_id', job_shifts: '$job_shifts', breaks: '$breaks', idempotency_key: '$idempotency_key' },
    });
    expect(tool('rippling_update_time_entry').parameters?.required).toEqual(['id', 'worker_id']);
    expect(tool('rippling_create_draft_hires').endpointMapping).toEqual({ method: 'POST', path: '/draft-hires/', bodyMapping: { draft_hires: '$draft_hires' } });
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

  it('writes carry explicit annotations; deletes install switched off', () => {
    for (const t of a.tools.filter((x) => !isRead(x))) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'DELETE')) expect(t.annotations?.destructiveHint).toBe(true);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['rippling_delete_team', 'rippling_delete_time_entry']);
    for (const t of a.tools.filter(isRead)) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(isRead(tool(a.probe.tool))).toBe(true);
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toContain('**Switched off at install**');
    expect(a.instructions).toContain('Personal data');
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_RIPPLING_LIVE === '1' && process.env.RIPPLING_API_TOKEN ? describe : describe.skip;
live('rippling adapter: live (read-only)', () => {
  const call = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${process.env.RIPPLING_API_TOKEN}`, Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { results: Array<Record<string, unknown>>; next_link?: string | null };
  };
  it('reads companies, workers, departments and leave types', async () => {
    const companies = await call('/companies/');
    expect(companies.results.length).toBeGreaterThan(0);
    const workers = await call(`/workers/?limit=5&filter=${encodeURIComponent("status eq 'ACTIVE'")}`);
    expect(Array.isArray(workers.results)).toBe(true);
    expect(Array.isArray((await call('/departments/?limit=5')).results)).toBe(true);
    expect(Array.isArray((await call('/leave-types/?limit=5')).results)).toBe(true);
  }, 60_000);
});
