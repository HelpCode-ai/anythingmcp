import * as adapter from './fakturownia.json';
/**
 * Fakturownia.pl API adapter.
 *
 * Static checks always run: the api_token query parameter on the account's
 * own subdomain, every route against the official README
 * (https://github.com/fakturownia/API), the 200-with-status-error rule, the
 * proforma body, and that every tool which issues, sends, cancels, deletes or
 * pays an invoice installs switched off. No tool submits to KSeF or moves money.
 *
 * Live checks run only with RUN_FAKTUROWNIA_LIVE=1 and FAKTUROWNIA_DOMAIN,
 * FAKTUROWNIA_API_TOKEN set: they read one client and this month's invoices.
 * Reads only.
 *
 *   RUN_FAKTUROWNIA_LIVE=1 FAKTUROWNIA_DOMAIN=... FAKTUROWNIA_API_TOKEN=... \
 *     npx jest src/adapters/pl/fakturownia.live.spec.ts
 */
type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: unknown;
  envDefaults?: Record<string, string>;
  encodePathParams?: boolean;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: Mapping;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; label?: string; help?: string }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string): Tool => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const pathParams = (path: string): string[] => [...path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map((m) => m[1]);
const refs = (value: unknown, out: Set<string> = new Set<string>()): Set<string> => {
  if (typeof value === 'string') {
    if (/^\$\w+$/.test(value)) out.add(value.slice(1));
  } else if (Array.isArray(value)) {
    value.forEach((item) => refs(item, out));
  } else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => refs(item, out));
  }
  return out;
};
const outsideBackticks = (text: string): string => text.replace(/`[^`]*`/g, '');

const ROUTES: Record<string, [string, string]> = {
  fakturownia_list_invoices: ["GET", "/invoices.json"],
  fakturownia_get_invoice: ["GET", "/invoices/{invoice_id}.json"],
  fakturownia_get_invoice_ksef_status: ["GET", "/invoices/{invoice_id}.json"],
  fakturownia_get_invoice_pdf: ["GET", "/invoices/{invoice_id}.pdf"],
  fakturownia_list_recurring_invoices: ["GET", "/recurrings.json"],
  fakturownia_create_proforma: ["POST", "/invoices.json"],
  fakturownia_create_invoice: ["POST", "/invoices.json"],
  fakturownia_update_invoice: ["PUT", "/invoices/{invoice_id}.json"],
  fakturownia_change_invoice_status: ["POST", "/invoices/{invoice_id}/change_status.json"],
  fakturownia_send_invoice_by_email: ["POST", "/invoices/{invoice_id}/send_by_email.json"],
  fakturownia_cancel_invoice: ["POST", "/invoices/cancel.json"],
  fakturownia_delete_invoice: ["DELETE", "/invoices/{invoice_id}.json"],
  fakturownia_list_clients: ["GET", "/clients.json"],
  fakturownia_get_client: ["GET", "/clients/{client_id}.json"],
  fakturownia_create_client: ["POST", "/clients.json"],
  fakturownia_update_client: ["PUT", "/clients/{client_id}.json"],
  fakturownia_delete_client: ["DELETE", "/clients/{client_id}.json"],
  fakturownia_list_products: ["GET", "/products.json"],
  fakturownia_get_product: ["GET", "/products/{product_id}.json"],
  fakturownia_create_product: ["POST", "/products.json"],
  fakturownia_update_product: ["PUT", "/products/{product_id}.json"],
  fakturownia_list_payments: ["GET", "/banking/payments.json"],
  fakturownia_create_payment: ["POST", "/banking/payments.json"],
  fakturownia_list_warehouses: ["GET", "/warehouses.json"],
  fakturownia_list_warehouse_documents: ["GET", "/warehouse_documents.json"],
  fakturownia_get_warehouse_document: ["GET", "/warehouse_documents/{document_id}.json"],
  fakturownia_list_departments: ["GET", "/departments.json"],
  fakturownia_list_categories: ["GET", "/categories.json"],
};
const SWITCHED_OFF = [
  "fakturownia_cancel_invoice",
  "fakturownia_change_invoice_status",
  "fakturownia_create_invoice",
  "fakturownia_create_payment",
  "fakturownia_delete_client",
  "fakturownia_delete_invoice",
  "fakturownia_send_invoice_by_email",
  "fakturownia_update_invoice",
];
const REQUIRED: Record<string, string[]> = {
  fakturownia_list_invoices: [],
  fakturownia_get_invoice: ["invoice_id"],
  fakturownia_get_invoice_ksef_status: ["invoice_id"],
  fakturownia_get_invoice_pdf: ["invoice_id"],
  fakturownia_list_recurring_invoices: [],
  fakturownia_create_proforma: ["positions"],
  fakturownia_create_invoice: ["invoice"],
  fakturownia_update_invoice: ["invoice", "invoice_id"],
  fakturownia_change_invoice_status: ["invoice_id", "status"],
  fakturownia_send_invoice_by_email: ["invoice_id"],
  fakturownia_cancel_invoice: ["invoice_id"],
  fakturownia_delete_invoice: ["invoice_id"],
  fakturownia_list_clients: [],
  fakturownia_get_client: ["client_id"],
  fakturownia_create_client: ["name"],
  fakturownia_update_client: ["client_id"],
  fakturownia_delete_client: ["client_id"],
  fakturownia_list_products: [],
  fakturownia_get_product: ["product_id"],
  fakturownia_create_product: ["name"],
  fakturownia_update_product: ["product_id"],
  fakturownia_list_payments: [],
  fakturownia_create_payment: ["invoice_ids", "name", "price"],
  fakturownia_list_warehouses: [],
  fakturownia_list_warehouse_documents: [],
  fakturownia_get_warehouse_document: ["document_id"],
  fakturownia_list_departments: [],
  fakturownia_list_categories: [],
};
const PROBE = {"tool": "fakturownia_list_clients", "params": {"per_page": 1}};
const PROBE_METHOD = "GET";

describe('fakturownia adapter: static contract', () => {
  it('sends the API token as the api_token query parameter on the account subdomain', () => {
    expect(a.slug).toBe('fakturownia');
    expect(a.region).toBe('pl');
    expect(a.category).toBe('accounting');
    expect(a.connector.baseUrl).toBe('https://{{FAKTUROWNIA_DOMAIN}}.fakturownia.pl');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ api_token: '{{FAKTUROWNIA_API_TOKEN}}' });
    expect(a.envVarMeta.FAKTUROWNIA_API_TOKEN.secret).toBe(true);
    const prefix = new RegExp(a.envVarMeta.FAKTUROWNIA_DOMAIN.pattern!);
    expect(prefix.test('mojafirma')).toBe(true);
    for (const bad of ['mojafirma.fakturownia.pl', 'https://mojafirma']) expect(prefix.test(bad)).toBe(false);
    expect(a.connector.config?.errorWhen).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'status', equals: 'error' })]));
  });

  it('never submits to KSeF and keeps legal or money-related writes switched off', () => {
    const text = JSON.stringify(a.tools.map((t) => t.endpointMapping));
    expect(text).not.toMatch(/send_to_ksef|gov_save_and_send/);
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'DELETE') expect(t.enabled).toBe(false);
      if (/invoice/.test(t.name) && t.endpointMapping.method !== 'GET') expect(t.enabled).toBe(false);
    }
    expect(tool('fakturownia_get_invoice_ksef_status').endpointMapping.queryParams).toEqual({
      'fields[invoice]': 'gov_status,gov_id,gov_send_date,gov_error_messages,gov_verification_link,gov_link,gov_corrected_invoice_number',
    });
  });

  it('creates proformas only, never VAT invoices, with the proforma tool', () => {
    const body = tool('fakturownia_create_proforma').endpointMapping.bodyMapping as { invoice: Record<string, unknown> };
    expect(body.invoice.kind).toBe('proforma');
    expect(tool('fakturownia_create_proforma').enabled).toBeUndefined();
    expect(Object.keys(tool('fakturownia_create_proforma').parameters.properties ?? {})).not.toContain('kind');
  });

  it('pins the method and path of every tool', () => {
    const actual: Record<string, [string, string]> = {};
    for (const t of a.tools) actual[t.name] = [t.endpointMapping.method, t.endpointMapping.path];
    expect(actual).toEqual(ROUTES);
  });

  it('installs exactly the risky tools switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
  });

  it('wires every parameter into the request and requires every path parameter', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = refs([m.queryParams ?? {}, m.bodyMapping ?? {}]);
      for (const p of pathParams(m.path)) used.add(p);
      for (const p of Object.keys(m.envDefaults ?? {})) used.add(p);
      for (const p of Object.keys(t.parameters.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of pathParams(m.path)) expect(`${t.name}:${p}:${(t.parameters.required ?? []).includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const r of t.parameters.required ?? []) expect(`${t.name}:${r}:${r in (t.parameters.properties ?? {})}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('pins the required parameters of every tool', () => {
    const actual: Record<string, string[]> = {};
    for (const t of a.tools) actual[t.name] = [...(t.parameters.required ?? [])].sort();
    expect(actual).toEqual(REQUIRED);
  });

  it('names every tool in the instructions, prefixes it with the slug and keeps the text MDX-safe', () => {
    const prefix = `${a.slug.replace(/-/g, '_')}_`;
    for (const t of a.tools) {
      expect(t.name.startsWith(prefix)).toBe(true);
      expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
      expect(outsideBackticks(t.description)).not.toMatch(/[{}<]/);
      for (const [p, d] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${Boolean(d.description)}`).toBe(`${t.name}.${p}:true`);
        expect(outsideBackticks(d.description ?? '')).not.toMatch(/[{}<]/);
      }
    }
    expect(outsideBackticks(a.instructions)).not.toMatch(/[{}<]/);
    expect(outsideBackticks(a.description)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });

  it('describes every variable and probes with a cheap read', () => {
    for (const v of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[v]).toMatchObject({ label: expect.any(String), kind: expect.any(String), help: expect.any(String) });
    }
    expect(a.probe).toEqual(PROBE);
    expect(tool(a.probe.tool).endpointMapping.method).toBe(PROBE_METHOD);
    for (const status of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[status]).toBeDefined();
  });
});

const live = process.env.RUN_FAKTUROWNIA_LIVE === '1' ? describe : describe.skip;
live('fakturownia adapter: live reads', () => {
  it("reads one client and this month's invoices", async () => {
    const base = `https://${process.env.FAKTUROWNIA_DOMAIN}.fakturownia.pl`;
    const token = encodeURIComponent(`${process.env.FAKTUROWNIA_API_TOKEN}`);
    for (const path of ['/clients.json?per_page=1', '/invoices.json?period=this_month&per_page=1']) {
      const res = await fetch(`${base}${path}&api_token=${token}`, { headers: { Accept: 'application/json' } });
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    }
  });
});
