import axios from 'axios';
import * as adapter from './holded-v2.json';
import * as legacy from './holded.json';

/**
 * Holded API v2 adapter (https://api.holded.com/api/v2).
 *
 * API v2 authenticates with an API token that carries permissions, sent as
 * Authorization: Bearer. The legacy v1 key of holded.json (header "key") is a
 * different credential, so v2 lives in its own adapter and the v1 adapter keeps
 * its tools unchanged. Paths, parameters and required fields come from Holded's
 * published OpenAPI document, https://api.holded.com/openapi/es.json.
 *
 * Static checks always run. Live checks run only with RUN_HOLDED_V2_LIVE=1:
 * without a token they confirm the API refuses the call with its problem
 * document; with HOLDED_API_TOKEN they read the account. Reads only.
 *
 *   RUN_HOLDED_V2_LIVE=1 HOLDED_API_TOKEN=... npx jest src/adapters/es/holded-v2.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: {
    properties?: Record<string, { type?: string; description?: string; default?: unknown; enum?: unknown[]; pattern?: string }>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  aliases?: string[];
  instructions: string;
  prerequisites?: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<
    string,
    { label?: string; kind?: string; secret?: boolean; pattern?: string; options?: Array<{ value: string; label: string }> }
  >;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: Record<string, unknown>;
  };
  tools: Tool[];
};
const tool = (name: string): Tool => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
/** Tool arguments a mapping reads: {x} in the path, "$x" and "${x}" in query, body and headers. */
const used = (entry: Tool): Set<string> => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
/** Text outside `code spans`: the website renders descriptions and instructions as MDX. */
const outsideCode = (text: string): string => text.replace(/`[^`]*`/g, '');

// name, HTTP method, path below the base URL
const TOOLS: Array<[string, string, string]> = [
  ['holded_v2_get_account', 'GET', '/account'],
  ['holded_v2_list_account_users', 'GET', '/account/users'],
  ['holded_v2_list_partner_accounts', 'GET', '/partner/accounts'],
  ['holded_v2_get_api_usage', 'GET', '/usage'],
  ['holded_v2_search_contacts', 'GET', '/contacts/search'],
  ['holded_v2_list_contacts', 'GET', '/contacts'],
  ['holded_v2_get_contact', 'GET', '/contacts/{contact_id}'],
  ['holded_v2_create_contact', 'POST', '/contacts'],
  ['holded_v2_list_invoices', 'GET', '/invoices'],
  ['holded_v2_get_invoice', 'GET', '/invoices/{invoice_id}'],
  ['holded_v2_find_invoices_by_number', 'GET', '/invoices/find-by-number'],
  ['holded_v2_create_invoice', 'POST', '/invoices'],
  ['holded_v2_approve_invoice', 'POST', '/invoices/{invoice_id}/approve'],
  ['holded_v2_get_invoice_pdf', 'GET', '/invoices/{invoice_id}/pdf'],
  ['holded_v2_list_estimates', 'GET', '/estimates'],
  ['holded_v2_create_estimate', 'POST', '/estimates'],
  ['holded_v2_list_credit_notes', 'GET', '/credit-notes'],
  ['holded_v2_list_purchases', 'GET', '/purchases'],
  ['holded_v2_get_purchase', 'GET', '/purchases/{purchase_id}'],
  ['holded_v2_list_products', 'GET', '/products'],
  ['holded_v2_get_product', 'GET', '/products/{product_id}'],
  ['holded_v2_get_product_stock', 'GET', '/products/{product_id}/stock'],
  ['holded_v2_create_product', 'POST', '/products'],
  ['holded_v2_list_payments', 'GET', '/payments'],
  ['holded_v2_list_treasury_accounts', 'GET', '/treasury/accounts'],
  ['holded_v2_list_bank_movements', 'GET', '/treasury/accounts/{account_id}/bank-movements'],
  ['holded_v2_list_cash_movements', 'GET', '/treasury/accounts/{account_id}/cash-movements'],
  ['holded_v2_list_taxes', 'GET', '/taxes'],
  ['holded_v2_list_ledger_entries', 'GET', '/ledger-entries'],
  ['holded_v2_get_ledger_entry', 'GET', '/ledger-entries/{ledger_entry_id}'],
  ['holded_v2_list_accounting_accounts', 'GET', '/accounting-accounts'],
  ['holded_v2_list_projects', 'GET', '/projects'],
  ['holded_v2_get_project_summary', 'GET', '/projects/{project_id}/summary'],
  ['holded_v2_list_project_times', 'GET', '/project-times'],
  ['holded_v2_create_project_time', 'POST', '/projects/{project_id}/times'],
];
const REQUIRED: Record<string, string[]> = {
  holded_v2_search_contacts: ['name'],
  holded_v2_get_contact: ['contact_id'],
  holded_v2_create_contact: ['name'],
  holded_v2_get_invoice: ['invoice_id'],
  holded_v2_find_invoices_by_number: ['document_number'],
  holded_v2_create_invoice: ['contact_id', 'items'],
  holded_v2_approve_invoice: ['invoice_id'],
  holded_v2_get_invoice_pdf: ['invoice_id'],
  holded_v2_create_estimate: ['contact_id', 'items'],
  holded_v2_get_purchase: ['purchase_id'],
  holded_v2_get_product: ['product_id'],
  holded_v2_get_product_stock: ['product_id'],
  holded_v2_create_product: ['name'],
  holded_v2_list_bank_movements: ['account_id'],
  holded_v2_list_cash_movements: ['account_id'],
  holded_v2_list_ledger_entries: ['start_date', 'end_date'],
  holded_v2_get_ledger_entry: ['ledger_entry_id'],
  holded_v2_get_project_summary: ['project_id'],
  holded_v2_create_project_time: ['project_id', 'duration', 'user_id'],
};
const SWITCHED_OFF: string[] = ['holded_v2_approve_invoice'];

describe('holded-v2 adapter: static contract', () => {
  it('is filed where the catalog expects it', () => {
    expect(a.slug).toBe('holded-v2');
    expect(a.region).toBe('es');
    expect(a.category).toBe('accounting');
    expect(a.icon).toBe('holded');
    expect(a.docsUrl).toBe('https://www.holded.com/es/desarrolladores');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.holded.com/api/v2');
  });

  it('authenticates as the vendor documents', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({
      'token': '{{HOLDED_API_TOKEN}}'
    });
    expect(a.requiredEnvVars).toEqual(['HOLDED_API_TOKEN']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[name]?.label).toBeTruthy();
    }
    for (const name of ['HOLDED_API_TOKEN']) {
      expect(a.envVarMeta[name]).toMatchObject({ kind: 'credential', secret: true });
    }
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(TOOLS.map(([name]) => name));
    for (const [name, method, path] of TOOLS) {
      const m = tool(name).endpointMapping;
      expect(`${name}: ${m.method} ${m.path}`).toBe(`${name}: ${method} ${path}`);
    }
  });

  it('prefixes every tool, declares every argument it reads and requires what the API requires', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    expect(names.size).toBe(a.tools.length);
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      expect(entry.name).toMatch(/^holded_v2_[a-z0-9_]+$/);
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect([entry.name, entry.parameters.required ?? []]).toEqual([entry.name, REQUIRED[entry.name] ?? []]);
      for (const [param, schema] of Object.entries(entry.parameters.properties ?? {})) {
        expect([entry.name, param, Boolean(schema.description)]).toEqual([entry.name, param, true]);
      }
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('installs the risky tools switched off and marks every GET read-only', () => {
    const offNow = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(offNow.sort()).toEqual(SWITCHED_OFF);
    for (const entry of a.tools) {
      const method = entry.endpointMapping.method;
      if (method === 'GET') expect([entry.name, entry.annotations?.readOnlyHint]).toEqual([entry.name, true]);
      if (method === 'DELETE') expect([entry.name, entry.enabled]).toEqual([entry.name, false]);
    }
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    expect(a.instructions.startsWith('## ')).toBe(true);
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    const texts = [a.instructions, a.prerequisites ?? '', ...a.tools.map((entry) => entry.description)];
    for (const entry of a.tools) {
      for (const schema of Object.values(entry.parameters.properties ?? {})) texts.push(schema.description ?? '');
    }
    for (const text of texts) {
      expect(outsideCode(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/\u2014/);
    }
  });

  it('probes with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({
      'tool': 'holded_v2_get_account',
      'params': {}
    });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });


  it('sends the token as a Bearer header and never the legacy key header', () => {
    expect(JSON.stringify(a.connector)).not.toContain('HOLDED_API_KEY');
    expect(Object.keys(a.connector.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('key');
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path.startsWith('/')).toBe(true);
      expect(entry.endpointMapping.path).not.toMatch(/\/v1\//);
      // Only the PDF download sets a header of its own: it asks for the file, not for JSON.
      expect([entry.name, entry.endpointMapping.headers]).toEqual([
        entry.name,
        entry.name === 'holded_v2_get_invoice_pdf' ? { Accept: 'application/pdf, application/json' } : undefined,
      ]);
    }
  });

  it('pages lists with the opaque cursor', () => {
    for (const name of [
      'holded_v2_list_contacts',
      'holded_v2_search_contacts',
      'holded_v2_list_invoices',
      'holded_v2_list_purchases',
      'holded_v2_list_bank_movements',
      'holded_v2_list_cash_movements',
      'holded_v2_list_ledger_entries',
      'holded_v2_list_project_times',
    ]) {
      expect(tool(name).endpointMapping.queryParams).toMatchObject({ cursor: '$cursor', limit: '$limit' });
    }
    expect(tool('holded_v2_list_project_times').endpointMapping.queryParams).toMatchObject({
      startDate: '$start_date',
      endDate: '$end_date',
    });
  });

  it('creates drafts only and moves no money', () => {
    const writes = a.tools.filter((entry) => entry.endpointMapping.method !== 'GET').map((entry) => entry.name);
    expect(writes.sort()).toEqual([
      'holded_v2_approve_invoice',
      'holded_v2_create_contact',
      'holded_v2_create_estimate',
      'holded_v2_create_invoice',
      'holded_v2_create_product',
      'holded_v2_create_project_time',
    ]);
    for (const entry of a.tools) {
      if (entry.endpointMapping.method === 'GET') continue;
      expect(entry.endpointMapping.path).not.toMatch(/payments|reconcile|ledger|bank-movements|send|cancel/);
    }
    expect(tool('holded_v2_create_invoice').endpointMapping.bodyMapping).toMatchObject({
      contact_id: '$contact_id',
      items: '$items',
    });
  });

  it('leaves the v1 adapter and its tool names as they were', () => {
    const v1 = legacy as unknown as {
      connector: { baseUrl: string; authConfig: Record<string, string> };
      tools: Array<{ name: string }>;
    };
    expect(v1.connector.baseUrl).toBe('https://api.holded.com/api');
    expect(v1.connector.authConfig.headerName).toBe('key');
    expect(v1.tools.map((entry) => entry.name)).toEqual([
      'holded_list_contacts',
      'holded_get_contact',
      'holded_list_documents',
      'holded_get_document',
      'holded_list_products',
      'holded_list_warehouses',
      'holded_list_treasury_accounts',
      'holded_list_funnels',
      'holded_list_leads',
    ]);
    const mine = new Set(a.tools.map((entry) => entry.name));
    for (const entry of v1.tools) expect(mine.has(entry.name)).toBe(false);
  });
});


// Opt-in: RUN_HOLDED_V2_LIVE=1. The refusal check needs no account; the read
// needs HOLDED_API_TOKEN. Nothing is written.
const live = process.env.RUN_HOLDED_V2_LIVE === '1';
(live ? describe : describe.skip)('holded-v2: live', () => {
  it('refuses a call without a valid token with a problem document', async () => {
    const response = await axios.get(`${a.connector.baseUrl}/account`, {
      headers: { Authorization: 'Bearer not-a-token', Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
    expect(response.data).toMatchObject({ status: response.status });
  });

  it('reads the account of the token', async () => {
    const token = process.env.HOLDED_API_TOKEN;
    if (!token) throw new Error('Set HOLDED_API_TOKEN for the live check');
    const response = await axios.get(`${a.connector.baseUrl}/account`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
  });
});
