import * as adapter from './housecall-pro.json';

/**
 * Housecall Pro public API (docs.housecallpro.com, OpenAPI "Housecall v1 API"): base https://api.housecallpro.com,
 * `Authorization: Token <API key>` (keys from My Apps > API Key Management, MAX plan only).
 * Live part: HOUSECALL_PRO_API_KEY=... RUN_HOUSECALL_PRO_LIVE=1 npx jest src/adapters/intl/housecall-pro
 * (read only: GET /customers?page_size=1 and GET /company).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'housecall_pro_';
const WRITES = [
  'housecall_pro_create_customer',
  'housecall_pro_update_customer',
  'housecall_pro_create_job',
  'housecall_pro_update_job_schedule',
  'housecall_pro_add_job_line_item',
  'housecall_pro_create_job_appointment',
  'housecall_pro_add_job_note',
  'housecall_pro_create_estimate',
  'housecall_pro_create_lead',
];
const SWITCHED_OFF = ['housecall_pro_delete_job_line_item'];
// Names users already gave hand-made tools on this host; the catalog re-sync matches by name.
const RESERVED = ['get_invoice', 'get_job', 'list_customers', 'list_invoices', 'list_jobs'];

describe('housecall-pro adapter: static spec conformance', () => {
  it('calls api.housecallpro.com with the API key as "Authorization: Token <key>"', () => {
    expect(a.slug).toBe('housecall-pro');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('field-service');
    expect(a.requiredEnvVars).toEqual(['HOUSECALL_PRO_API_KEY']);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.housecallpro.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Token {{HOUSECALL_PRO_API_KEY}}' });
    expect(a.connector.headers?.Accept).toBe('application/json');
    expect(a.envVarMeta?.HOUSECALL_PRO_API_KEY.secret).toBe(true);
    const key = new RegExp(a.envVarMeta?.HOUSECALL_PRO_API_KEY.pattern ?? '');
    expect(key.test('0046421dc0ba47ec87bef0c089415380')).toBe(true);
    expect(key.test('Token 0046421dc0ba47ec87bef0c089415380')).toBe(false);
    expect(a.probe).toEqual({ tool: 'housecall_pro_list_customers', params: { page_size: 1 } });
    expect(a.instructions).toMatch(/MAX plan/);
  });

  it('maps the customer, job and invoice reads to the documented routes', () => {
    expect(tool('housecall_pro_get_company').endpointMapping).toEqual({ method: 'GET', path: '/company' });
    expect(tool('housecall_pro_list_customers').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/customers',
      queryParams: { q: '$q', page: '$page', page_size: '$page_size', 'location_ids[]': '$location_ids', 'expand[]': '$expand' },
    });
    expect(tool('housecall_pro_get_customer').endpointMapping.path).toBe('/customers/{customer_id}');
    expect(tool('housecall_pro_list_customer_addresses').endpointMapping.path).toBe('/customers/{customer_id}/addresses');
    expect(tool('housecall_pro_list_jobs').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/jobs',
      queryParams: { scheduled_start_min: '$scheduled_start_min', customer_id: '$customer_id', 'employee_ids[]': '$employee_ids', 'work_status[]': '$work_status' },
    });
    expect(tool('housecall_pro_get_job').endpointMapping).toMatchObject({ method: 'GET', path: '/jobs/{job_id}' });
    expect(tool('housecall_pro_list_job_line_items').endpointMapping).toEqual({ method: 'GET', path: '/jobs/{job_id}/line_items' });
    expect(tool('housecall_pro_list_job_appointments').endpointMapping).toEqual({ method: 'GET', path: '/jobs/{job_id}/appointments' });
    expect(tool('housecall_pro_list_job_invoices').endpointMapping).toEqual({ method: 'GET', path: '/jobs/{job_id}/invoices' });
    expect(tool('housecall_pro_list_invoices').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/invoices',
      queryParams: { 'status[]': '$status', 'customer_uuid[]': '$customer_uuid', created_at_min: '$created_at_min', due_at_max: '$due_at_max', 'payment_method[]': '$payment_method' },
    });
    // The single invoice lives under /api/invoices/{uuid}; /invoices/{id} answers 404.
    expect(tool('housecall_pro_get_invoice').endpointMapping).toEqual({ method: 'GET', path: '/api/invoices/{invoice_id}' });
  });

  it('maps estimates, leads, schedule and price book to the documented routes', () => {
    expect(tool('housecall_pro_list_estimates').endpointMapping).toMatchObject({ method: 'GET', path: '/estimates', queryParams: { 'work_status[]': '$work_status' } });
    expect(tool('housecall_pro_get_estimate').endpointMapping.path).toBe('/estimates/{estimate_id}');
    expect(tool('housecall_pro_list_estimate_option_line_items').endpointMapping.path).toBe('/estimates/{estimate_id}/options/{option_id}/line_items');
    expect(tool('housecall_pro_list_leads').endpointMapping).toMatchObject({ method: 'GET', path: '/leads', queryParams: { status: '$status', 'tag_ids[]': '$tag_ids' } });
    expect(tool('housecall_pro_get_lead').endpointMapping).toEqual({ method: 'GET', path: '/leads/{lead_id}' });
    expect(tool('housecall_pro_list_lead_sources').endpointMapping.path).toBe('/lead_sources');
    expect(tool('housecall_pro_list_employees').endpointMapping.path).toBe('/employees');
    expect(tool('housecall_pro_get_schedule_windows').endpointMapping).toEqual({ method: 'GET', path: '/company/schedule_availability' });
    expect(tool('housecall_pro_get_booking_windows').endpointMapping).toMatchObject({ path: '/company/schedule_availability/booking_windows', queryParams: { show_for_days: '$show_for_days' } });
    expect(tool('housecall_pro_list_price_book_services').endpointMapping.path).toBe('/api/price_book/services');
    expect(tool('housecall_pro_list_material_categories').endpointMapping).toMatchObject({ path: '/api/price_book/material_categories', queryParams: { parent_uuid: '$parent_uuid' } });
    expect(tool('housecall_pro_list_materials').endpointMapping).toMatchObject({ path: '/api/price_book/materials', queryParams: { material_category_uuid: '$material_category_uuid' } });
    expect(tool('housecall_pro_list_job_types').endpointMapping).toMatchObject({ path: '/job_fields/job_types', queryParams: { name: '$name' } });
    expect(tool('housecall_pro_list_tags').endpointMapping.path).toBe('/tags');
    expect(tool('housecall_pro_list_events').endpointMapping.path).toBe('/events');
  });

  it('maps the writes to the documented routes and bodies', () => {
    expect(tool('housecall_pro_create_customer').endpointMapping).toMatchObject({ method: 'POST', path: '/customers', bodyMapping: { first_name: '$first_name', addresses: '$addresses' } });
    expect(tool('housecall_pro_update_customer').endpointMapping).toMatchObject({ method: 'PUT', path: '/customers/{customer_id}', bodyMapping: { email: '$email', tags: '$tags' } });
    expect(tool('housecall_pro_create_job').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/jobs',
      bodyMapping: {
        customer_id: '$customer_id',
        address_id: '$address_id',
        schedule: '$schedule',
        line_items: '$line_items',
        job_fields: '$job_fields',
      },
    });
    // Optional nested objects are whole arguments, so an unscheduled job sends no empty "schedule": {}.
    for (const n of ['housecall_pro_create_job', 'housecall_pro_create_estimate']) {
      const body = tool(n).endpointMapping.bodyMapping as Record<string, unknown>;
      for (const v of Object.values(body)) expect(typeof v).toBe('string');
    }
    expect(tool('housecall_pro_update_job_schedule').endpointMapping).toMatchObject({ method: 'PUT', path: '/jobs/{job_id}/schedule', bodyMapping: { start_time: '$start_time', notify: '$notify' } });
    expect(tool('housecall_pro_add_job_line_item').endpointMapping).toMatchObject({ method: 'POST', path: '/jobs/{job_id}/line_items', bodyMapping: { name: '$name', unit_price: '$unit_price', kind: '$kind' } });
    expect(tool('housecall_pro_delete_job_line_item').endpointMapping).toEqual({ method: 'DELETE', path: '/jobs/{job_id}/line_items/{line_item_id}' });
    expect(tool('housecall_pro_create_job_appointment').endpointMapping).toMatchObject({ method: 'POST', path: '/jobs/{job_id}/appointments', bodyMapping: { dispatched_employees_ids: '$dispatched_employees_ids' } });
    expect(tool('housecall_pro_add_job_note').endpointMapping).toEqual({ method: 'POST', path: '/jobs/{job_id}/notes', bodyMapping: { content: '$content' } });
    expect(tool('housecall_pro_create_estimate').endpointMapping).toMatchObject({ method: 'POST', path: '/estimates', bodyMapping: { customer_id: '$customer_id', options: '$options', estimate_fields: '$estimate_fields' } });
    expect(tool('housecall_pro_create_lead').endpointMapping).toMatchObject({ method: 'POST', path: '/leads', bodyMapping: { customer_id: '$customer_id', customer: '$customer' } });
  });

  it('every tool is prefixed, avoids reserved names, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(RESERVED).not.toContain(t.name);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
  });

  it('reads are GET, writes are annotated, the delete is switched off; no money movement', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...SWITCHED_OFF].sort());
    for (const n of SWITCHED_OFF) expect(tool(n).annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    for (const t of a.tools) {
      if (SWITCHED_OFF.includes(t.name)) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(t.endpointMapping.method).not.toBe('DELETE');
      if (WRITES.includes(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
      else expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    }
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/payment|refund|charge|pay_invoice/);
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env;
const live = env.RUN_HOUSECALL_PRO_LIVE === '1' && env.HOUSECALL_PRO_API_KEY ? describe : describe.skip;
live('housecall-pro adapter: live (read-only)', () => {
  const base = 'https://api.housecallpro.com';
  const headers = { Accept: 'application/json', Authorization: `Token ${env.HOUSECALL_PRO_API_KEY}` };
  it('lists one customer and reads the company', async () => {
    const res = await fetch(`${base}/customers?page_size=1`, { headers });
    expect(res.status).toBe(200);
    const customers = (await res.json()) as { customers: unknown[]; total_pages: number; page_size: number };
    expect(Array.isArray(customers.customers)).toBe(true);
    expect(typeof customers.total_pages).toBe('number');
    const company = (await (await fetch(`${base}/company`, { headers })).json()) as { id: string; name: string };
    expect(typeof company.id).toBe('string');
  }, 60_000);
});
