import * as adapter from './invoice123.json';

/**
 * Invoice123 API v1.0 (OpenAPI at app.invoice123.com/docs/definitions/openapi.1_0.json, rendered at
 * app.invoice123.com/docs/index.html): base https://app.invoice123.com/api/v1.0, Authorization: Bearer
 * with a key generated under Account settings > Integrations > API, per-permission scopes.
 * Live part: INVOICE123_API_TOKEN=... RUN_INVOICE123_LIVE=1 npx jest src/adapters/intl/invoice123
 * (reads only: company, one page of invoices, invoice VAT rates).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, any>; headers?: Record<string, string>; config?: Record<string, any> };
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
const PREFIX = 'invoice123_';
const WRITES: string[] = [];
const SWITCHED_OFF: string[] = [];

describe('invoice123 adapter: static spec conformance', () => {

  it('sends the key as Bearer to the documented v1.0 base URL and asks for JSON', () => {
    expect(a.requiredEnvVars).toEqual(['INVOICE123_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://app.invoice123.com/api/v1.0');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{INVOICE123_API_TOKEN}}' });
    expect(a.connector.headers).toEqual({ Accept: 'application/json' });
    expect(a.envVarMeta?.INVOICE123_API_TOKEN.secret).toBe(true);
    expect(a.probe?.tool).toBe('invoice123_get_company');
  });

  it('maps the documented invoice routes and filters', () => {
    expect(tool('invoice123_list_invoices').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/invoices',
      queryParams: { page: '$page', limit: '$limit', text: '$text', range: '$range', status: '$status', client: '$client_id', series: '$series_id', invoice: '$invoice_id', payment_date: '$payment_date' },
    });
    expect(tool('invoice123_list_invoice_payments').endpointMapping.path).toBe('/invoices/{invoice_id}/payments');
    expect(tool('invoice123_download_invoice_pdf').endpointMapping.path).toBe('/invoice/{invoice_id}/pdf/{language}');
    expect((tool('invoice123_download_invoice_pdf').parameters?.properties?.language as { enum: string[] }).enum).toEqual(['lt', 'en', 'lv']);
    expect(tool('invoice123_get_invoice_payment_link').endpointMapping.path).toBe('/invoice/{invoice_id}/payment-link');
    expect(tool('invoice123_list_invoice_vat_rates').endpointMapping.path).toBe('/invoice/vats');
    expect(tool('invoice123_get_invoice_data').endpointMapping).toEqual({ method: 'GET', path: '/invoice-data', queryParams: { types: '$types' } });
  });

  it('maps purchases, master data and reference lists', () => {
    expect(tool('invoice123_list_purchases').endpointMapping).toMatchObject({ path: '/expenses', queryParams: { type: '$type', status: '$status', expense_type: '$expense_type_id', client: '$client_id' } });
    expect(tool('invoice123_list_purchase_vat_rates').endpointMapping.path).toBe('/expense/vats');
    expect(tool('invoice123_list_purchase_types').endpointMapping.path).toBe('/expense/types');
    expect(tool('invoice123_download_commercial_offer_pdf').endpointMapping.path).toBe('/commercial-suggestion/{offer_id}/pdf/{language}');
    expect(tool('invoice123_list_clients').endpointMapping).toMatchObject({ path: '/clients', queryParams: { name: '$name', code: '$code' } });
    expect(tool('invoice123_list_products').endpointMapping).toMatchObject({ path: '/products', queryParams: { code: '$code' } });
    const simple: Record<string, string> = {
      invoice123_list_projects: '/projects', invoice123_list_waybills: '/waybills', invoice123_list_bank_accounts: '/banks', invoice123_list_series: '/series',
      invoice123_list_cash_registers: '/cash-registers', invoice123_list_units: '/units', invoice123_list_activities: '/activities', invoice123_list_email_templates: '/templates', invoice123_get_company: '/company',
    };
    for (const [n, p] of Object.entries(simple)) expect(`${n}:${tool(n).endpointMapping.path}`).toBe(`${n}:${p}`);
    // /vats is deprecated by the vendor in favour of /invoice/vats and /expense/vats.
    for (const t of a.tools) expect(t.endpointMapping.path).not.toBe('/vats');
  });

  it('is read-only', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      if (t.endpointMapping.method === 'static') continue;
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated, the risky ones installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...SWITCHED_OFF].sort());
    for (const n of WRITES) expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:false`);
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (!['GET', 'static'].includes(t.endpointMapping.method) && !t.endpointMapping.method.startsWith('odata_')) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
  });

  it('documents every tool in the instructions, marks secrets and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    for (const [name, meta] of Object.entries(a.envVarMeta ?? {})) if (/PASSWORD|SECRET|TOKEN/.test(name) || name.endsWith('_KEY')) expect(`${name}:${meta.secret}`).toBe(`${name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
    if (a.probe) {
      const probe = tool(a.probe.tool);
      expect(probe.annotations?.readOnlyHint === false).toBe(false);
      expect(probe.parameters?.required ?? []).toEqual([]);
    }
  });
});

const live = process.env.RUN_INVOICE123_LIVE === '1' && process.env.INVOICE123_API_TOKEN ? describe : describe.skip;
live('invoice123 adapter: live (read-only)', () => {
  const headers = { Authorization: `Bearer ${process.env.INVOICE123_API_TOKEN ?? ''}`, Accept: 'application/json' };
  it('reads the company, one page of invoices and the invoice VAT rates', async () => {
    const company = await fetch(`${a.connector.baseUrl}/company`, { headers });
    expect(company.status).toBe(200);
    const invoices = (await (await fetch(`${a.connector.baseUrl}/invoices?page=1&limit=1`, { headers })).json()) as { data: { result: unknown[]; pagination: { total: number } } };
    expect(Array.isArray(invoices.data.result)).toBe(true);
    const vats = (await (await fetch(`${a.connector.baseUrl}/invoice/vats`, { headers })).json()) as { data: unknown[] };
    expect(Array.isArray(vats.data)).toBe(true);
  }, 60_000);
});
