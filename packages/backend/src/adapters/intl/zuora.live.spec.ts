import * as adapter from './zuora.json';

/**
 * Zuora Billing REST API v1 (developer.zuora.com/v1-api-reference, OpenAPI at developer.zuora.com/yaml/apis/zuora-openapi-full-compact.yaml):
 * base = the REST host of the tenant's data center (ZUORA_API_URL), OAuth 2.0 client credentials at {host}/oauth/token,
 * Object Query lists paged with cursor/nextPage, v1 lists with page/pageSize.
 * Live part (reads only: token, catalog, accounts via Object Query, invoices):
 *   ZUORA_CLIENT_ID=... ZUORA_CLIENT_SECRET=... ZUORA_API_URL=https://rest.apisandbox.zuora.com RUN_ZUORA_LIVE=1 npx jest src/adapters/intl/zuora
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
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
const ENV = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings (connector variables excluded).
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
  for (const e of ENV) out.delete(e);
  return out;
};
const PREFIX = 'zuora_';

describe('zuora adapter: static spec conformance', () => {
  it('gets an OAuth token with the client credentials grant from the tenant host', () => {
    expect(a.slug).toBe('zuora');
    expect(a.region).toBe('intl');
    expect(a.requiredEnvVars).toEqual(['ZUORA_CLIENT_ID', 'ZUORA_CLIENT_SECRET', 'ZUORA_API_URL']);
    expect(a.connector.baseUrl).toBe('{{ZUORA_API_URL}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{ZUORA_CLIENT_ID}}',
      clientSecret: '{{ZUORA_CLIENT_SECRET}}',
      tokenUrl: '{{ZUORA_API_URL}}/oauth/token',
      tokenAuthMethod: 'client_secret_post',
    });
    expect(a.envVarMeta?.ZUORA_CLIENT_SECRET.secret).toBe(true);
    const host = new RegExp(a.envVarMeta?.ZUORA_API_URL.pattern as string);
    for (const h of ['https://rest.zuora.com', 'https://rest.na.zuora.com', 'https://rest.eu.zuora.com', 'https://rest.ap.zuora.com', 'https://rest.apisandbox.zuora.com', 'https://rest.sandbox.na.zuora.com', 'https://rest.sandbox.eu.zuora.com', 'https://rest.test.zuora.com', 'https://rest.test.eu.zuora.com', 'https://rest.test.ap.zuora.com'])
      expect(`${h}:${host.test(h)}`).toBe(`${h}:true`);
    expect(host.test('https://rest.zuora.com/')).toBe(false);
    expect(host.test('https://www.zuora.com')).toBe(false);
    expect(host.test('https://rest.zuora.com/v1')).toBe(false);
  });

  it('lists with Object Query bracket parameters and a cursor', () => {
    for (const [n, p] of [['zuora_list_accounts', '/object-query/accounts'], ['zuora_list_subscriptions', '/object-query/subscriptions'], ['zuora_list_invoices', '/object-query/invoices'], ['zuora_list_usages', '/object-query/usages']]) {
      expect(tool(n).endpointMapping).toEqual({
        method: 'GET',
        path: p,
        queryParams: { 'filter[]': '$filter', 'sort[]': '$sort', 'expand[]': '$expand', 'fields[]': '$fields', pageSize: '$page_size', cursor: '$cursor' },
      });
      expect(tool(n).parameters?.properties?.filter).toMatchObject({ type: 'array' });
    }
  });

  it('maps accounts, subscriptions, orders and invoices', () => {
    expect(tool('zuora_get_account').endpointMapping).toEqual({ method: 'GET', path: '/v1/accounts/{account_key}' });
    expect(tool('zuora_get_account_summary').endpointMapping.path).toBe('/v1/accounts/{account_key}/summary');
    expect(tool('zuora_create_account').endpointMapping.bodyMapping).toMatchObject({ name: '$name', currency: '$currency', billToContact: '$bill_to_contact', __merge: '$custom_fields' });
    expect(tool('zuora_update_account').endpointMapping.method).toBe('PUT');
    expect(tool('zuora_list_account_subscriptions').endpointMapping.path).toBe('/v1/subscriptions/accounts/{account_key}');
    expect(tool('zuora_preview_order').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/orders/preview', bodyMapping: { orderDate: '$order_date', subscriptions: '$subscriptions', previewOptions: '$preview_options' } });
    expect(tool('zuora_create_order').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/orders', bodyMapping: { orderDate: '$order_date', existingAccountNumber: '$existing_account_number', subscriptions: '$subscriptions' } });
    for (const [n, p] of [['zuora_renew_subscription', 'renew'], ['zuora_suspend_subscription', 'suspend'], ['zuora_resume_subscription', 'resume'], ['zuora_cancel_subscription', 'cancel']])
      expect(tool(n).endpointMapping).toMatchObject({ method: 'PUT', path: `/v1/subscriptions/{subscription_key}/${p}` });
    expect(tool('zuora_cancel_subscription').endpointMapping.bodyMapping).toMatchObject({ cancellationPolicy: '$cancellation_policy' });
    expect(tool('zuora_list_invoice_files').endpointMapping.path).toBe('/v1/invoices/{invoice_key}/files');
    expect(tool('zuora_email_invoice').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/invoices/{invoice_key}/emails' });
    expect(tool('zuora_create_credit_memo_from_invoice').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/credit-memos/invoice/{invoice_key}', bodyMapping: { invoiceId: '$invoice_id' } });
    expect(tool('zuora_create_usage').endpointMapping.bodyMapping).toMatchObject({ UOM: '$uom', Quantity: '$quantity', StartDateTime: '$start_date_time' });
  });

  it('marks the POST queries read-only and builds the Data Query job body', () => {
    expect(tool('zuora_query').endpointMapping).toEqual({ method: 'POST', path: '/v1/action/query', bodyMapping: { queryString: '$query' } });
    expect(tool('zuora_query_more').endpointMapping).toEqual({ method: 'POST', path: '/v1/action/queryMore', bodyMapping: { queryLocator: '$query_locator' } });
    expect(tool('zuora_create_data_query').endpointMapping).toEqual({
      method: 'POST',
      path: '/query/jobs',
      bodyMapping: { query: '$query', outputFormat: '$output_format', compression: 'NONE', output: { target: 'S3' }, readDeleted: '$read_deleted' },
    });
    for (const n of ['zuora_query', 'zuora_query_more', 'zuora_create_data_query', 'zuora_preview_order']) expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:true`);
    expect(tool('zuora_get_data_query').endpointMapping.path).toBe('/query/jobs/{job_id}');
  });

  it('installs money-moving and irreversible tools switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual(['zuora_cancel_subscription', 'zuora_create_payment', 'zuora_refund_payment']);
    for (const n of off) expect(tool(n).annotations?.destructiveHint).toBe(true);
    expect(tool('zuora_create_payment').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/payments' });
    expect(tool('zuora_refund_payment').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/payments/{payment_key}/refunds' });
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
    expect(a.instructions).toContain('**Switched off at install**: `zuora_cancel_subscription`, `zuora_create_payment` and `zuora_refund_payment`');
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(`${t.name}:${r}:${props.includes(r)}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('keeps GET tools read-only', () => {
    for (const t of a.tools) if (t.endpointMapping.method === 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:false`);
  });

  it('probes with a read tool without required parameters and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_ZUORA_LIVE === '1' && process.env.ZUORA_CLIENT_ID && process.env.ZUORA_CLIENT_SECRET ? describe : describe.skip;
live('zuora adapter: live (read-only)', () => {
  const base = process.env.ZUORA_API_URL || 'https://rest.apisandbox.zuora.com';
  let token = '';
  beforeAll(async () => {
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.ZUORA_CLIENT_ID as string, client_secret: process.env.ZUORA_CLIENT_SECRET as string, grant_type: 'client_credentials' }),
    });
    expect(res.status).toBe(200);
    token = ((await res.json()) as { access_token: string }).access_token;
  });
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the catalog, accounts, subscriptions and invoices', async () => {
    expect((await get('/v1/catalog/products?pageSize=1')).success).toBe(true);
    for (const p of ['/object-query/accounts?pageSize=1', '/object-query/subscriptions?pageSize=1', '/object-query/invoices?pageSize=1']) expect(Array.isArray((await get(p)).data)).toBe(true);
  }, 60_000);
});
