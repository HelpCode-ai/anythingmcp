import * as adapter from './servicetitan.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * ServiceTitan API v2 (developer.servicetitan.io; one OpenAPI 3.1 file per module at
 * developer.servicetitan.io/api/docs/apis/tenant-<module>-v2): base https://api.servicetitan.io,
 * OAuth2 client credentials at auth.servicetitan.io/connect/token, the app key in the ST-App-Key
 * header on every call and the tenant id in every path (/<module>/v2/tenant/<id>/...).
 * Lists answer { page, pageSize, hasMore, totalCount, data }.
 * Live part (reads only: customers, business units, jobs):
 *   SERVICETITAN_CLIENT_ID=... SERVICETITAN_CLIENT_SECRET=... SERVICETITAN_APP_KEY=... SERVICETITAN_TENANT_ID=... \
 *   RUN_SERVICETITAN_LIVE=1 npx jest src/adapters/intl/servicetitan
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
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
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; healthcheckPath?: string };
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
const PREFIX = 'servicetitan_';
const TENANT = '{{SERVICETITAN_TENANT_ID}}';
const route = (module: string, rest: string) => `/${module}/tenant/${TENANT}${rest}`;
const MODULES = ['crm/v2', 'jpm/v2', 'dispatch/v2', 'settings/v2', 'accounting/v2', 'sales/v2', 'pricebook/v2', 'memberships/v2', 'marketing/v2', 'telecom/v2', 'telecom/v3'];
const PAGE_Q = { page: '$page', pageSize: '$page_size', includeTotal: '$include_total' };

describe('servicetitan adapter: static spec conformance', () => {
  it('signs in with OAuth2 client credentials and sends the app key as ST-App-Key', () => {
    expect(a.requiredEnvVars).toEqual(['SERVICETITAN_CLIENT_ID', 'SERVICETITAN_CLIENT_SECRET', 'SERVICETITAN_APP_KEY', 'SERVICETITAN_TENANT_ID']);
    expect(a.connector.baseUrl).toBe('https://api.servicetitan.io');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{SERVICETITAN_CLIENT_ID}}',
      clientSecret: '{{SERVICETITAN_CLIENT_SECRET}}',
      tokenUrl: 'https://auth.servicetitan.io/connect/token',
      tokenAuthMethod: 'client_secret_post',
      extraHeaders: { 'ST-App-Key': '{{SERVICETITAN_APP_KEY}}' },
    });
    expect(a.connector.healthcheckPath).toBe(`/crm/v2/tenant/${TENANT}/customers?pageSize=1`);
    expect(a.envVarMeta?.SERVICETITAN_CLIENT_SECRET.secret).toBe(true);
    expect(a.envVarMeta?.SERVICETITAN_APP_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.SERVICETITAN_TENANT_ID.pattern ?? '').test('1234567890')).toBe(true);
    expect(new RegExp(a.envVarMeta?.SERVICETITAN_TENANT_ID.pattern ?? '').test('acme')).toBe(false);
  });

  it('puts the tenant id in every path, under a documented module', () => {
    for (const t of a.tools) {
      const m = /^\/([a-z]+\/v[23])\/tenant\/\{\{SERVICETITAN_TENANT_ID\}\}\//.exec(t.endpointMapping.path);
      expect(`${t.name}:${m ? MODULES.includes(m[1]) : false}`).toBe(`${t.name}:true`);
    }
  });

  it('maps the CRM routes with the documented query and body names', () => {
    expect(tool('servicetitan_list_customers').endpointMapping).toEqual({
      method: 'GET',
      path: route('crm/v2', '/customers'),
      queryParams: {
        name: '$name', phone: '$phone', street: '$street', city: '$city', state: '$state', zip: '$zip', ids: '$ids', active: '$active',
        createdOnOrAfter: '$created_on_or_after', modifiedOnOrAfter: '$modified_on_or_after', sort: '$sort', ...PAGE_Q,
      },
    });
    expect(tool('servicetitan_get_customer').endpointMapping).toEqual({ method: 'GET', path: route('crm/v2', '/customers/{id}') });
    expect(tool('servicetitan_create_customer').endpointMapping).toMatchObject({
      method: 'POST',
      path: route('crm/v2', '/customers'),
      bodyMapping: { name: '$name', type: '$type', address: '$address', locations: '$locations', contacts: '$contacts', doNotMail: '$do_not_mail', doNotService: '$do_not_service', tagTypeIds: '$tag_type_ids' },
    });
    expect(tool('servicetitan_create_customer').parameters?.required).toEqual(['name', 'address', 'locations']);
    expect(tool('servicetitan_update_customer').endpointMapping.method).toBe('PATCH');
    expect(tool('servicetitan_add_customer_note').endpointMapping).toEqual({ method: 'POST', path: route('crm/v2', '/customers/{id}/notes'), bodyMapping: { text: '$text', pinToTop: '$pin_to_top', addToLocations: '$add_to_locations' } });
    expect(tool('servicetitan_create_location').endpointMapping.bodyMapping).toEqual({ customerId: '$customer_id', name: '$name', address: '$address', contacts: '$contacts' });
    expect(tool('servicetitan_list_leads').parameters?.properties?.status.enum).toEqual(['Open', 'Dismissed', 'Converted']);
    expect(tool('servicetitan_list_campaigns').endpointMapping.path).toBe(route('marketing/v2', '/campaigns'));
  });

  it('maps jobs, appointments and dispatch', () => {
    expect(tool('servicetitan_list_jobs').endpointMapping.queryParams).toMatchObject({ jobStatus: '$job_status', customerId: '$customer_id', technicianId: '$technician_id', appointmentStartsOnOrAfter: '$appointment_starts_on_or_after' });
    expect(tool('servicetitan_list_jobs').parameters?.properties?.job_status.enum).toEqual(['Scheduled', 'Dispatched', 'InProgress', 'Hold', 'Completed', 'Canceled']);
    expect(tool('servicetitan_create_job').endpointMapping).toMatchObject({
      method: 'POST',
      path: route('jpm/v2', '/jobs'),
      bodyMapping: { customerId: '$customer_id', locationId: '$location_id', businessUnitId: '$business_unit_id', jobTypeId: '$job_type_id', priority: '$priority', campaignId: '$campaign_id', appointments: '$appointments' },
    });
    expect(tool('servicetitan_create_job').parameters?.required).toEqual(['customer_id', 'location_id', 'business_unit_id', 'job_type_id', 'priority', 'campaign_id', 'appointments']);
    expect(tool('servicetitan_cancel_job').endpointMapping).toEqual({ method: 'PUT', path: route('jpm/v2', '/jobs/{id}/cancel'), bodyMapping: { reasonId: '$reason_id', memo: '$memo' } });
    expect(tool('servicetitan_get_job_history').endpointMapping.path).toBe(route('jpm/v2', '/jobs/{id}/history'));
    expect(tool('servicetitan_add_appointment').endpointMapping).toMatchObject({ method: 'POST', path: route('jpm/v2', '/appointments'), bodyMapping: { jobId: '$job_id', start: '$start', end: '$end' } });
    expect(tool('servicetitan_reschedule_appointment').endpointMapping).toMatchObject({ method: 'PATCH', path: route('jpm/v2', '/appointments/{id}/reschedule') });
    expect(tool('servicetitan_assign_technicians').endpointMapping).toEqual({
      method: 'POST',
      path: route('dispatch/v2', '/appointment-assignments/assign-technicians'),
      bodyMapping: { jobAppointmentId: '$appointment_id', technicianIds: '$technician_ids' },
    });
    expect(tool('servicetitan_unassign_technicians').endpointMapping.path).toBe(route('dispatch/v2', '/appointment-assignments/unassign-technicians'));
    expect(tool('servicetitan_get_capacity').endpointMapping).toMatchObject({ method: 'POST', path: route('dispatch/v2', '/capacity'), bodyMapping: { startsOnOrAfter: '$starts_on_or_after', endsOnOrBefore: '$ends_on_or_before', skillBasedAvailability: '$skill_based_availability' } });
    expect(tool('servicetitan_get_capacity').annotations).toEqual({ readOnlyHint: true });
    expect(tool('servicetitan_list_technicians').endpointMapping.path).toBe(route('settings/v2', '/technicians'));
    expect(tool('servicetitan_list_business_units').endpointMapping.path).toBe(route('settings/v2', '/business-units'));
  });

  it('maps accounting, sales, pricebook, memberships and calls', () => {
    expect(tool('servicetitan_list_invoices').endpointMapping.queryParams).toMatchObject({ ids: '$ids', customerId: '$customer_id', jobId: '$job_id', invoicedOnOrAfter: '$invoiced_on_or_after', invoicedOnBefore: '$invoiced_on_before' });
    expect(tool('servicetitan_list_payments').endpointMapping.path).toBe(route('accounting/v2', '/payments'));
    expect(tool('servicetitan_list_estimates').endpointMapping.path).toBe(route('sales/v2', '/estimates'));
    expect(tool('servicetitan_list_estimate_items').endpointMapping.path).toBe(route('sales/v2', '/estimates/items'));
    expect(tool('servicetitan_sell_estimate').endpointMapping).toEqual({ method: 'PUT', path: route('sales/v2', '/estimates/{id}/sell'), bodyMapping: { soldBy: '$sold_by' } });
    expect(tool('servicetitan_list_pricebook_services').endpointMapping.queryParams).toMatchObject({ searchText: '$search_text', categoryIds: '$category_ids' });
    expect(tool('servicetitan_list_memberships').endpointMapping.queryParams).toMatchObject({ customerIds: '$customer_ids', status: '$status' });
    expect(tool('servicetitan_list_calls').endpointMapping.path).toBe(route('telecom/v3', '/calls'));
    expect(tool('servicetitan_get_call').endpointMapping.path).toBe(route('telecom/v2', '/calls/{id}'));
  });

  it('drops GL accounts from invoice lines and images and vendors from pricebook items', () => {
    const gl = { id: 1, name: 'Sales', number: '4000', type: 'Income', detailType: 'x' };
    const inv = applyResponseTransform(
      { page: 1, hasMore: false, data: [{ id: 7, total: '120.00', items: [{ id: 1, skuName: 'Tune-up', total: '120.00', generalLedgerAccount: gl, costOfSaleAccount: gl, assetAccount: gl }] }] },
      tool('servicetitan_list_invoices').responseMapping as never,
    ).value;
    expect(inv).toEqual({ page: 1, hasMore: false, data: [{ id: 7, total: '120.00', items: [{ id: 1, skuName: 'Tune-up', total: '120.00' }] }] });
    const svc = applyResponseTransform(
      { data: [{ id: 3, code: 'TU', price: 89, assets: [{ url: 'x' }], otherVendors: [{ id: 2 }], externalData: [], account: 'Income' }] },
      tool('servicetitan_list_pricebook_services').responseMapping as never,
    ).value;
    expect(svc).toEqual({ data: [{ id: 3, code: 'TU', price: 89 }] });
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

  it('switches nothing off (no deletes) and annotates the non-GET tools', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual([]);
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET') expect(t.annotations).toBeUndefined();
      expect(t.endpointMapping.method).not.toBe('DELETE');
    }
    expect(tool('servicetitan_cancel_job').annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(tool('servicetitan_unassign_technicians').annotations?.destructiveHint).toBe(true);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

describe('servicetitan adapter: requests', () => {
  const engine = new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('tok'), refreshToken: jest.fn() } as any,
    { getToken: jest.fn(), forceRelogin: jest.fn() } as any,
  );
  const appKey = ['ak1', 'test', 'key'].join('.');
  const config = {
    baseUrl: a.connector.baseUrl,
    authType: 'OAUTH2' as const,
    authConfig: { ...a.connector.authConfig, clientId: 'cid', clientSecret: 'cs', extraHeaders: { 'ST-App-Key': appKey } },
    headers: a.connector.headers,
  };
  const mapping = (name: string) => {
    const m = { ...(tool(name).endpointMapping as any) };
    m.path = m.path.replace(TENANT, '123456');
    return m;
  };
  const sent = () => mockedAxios.mock.calls[0][0] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.mockResolvedValue({ status: 200, data: { page: 1, hasMore: false, data: [] }, headers: {} });
  });

  it('sends the bearer token and the ST-App-Key header together on a tenant path', async () => {
    await engine.execute(config, mapping('servicetitan_list_customers'), { name: 'Smith', page_size: 10 });
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe('https://api.servicetitan.io/crm/v2/tenant/123456/customers');
    expect(sent().params).toEqual({ name: 'Smith', pageSize: 10 });
    expect(sent().headers.Authorization).toBe('Bearer tok');
    expect(sent().headers['ST-App-Key']).toBe(appKey);
  });

  it('builds the assign-technicians body with the API field names', async () => {
    await engine.execute(config, mapping('servicetitan_assign_technicians'), { appointment_id: 55, technician_ids: [7, 8] });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe('https://api.servicetitan.io/dispatch/v2/tenant/123456/appointment-assignments/assign-technicians');
    expect(sent().data).toEqual({ jobAppointmentId: 55, technicianIds: [7, 8] });
  });
});

const env = process.env;
const live = env.RUN_SERVICETITAN_LIVE === '1' && env.SERVICETITAN_CLIENT_ID && env.SERVICETITAN_CLIENT_SECRET && env.SERVICETITAN_APP_KEY && env.SERVICETITAN_TENANT_ID ? describe : describe.skip;
live('servicetitan adapter: live (read-only)', () => {
  const real = jest.requireActual('axios');
  let token = '';
  const get = async (module: string, rest: string) => {
    const res = await real.get(`https://api.servicetitan.io/${module}/tenant/${env.SERVICETITAN_TENANT_ID}${rest}`, {
      headers: { Authorization: `Bearer ${token}`, 'ST-App-Key': env.SERVICETITAN_APP_KEY, Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    return res.data as { hasMore: boolean; data: unknown[] };
  };
  beforeAll(async () => {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SERVICETITAN_CLIENT_ID ?? '', client_secret: env.SERVICETITAN_CLIENT_SECRET ?? '' });
    const res = await real.post('https://auth.servicetitan.io/connect/token', body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    token = res.data.access_token;
  });
  it('reads customers, business units and jobs', async () => {
    const customers = await get('crm/v2', '/customers?pageSize=2');
    expect(Array.isArray(customers.data)).toBe(true);
    expect(typeof customers.hasMore).toBe('boolean');
    expect(Array.isArray((await get('settings/v2', '/business-units?pageSize=5')).data)).toBe(true);
    expect(Array.isArray((await get('jpm/v2', '/jobs?pageSize=2')).data)).toBe(true);
  }, 60_000);
});
