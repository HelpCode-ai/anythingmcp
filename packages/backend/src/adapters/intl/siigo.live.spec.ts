import axios from 'axios';
import * as adapter from './siigo.json';

/**
 * Siigo API adapter (https://api.siigo.com), Siigo Nube, Colombia.
 *
 * The connector signs in at POST /auth with the API username and access key
 * (JSON body, Partner-Id header), receives a JWT that lasts 24 hours and sends
 * it as Authorization: Bearer with the Partner-Id header Siigo requires on
 * every call. Paths, parameters and required fields come from Siigo's API
 * blueprint, https://siigoapi.docs.apiary.io/.
 *
 * Static checks always run. Live checks run only with RUN_SIIGO_LIVE=1:
 * without an account they confirm that the login and the API refuse wrong
 * credentials; with SIIGO_USERNAME and SIIGO_ACCESS_KEY they sign in and read
 * the users and the taxes. Reads only: no document is created.
 *
 *   RUN_SIIGO_LIVE=1 SIIGO_USERNAME=... SIIGO_ACCESS_KEY=... npx jest src/adapters/intl/siigo.live.spec.ts
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
  ['siigo_list_document_types', 'GET', '/v1/document-types'],
  ['siigo_list_taxes', 'GET', '/v1/taxes'],
  ['siigo_list_payment_types', 'GET', '/v1/payment-types'],
  ['siigo_list_cost_centers', 'GET', '/v1/cost-centers'],
  ['siigo_list_users', 'GET', '/v1/users'],
  ['siigo_list_warehouses', 'GET', '/v1/warehouses'],
  ['siigo_list_account_groups', 'GET', '/v1/account-groups'],
  ['siigo_list_customers', 'GET', '/v1/customers'],
  ['siigo_get_customer', 'GET', '/v1/customers/{customer_id}'],
  ['siigo_create_customer', 'POST', '/v1/customers'],
  ['siigo_list_products', 'GET', '/v1/products'],
  ['siigo_get_product', 'GET', '/v1/products/{product_id}'],
  ['siigo_create_product', 'POST', '/v1/products'],
  ['siigo_list_invoices', 'GET', '/v1/invoices'],
  ['siigo_get_invoice', 'GET', '/v1/invoices/{invoice_id}'],
  ['siigo_create_invoice', 'POST', '/v1/invoices'],
  ['siigo_get_invoice_stamp_errors', 'GET', '/v1/invoices/{invoice_id}/stamp/errors'],
  ['siigo_send_invoice_email', 'POST', '/v1/invoices/{invoice_id}/mail'],
  ['siigo_annul_invoice', 'POST', '/v1/invoices/{invoice_id}/annul'],
  ['siigo_delete_invoice', 'DELETE', '/v1/invoices/{invoice_id}'],
  ['siigo_list_quotations', 'GET', '/v1/quotations'],
  ['siigo_get_quotation', 'GET', '/v1/quotations/{quotation_id}'],
  ['siigo_list_credit_notes', 'GET', '/v1/credit-notes'],
  ['siigo_get_credit_note', 'GET', '/v1/credit-notes/{credit_note_id}'],
  ['siigo_list_vouchers', 'GET', '/v1/vouchers'],
  ['siigo_get_voucher', 'GET', '/v1/vouchers/{voucher_id}'],
  ['siigo_list_payment_receipts', 'GET', '/v1/payment-receipts'],
  ['siigo_list_journals', 'GET', '/v1/journals'],
  ['siigo_generate_trial_balance', 'POST', '/v1/test-balance-report'],
  ['siigo_generate_trial_balance_by_third_party', 'POST', '/v1/test-balance-report-by-thirdparty'],
  ['siigo_list_accounts_payable', 'GET', '/v1/accounts-payable'],
];
const REQUIRED: Record<string, string[]> = {
  siigo_get_customer: ['customer_id'],
  siigo_create_customer: ['person_type', 'id_type', 'identification', 'name', 'address', 'phones', 'contacts'],
  siigo_get_product: ['product_id'],
  siigo_create_product: ['code', 'name', 'account_group'],
  siigo_get_invoice: ['invoice_id'],
  siigo_create_invoice: ['document_id', 'date', 'customer_identification', 'seller', 'items', 'payments'],
  siigo_get_invoice_stamp_errors: ['invoice_id'],
  siigo_send_invoice_email: ['invoice_id', 'mail_to'],
  siigo_annul_invoice: ['invoice_id'],
  siigo_delete_invoice: ['invoice_id'],
  siigo_get_quotation: ['quotation_id'],
  siigo_get_credit_note: ['credit_note_id'],
  siigo_get_voucher: ['voucher_id'],
  siigo_generate_trial_balance: ['year', 'month_start', 'month_end'],
  siigo_generate_trial_balance_by_third_party: ['year', 'month_start', 'month_end'],
};
const SWITCHED_OFF: string[] = ['siigo_annul_invoice', 'siigo_delete_invoice'];

describe('siigo adapter: static contract', () => {
  it('is filed where the catalog expects it', () => {
    expect(a.slug).toBe('siigo');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('accounting');
    expect(a.icon).toBe('siigo');
    expect(a.docsUrl).toBe('https://siigoapi.docs.apiary.io/');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.siigo.com');
  });

  it('authenticates as the vendor documents', () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toEqual({
      'loginUrl': 'https://api.siigo.com/auth',
      'loginMethod': 'POST',
      'loginHeaders': {
        'Content-Type': 'application/json',
        'Partner-Id': 'AnythingMCP'
      },
      'loginBody': {
        'username': '${username}',
        'access_key': '${password}'
      },
      'username': '{{SIIGO_USERNAME}}',
      'password': '{{SIIGO_ACCESS_KEY}}',
      'tokenJsonPath': 'access_token',
      'expiryJsonPath': 'expires_in',
      'expiryFormat': 'ttl_seconds',
      'tokenTTLSeconds': 86400,
      'proactiveRefreshSeconds': 1800,
      'refreshOn401': true,
      'headerName': 'Authorization',
      'headerTemplate': 'Bearer ${token}'
    });
    expect(a.requiredEnvVars).toEqual(['SIIGO_USERNAME', 'SIIGO_ACCESS_KEY']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[name]?.label).toBeTruthy();
    }
    for (const name of ['SIIGO_ACCESS_KEY']) {
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
      expect(entry.name).toMatch(/^siigo_[a-z0-9_]+$/);
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
      'tool': 'siigo_list_users',
      'params': {}
    });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['401', '403', '404', 'auth_failed', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });


  it('identifies the integration with Partner-Id on the login and on every call', () => {
    expect(a.connector.headers).toMatchObject({ 'Partner-Id': 'AnythingMCP' });
    const auth = a.connector.authConfig as unknown as { loginHeaders: Record<string, string>; proactiveRefreshSeconds: number; tokenTTLSeconds: number };
    expect(auth.loginHeaders['Partner-Id']).toBe('AnythingMCP');
    // Siigo: 3 to 100 letters and digits, no spaces or special characters.
    expect(auth.loginHeaders['Partner-Id']).toMatch(/^[A-Za-z0-9]{3,100}$/);
    // The token lasts 24 hours: renew shortly before, not on every call.
    expect(auth.proactiveRefreshSeconds).toBeLessThan(auth.tokenTTLSeconds / 2);
  });

  it('pages every paged list with page and page_size', () => {
    for (const name of [
      'siigo_list_customers',
      'siigo_list_products',
      'siigo_list_invoices',
      'siigo_list_quotations',
      'siigo_list_credit_notes',
      'siigo_list_vouchers',
      'siigo_list_payment_receipts',
      'siigo_list_journals',
      'siigo_list_accounts_payable',
    ]) {
      expect(tool(name).endpointMapping.queryParams).toMatchObject({ page: '$page', page_size: '$page_size' });
      expect(tool(name).parameters.properties?.page_size).toMatchObject({ maximum: 100 });
    }
    expect(tool('siigo_list_document_types').endpointMapping.queryParams).toEqual({ type: '$type' });
    expect(tool('siigo_list_payment_types').endpointMapping.queryParams).toEqual({ document_type: '$document_type' });
  });

  it('creates an invoice without sending it to the DIAN or by mail unless asked', () => {
    const entry = tool('siigo_create_invoice');
    expect(entry.enabled).not.toBe(false);
    expect(entry.parameters.properties?.send_to_dian).toMatchObject({ type: 'boolean', default: false });
    expect(entry.parameters.properties?.send_email).toMatchObject({ type: 'boolean', default: false });
    expect(entry.endpointMapping.bodyMapping).toEqual({
      document: { id: '$document_id' },
      date: '$date',
      customer: { identification: '$customer_identification', branch_office: '$customer_branch_office' },
      seller: '$seller',
      stamp: { send: '$send_to_dian' },
      mail: { send: '$send_email' },
      observations: '$observations',
      cost_center: '$cost_center',
      currency: '$currency',
      retentions: '$retentions',
      items: '$items',
      payments: '$payments',
    });
    expect(entry.endpointMapping.headers).toEqual({ 'Idempotency-Key': '$idempotency_key' });
  });

  it('writes only third parties, products and sales invoices, and keeps annul and delete switched off', () => {
    const writes = a.tools
      .filter((entry) => entry.endpointMapping.method !== 'GET' && entry.annotations?.readOnlyHint !== true)
      .map((entry) => entry.name);
    expect(writes.sort()).toEqual([
      'siigo_annul_invoice',
      'siigo_create_customer',
      'siigo_create_invoice',
      'siigo_create_product',
      'siigo_delete_invoice',
      'siigo_send_invoice_email',
    ]);
    for (const entry of a.tools) {
      if (entry.endpointMapping.method === 'GET') continue;
      expect(entry.endpointMapping.path).not.toMatch(/vouchers|payment-receipts|journals|credit-notes|purchases|batch|webhooks/);
    }
    // The two reports are POSTs that only build a file.
    for (const name of ['siigo_generate_trial_balance', 'siigo_generate_trial_balance_by_third_party']) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(tool(name).annotations).toEqual({ readOnlyHint: true });
    }
  });
});


// Opt-in: RUN_SIIGO_LIVE=1. The refusal checks need no account; the reads need
// SIIGO_USERNAME and SIIGO_ACCESS_KEY. Nothing is written.
const live = process.env.RUN_SIIGO_LIVE === '1';
const PARTNER = { 'Partner-Id': 'AnythingMCP' };
(live ? describe : describe.skip)('siigo: live', () => {
  it('refuses a wrong username and access key at the login', async () => {
    const response = await axios.post(
      'https://api.siigo.com/auth',
      { username: 'nobody@example.org', access_key: 'bm90LWEta2V5' },
      { headers: { 'Content-Type': 'application/json', ...PARTNER }, validateStatus: () => true },
    );
    expect(response.status).toBe(401);
  });

  it('refuses an invalid token on the API', async () => {
    const response = await axios.get(`${a.connector.baseUrl}/v1/taxes`, {
      headers: { Authorization: 'Bearer not-a-token', ...PARTNER },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
  });

  it('signs in and reads the users and the taxes', async () => {
    const username = process.env.SIIGO_USERNAME;
    const accessKey = process.env.SIIGO_ACCESS_KEY;
    if (!username || !accessKey) throw new Error('Set SIIGO_USERNAME and SIIGO_ACCESS_KEY for the live check');
    const login = await axios.post(
      'https://api.siigo.com/auth',
      { username, access_key: accessKey },
      { headers: { 'Content-Type': 'application/json', ...PARTNER }, validateStatus: () => true },
    );
    expect([200, 201]).toContain(login.status);
    expect(typeof login.data.access_token).toBe('string');
    const headers = { Authorization: `Bearer ${login.data.access_token}`, ...PARTNER };
    const users = await axios.get(`${a.connector.baseUrl}/v1/users`, { headers, validateStatus: () => true });
    expect(users.status).toBe(200);
    const taxes = await axios.get(`${a.connector.baseUrl}/v1/taxes`, { headers, validateStatus: () => true });
    expect(taxes.status).toBe(200);
  });
});
