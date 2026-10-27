import * as adapter from './moss.json';

/**
 * Moss Public API (developers.getmoss.com, OpenAPI at /specs/latest/openapi.yaml):
 * OAuth 2.0 client credentials at /oauth2/token with the API key (kid_ / sk_),
 * Bearer token on https://public-api.getmoss.com/v1/...
 * Live part: MOSS_KEY_ID=kid_... MOSS_SECRET_KEY=sk_... RUN_MOSS_LIVE=1 npx jest src/adapters/de/moss
 * (reads only: a read-scoped token, expenses, bank accounts, dimensions, tax rates).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: string[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: { binary?: unknown };
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
const PREFIX = 'moss_';
const WRITES = ['moss_create_dimension', 'moss_create_dimension_item', 'moss_create_supplier', 'moss_update_dimension', 'moss_update_dimension_item', 'moss_update_supplier'];
const OFF = ['moss_update_supplier'];

describe('moss adapter: static spec conformance', () => {
  it('gets a token with the client credentials grant and the API key', () => {
    expect(a.slug).toBe('moss');
    expect(a.region).toBe('de');
    expect(a.requiredEnvVars).toEqual(['MOSS_KEY_ID', 'MOSS_SECRET_KEY']);
    expect(a.connector.baseUrl).toBe('https://public-api.getmoss.com');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{MOSS_KEY_ID}}',
      clientSecret: '{{MOSS_SECRET_KEY}}',
      tokenUrl: 'https://public-api.getmoss.com/oauth2/token',
      tokenAuthMethod: 'client_secret_post',
      scope: 'write',
    });
    expect(a.envVarMeta?.MOSS_SECRET_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.MOSS_KEY_ID.pattern as string).test('kid_FaYnufhSMSP1qaXy')).toBe(true);
    expect(new RegExp(a.envVarMeta?.MOSS_SECRET_KEY.pattern as string).test('sk_rKvWDzU6h46hiy3t')).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/v1\//);
  });

  it('maps expenses, files and bank reads to the documented routes and filter names', () => {
    expect(tool('moss_list_expenses').endpointMapping).toEqual({
      method: 'GET',
      path: '/v1/expenses',
      queryParams: {
        type: '$types', status: '$statuses', export_status: '$export_statuses', id: '$ids',
        create_date__gte: '$created_from', create_date__lte: '$created_to',
        expense_date__gte: '$expense_date_from', expense_date__lte: '$expense_date_to',
        update_time__gte: '$updated_from', update_time__lte: '$updated_to',
        sort: '$sort', page: '$page', page_size: '$page_size',
      },
    });
    expect(tool('moss_list_expenses').parameters?.properties?.page_size).toMatchObject({ default: 50 });
    expect(tool('moss_search_files').endpointMapping).toEqual({
      method: 'POST',
      path: '/v1/files/search-query',
      bodyMapping: { filters: { expenseIds: '$expense_ids' }, pagination: { page: '$page', pageSize: '$page_size' } },
    });
    expect(tool('moss_download_file').endpointMapping).toEqual({ method: 'GET', path: '/v1/files/{file_id}/content' });
    expect(tool('moss_download_file').responseMapping?.binary).toBeDefined();
    expect(tool('moss_get_bank_account_balance').endpointMapping.path).toBe('/v1/bank-accounts/{bank_account_id}/balance');
    expect(tool('moss_search_bank_transactions').endpointMapping).toEqual({
      method: 'POST',
      path: '/v1/bank-transactions/search-query',
      bodyMapping: {
        filters: { bookingDateFrom: '$booking_date_from', bookingDateTo: '$booking_date_to', accountIds: '$account_ids', ids: '$ids' },
        sort: { sortBy: 'bookingDate', sortOrder: '$sort_order' },
        pagination: { page: '$page', pageSize: '$page_size' },
      },
    });
    expect(tool('moss_search_bank_transactions').parameters?.required).toEqual(['booking_date_from', 'booking_date_to']);
    expect(tool('moss_list_dimension_items').endpointMapping).toMatchObject({
      path: '/v1/dimensions/{dimension_id}/items',
      queryParams: { update_date__gte: '$updated_from', update_date__lte: '$updated_to' },
    });
    expect(tool('moss_list_expense_accounts').endpointMapping.queryParams).toMatchObject({ account_number__gte: '$account_number_from', account_number__lte: '$account_number_to' });
    expect(tool('moss_list_users').endpointMapping.queryParams).toMatchObject({ status: '$statuses', role: '$roles' });
    expect(tool('moss_list_teams').endpointMapping.queryParams).toMatchObject({ department_id: '$department_ids' });
  });

  it('maps the master-data writes and never offers a delete', () => {
    expect(tool('moss_create_supplier').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/suppliers', bodyMapping: { name: '$name', vatId: '$vat_id', iban: '$iban', defaultPaymentMethod: '$default_payment_method', status: '$status', externalUserId: '$external_user_id' } });
    expect(tool('moss_create_supplier').parameters?.required).toEqual(['name', 'default_payment_method']);
    expect(tool('moss_update_supplier').endpointMapping).toMatchObject({ method: 'PATCH', path: '/v1/suppliers/{supplier_id}' });
    expect(tool('moss_create_dimension').endpointMapping).toEqual({ method: 'POST', path: '/v1/dimensions', bodyMapping: { name: '$name', erpName: '$erp_name', erpId: '$erp_id', externalUserId: '$external_user_id' } });
    expect(tool('moss_update_dimension').endpointMapping).toEqual({ method: 'PATCH', path: '/v1/dimensions/{dimension_id}', bodyMapping: { name: '$name', erpName: '$erp_name', externalUserId: '$external_user_id' } });
    expect(tool('moss_create_dimension_item').endpointMapping).toEqual({ method: 'POST', path: '/v1/dimensions/{dimension_id}/items', bodyMapping: { name: '$name', code: '$code', status: '$status', externalUserId: '$external_user_id' } });
    expect(tool('moss_update_dimension_item').endpointMapping).toMatchObject({ method: 'PATCH', path: '/v1/dimensions/{dimension_id}/items/{dimension_item_id}' });
    expect(tool('moss_update_dimension_item').parameters?.required).toEqual(['dimension_id', 'dimension_item_id', 'name', 'status']);
    for (const n of ['moss_create_supplier', 'moss_update_supplier', 'moss_create_dimension_item', 'moss_update_dimension_item']) {
      expect(`${n}:${tool(n).parameters?.properties?.status?.enum}`).toBe(`${n}:ACTIVE,DEACTIVATED`);
    }
    for (const t of a.tools) expect(t.endpointMapping.method).not.toBe('DELETE');
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

  it('writes are annotated, the supplier update installed switched off; POST searches are read-only', () => {
    const writes = a.tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of ['moss_update_supplier', 'moss_update_dimension', 'moss_update_dimension_item']) expect(tool(n).annotations?.destructiveHint).toBe(true);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_MOSS_LIVE === '1' && process.env.MOSS_KEY_ID && process.env.MOSS_SECRET_KEY ? describe : describe.skip;
live('moss adapter: live (read-only)', () => {
  const base = 'https://public-api.getmoss.com';
  it('gets a read token and reads expenses, bank accounts, dimensions and tax rates', async () => {
    const tokenRes = await fetch(`${base}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.MOSS_KEY_ID as string, client_secret: process.env.MOSS_SECRET_KEY as string, scope: 'read' }),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const headers = { Authorization: `Bearer ${access_token}`, Accept: 'application/json' };
    const expenses = (await (await fetch(`${base}/v1/expenses?page_size=5&sort=-expense_time`, { headers })).json()) as { data: unknown[]; meta: { pagination: { hasMore: boolean } } };
    expect(Array.isArray(expenses.data)).toBe(true);
    expect(typeof expenses.meta.pagination.hasMore).toBe('boolean');
    const accounts = (await (await fetch(`${base}/v1/bank-accounts`, { headers })).json()) as { data: Array<{ id: string }> };
    expect(Array.isArray(accounts.data)).toBe(true);
    const dims = (await (await fetch(`${base}/v1/dimensions`, { headers })).json()) as { data: unknown[] };
    expect(Array.isArray(dims.data)).toBe(true);
    const rates = (await (await fetch(`${base}/v1/tax-rates?page_size=5`, { headers })).json()) as { data: unknown[] };
    expect(Array.isArray(rates.data)).toBe(true);
  }, 60_000);
});
