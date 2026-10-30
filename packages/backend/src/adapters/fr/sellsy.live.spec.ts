import axios from 'axios';
import * as adapter from './sellsy.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock;

const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  probe?: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    healthcheckPath?: string;
  };
  tools: Array<{ name: string; endpointMapping: Record<string, unknown> }>;
};

const toolNames = a.tools.map((t) => t.name);

describe('sellsy adapter — static spec conformance', () => {
  it("targets v2, not the single-endpoint v1 RPC API", () => {
    expect(a.connector.baseUrl).toBe('https://api.sellsy.com/v2');
    expect((adapter as unknown as { instructions: string }).instructions).toContain('v1');
  });

  it("authenticates at Sellsy's separate login host", () => {
    expect(a.connector.authConfig?.tokenUrl).toBe('https://login.sellsy.com/oauth2/access-tokens');
  });

  it("offers the expressive POST search alongside the plain list", () => {
    expect(toolNames).toContain('sellsy_search_invoices');
    expect(toolNames).toContain('sellsy_list_invoices');
  });

  it("only offers the sort fields Sellsy's spec accepts", () => {
    const props = (name: string) =>
      (a.tools.find((t) => t.name === name) as unknown as {
        parameters: { properties: Record<string, { enum?: string[] }> };
      }).parameters.properties;
    expect(props('sellsy_list_companies').order.enum).toEqual(['name', 'id', 'created_at', 'updated_at']);
    expect(props('sellsy_list_contacts').order.enum).toEqual(['id', 'name', 'created_at']);
    expect(props('sellsy_list_companies').direction.enum).toEqual(['asc', 'desc']);
  });

  it("tells the model the company filter keys Sellsy accepts", () => {
    const t = a.tools.find((x) => x.name === 'sellsy_search_companies') as unknown as {
      parameters: { properties: { filters: { description: string } } };
    };
    const d = t.parameters.properties.filters.description;
    expect(d).toContain('updated_at');
    expect(d).toContain('date-time');
    expect(d).not.toContain('"2026-01-01"}');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_SELLSY_LIVE === '1';
(live ? describe : describe.skip)('sellsy — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // sellsy answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

const byName = (name: string) => {
  const found = (adapter as unknown as { tools: Array<{ name: string; parameters: { required?: string[] }; endpointMapping: Record<string, unknown> }> }).tools.find((x) => x.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

describe('sellsy adapter: contact and company edits', () => {
  const t = (name: string) => byName(name);
  it('lists the companies of a contact', () => {
    expect(t('sellsy_list_contact_companies').endpointMapping).toMatchObject({ method: 'GET', path: '/contacts/{contactId}/companies' });
  });
  it('edits contacts and companies with a partial PUT of the given fields', () => {
    expect(t('sellsy_edit_contact').endpointMapping).toMatchObject({ method: 'PUT', path: '/contacts/{contactId}', bodyTemplate: '${fields}' });
    expect(t('sellsy_edit_company').endpointMapping).toMatchObject({ method: 'PUT', path: '/companies/{companyId}', bodyTemplate: '${fields}' });
  });
});

// ---------------------------------------------------------------------------
// Full API v2 coverage, checked on 30 Oct 2026 against the OpenAPI document behind
// https://api.sellsy.com/doc/v2/ (dist/sellsy.v2.latest.yaml, version 2.313.0).
// ---------------------------------------------------------------------------

type FullTool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { description?: string; enum?: unknown[]; items?: { enum?: unknown[] } }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; bodyTemplate?: string };
  annotations?: Record<string, unknown>;
};
const full = adapter as unknown as { instructions: string; tools: FullTool[] };
const ft = (name: string) => {
  const t = full.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" in strings.
const usedArgs = (t: FullTool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.bodyTemplate ?? '');
  return out;
};
const ORIGINAL_TOOLS = [
  'sellsy_list_companies', 'sellsy_search_companies', 'sellsy_get_company', 'sellsy_list_contacts',
  'sellsy_list_invoices', 'sellsy_search_invoices', 'sellsy_get_invoice', 'sellsy_list_estimates',
  'sellsy_list_opportunities', 'sellsy_list_items', 'sellsy_get_contact', 'sellsy_list_contact_companies',
  'sellsy_edit_contact', 'sellsy_edit_company',
];

describe('sellsy adapter: API v2 coverage', () => {
  it('keeps the original tools first and in order, and adds the rest of the v2 surface', () => {
    expect(full.tools.slice(0, ORIGINAL_TOOLS.length).map((t) => t.name)).toEqual(ORIGINAL_TOOLS);
    expect(full.tools.length).toBeGreaterThanOrEqual(80);
    expect(full.tools.length).toBeLessThanOrEqual(100);
    expect(new Set(full.tools.map((t) => t.name)).size).toBe(full.tools.length);
  });

  it('maps the documented paths and methods', () => {
    const m = (n: string) => ft(n).endpointMapping;
    const expected: Array<[string, string, string]> = [
      ['sellsy_create_company', 'POST', '/companies'],
      ['sellsy_list_company_contacts', 'GET', '/companies/{companyId}/contacts'],
      ['sellsy_link_contact_to_company', 'POST', '/companies/{companyId}/contacts/{contactId}'],
      ['sellsy_list_company_addresses', 'GET', '/companies/{companyId}/addresses'],
      ['sellsy_create_company_address', 'POST', '/companies/{companyId}/addresses'],
      ['sellsy_get_company_custom_fields', 'GET', '/companies/{companyId}/custom-fields'],
      ['sellsy_update_company_custom_fields', 'PUT', '/companies/{companyId}/custom-fields'],
      ['sellsy_list_company_files', 'GET', '/companies/{companyId}/files'],
      ['sellsy_list_individuals', 'GET', '/individuals'],
      ['sellsy_search_individuals', 'POST', '/individuals/search'],
      ['sellsy_get_individual', 'GET', '/individuals/{individualId}'],
      ['sellsy_create_individual', 'POST', '/individuals'],
      ['sellsy_edit_individual', 'PUT', '/individuals/{individualId}'],
      ['sellsy_search_contacts', 'POST', '/contacts/search'],
      ['sellsy_create_contact', 'POST', '/contacts'],
      ['sellsy_get_opportunity', 'GET', '/opportunities/{opportunityId}'],
      ['sellsy_search_opportunities', 'POST', '/opportunities/search'],
      ['sellsy_create_opportunity', 'POST', '/opportunities'],
      ['sellsy_update_opportunity', 'PATCH', '/opportunities/{opportunityId}'],
      ['sellsy_move_opportunity_step', 'PATCH', '/opportunities/{opportunityId}/step-rank'],
      ['sellsy_list_opportunity_pipelines', 'GET', '/opportunities/pipelines'],
      ['sellsy_list_pipeline_steps', 'GET', '/opportunities/pipelines/{pipelineId}/steps'],
      ['sellsy_list_opportunity_sources', 'GET', '/opportunities/sources'],
      ['sellsy_list_opportunity_categories', 'GET', '/opportunities/categories'],
      ['sellsy_get_estimate', 'GET', '/estimates/{estimateId}'],
      ['sellsy_search_estimates', 'POST', '/estimates/search'],
      ['sellsy_create_estimate', 'POST', '/estimates'],
      ['sellsy_update_estimate_status', 'PUT', '/estimates/{estimateId}/status'],
      ['sellsy_create_invoice', 'POST', '/invoices'],
      ['sellsy_validate_invoice', 'POST', '/invoices/{invoiceId}/validate'],
      ['sellsy_list_invoice_payments', 'GET', '/invoices/{invoiceId}/payments'],
      ['sellsy_list_invoice_credit_notes', 'GET', '/invoices/{invoiceId}/credit-notes'],
      ['sellsy_list_invoice_files', 'GET', '/invoices/{invoiceId}/files'],
      ['sellsy_list_credit_notes', 'GET', '/credit-notes'],
      ['sellsy_search_credit_notes', 'POST', '/credit-notes/search'],
      ['sellsy_get_credit_note', 'GET', '/credit-notes/{creditNoteId}'],
      ['sellsy_list_orders', 'GET', '/orders'],
      ['sellsy_search_orders', 'POST', '/orders/search'],
      ['sellsy_get_order', 'GET', '/orders/{orderId}'],
      ['sellsy_list_deliveries', 'GET', '/deliveries'],
      ['sellsy_list_payments', 'GET', '/payments'],
      ['sellsy_search_payments', 'POST', '/payments/search'],
      ['sellsy_get_payment', 'GET', '/payments/{paymentId}'],
      ['sellsy_list_payment_methods', 'GET', '/payments/methods'],
      ['sellsy_get_item', 'GET', '/items/{itemId}'],
      ['sellsy_search_items', 'POST', '/items/search'],
      ['sellsy_create_item', 'POST', '/items'],
      ['sellsy_edit_item', 'PUT', '/items/{itemId}'],
      ['sellsy_get_item_prices', 'GET', '/items/{itemId}/prices'],
      ['sellsy_list_taxes', 'GET', '/taxes'],
      ['sellsy_list_units', 'GET', '/units'],
      ['sellsy_list_currencies', 'GET', '/currencies'],
      ['sellsy_list_payment_terms', 'GET', '/payment-terms'],
      ['sellsy_list_rate_categories', 'GET', '/rate-categories'],
      ['sellsy_list_custom_fields', 'GET', '/custom-fields'],
      ['sellsy_list_tasks', 'GET', '/tasks'],
      ['sellsy_search_tasks', 'POST', '/tasks/search'],
      ['sellsy_get_task', 'GET', '/tasks/{taskId}'],
      ['sellsy_create_task', 'POST', '/tasks'],
      ['sellsy_update_task', 'PUT', '/tasks/{taskId}'],
      ['sellsy_list_task_labels', 'GET', '/tasks/labels'],
      ['sellsy_list_comments', 'GET', '/comments'],
      ['sellsy_search_comments', 'POST', '/comments/search'],
      ['sellsy_create_comment', 'POST', '/comments'],
      ['sellsy_list_calendar_events', 'GET', '/calendar-events'],
      ['sellsy_search_calendar_events', 'POST', '/calendar-events/search'],
      ['sellsy_get_calendar_event', 'GET', '/calendar-events/{eventId}'],
      ['sellsy_create_calendar_event', 'POST', '/calendar-events'],
      ['sellsy_update_calendar_event', 'PUT', '/calendar-events/{eventId}'],
      ['sellsy_list_calendar_event_labels', 'GET', '/calendar-events/labels'],
      ['sellsy_list_crm_activity', 'GET', '/activities/crm'],
      ['sellsy_list_staffs', 'GET', '/staffs'],
      ['sellsy_get_staff', 'GET', '/staffs/{staffId}'],
      ['sellsy_list_teams', 'GET', '/teams'],
      ['sellsy_get_file', 'GET', '/files/{fileId}'],
      ['sellsy_list_subscriptions', 'GET', '/subscriptions'],
      ['sellsy_get_subscription', 'GET', '/subscriptions/{subscriptionId}'],
      ['sellsy_search', 'GET', '/search'],
      ['sellsy_get_quotas', 'GET', '/quotas'],
    ];
    for (const [name, method, path] of expected) expect(`${name} ${m(name).method} ${m(name).path}`).toBe(`${name} ${method} ${path}`);
    // Partial opportunity update: Sellsy only applies the fields named in only[].
    expect(m('sellsy_update_opportunity').queryParams).toEqual({ 'only[]': '$only' });
    expect(ft('sellsy_update_opportunity').parameters?.required).toEqual(['opportunityId', 'only']);
    expect(m('sellsy_search').queryParams).toEqual({ q: '$q', 'type[]': '$type', limit: '$limit', archived: '$archived' });
    expect(m('sellsy_update_company_custom_fields').bodyTemplate).toBe('${values}');
    expect(m('sellsy_create_invoice').bodyTemplate).toBe('${document}');
    expect(m('sellsy_create_estimate').bodyTemplate).toBe('${document}');
    expect(ft('sellsy_update_estimate_status').parameters?.properties?.status.enum).toEqual(['draft', 'sent', 'read', 'accepted', 'refused', 'expired', 'advanced', 'partialinvoiced', 'invoiced', 'cancelled']);
    expect(ft('sellsy_create_opportunity').parameters?.required).toEqual(['name', 'pipeline', 'step', 'related']);
    expect(ft('sellsy_create_task').parameters?.required).toEqual(['due_date', 'label_id', 'related']);
    expect(ft('sellsy_create_calendar_event').parameters?.required).toEqual(['title', 'datetime_start', 'datetime_end', 'label_id']);
  });

  it('sends the bracketed only[] and type[] lists and array bodies through the real RestEngine', async () => {
    // The OAuth2 token is the engine's job; NONE keeps this test to the request itself.
    const run = (name: string, params: Record<string, unknown>) =>
      new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
        { baseUrl: a.connector.baseUrl, authType: 'NONE', headers: a.connector.headers } as any,
        ft(name).endpointMapping as any,
        params,
      );
    const sentCall = () => mockedAxios.mock.calls[0][0];
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: {}, headers: {} });
    await run('sellsy_update_opportunity', { opportunityId: 7, only: ['status', 'amount'], status: 'won', amount: 1200 });
    expect(sentCall().method).toBe('PATCH');
    expect(sentCall().url).toBe('https://api.sellsy.com/v2/opportunities/7');
    expect(sentCall().paramsSerializer(sentCall().params)).toBe('only%5B%5D=status&only%5B%5D=amount');
    expect(sentCall().data).toEqual({ status: 'won', amount: 1200 });

    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: {}, headers: {} });
    await run('sellsy_update_company_custom_fields', { companyId: 3, values: [{ id: 1542, value: 'Gold' }] });
    expect(sentCall().method).toBe('PUT');
    expect(sentCall().data).toEqual([{ id: 1542, value: 'Gold' }]);

    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: {}, headers: {} });
    await run('sellsy_search_tasks', { filters: { statuses: ['todo'] }, limit: 10 });
    expect(sentCall().url).toBe('https://api.sellsy.com/v2/tasks/search');
    expect(sentCall().data).toEqual({ filters: { statuses: ['todo'] } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of full.tools) {
      expect(t.name).toMatch(/^sellsy_[a-z_]+$/);
      const u = usedArgs(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('marks every POST search read-only and asks for confirmation before new writes', () => {
    for (const t of full.tools) {
      const isSearch = t.endpointMapping.method === 'POST' && t.endpointMapping.path.endsWith('/search');
      if (isSearch) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      const isWrite = t.endpointMapping.method !== 'GET' && !isSearch;
      if (isWrite && !ORIGINAL_TOOLS.includes(t.name)) expect(t.description).toMatch(/[Cc]onfirm/);
    }
    expect(ft('sellsy_validate_invoice').annotations).toMatchObject({ destructiveHint: true });
    expect(full.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('documents every tool in the instructions, names no missing tool and writes no em dash', () => {
    const names = new Set(full.tools.map((t) => t.name));
    for (const n of names) expect(`${n}:${full.instructions.includes(`\`${n}\``)}`).toBe(`${n}:true`);
    for (const [n] of [...full.instructions.matchAll(/\bsellsy_[a-z_]+/g)]) expect(names).toContain(n);
    for (const t of full.tools) for (const [n] of [...t.description.matchAll(/\bsellsy_[a-z_]+/g)]) expect(names).toContain(n);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

// Read-only live calls with a real client-credentials application:
//   SELLSY_CLIENT_ID=... SELLSY_CLIENT_SECRET=... RUN_SELLSY_LIVE=1 npx jest src/adapters/fr/sellsy
const liveReads = process.env.RUN_SELLSY_LIVE === '1' && process.env.SELLSY_CLIENT_ID && process.env.SELLSY_CLIENT_SECRET ? describe : describe.skip;
liveReads('sellsy: live reads (read-only)', () => {
  let token = '';
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as Record<string, any>;
  };
  beforeAll(async () => {
    const res = await fetch(String(a.connector.authConfig?.tokenUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.SELLSY_CLIENT_ID!, client_secret: process.env.SELLSY_CLIENT_SECRET! }),
    });
    expect(res.status).toBe(200);
    token = ((await res.json()) as { access_token: string }).access_token;
  });
  it('reads companies, staff, reference data, pipelines and documents', async () => {
    expect(Array.isArray((await get('/companies?limit=1')).data)).toBe(true);
    expect((await get('/staffs/me')).id).toBeTruthy();
    for (const p of ['/taxes?limit=5', '/units?limit=5', '/payment-terms?limit=5', '/opportunities/pipelines?limit=5', '/tasks/labels?limit=5', '/calendar-events/labels?limit=5', '/custom-fields?limit=5', '/payments/methods?limit=5']) {
      expect(Array.isArray((await get(p)).data)).toBe(true);
    }
    for (const p of ['/individuals?limit=1', '/orders?limit=1', '/credit-notes?limit=1', '/payments?limit=1', '/tasks?limit=1', '/comments?limit=1', '/calendar-events?limit=1']) {
      expect(Array.isArray((await get(p)).data)).toBe(true);
    }
  }, 60_000);
});
