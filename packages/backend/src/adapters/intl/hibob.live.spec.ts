import * as adapter from './hibob.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * HiBob (Bob) public API (apidocs.hibob.com, OpenAPI embedded in each reference page):
 * base https://api.hibob.com/v1, HTTP Basic auth with a service user ID as user name
 * and its token as password. People search and read-by-id are POST reads; bulk
 * history tables and calendar events page with response_metadata.next_cursor.
 * Live part (reads only: fields metadata, policy types, a people search, who's out):
 *   HIBOB_SERVICE_USER_ID=... HIBOB_SERVICE_USER_TOKEN=... RUN_HIBOB_LIVE=1 npx jest src/adapters/intl/hibob
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, unknown>;
    encodePathParams?: boolean;
    exposeHeaders?: string[];
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
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
const PREFIX = 'hibob_';
const isRead = (t: Tool) => t.endpointMapping.method === 'GET' || t.annotations?.readOnlyHint === true;

describe('hibob adapter: static spec conformance', () => {
  it('authenticates with Basic auth: service user ID as user name, token as password', () => {
    expect(a.slug).toBe('hibob');
    expect(a.category).toBe('hr');
    expect(a.requiredEnvVars).toEqual(['HIBOB_SERVICE_USER_ID', 'HIBOB_SERVICE_USER_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.hibob.com/v1');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{HIBOB_SERVICE_USER_ID}}', password: '{{HIBOB_SERVICE_USER_TOKEN}}' });
    expect(a.envVarMeta?.HIBOB_SERVICE_USER_TOKEN.secret).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/')).toBe(true);
  });

  it('maps people search and read-by-id as POST reads with the documented body keys', () => {
    expect(tool('hibob_search_people').endpointMapping).toEqual({
      method: 'POST',
      path: '/people/search',
      bodyMapping: { fields: '$fields', filters: '$filters', showInactive: '$show_inactive', humanReadable: '$human_readable' },
    });
    expect(tool('hibob_get_employee').endpointMapping).toEqual({ method: 'POST', path: '/people/{identifier}', bodyMapping: { fields: '$fields', humanReadable: '$human_readable' } });
    for (const n of ['hibob_search_people', 'hibob_get_employee', 'hibob_search_calendar_events']) expect(tool(n).annotations).toEqual({ readOnlyHint: true });
    expect(tool('hibob_search_people').parameters?.properties?.human_readable.enum).toEqual(['APPEND', 'REPLACE']);
  });

  it('sends employee updates as the body itself, switched off at install', () => {
    const u = tool('hibob_update_employee');
    expect(u.endpointMapping).toEqual({ method: 'PUT', path: '/people/{identifier}', bodyMapping: { __merge: '$fields' } });
    expect(u.enabled).toBe(false);
    expect(u.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  it('maps the employee history tables, single and bulk', () => {
    for (const [n, table] of [
      ['hibob_list_work_history', 'work'],
      ['hibob_list_employment_history', 'employment'],
      ['hibob_list_lifecycle_history', 'lifecycle'],
      ['hibob_list_salary_history', 'salaries'],
    ]) expect(tool(n).endpointMapping).toEqual({ method: 'GET', path: `/people/{employee_id}/${table}`, queryParams: { includeArchived: '$include_archived' } });
    for (const [n, table] of [
      ['hibob_bulk_list_work_history', 'work'],
      ['hibob_bulk_list_lifecycle_history', 'lifecycle'],
      ['hibob_bulk_list_salary_history', 'salaries'],
    ])
      expect(tool(n).endpointMapping).toEqual({
        method: 'GET',
        path: `/bulk/people/${table}`,
        queryParams: { employeeIds: '$employee_ids', limit: '$limit', cursor: '$cursor', includeArchived: '$include_archived' },
      });
    expect(tool('hibob_create_work_entry').endpointMapping).toMatchObject({ method: 'POST', path: '/people/{employee_id}/work', bodyMapping: { effectiveDate: '$effective_date', siteId: '$site_id', reportsTo: '$reports_to' } });
  });

  it('maps the time off endpoints with their documented query names', () => {
    expect(tool('hibob_list_whos_out').endpointMapping).toEqual({
      method: 'GET',
      path: '/timeoff/whosout',
      queryParams: { from: '$from', to: '$to', includeHourly: '$include_hourly', includePrivate: '$include_private', includePending: '$include_pending', includeWorkingRequests: '$include_working_requests' },
    });
    expect(tool('hibob_list_out_today').endpointMapping.queryParams).toEqual({ today: '$date', includeHourly: '$include_hourly', includePrivate: '$include_private', siteId: '$site_id' });
    expect(tool('hibob_list_time_off_changes').endpointMapping).toEqual({ method: 'GET', path: '/timeoff/requests/changes', queryParams: { since: '$since', to: '$to', includePending: '$include_pending' } });
    expect(tool('hibob_get_time_off_balance').endpointMapping).toEqual({ method: 'GET', path: '/timeoff/employees/{employee_id}/balance', queryParams: { policyType: '$policy_type', date: '$date' } });
    expect(tool('hibob_get_time_off_request').endpointMapping.path).toBe('/timeoff/employees/{employee_id}/requests/{request_id}');
    expect(tool('hibob_cancel_time_off_request').endpointMapping).toEqual({ method: 'DELETE', path: '/timeoff/employees/{employee_id}/requests/{request_id}' });
    expect(tool('hibob_cancel_time_off_request').annotations?.destructiveHint).toBe(true);
    expect(tool('hibob_submit_time_off_request').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/timeoff/employees/{employee_id}/requests',
      bodyMapping: { requestRangeType: '$request_range_type', policyType: '$policy_type', startDate: '$start_date', endDate: '$end_date', startDatePortion: '$start_date_portion', endDatePortion: '$end_date_portion', reasonCode: '$reason_code', skipManagerApproval: '$skip_manager_approval' },
    });
    expect(tool('hibob_list_policy_types').endpointMapping).toEqual({ method: 'GET', path: '/timeoff/policy-types' });
    expect(tool('hibob_get_policy_type').endpointMapping).toEqual({ method: 'GET', path: '/timeoff/policy-types/{policy_type}', encodePathParams: true });
    expect(tool('hibob_list_policy_type_reason_codes').endpointMapping.path).toBe('/timeoff/policy-types/{policy_type}/reason-codes');
    expect(tool('hibob_list_policy_names').endpointMapping.queryParams).toEqual({ policyTypeName: '$policy_type' });
    expect(tool('hibob_get_policy').endpointMapping.queryParams).toEqual({ policyName: '$policy_name' });
    expect(tool('hibob_search_calendar_events').endpointMapping).toEqual({ method: 'POST', path: '/timeoff/calendars/events/search', bodyMapping: { filters: '$filters', fields: '$fields', limit: '$limit', cursor: '$cursor' } });
  });

  it('maps reports, lists, custom tables, tasks and documents', () => {
    expect(tool('hibob_download_report').endpointMapping).toEqual({
      method: 'GET',
      path: '/company/reports/{report_id}/download',
      queryParams: { format: '$format', includeInfo: '$include_info', locale: '$locale', humanReadable: '$human_readable' },
    });
    expect(tool('hibob_download_report').parameters?.properties?.format.enum).toEqual(['json', 'csv', 'xlsx']);
    expect(tool('hibob_request_report_download').endpointMapping).toMatchObject({ path: '/company/reports/{report_id}/download-async', exposeHeaders: ['location'] });
    expect(tool('hibob_download_report_by_name').endpointMapping.path).toBe('/company/reports/download/{report_name}');
    expect(tool('hibob_get_named_list').endpointMapping.path).toBe('/company/named-lists/{list_name}');
    expect(tool('hibob_add_named_list_item').endpointMapping).toEqual({ method: 'POST', path: '/company/named-lists/{list_name}', bodyMapping: { name: '$name', parentId: '$parent_id' } });
    expect(tool('hibob_list_custom_table_entries').endpointMapping).toEqual({ method: 'GET', path: '/people/custom-tables/{employee_id}/{custom_table_id}', queryParams: { includeHumanReadable: '$include_human_readable' } });
    expect(tool('hibob_get_custom_table_metadata').endpointMapping.path).toBe('/people/custom-tables/metadata/{custom_table_id}');
    expect(tool('hibob_list_employee_tasks').endpointMapping).toEqual({ method: 'GET', path: '/tasks/people/{employee_id}', queryParams: { task_status: '$task_status' } });
    expect(tool('hibob_complete_task').endpointMapping).toEqual({ method: 'POST', path: '/tasks/{task_id}/complete' });
    expect(tool('hibob_list_employee_documents').endpointMapping).toEqual({ method: 'GET', path: '/docs/people/{employee_id}' });
    expect(tool('hibob_upload_shared_document').endpointMapping.bodyMapping).toEqual({ documentName: '$document_name', documentUrl: '$document_url', tags: '$tags' });
  });

  it('trims the fields metadata and the report list', () => {
    const fields = applyResponseTransform(
      [{ id: 'work.department', name: 'Department', categoryId: 'work', categoryDisplayName: 'Work', category: 'work', description: 'long', type: 'list', typeData: { listId: 'department' }, historical: true, jsonPath: 'work.department' }],
      tool('hibob_list_employee_fields').responseMapping as never,
    ).value;
    expect(fields).toEqual({ fields: [{ id: 'work.department', name: 'Department', categoryId: 'work', categoryDisplayName: 'Work', type: 'list', historical: true, listId: 'department', jsonPath: 'work.department' }] });
    const reports = applyResponseTransform(
      { views: [{ id: 42, name: 'Headcount', type: 'people', folderId: 1, configuration: { columns: ['x'] }, isScheduled: false }] },
      tool('hibob_list_reports').responseMapping as never,
    ).value;
    expect(reports).toEqual({ views: [{ id: 42, name: 'Headcount', type: 'people', folderId: 1, isScheduled: false }] });
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

  it('writes carry explicit annotations; master-data writes install switched off', () => {
    for (const t of a.tools.filter((x) => !isRead(x))) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
    for (const n of ['hibob_update_employee', 'hibob_create_work_entry', 'hibob_create_custom_table_entry', 'hibob_add_named_list_item', 'hibob_upload_shared_document']) expect(tool(n).enabled).toBe(false);
    for (const t of a.tools.filter(isRead)) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(isRead(tool(a.probe.tool))).toBe(true);
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_HIBOB_LIVE === '1' && process.env.HIBOB_SERVICE_USER_ID && process.env.HIBOB_SERVICE_USER_TOKEN ? describe : describe.skip;
live('hibob adapter: live (read-only)', () => {
  const auth = `Basic ${Buffer.from(`${process.env.HIBOB_SERVICE_USER_ID}:${process.env.HIBOB_SERVICE_USER_TOKEN}`).toString('base64')}`;
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads fields metadata, policy types, a people search and who is out', async () => {
    const fields = (await call('GET', '/company/people/fields')) as unknown as Array<{ id: string }>;
    expect(fields.map((f) => f.id)).toContain('root.id');
    expect(Array.isArray((await call('GET', '/timeoff/policy-types')).policyTypes)).toBe(true);
    const people = await call('POST', '/people/search', { fields: ['root.id', 'root.displayName'] });
    expect(Array.isArray(people.employees)).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(Array.isArray((await call('GET', `/timeoff/whosout?from=${today}&to=${today}`)).outs)).toBe(true);
  }, 60_000);
});
