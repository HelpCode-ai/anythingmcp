import * as adapter from './deputy.json';

/**
 * Deputy API (developer.deputy.com, reference pages as Markdown with embedded OpenAPI):
 * per-install base https://{install}.{region}.deputy.com/api/v1, Bearer permanent token
 * from the install's OAuth clients page. Management calls live under /supervise, the
 * token user's own data under /my, and every object under /resource/{Object} with a
 * POST /QUERY search (a read) that pages with start and max (max 500).
 * Live part (reads only: me, locations, areas, a roster query):
 *   DEPUTY_HOST=mycompany.au.deputy.com DEPUTY_ACCESS_TOKEN=... RUN_DEPUTY_LIVE=1 npx jest src/adapters/intl/deputy
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
const PREFIX = 'deputy_';
const isRead = (t: Tool) => t.endpointMapping.method === 'GET' || t.annotations?.readOnlyHint === true;
const QUERY = { search: '$search', sort: '$sort', start: '$start', max: '$max', join: '$join' };

describe('deputy adapter: static spec conformance', () => {
  it('authenticates with a Bearer permanent token on the per-install host', () => {
    expect(a.slug).toBe('deputy');
    expect(a.category).toBe('hr');
    expect(a.requiredEnvVars).toEqual(['DEPUTY_HOST', 'DEPUTY_ACCESS_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://{{DEPUTY_HOST}}/api/v1');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{DEPUTY_ACCESS_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/me');
    expect(a.envVarMeta?.DEPUTY_ACCESS_TOKEN.secret).toBe(true);
    const host = new RegExp(a.envVarMeta?.DEPUTY_HOST.pattern ?? '');
    for (const ok of ['mycompany.au.deputy.com', 'my-co.na.deputy.com', 'shop1.uk.deputy.com', 'legacy.deputy.com']) expect(`${ok}:${host.test(ok)}`).toBe(`${ok}:true`);
    for (const bad of ['https://mycompany.au.deputy.com', 'mycompany.au.deputy.com/api/v1', 'example.com']) expect(`${bad}:${host.test(bad)}`).toBe(`${bad}:false`);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/')).toBe(true);
  });

  it('maps the resource QUERY searches as POST reads with the documented body', () => {
    for (const [n, obj] of [
      ['deputy_query_employees', 'Employee'],
      ['deputy_query_rosters', 'Roster'],
      ['deputy_query_timesheets', 'Timesheet'],
      ['deputy_query_leave', 'Leave'],
      ['deputy_query_availability', 'EmployeeAvailability'],
    ]) {
      expect(tool(n).endpointMapping).toEqual({ method: 'POST', path: `/resource/${obj}/QUERY`, bodyMapping: QUERY });
      expect(tool(n).annotations).toEqual({ readOnlyHint: true });
      expect(tool(n).parameters?.properties?.max.maximum).toBe(500);
    }
    expect(tool('deputy_query_resource').endpointMapping).toEqual({ method: 'POST', path: '/resource/{object}/QUERY', bodyMapping: QUERY });
    expect(tool('deputy_query_resource').annotations).toEqual({ readOnlyHint: true });
    expect(tool('deputy_query_resource').parameters?.properties?.object.enum).toContain('LeaveRules');
    expect(tool('deputy_get_resource').endpointMapping).toEqual({ method: 'GET', path: '/resource/{object}/{id}' });
    expect(tool('deputy_get_resource_info').endpointMapping).toEqual({ method: 'GET', path: '/resource/{object}/INFO' });
  });

  it('maps the supervise and my reads', () => {
    for (const [n, p] of [
      ['deputy_get_me', '/me'],
      ['deputy_list_employees', '/supervise/employee'],
      ['deputy_get_employee', '/supervise/employee/{employee_id}'],
      ['deputy_get_employee_shift_status', '/supervise/empshiftinfo/{employee_id}'],
      ['deputy_list_locations', '/resource/Company'],
      ['deputy_list_areas', '/resource/OperationalUnit'],
      ['deputy_list_rosters', '/supervise/roster'],
      ['deputy_get_timesheet', '/supervise/timesheet/{timesheet_id}/details'],
      ['deputy_get_employee_leave', '/supervise/leave/{employee_id}'],
      ['deputy_get_employee_unavailability', '/supervise/unavail/{employee_id}'],
      ['deputy_get_my_rosters', '/my/roster'],
      ['deputy_get_my_timesheets', '/my/timesheets'],
      ['deputy_get_my_leave', '/my/leave'],
      ['deputy_get_my_unavailability', '/my/unavail'],
      ['deputy_get_my_locations', '/my/location'],
      ['deputy_get_my_colleagues', '/my/colleague'],
    ]) expect(`${n}:${tool(n).endpointMapping.method} ${tool(n).endpointMapping.path}`).toBe(`${n}:GET ${p}`);
  });

  it('maps rosters, timesheets, leave and employee writes with Deputy field names', () => {
    expect(tool('deputy_save_shift').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/supervise/roster',
      bodyMapping: { intRosterId: '$roster_id', intOpunitId: '$area_id', intStartTimestamp: '$start', intEndTimestamp: '$end', intRosterEmployee: '$employee_id', blnPublish: '$publish' },
    });
    expect(tool('deputy_publish_rosters').endpointMapping).toEqual({ method: 'POST', path: '/supervise/roster/publish', bodyMapping: { intRosterArray: '$roster_ids', intMode: '$notify', blnAllLocationsMode: '$all_locations' } });
    expect(tool('deputy_publish_rosters').parameters?.properties?.notify.enum).toEqual([1, 2, 3, 4, 5]);
    expect(tool('deputy_copy_rosters').endpointMapping.bodyMapping).toEqual({ strFromDate: '$from_date', strToDate: '$to_date', intOperationalUnitArray: '$area_ids', blnRequireErrorDetails: '$error_details' });
    expect(tool('deputy_start_timesheet').endpointMapping).toEqual({ method: 'POST', path: '/supervise/timesheet/start', bodyMapping: { intEmployeeId: '$employee_id', intOpunitId: '$area_id' } });
    expect(tool('deputy_end_timesheet').endpointMapping.bodyMapping).toEqual({ intTimesheetId: '$timesheet_id', intMealbreakMinute: '$meal_break_minutes' });
    for (const [n, p] of [
      ['deputy_pause_timesheet', 'pause'],
      ['deputy_approve_timesheet', 'approve'],
      ['deputy_discard_timesheet', 'discard'],
    ]) expect(tool(n).endpointMapping).toEqual({ method: 'POST', path: `/supervise/timesheet/${p}`, bodyMapping: { intTimesheetId: '$timesheet_id' } });
    expect(tool('deputy_save_timesheet').endpointMapping).toMatchObject({ path: '/supervise/timesheet/update', bodyMapping: { blnApproveTimesheet: '$approve', arrSlots: '$slots' } });
    expect(tool('deputy_add_leave').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/resource/Leave',
      bodyMapping: { Employee: '$employee_id', LeaveRule: '$leave_rule_id', Company: '$location_id', DateStart: '$date_start', DateEnd: '$date_end', Status: '$status' },
    });
    expect(tool('deputy_update_leave').endpointMapping).toMatchObject({ method: 'POST', path: '/resource/Leave/{leave_id}', bodyMapping: { Status: '$status', ApprovalComment: '$approval_comment' } });
    expect(tool('deputy_add_unavailability').endpointMapping.bodyMapping).toEqual({
      employee: '$employee_id',
      start: { timestamp: '$start' },
      end: { timestamp: '$end' },
      strComment: '$comment',
      recurrence: '$recurrence',
    });
    expect(tool('deputy_add_employee').endpointMapping).toMatchObject({ method: 'POST', path: '/supervise/employee', bodyMapping: { strFirstName: '$first_name', strLastName: '$last_name', intCompanyId: '$location_id' } });
    expect(tool('deputy_update_employee').endpointMapping).toEqual({ method: 'POST', path: '/resource/Employee/{employee_id}', bodyMapping: { __merge: '$fields' } });
    for (const [n, act] of [
      ['deputy_invite_employee', 'invite'],
      ['deputy_terminate_employee', 'terminate'],
      ['deputy_reactivate_employee', 'activate'],
      ['deputy_delete_employee', 'delete'],
    ]) expect(tool(n).endpointMapping).toEqual({ method: 'POST', path: `/supervise/employee/{employee_id}/${act}` });
    expect(tool('deputy_post_memo').endpointMapping).toMatchObject({ method: 'PUT', path: '/supervise/memo', bodyMapping: { strContent: '$content', intCompany: '$location_id' } });
    expect(tool('deputy_post_journal').endpointMapping).toEqual({ method: 'POST', path: '/supervise/journal', bodyMapping: { intEmployeeId: '$employee_id', strComment: '$comment' } });
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

  it('writes carry explicit annotations; irreversible ones install switched off', () => {
    for (const t of a.tools.filter((x) => !isRead(x))) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['deputy_delete_employee', 'deputy_discard_rosters', 'deputy_discard_timesheet']);
    for (const n of ['deputy_delete_employee', 'deputy_discard_rosters', 'deputy_discard_timesheet', 'deputy_terminate_employee']) expect(tool(n).annotations?.destructiveHint).toBe(true);
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

const live = process.env.RUN_DEPUTY_LIVE === '1' && process.env.DEPUTY_HOST && process.env.DEPUTY_ACCESS_TOKEN ? describe : describe.skip;
live('deputy adapter: live (read-only)', () => {
  const base = a.connector.baseUrl.replace('{{DEPUTY_HOST}}', process.env.DEPUTY_HOST ?? '');
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${process.env.DEPUTY_ACCESS_TOKEN}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as unknown;
  };
  it('reads me, locations, areas and a roster query', async () => {
    const me = await call('GET', '/me');
    expect(me && typeof me === 'object' && !Array.isArray(me)).toBe(true);
    expect(Array.isArray(await call('GET', '/resource/Company'))).toBe(true);
    expect(Array.isArray(await call('GET', '/resource/OperationalUnit'))).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(Array.isArray(await call('POST', '/resource/Roster/QUERY', { search: { s1: { field: 'Date', type: 'ge', data: today } }, max: 5 }))).toBe(true);
  }, 60_000);
});
