import * as adapter from './mindbody.json';

/**
 * Mindbody Public API v6 (developers.mindbodyonline.com/PublicDocumentation/V6; the official SDKs in
 * github.com/mindbody/Mindbody-API-SDKs carry every route and query key): base
 * https://api.mindbodyonline.com/public/v6, Api-Key and SiteId headers on every call plus a staff user
 * token from POST /usertoken/issue ({Username, Password} -> AccessToken) as Authorization: Bearer.
 * Query keys use the documented request.* prefix; lists repeat the key.
 * Live part (reads only: locations, programs, today's classes, staff):
 *   MINDBODY_API_KEY=... MINDBODY_SITE_ID=-99 MINDBODY_USERNAME=... MINDBODY_PASSWORD=... RUN_MINDBODY_LIVE=1 npx jest src/adapters/intl/mindbody
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: string[]; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
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
const P = 'mindbody_';
const V6 = '/public/v6';
const WRITES = [
  'mindbody_add_appointment',
  'mindbody_add_arrival',
  'mindbody_add_client',
  'mindbody_add_client_to_class',
  'mindbody_add_client_to_enrollment',
  'mindbody_add_contact_log',
  'mindbody_cancel_single_class',
  'mindbody_remove_client_from_class',
  'mindbody_remove_from_waitlist',
  'mindbody_update_appointment',
  'mindbody_update_client',
];
const OFF = ['mindbody_cancel_single_class'];

describe('mindbody adapter: static spec conformance', () => {
  it('logs in for a staff user token and sends Api-Key and SiteId on every call', () => {
    expect(a.slug).toBe('mindbody');
    expect(a.region).toBe('intl');
    expect(a.icon).toBe('mindbody');
    expect(a.requiredEnvVars).toEqual(['MINDBODY_API_KEY', 'MINDBODY_SITE_ID', 'MINDBODY_USERNAME', 'MINDBODY_PASSWORD']);
    expect(a.connector.baseUrl).toBe('https://api.mindbodyonline.com');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: 'https://api.mindbodyonline.com/public/v6/usertoken/issue',
      loginMethod: 'POST',
      loginHeaders: { 'Api-Key': '{{MINDBODY_API_KEY}}', SiteId: '{{MINDBODY_SITE_ID}}' },
      loginBody: { Username: '${username}', Password: '${password}' },
      username: '{{MINDBODY_USERNAME}}',
      password: '{{MINDBODY_PASSWORD}}',
      tokenJsonPath: 'AccessToken',
      expiryJsonPath: 'Expires',
      refreshOn401: true,
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
      extraHeaders: { 'Api-Key': '{{MINDBODY_API_KEY}}', SiteId: '{{MINDBODY_SITE_ID}}' },
    });
    expect(a.envVarMeta?.MINDBODY_API_KEY.secret).toBe(true);
    expect(a.envVarMeta?.MINDBODY_PASSWORD.secret).toBe(true);
    const site = new RegExp(a.envVarMeta?.MINDBODY_SITE_ID.pattern as string);
    expect(site.test('-99')).toBe(true);
    expect(site.test('123456')).toBe(true);
    expect(site.test('abc')).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith(`${V6}/`)).toBe(true);
  });

  it('maps class, appointment and enrollment reads with the request.* query keys', () => {
    expect(tool('mindbody_get_classes').endpointMapping).toMatchObject({
      method: 'GET',
      path: `${V6}/class/classes`,
      queryParams: { 'request.startDateTime': '$start_date_time', 'request.endDateTime': '$end_date_time', 'request.classIds': '$class_ids', 'request.locationIds': '$location_ids', 'request.staffIds': '$staff_ids', 'request.limit': '$limit', 'request.offset': '$offset' },
    });
    expect(tool('mindbody_get_class_visits').endpointMapping.queryParams).toMatchObject({ 'request.classID': '$class_id' });
    expect(tool('mindbody_get_class_visits').parameters?.required).toEqual(['class_id']);
    expect(tool('mindbody_get_class_schedules').endpointMapping.path).toBe(`${V6}/class/classschedules`);
    expect(tool('mindbody_get_waitlist_entries').endpointMapping.path).toBe(`${V6}/class/waitlistentries`);
    expect(tool('mindbody_get_bookable_items').endpointMapping).toMatchObject({ path: `${V6}/appointment/bookableitems`, queryParams: { 'request.sessionTypeIds': '$session_type_ids', 'request.startDate': '$start_date' } });
    expect(tool('mindbody_get_bookable_items').parameters?.required).toEqual(['session_type_ids']);
    expect(tool('mindbody_get_staff_appointments').endpointMapping.path).toBe(`${V6}/appointment/staffappointments`);
    expect(tool('mindbody_get_available_dates').endpointMapping.queryParams).toMatchObject({ 'request.sessionTypeId': '$session_type_id' });
    expect(tool('mindbody_get_enrollments').endpointMapping.path).toBe(`${V6}/enrollment/enrollments`);
    expect(tool('mindbody_get_session_types').endpointMapping.queryParams).toMatchObject({ 'request.programIDs': '$program_ids' });
  });

  it('maps client, sale, site and staff reads', () => {
    expect(tool('mindbody_get_clients').endpointMapping).toMatchObject({ path: `${V6}/client/clients`, queryParams: { 'request.searchText': '$search_text', 'request.clientIDs': '$client_ids' } });
    expect(tool('mindbody_get_client_complete_info').endpointMapping.path).toBe(`${V6}/client/clientcompleteinfo`);
    expect(tool('mindbody_get_client_services').endpointMapping.path).toBe(`${V6}/client/clientservices`);
    expect(tool('mindbody_get_client_account_balances').parameters?.required).toEqual(['client_ids']);
    expect(tool('mindbody_get_sales').endpointMapping.queryParams).toMatchObject({ 'request.startSaleDateTime': '$start_sale_date_time', 'request.endSaleDateTime': '$end_sale_date_time' });
    expect(tool('mindbody_get_contracts').parameters?.required).toEqual(['location_id']);
    expect(tool('mindbody_get_locations').endpointMapping).toEqual({ method: 'GET', path: `${V6}/site/locations`, queryParams: { 'request.limit': '$limit', 'request.offset': '$offset' } });
    expect(tool('mindbody_get_staff').endpointMapping.path).toBe(`${V6}/staff/staff`);
    expect(tool('mindbody_get_staff_session_types').endpointMapping.path).toBe(`${V6}/staff/sessiontypes`);
    for (const t of a.tools) for (const k of Object.keys(t.endpointMapping.queryParams ?? {})) expect(`${t.name}:${k.startsWith('request.')}`).toBe(`${t.name}:true`);
  });

  it('maps the writes to POST bodies with the PascalCase field names', () => {
    expect(tool('mindbody_add_client_to_class').endpointMapping).toMatchObject({ method: 'POST', path: `${V6}/class/addclienttoclass`, bodyMapping: { ClientId: '$client_id', ClassId: '$class_id', Waitlist: '$waitlist', Test: '$test' } });
    expect(tool('mindbody_remove_client_from_class').endpointMapping).toMatchObject({ path: `${V6}/class/removeclientfromclass`, bodyMapping: { ClassId: '$class_id', ClientId: '$client_id', LateCancel: '$late_cancel' } });
    expect(tool('mindbody_remove_from_waitlist').endpointMapping).toEqual({ method: 'POST', path: `${V6}/class/removefromwaitlist`, queryParams: { 'request.waitlistEntryIds': '$waitlist_entry_ids' } });
    expect(tool('mindbody_add_appointment').endpointMapping).toMatchObject({ path: `${V6}/appointment/addappointment`, bodyMapping: { ClientId: '$client_id', LocationId: '$location_id', SessionTypeId: '$session_type_id', StaffId: '$staff_id', StartDateTime: '$start_date_time' } });
    expect(tool('mindbody_add_appointment').parameters?.required).toEqual(['client_id', 'location_id', 'session_type_id', 'staff_id', 'start_date_time']);
    expect(tool('mindbody_update_appointment').endpointMapping).toMatchObject({ path: `${V6}/appointment/updateappointment`, bodyMapping: { AppointmentId: '$appointment_id', Execute: '$execute' } });
    expect(tool('mindbody_update_appointment').parameters?.properties?.execute.enum).toEqual(['confirm', 'unconfirm', 'arrive', 'unarrive', 'cancel', 'latecancel', 'complete']);
    expect(tool('mindbody_add_client').endpointMapping).toMatchObject({ path: `${V6}/client/addclient`, bodyMapping: { FirstName: '$first_name', LastName: '$last_name', Email: '$email' } });
    expect(tool('mindbody_update_client').endpointMapping.bodyMapping).toEqual({ Client: '$client', CrossRegionalUpdate: '$cross_regional_update', Test: '$test' });
    expect(tool('mindbody_add_arrival').endpointMapping.path).toBe(`${V6}/client/addarrival`);
    expect(tool('mindbody_add_contact_log').endpointMapping.path).toBe(`${V6}/client/addcontactlog`);
    expect(tool('mindbody_add_client_to_enrollment').endpointMapping).toMatchObject({ path: `${V6}/enrollment/addclienttoenrollment`, bodyMapping: { ClientId: '$client_id', ClassScheduleId: '$class_schedule_id' } });
    expect(tool('mindbody_cancel_single_class').endpointMapping).toMatchObject({ path: `${V6}/class/cancelsingleclass`, bodyMapping: { ClassID: '$class_id' } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(P)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('reads are GET, the writes are the expected set and only cancel_single_class is switched off', () => {
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(WRITES);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    expect(tool('mindbody_cancel_single_class').annotations?.destructiveHint).toBe(true);
    expect(a.instructions).toContain('**Switched off at install**: `mindbody_cancel_single_class`; it cannot be undone');
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env;
const live = env.RUN_MINDBODY_LIVE === '1' && env.MINDBODY_API_KEY && env.MINDBODY_SITE_ID && env.MINDBODY_USERNAME && env.MINDBODY_PASSWORD ? describe : describe.skip;
live('mindbody adapter: live (read-only)', () => {
  const base = { 'Api-Key': env.MINDBODY_API_KEY as string, SiteId: env.MINDBODY_SITE_ID as string, Accept: 'application/json' };
  let token = '';
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${V6}${path}`, { headers: { ...base, Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  beforeAll(async () => {
    const res = await fetch(`${a.connector.baseUrl}${V6}/usertoken/issue`, {
      method: 'POST',
      headers: { ...base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: env.MINDBODY_USERNAME, Password: env.MINDBODY_PASSWORD }),
    });
    expect(res.status).toBe(200);
    token = ((await res.json()) as { AccessToken: string }).AccessToken;
  });
  it('reads locations, programs, today\'s classes and staff', async () => {
    expect(Array.isArray((await get('/site/locations?request.limit=5')).Locations)).toBe(true);
    expect(Array.isArray((await get('/site/programs?request.limit=5')).Programs)).toBe(true);
    expect(Array.isArray((await get('/class/classes?request.limit=5')).Classes)).toBe(true);
    expect(Array.isArray((await get('/staff/staff?request.limit=5')).StaffMembers)).toBe(true);
  }, 60_000);
});
