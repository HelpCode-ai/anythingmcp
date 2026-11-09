import * as adapter from './egypt-eta.json';

/**
 * Egyptian Tax Authority e-Invoicing API (sdk.invoicing.eta.gov.eg): API host
 * api.invoicing.eta.gov.eg (preprod api.preprod.invoicing.eta.gov.eg), OAuth 2 client
 * credentials at https://id.eta.gov.eg/connect/token (preprod id.preprod.eta.gov.eg),
 * scope InvoicingAPI, token valid one hour.
 * Live part (preprod): ETA_CLIENT_ID=... ETA_CLIENT_SECRET=... RUN_EGYPT_ETA_LIVE=1 npx jest src/adapters/eg/egypt-eta
 * (reads only: token, document types).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  responseMapping?: { binary?: unknown; transform?: { exclude?: string[] } };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
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
const PREFIX = 'egypt_eta_';
const SWITCHED_OFF = ['egypt_eta_cancel_document', 'egypt_eta_reject_document', 'egypt_eta_decline_cancellation', 'egypt_eta_decline_rejection'];
const WRITES = [...SWITCHED_OFF, 'egypt_eta_request_document_package'];
const RESERVED = [
  'eta_get_document_details',
  'eta_get_document_pdf',
  'eta_get_document_raw',
  'eta_get_document_type',
  'eta_list_document_types',
  'eta_search_received_documents',
];

describe('egypt-eta adapter: static spec conformance', () => {
  it('uses OAuth 2 client credentials at the identity host of the chosen environment', () => {
    expect(a.region).toBe('eg');
    expect(a.requiredEnvVars).toEqual(['ETA_API_HOST', 'ETA_ID_HOST', 'ETA_CLIENT_ID', 'ETA_CLIENT_SECRET']);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://{{ETA_API_HOST}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{ETA_CLIENT_ID}}',
      clientSecret: '{{ETA_CLIENT_SECRET}}',
      tokenUrl: 'https://{{ETA_ID_HOST}}/connect/token',
      tokenAuthMethod: 'client_secret_post',
      scope: 'InvoicingAPI',
    });
    expect(a.envVarMeta?.ETA_CLIENT_SECRET.secret).toBe(true);
    expect(a.probe?.tool).toBe('egypt_eta_list_document_types');
  });

  it('accepts only the production and preproduction hosts', () => {
    const api = new RegExp(a.envVarMeta?.ETA_API_HOST.pattern ?? '');
    expect(api.test('api.invoicing.eta.gov.eg')).toBe(true);
    expect(api.test('api.preprod.invoicing.eta.gov.eg')).toBe(true);
    expect(api.test('https://api.invoicing.eta.gov.eg')).toBe(false);
    expect(api.test('id.eta.gov.eg')).toBe(false);
    const id = new RegExp(a.envVarMeta?.ETA_ID_HOST.pattern ?? '');
    expect(id.test('id.eta.gov.eg')).toBe(true);
    expect(id.test('id.preprod.eta.gov.eg')).toBe(true);
    expect(id.test('api.invoicing.eta.gov.eg')).toBe(false);
  });

  it('maps the document reads to the documented routes (observed paths covered)', () => {
    expect(tool('egypt_eta_search_documents').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/api/v1.0/documents/search',
      queryParams: {
        submissionDateFrom: '$submission_date_from',
        submissionDateTo: '$submission_date_to',
        issueDateFrom: '$issue_date_from',
        issueDateTo: '$issue_date_to',
        direction: '$direction',
        status: '$status',
        documentType: '$document_type',
        internalID: '$internal_id',
        pageSize: '$page_size',
        continuationToken: '$continuation_token',
      },
    });
    expect(tool('egypt_eta_list_recent_documents').endpointMapping).toMatchObject({ method: 'GET', path: '/api/v1.0/documents/recent', queryParams: { pageNo: '$page_no' } });
    expect(tool('egypt_eta_get_document_details').endpointMapping).toEqual({ method: 'GET', path: '/api/v1.0/documents/{uuid}/details' });
    expect(tool('egypt_eta_get_document_raw').endpointMapping).toMatchObject({ method: 'GET', path: '/api/v1.0/documents/{uuid}/raw', headers: { Accept: '$accept' } });
    expect(tool('egypt_eta_get_document_pdf').endpointMapping).toMatchObject({ method: 'GET', path: '/api/v1.0/documents/{uuid}/pdf' });
    expect(tool('egypt_eta_get_document_pdf').responseMapping?.binary).toBeDefined();
    expect(tool('egypt_eta_get_submission').endpointMapping).toMatchObject({ method: 'GET', path: '/api/v1.0/documentsubmissions/{submission_uuid}' });
    expect(tool('egypt_eta_list_document_types').endpointMapping).toEqual({ method: 'GET', path: '/api/v1.0/documenttypes' });
    expect(tool('egypt_eta_get_document_type').endpointMapping).toEqual({ method: 'GET', path: '/api/v1.0/documenttypes/{id}' });
    expect(tool('egypt_eta_get_document_type_version').endpointMapping).toEqual({ method: 'GET', path: '/api/v1.0/documenttypes/{id}/versions/{vid}' });
    for (const n of ['egypt_eta_search_documents', 'egypt_eta_list_recent_documents']) {
      expect(tool(n).responseMapping?.transform?.exclude).toEqual(['result[*].publicUrl']);
    }
  });

  it('maps packages, notifications and item codes', () => {
    expect(tool('egypt_eta_request_document_package').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/api/v1.0/documentpackages/requests',
      bodyMapping: { type: '$type', format: '$format', queryParameters: { dateFrom: '$date_from', dateTo: '$date_to', statuses: '$statuses', itemCodes: '$item_codes', truncateifexceeded: '$truncate_if_exceeded' } },
    });
    expect(tool('egypt_eta_list_package_requests').endpointMapping).toMatchObject({ method: 'GET', path: '/api/v1.0/documentpackages/requests' });
    expect(tool('egypt_eta_download_document_package').endpointMapping).toMatchObject({ method: 'GET', path: '/api/v1.0/documentpackages/{package_id}' });
    expect(tool('egypt_eta_download_document_package').responseMapping?.binary).toBeDefined();
    expect(tool('egypt_eta_list_notifications').endpointMapping).toMatchObject({ method: 'GET', path: '/api/v1.0/notifications/taxpayer' });
    expect(tool('egypt_eta_search_published_codes').endpointMapping).toMatchObject({ method: 'GET', path: '/api/v1.0/codetypes/{code_type}/codes', queryParams: { Ps: '$page_size', Pn: '$page_number' } });
    expect(tool('egypt_eta_get_code_details').endpointMapping).toEqual({ method: 'GET', path: '/api/v1.0/codetypes/{code_type}/codes/{item_code}' });
    expect(tool('egypt_eta_search_my_code_usage_requests').endpointMapping).toMatchObject({ method: 'GET', path: '/api/v1.0/codetypes/requests/my', queryParams: { PageSize: '$page_size', PageNumber: '$page_number' } });
  });

  it('maps the state changes and installs them switched off', () => {
    expect(tool('egypt_eta_cancel_document').endpointMapping).toEqual({ method: 'PUT', path: '/api/v1.0/documents/state/{uuid}/state', bodyMapping: { status: 'cancelled', reason: '$reason' } });
    expect(tool('egypt_eta_reject_document').endpointMapping).toEqual({ method: 'PUT', path: '/api/v1.0/documents/state/{uuid}/state', bodyMapping: { status: 'rejected', reason: '$reason' } });
    expect(tool('egypt_eta_decline_cancellation').endpointMapping).toEqual({ method: 'PUT', path: '/api/v1.0/documents/state/{uuid}/decline/cancelation' });
    expect(tool('egypt_eta_decline_rejection').endpointMapping).toEqual({ method: 'PUT', path: '/api/v1.0/documents/state/{uuid}/decline/rejection' });
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...SWITCHED_OFF].sort());
    for (const n of SWITCHED_OFF) expect(tool(n).annotations?.destructiveHint).toBe(true);
  });

  it('has no document submission tool', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.path).not.toMatch(/documentsubmissions\/?$/i);
      expect(t.endpointMapping.path).not.toMatch(/receipt/i);
    }
  });

  it('every tool is prefixed, avoids reserved names, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(RESERVED).not.toContain(t.name);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated; reads are GET and read-only; no deletes', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).not.toBe('DELETE');
      if (WRITES.includes(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
      else {
        expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
        expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      }
    }
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env;
const live = env.RUN_EGYPT_ETA_LIVE === '1' && env.ETA_CLIENT_ID && env.ETA_CLIENT_SECRET ? describe : describe.skip;
live('egypt-eta adapter: live (preprod, read-only)', () => {
  const idHost = env.ETA_ID_HOST || 'id.preprod.eta.gov.eg';
  const apiHost = env.ETA_API_HOST || 'api.preprod.invoicing.eta.gov.eg';
  it('gets a client credentials token and reads the document types', async () => {
    const tokenRes = await fetch(`https://${idHost}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: String(env.ETA_CLIENT_ID),
        client_secret: String(env.ETA_CLIENT_SECRET),
        scope: 'InvoicingAPI',
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token: token } = (await tokenRes.json()) as { access_token: string };
    expect(typeof token).toBe('string');
    const types = (await (await fetch(`https://${apiHost}/api/v1.0/documenttypes`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } })).json()) as {
      result: Array<{ id: number; name: string }>;
    };
    expect(Array.isArray(types.result)).toBe(true);
    expect(types.result.map((t) => t.name)).toContain('i');
  }, 60_000);
});
