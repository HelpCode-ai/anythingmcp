import * as adapter from './servicem8.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * ServiceM8 REST API (developer.servicem8.com; OpenAPI per endpoint in the reference pages and in the
 * official servicem8-node SDK's api.json): base https://api.servicem8.com/api_1.0, private API key in the
 * X-API-Key header, OData-style $filter, cursor paging (cursor=-1, then the x-next-cursor header), new
 * record UUIDs in the x-record-uuid header, updates as partial POSTs to /<object>/<uuid>.json and
 * deletes that only set active to 0.
 * Live part (reads only: account, staff, categories, one page of jobs):
 *   SERVICEM8_API_KEY=... RUN_SERVICEM8_LIVE=1 npx jest src/adapters/intl/servicem8
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
  parameters?: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; exposeHeaders?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
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

describe('servicem8 adapter: static spec conformance', () => {
  it('authenticates with the private API key in X-API-Key', () => {
    expect(a.requiredEnvVars).toEqual(['SERVICEM8_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.servicem8.com/api_1.0');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-Key', apiKey: '{{SERVICEM8_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/vendor.json');
    expect(a.envVarMeta?.SERVICEM8_API_KEY.secret).toBe(true);
  });

  it('lists take $filter and cursor and expose x-next-cursor', () => {
    const lists = a.tools.filter((t) => t.name.startsWith('servicem8_list_'));
    expect(lists.length).toBeGreaterThan(15);
    for (const t of lists) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(t.endpointMapping.queryParams).toEqual({ $filter: '$filter', cursor: '$cursor' });
      expect(t.endpointMapping.exposeHeaders).toEqual(['x-next-cursor']);
      expect(t.endpointMapping.path).toMatch(/^\/[a-z]+\.json$/);
    }
  });

  it('maps the documented object routes', () => {
    const route = (n: string) => `${tool(n).endpointMapping.method} ${tool(n).endpointMapping.path}`;
    expect(route('servicem8_get_account')).toBe('GET /vendor.json');
    expect(route('servicem8_list_jobs')).toBe('GET /job.json');
    expect(route('servicem8_get_job')).toBe('GET /job/{uuid}.json');
    expect(route('servicem8_list_clients')).toBe('GET /company.json');
    expect(route('servicem8_list_client_contacts')).toBe('GET /companycontact.json');
    expect(route('servicem8_list_job_activities')).toBe('GET /jobactivity.json');
    expect(route('servicem8_list_job_allocations')).toBe('GET /joballocation.json');
    expect(route('servicem8_list_staff')).toBe('GET /staff.json');
    expect(route('servicem8_list_materials')).toBe('GET /material.json');
    expect(route('servicem8_list_job_payments')).toBe('GET /jobpayment.json');
    expect(route('servicem8_list_attachments')).toBe('GET /attachment.json');
    expect(route('servicem8_get_attachment')).toBe('GET /dboattachment/{uuid}.json');
    expect(route('servicem8_list_form_responses')).toBe('GET /formresponse.json');
    expect(route('servicem8_list_job_queues')).toBe('GET /queue.json');
    expect(route('servicem8_create_job')).toBe('POST /job.json');
    expect(route('servicem8_update_job')).toBe('POST /job/{uuid}.json');
    expect(route('servicem8_create_job_from_template')).toBe('POST /jobtemplate/{uuid}/job.json');
    expect(route('servicem8_create_client')).toBe('POST /company.json');
    expect(route('servicem8_update_client')).toBe('POST /company/{uuid}.json');
    expect(route('servicem8_schedule_job_activity')).toBe('POST /jobactivity.json');
    expect(route('servicem8_update_job_activity')).toBe('POST /jobactivity/{uuid}.json');
    expect(route('servicem8_remove_job_activity')).toBe('DELETE /jobactivity/{uuid}.json');
    expect(route('servicem8_add_job_material')).toBe('POST /jobmaterial.json');
    expect(route('servicem8_record_job_payment')).toBe('POST /jobpayment.json');
    expect(route('servicem8_add_note')).toBe('POST /note.json');
    expect(tool('servicem8_create_job').parameters?.properties?.status.enum).toEqual(['Quote', 'Work Order', 'Unsuccessful', 'Completed']);
    expect(tool('servicem8_create_job').parameters?.required).toEqual(['status']);
    expect(tool('servicem8_create_client').parameters?.required).toEqual(['name']);
    expect(tool('servicem8_add_job_material').parameters?.required).toEqual(['job_uuid', 'quantity']);
  });

  it('creates return the new UUID header; updates are partial', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'POST' && !x.endpointMapping.path.includes('{uuid}.json'))) {
      expect(`${t.name}:${JSON.stringify(t.endpointMapping.exposeHeaders)}`).toBe(`${t.name}:["x-record-uuid"]`);
    }
    for (const n of ['servicem8_update_job', 'servicem8_update_client', 'servicem8_update_job_activity']) {
      expect(tool(n).parameters?.required).toEqual(['uuid']);
    }
  });

  it('drops unused payment and geocoding fields from the job list and signature data from attachments', () => {
    const jobs = applyResponseTransform(
      [{ uuid: 'j1', status: 'Quote', generated_job_id: '101', payment_amount: '0', ready_to_invoice: '0', lat: 1, lng: 2, geo_street: 'x' }],
      tool('servicem8_list_jobs').responseMapping as never,
    ).value;
    expect(jobs).toEqual([{ uuid: 'j1', status: 'Quote', generated_job_id: '101' }]);
    const att = applyResponseTransform([{ uuid: 'a1', attachment_name: 'photo.jpg', signature_data: 'xxx', metadata: '{}' }], tool('servicem8_list_attachments').responseMapping as never).value;
    expect(att).toEqual([{ uuid: 'a1', attachment_name: 'photo.jpg' }]);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('servicem8_')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('switches nothing off (deletes only set active to 0) and annotates every write', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual([]);
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET') expect(t.annotations).toBeUndefined();
      else expect(t.annotations?.readOnlyHint).toBe(false);
    }
    expect(tool('servicem8_remove_job_activity').annotations?.destructiveHint).toBe(true);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

describe('servicem8 adapter: requests', () => {
  const engine = new RestEngine({} as any, {} as any);
  const key = ['sm8', 'test', '0'.repeat(12)].join('-');
  const config = { baseUrl: a.connector.baseUrl, authType: 'API_KEY' as const, authConfig: { headerName: 'X-API-Key', apiKey: key }, headers: a.connector.headers };
  const sent = () => mockedAxios.mock.calls[0][0] as any;
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.mockResolvedValue({ status: 200, data: [], headers: { 'x-next-cursor': 'c2' } });
  });

  it('sends the key, the $filter and the cursor', async () => {
    await engine.execute(config, tool('servicem8_list_jobs').endpointMapping as any, { filter: "status eq 'Work Order'", cursor: '-1' });
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe('https://api.servicem8.com/api_1.0/job.json');
    expect(sent().params).toEqual({ $filter: "status eq 'Work Order'", cursor: '-1' });
    expect(sent().headers['X-API-Key']).toBe(key);
  });

  it('posts a booking with the API field names', async () => {
    await engine.execute(config, tool('servicem8_schedule_job_activity').endpointMapping as any, {
      job_uuid: 'j1', staff_uuid: 's1', start_date: '2026-11-03 09:00:00', end_date: '2026-11-03 11:00:00', activity_was_scheduled: 1,
    });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe('https://api.servicem8.com/api_1.0/jobactivity.json');
    expect(sent().data).toEqual({ job_uuid: 'j1', staff_uuid: 's1', start_date: '2026-11-03 09:00:00', end_date: '2026-11-03 11:00:00', activity_was_scheduled: 1 });
  });
});

const live = process.env.RUN_SERVICEM8_LIVE === '1' && process.env.SERVICEM8_API_KEY ? describe : describe.skip;
live('servicem8 adapter: live (read-only)', () => {
  const real = jest.requireActual('axios');
  const get = async (path: string) => {
    const res = await real.get(`${a.connector.baseUrl}${path}`, { headers: { 'X-API-Key': process.env.SERVICEM8_API_KEY, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return res;
  };
  it('reads the account, staff, categories and one page of jobs', async () => {
    expect(Array.isArray((await get('/vendor.json')).data)).toBe(true);
    expect(Array.isArray((await get('/staff.json?%24filter=active%20eq%201')).data)).toBe(true);
    expect(Array.isArray((await get('/category.json')).data)).toBe(true);
    const jobs = await get('/job.json?cursor=-1&%24filter=active%20eq%201');
    expect(Array.isArray(jobs.data)).toBe(true);
    expect(jobs.data.length).toBeLessThanOrEqual(1000);
  }, 60_000);
});
