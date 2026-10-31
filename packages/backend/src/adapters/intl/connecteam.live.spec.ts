import * as adapter from './connecteam.json';

/**
 * Connecteam API (developer.connecteam.com, OpenAPI at https://api.connecteam.com/openapi.json):
 * base https://api.connecteam.com (Australian accounts: https://api-au.connecteam.com), API key
 * in the X-API-KEY header. Lists page with limit and offset; batch creates and updates take a
 * top-level JSON array; times are Unix seconds with an IANA time zone.
 * Live part (reads only: account, users, time clocks, schedulers):
 *   CONNECTEAM_API_KEY=... [CONNECTEAM_API_HOST=https://api.connecteam.com] RUN_CONNECTEAM_LIVE=1 npx jest src/adapters/intl/connecteam
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
const PREFIX = 'connecteam_';
const isRead = (t: Tool) => t.endpointMapping.method === 'GET';
const PAGE = { limit: '$limit', offset: '$offset' };

describe('connecteam adapter: static spec conformance', () => {
  it('authenticates with the X-API-KEY header on the global or Australian host', () => {
    expect(a.slug).toBe('connecteam');
    expect(a.category).toBe('hr');
    expect(a.requiredEnvVars).toEqual(['CONNECTEAM_API_HOST', 'CONNECTEAM_API_KEY']);
    expect(a.connector.baseUrl).toBe('{{CONNECTEAM_API_HOST}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-KEY', apiKey: '{{CONNECTEAM_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/me');
    expect(a.envVarMeta?.CONNECTEAM_API_KEY.secret).toBe(true);
    const host = new RegExp(a.envVarMeta?.CONNECTEAM_API_HOST.pattern ?? '');
    expect(host.test('https://api.connecteam.com')).toBe(true);
    expect(host.test('https://api-au.connecteam.com')).toBe(true);
    expect(host.test('https://api.connecteam.com/')).toBe(false);
    expect(host.test('https://app.connecteam.com')).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/')).toBe(true);
  });

  it('maps the reads with the OpenAPI query names', () => {
    expect(tool('connecteam_get_account').endpointMapping).toEqual({ method: 'GET', path: '/me' });
    expect(tool('connecteam_list_users').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/users/v1/users',
      queryParams: { userIds: '$userIds', userStatus: '$userStatus', emailAddresses: '$emailAddresses', modifiedAt: '$modifiedAt', ...PAGE },
    });
    expect(tool('connecteam_list_users').parameters?.properties?.limit.maximum).toBe(500);
    expect(tool('connecteam_list_time_activities').endpointMapping).toMatchObject({
      path: '/time-clock/v1/time-clocks/{timeClockId}/time-activities',
      queryParams: { startDate: '$startDate', endDate: '$endDate', userIds: '$userIds', activityTypes: '$activityTypes' },
    });
    expect(tool('connecteam_get_timesheet_totals').endpointMapping.path).toBe('/time-clock/v1/time-clocks/{timeClockId}/timesheet');
    expect(tool('connecteam_list_shifts').endpointMapping).toMatchObject({
      path: '/scheduler/v1/schedulers/{schedulerId}/shifts',
      queryParams: { startTime: '$startTime', endTime: '$endTime', assignedUserIds: '$assignedUserIds', isPublished: '$isPublished', ...PAGE },
    });
    expect(tool('connecteam_list_shifts').parameters?.required).toEqual(['schedulerId', 'startTime', 'endTime']);
    expect(tool('connecteam_get_shift').endpointMapping.path).toBe('/scheduler/v1/schedulers/{schedulerId}/shifts/{shiftId}');
    expect(tool('connecteam_list_user_unavailabilities').endpointMapping).toEqual({
      method: 'GET',
      path: '/scheduler/v1/schedulers/user-unavailability',
      queryParams: { userId: '$userId', startTime: '$startTime', endTime: '$endTime' },
    });
    for (const [n, p] of [
      ['connecteam_list_custom_fields', '/users/v1/custom-fields'],
      ['connecteam_list_custom_field_categories', '/users/v1/custom-field-categories'],
      ['connecteam_list_smart_groups', '/users/v1/smart-groups'],
      ['connecteam_list_time_clocks', '/time-clock/v1/time-clocks'],
      ['connecteam_list_schedulers', '/scheduler/v1/schedulers'],
      ['connecteam_list_shift_custom_fields', '/scheduler/v1/schedulers/{schedulerId}/custom-fields'],
      ['connecteam_list_jobs', '/jobs/v1/jobs'],
      ['connecteam_get_job', '/jobs/v1/jobs/{jobId}'],
      ['connecteam_list_job_custom_fields', '/jobs/v1/custom-fields'],
      ['connecteam_list_forms', '/forms/v1/forms'],
      ['connecteam_get_form', '/forms/v1/forms/{formId}'],
      ['connecteam_list_form_submissions', '/forms/v1/forms/{formId}/form-submissions'],
      ['connecteam_get_form_submission', '/forms/v1/forms/{formId}/form-submissions/{formSubmissionId}'],
      ['connecteam_list_task_boards', '/tasks/v1/taskboards'],
      ['connecteam_list_tasks', '/tasks/v1/taskboards/{taskBoardId}/tasks'],
      ['connecteam_list_task_labels', '/tasks/v1/taskboards/{taskBoardId}/labels'],
      ['connecteam_list_time_off_policy_types', '/time-off/v1/policy-types'],
      ['connecteam_list_time_off_balances', '/time-off/v1/policy-types/{policyTypeId}/balances'],
      ['connecteam_list_time_off_requests', '/time-off/v1/requests'],
      ['connecteam_list_conversations', '/chat/v1/conversations'],
      ['connecteam_list_publishers', '/publishers/v1/publishers'],
    ]) expect(`${n}:${tool(n).endpointMapping.method} ${tool(n).endpointMapping.path}`).toBe(`${n}:GET ${p}`);
    expect(tool('connecteam_list_form_submissions').parameters?.properties?.limit.maximum).toBe(100);
  });

  it('sends batch writes as a top-level array and single writes with documented fields', () => {
    expect(tool('connecteam_create_users').endpointMapping).toEqual({ method: 'POST', path: '/users/v1/users', queryParams: { sendActivation: '$sendActivation' }, bodyMapping: { __raw: '$users' } });
    expect(tool('connecteam_update_users').endpointMapping).toEqual({ method: 'PUT', path: '/users/v1/users', queryParams: { editUsersByPhone: '$editUsersByPhone' }, bodyMapping: { __raw: '$users' } });
    expect(tool('connecteam_archive_users').endpointMapping).toEqual({ method: 'DELETE', path: '/users/v1/users', queryParams: { deletionType: 'archive' }, bodyMapping: { __raw: '$userIds' } });
    expect(tool('connecteam_delete_user').endpointMapping).toEqual({ method: 'DELETE', path: '/users/v1/users/{userId}', queryParams: { deletionType: 'delete' } });
    expect(tool('connecteam_create_shifts').endpointMapping).toEqual({
      method: 'POST',
      path: '/scheduler/v1/schedulers/{schedulerId}/shifts',
      queryParams: { notifyUsers: '$notifyUsers' },
      bodyMapping: { __raw: '$shifts' },
    });
    expect(tool('connecteam_update_shifts').endpointMapping.method).toBe('PUT');
    expect(tool('connecteam_create_jobs').endpointMapping).toEqual({ method: 'POST', path: '/jobs/v1/jobs', bodyMapping: { __raw: '$jobs' } });
    expect(tool('connecteam_update_job').endpointMapping).toEqual({ method: 'PUT', path: '/jobs/v1/jobs/{jobId}', bodyMapping: { __merge: '$fields' } });
    expect(tool('connecteam_clock_in').endpointMapping).toMatchObject({ method: 'POST', path: '/time-clock/v1/time-clocks/{timeClockId}/clock-in', bodyMapping: { userId: '$userId', jobId: '$jobId' } });
    expect(tool('connecteam_clock_out').endpointMapping.path).toBe('/time-clock/v1/time-clocks/{timeClockId}/clock-out');
    expect(tool('connecteam_create_time_activities').endpointMapping.bodyMapping).toEqual({ timeActivities: '$timeActivities', isSplitShiftOnManualBreak: '$isSplitShiftOnManualBreak' });
    expect(tool('connecteam_update_time_activities').endpointMapping).toEqual({
      method: 'PUT',
      path: '/time-clock/v1/time-clocks/{timeClockId}/time-activities',
      bodyMapping: { timeActivities: '$timeActivities' },
    });
    expect(tool('connecteam_create_task').parameters?.required).toEqual(['taskBoardId', 'userIds', 'status', 'title']);
    expect(tool('connecteam_update_task').endpointMapping).toMatchObject({ method: 'PUT', path: '/tasks/v1/taskboards/{taskBoardId}/tasks/{taskId}', bodyMapping: { userIds: '$userIds', status: '$status', title: '$title' } });
    expect(tool('connecteam_create_time_off_request').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/time-off/v1/requests',
      bodyMapping: { userId: '$userId', policyTypeId: '$policyTypeId', isAllDay: '$isAllDay', startDate: '$startDate', endDate: '$endDate', timezone: '$timezone', status: '$status' },
    });
    expect(tool('connecteam_update_time_off_request').parameters?.properties?.status.enum).toEqual(['approved', 'pending', 'denied']);
    expect(tool('connecteam_send_message').endpointMapping).toEqual({ method: 'POST', path: '/chat/v1/conversations/{conversationId}/message', bodyMapping: { senderId: '$senderId', text: '$text' } });
    expect(tool('connecteam_send_private_message').endpointMapping.path).toBe('/chat/v1/conversations/privateMessage/{userId}');
    expect(tool('connecteam_create_user_note').endpointMapping).toEqual({ method: 'POST', path: '/users/v1/users/{userId}/notes', bodyMapping: { title: '$title', text: '$text' } });
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

  it('writes carry explicit annotations; permanent deletes install switched off', () => {
    for (const t of a.tools.filter((x) => !isRead(x))) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'DELETE')) expect(t.annotations?.destructiveHint).toBe(true);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['connecteam_delete_user', 'connecteam_delete_shift', 'connecteam_delete_task']);
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

const live = process.env.RUN_CONNECTEAM_LIVE === '1' && process.env.CONNECTEAM_API_KEY ? describe : describe.skip;
live('connecteam adapter: live (read-only)', () => {
  const base = process.env.CONNECTEAM_API_HOST || 'https://api.connecteam.com';
  const call = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { 'X-API-KEY': process.env.CONNECTEAM_API_KEY ?? '', Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: Record<string, unknown> };
  };
  it('reads the account, users, time clocks and schedulers', async () => {
    expect((await call('/me')).data).toBeDefined();
    expect(Array.isArray((await call('/users/v1/users?limit=5')).data.users)).toBe(true);
    expect((await call('/time-clock/v1/time-clocks')).data).toBeDefined();
    expect((await call('/scheduler/v1/schedulers')).data).toBeDefined();
  }, 60_000);
});
